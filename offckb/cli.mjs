#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const usage = `Usage: offckb [--plugin-port <port>] explorer [--project <directory>]...

Run CKB Devnet Explorer through offckb's restricted plugin interface.
The current project is used when --project is omitted. Additional project
paths need matching offckb --read grants for their deployment directories.

Install with:
  offckb plugin install github:wildanrhmn/ckb-devnet-explorer \\
    --allow devnet-read --allow project-deployment --allow serve`;

if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
  console.log(usage);
  process.exit(0);
}

let json = false;
let temporary;

try {
  const contextFile = process.env.OFFCKB_PLUGIN_CONTEXT;
  if (!contextFile) throw new Error("OFFCKB_PLUGIN_CONTEXT is required; run this entry through offckb");
  const context = JSON.parse(fs.readFileSync(contextFile, "utf8"));
  json = context.output === "json";
  validateContext(context);

  const { values } = parseArgs({
    args,
    options: { project: { type: "string", multiple: true } },
  });
  const projects = (values.project ?? [context.cwd]).map((directory) => path.resolve(context.cwd, directory));
  const bin = providerBin();
  const capabilities = integrationInfo(bin);
  for (const capability of ["system-scripts", "bridge", "json-ready", "read-only", "genesis-check", "address-prefix", "rpc-queue"]) {
    if (!capabilities.includes(capability)) throw new Error(`Explorer does not provide the ${capability} capability`);
  }

  // Keep the authenticated bridge token out of argv. The host makes its temporary
  // directory writable in both sandboxed and trusted execution modes.
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ckb-devnet-explorer-"));
  const bridge = path.join(temporary, "bridge.json");
  const http = context.sandbox.http;
  fs.writeFileSync(bridge, JSON.stringify({ apiVersion: 1, transport: http.transport, endpoint: http.endpoint, token: http.token, url: http.url }), { mode: 0o600 });

  const provider = spawn(process.execPath, [
    bin,
    "serve",
    "--json",
    "--rpc", context.devnet.rpcUrl,
    "--system-scripts", context.devnet.systemScriptsFile,
    "--bridge", bridge,
    "--expected-genesis", context.devnet.genesisHash,
    "--address-prefix", context.devnet.addressPrefix,
    ...projects.flatMap((directory) => ["--project", directory]),
  ], { stdio: ["ignore", "pipe", "inherit"] });
  process.exitCode = await runProvider(provider, context);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(json ? JSON.stringify({ ok: false, code: "EXPLORER_FAILED", message }) : message);
  process.exitCode = 1;
} finally {
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
}

function validateContext(context) {
  if (context?.apiVersion !== 1 || !["json", "text"].includes(context.output) || typeof context.cwd !== "string")
    throw new Error("Explorer requires offckb plugin context API v1");
  const devnet = context.devnet;
  if (!["pure-devnet", "fork-of-mainnet", "fork-of-testnet"].includes(devnet?.kind))
    throw new Error("Explorer requires a known devnet or fork; initialize the chain before starting the plugin");
  if (typeof devnet.rpcUrl !== "string" || !devnet.rpcUrl || typeof devnet.systemScriptsFile !== "string" || !devnet.systemScriptsFile)
    throw new Error("Explorer requires devnet-read and a system scripts snapshot");
  if (devnet.systemScriptsVersion !== 1) throw new Error("Explorer requires system scripts snapshot API v1");
  if (typeof devnet.genesisHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(devnet.genesisHash))
    throw new Error("Explorer requires the devnet genesis hash");
  if (!["ckt", "ckb"].includes(devnet.addressPrefix)) throw new Error("Explorer requires a valid address prefix");
  const http = context.sandbox?.http;
  if (!http || !["proxy-connect-v1", "tcp-v1"].includes(http.transport) || typeof http.endpoint !== "string" || !http.endpoint ||
      typeof http.token !== "string" || !http.token || /[\r\n]/.test(http.token) || typeof http.url !== "string" || !http.url)
    throw new Error("Explorer requires the serve capability and an authenticated HTTP bridge");
  for (const permission of ["devnet-read", "project-deployment", "serve"]) {
    if (!context.sandbox.permissions?.includes(permission)) throw new Error(`Explorer requires the ${permission} grant`);
  }
}

function providerBin() {
  const root = fs.realpathSync(fileURLToPath(new URL("..", import.meta.url)));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const declared = manifest.bin?.["ckb-devnet-explorer"];
  if (typeof declared !== "string") throw new Error("The ckb-devnet-explorer bin is not declared");
  const bin = fs.realpathSync(path.resolve(root, declared));
  const relative = path.relative(root, bin);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !fs.statSync(bin).isFile())
    throw new Error("Invalid Explorer public CLI entry");
  return bin;
}

function integrationInfo(bin) {
  const result = spawnSync(process.execPath, [bin, "--integration-info"], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 65536,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) throw new Error("Explorer public CLI integration check failed");
  const info = JSON.parse(result.stdout);
  if (info.apiVersion !== 1 || !Array.isArray(info.capabilities)) throw new Error("Explorer requires public CLI integration API v1");
  return info.capabilities;
}

async function runProvider(provider, context) {
  let buffer = "";
  let readyCount = 0;
  let invalid;
  let requested;
  let termination;
  const terminate = () => {
    if (provider.exitCode !== null || provider.signalCode !== null) return;
    provider.kill("SIGTERM");
    termination ??= setTimeout(() => provider.kill("SIGKILL"), 3000);
    termination.unref();
  };
  const fail = (message) => {
    invalid ??= new Error(message);
    terminate();
  };
  const closed = new Promise((resolve, reject) => {
    provider.once("error", reject);
    provider.once("close", (code, signal) => {
      clearTimeout(termination);
      resolve({ code, signal });
    });
  });
  const signals = [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]];
  const listeners = signals.map(([signal, code]) => {
    const listener = () => {
      // OffCKB signals the whole POSIX process group, including the provider.
      // Forwarding here would deliver a second signal and bypass graceful cleanup.
      requested ??= code;
    };
    process.once(signal, listener);
    return [signal, listener];
  });
  provider.stdout.on("data", (chunk) => {
    if (invalid) return;
    buffer += chunk.toString();
    if (buffer.length > 65536) return fail("Explorer exceeded its ready/output limit");
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (++readyCount !== 1) return fail("Explorer emitted more than one output record");
      try {
        const ready = JSON.parse(line);
        if (ready.ok !== true || ready.apiVersion !== 1 || ready.transport !== context.sandbox.http.transport || ready.url !== context.sandbox.http.url)
          throw new Error("Unexpected ready record");
        if (context.output === "json") {
          console.log(JSON.stringify({ ok: true, apiVersion: 1, command: "explorer", url: ready.url, transport: ready.transport }));
        } else console.error(`Explorer: ${ready.url}`);
      } catch {
        return fail("Explorer violated its public ready/output contract");
      }
    }
  });
  try {
    const exit = await closed;
    if (invalid) throw invalid;
    if (requested !== undefined) return requested;
    if (readyCount !== 1 || buffer.trim()) throw new Error("Explorer exited without one valid ready record");
    return exit.code ?? 1;
  } finally {
    clearTimeout(termination);
    for (const [signal, listener] of listeners) process.removeListener(signal, listener);
  }
}
