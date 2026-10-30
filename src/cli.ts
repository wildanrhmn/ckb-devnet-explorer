#!/usr/bin/env -S npx tsx
import { parseArgs } from "node:util";
import { getBlock, getTipNumber, type RpcTransaction } from "./rpc.ts";
import { loadProjectScripts, loadSystemScripts } from "./scripts.ts";
import { Resolver } from "./resolver.ts";
import { Explorer } from "./explorer.ts";
import { createExplorerServer, startServer } from "./server.ts";
import { serveBridge } from "./bridge.ts";
import { Faucet } from "./faucet.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    rpc: { type: "string", default: "http://127.0.0.1:8114" },
    project: { type: "string", multiple: true, default: [process.cwd()] },
    txs: { type: "string", default: "10" },
    port: { type: "string", default: "7070" },
    host: { type: "string", default: "127.0.0.1" },
    "system-scripts": { type: "string" },
    bridge: { type: "string" },
    json: { type: "boolean", default: false },
    "integration-info": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values["integration-info"]) {
  console.log(JSON.stringify({ apiVersion: 1, capabilities: ["system-scripts", "host", "bridge", "json-ready"] }));
  process.exit(0);
}

if (values.help) {
  console.log(`ckb-devnet-explorer: a lightweight explorer for OffCKB devnets

Usage:
  ckb-devnet-explorer serve [options]   start the web explorer
  ckb-devnet-explorer [options]         print the latest transactions in the terminal

Options:
  --project <dir>   a project deployed with \`offckb deploy\` (repeatable, default: current folder)
  --rpc <url>       devnet RPC (default: http://127.0.0.1:8114)
  --port <n>        web port for serve (default: 7070)
  --host <address>  bind address for serve (default: 127.0.0.1)
  --system-scripts <file>  read the offckb-format scripts JSON instead of calling offckb
  --bridge <path>   serve over outbound Unix-socket connections instead of opening a TCP port
  --json           emit one versioned ready record for serve; diagnostics go to stderr
  --integration-info  print the public CLI integration version and capabilities, without RPC access
  --txs <n>         how many transactions the terminal version prints (default: 10)
  -h, --help        show this help

Needs a running devnet (\`offckb node\`), plus offckb on PATH unless --system-scripts is supplied.`);
  process.exit(0);
}

const url = values.rpc!;
const projects = values.project!;
let known: ReturnType<typeof loadSystemScripts>;
try {
  known = loadSystemScripts(values["system-scripts"]);
} catch (err) {
  if (values["system-scripts"] || (err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  console.error("offckb isn't on your PATH. Install it with `npm i -g @offckb/cli`, start a devnet with `offckb node`, then run this again.");
  process.exit(1);
}
let projectCount = 0;
for (const dir of projects) {
  const scripts = loadProjectScripts(dir);
  projectCount += scripts.size;
  for (const [k, v] of scripts) known.set(k, v);
}
const resolver = new Resolver(known);

if (positionals[0] === "serve") {
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be an integer from 0 to 65535");
  console.error(`known scripts: ${known.size - projectCount} genesis + ${projectCount} from projects`);
  const ready = (address?: string) => {
    if (values.json) console.log(JSON.stringify({ ok: true, apiVersion: 1, ...(address ? { url: address } : { transport: "bridge" }) }));
    else console.error(address ? `ckb-devnet-explorer running at ${address}` : "ckb-devnet-explorer bridge ready");
  };
  const explorer = new Explorer(url, resolver);
  const faucet = new Faucet(url);
  const server = values.bridge
    ? createExplorerServer(explorer, faucet, url, projects, { writable: false })
    : startServer(explorer, faucet, port, url, projects, values.host);
  const stopBridge = values.bridge ? serveBridge(server, values.bridge, () => ready()) : undefined;
  const stop = () => { stopBridge?.(); server.close(); server.closeAllConnections(); };
  if (!values.bridge) server.once("listening", () => {
    const address = server.address();
    if (address && typeof address !== "string") ready(`http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`);
  });
  server.once("error", (error: NodeJS.ErrnoException) => {
    console.error(JSON.stringify({ ok: false, code: "SERVER_FAILED", message: error.code || "Server failed" }));
    stop(); process.exitCode = 1;
  });
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    process.once(signal, () => { stop(); process.exitCode = code; });
  }
} else {
  await scan();
}

async function scan() {
  const wanted = Number(values.txs);
  const tip = await getTipNumber(url);
  console.log(`devnet tip: block ${tip} | known scripts: ${known.size - projectCount} genesis + ${projectCount} from projects\n`);

  // Walk back from the tip and collect the newest non-cellbase transactions.
  const found: { block: number; tx: RpcTransaction }[] = [];
  for (let n = tip; n >= 0 && found.length < wanted; n -= 50) {
    const numbers = Array.from({ length: Math.min(50, n + 1) }, (_, i) => n - i);
    const blocks = await Promise.all(numbers.map((b) => getBlock(url, b)));
    for (const block of blocks) {
      if (!block) continue;
      for (const tx of block.transactions.slice(1)) {
        if (found.length < wanted) found.push({ block: Number(BigInt(block.header.number)), tx });
      }
    }
  }

  for (const { block, tx } of found) {
    console.log(`block ${block}  tx ${tx.hash}`);
    tx.outputs.forEach((o, i) => {
      const ckb = (Number(BigInt(o.capacity)) / 1e8).toString();
      const bytes = (tx.outputs_data[i].length - 2) / 2;
      console.log(`  #${i}  ${ckb} CKB  lock: ${resolver.describe(o.lock)}  type: ${resolver.describe(o.type)}  data: ${bytes} bytes`);
    });
    console.log();
  }
}
