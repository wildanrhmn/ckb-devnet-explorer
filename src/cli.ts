#!/usr/bin/env -S npx tsx
import { parseArgs } from "node:util";
import { getBlock, getBlockHash, getTipNumber, type RpcTransaction } from "./rpc.ts";
import { loadProjectScripts, loadSystemScripts } from "./scripts.ts";
import { Resolver } from "./resolver.ts";
import { Explorer, type AddressPrefix } from "./explorer.ts";
import { createExplorerServer, startServer } from "./server.ts";
import { loadBridgeConfig, serveBridge } from "./bridge.ts";
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
    "read-only": { type: "boolean", default: false },
    "expected-genesis": { type: "string" },
    "address-prefix": { type: "string", default: "ckt" },
    json: { type: "boolean", default: false },
    "integration-info": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values["integration-info"]) {
  console.log(JSON.stringify({ apiVersion: 1, capabilities: ["system-scripts", "host", "bridge", "json-ready", "read-only", "genesis-check", "address-prefix", "rpc-queue"] }));
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
  --bridge <file>   serve over authenticated reverse channels described by a JSON config
  --read-only      disable faucet and transaction broadcast even without a bridge
  --expected-genesis <hash>  refuse to serve unless RPC genesis matches this hash
  --address-prefix <ckt|ckb>  address prefix (default: ckt; use ckb for a mainnet fork)
  --json           emit one versioned ready record for serve; diagnostics go to stderr
  --integration-info  print the public CLI integration version and capabilities, without RPC access
  --txs <n>         how many transactions the terminal version prints (default: 10)
  -h, --help        show this help

Needs a running devnet (\`offckb node\`), plus offckb on PATH unless --system-scripts is supplied.`);
  process.exit(0);
}

const url = values.rpc!;
const projects = values.project!;
const addressPrefix = values["address-prefix"] as AddressPrefix;
if (!["ckt", "ckb"].includes(addressPrefix)) throw new Error("--address-prefix must be ckt or ckb");
const expectedGenesis = values["expected-genesis"];
if (expectedGenesis && !/^0x[0-9a-fA-F]{64}$/.test(expectedGenesis)) throw new Error("--expected-genesis must be a 32-byte hex hash");
const bridge = values.bridge ? loadBridgeConfig(values.bridge) : undefined;
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

if (expectedGenesis) {
  const actual = await getBlockHash(url, 0);
  if (actual?.toLowerCase() !== expectedGenesis.toLowerCase())
    throw new Error(`RPC genesis mismatch: expected ${expectedGenesis}, got ${actual ?? "no genesis block"}`);
}

if (positionals[0] === "serve") {
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be an integer from 0 to 65535");
  console.error(`known scripts: ${known.size - projectCount} genesis + ${projectCount} from projects`);
  const ready = (result: { url?: string; transport?: string }) => {
    if (values.json) console.log(JSON.stringify({ ok: true, apiVersion: 1, ...result }));
    else console.error(result.url ? `ckb-devnet-explorer running at ${result.url}` : "ckb-devnet-explorer bridge ready");
  };
  const explorer = new Explorer(url, resolver, addressPrefix);
  const faucet = new Faucet(url, addressPrefix);
  // Reverse-hosted explorers are read-only because the host only supplies read RPC. Its CSP
  // may also disallow downloads; Copy JSON and the Raw view remain available.
  const options = { writable: !bridge && !values["read-only"], downloads: !bridge, keepAlive: !!bridge };
  const server = bridge
    ? createExplorerServer(explorer, faucet, url, projects, options)
    : startServer(explorer, faucet, port, url, projects, values.host, options);
  let stopBridge: (() => void) | undefined;
  const stop = () => { stopBridge?.(); server.close(); server.closeAllConnections(); };
  server.once("error", (error: NodeJS.ErrnoException) => {
    console.error(JSON.stringify({ ok: false, code: "SERVER_FAILED", message: error.code || "Server failed" }));
    stop(); process.exitCode = 1;
  });
  if (bridge) stopBridge = serveBridge(server, bridge, () => ready({ ...(bridge.url ? { url: bridge.url } : {}), transport: bridge.transport }));
  else server.once("listening", () => {
    const address = server.address();
    if (address && typeof address !== "string") ready({ url: `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}` });
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
