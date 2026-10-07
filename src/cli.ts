#!/usr/bin/env -S npx tsx
import { parseArgs } from "node:util";
import { getBlock, getTipNumber, type RpcTransaction } from "./rpc.ts";
import { loadProjectScripts, loadSystemScripts } from "./scripts.ts";
import { Resolver } from "./resolver.ts";
import { Explorer } from "./explorer.ts";
import { startServer } from "./server.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    rpc: { type: "string", default: "http://127.0.0.1:8114" },
    project: { type: "string", multiple: true, default: [process.cwd()] },
    txs: { type: "string", default: "10" },
    port: { type: "string", default: "7070" },
  },
});

const url = values.rpc!;
const projects = values.project!;
const known = loadSystemScripts();
let projectCount = 0;
for (const dir of projects) {
  const scripts = loadProjectScripts(dir);
  projectCount += scripts.size;
  for (const [k, v] of scripts) known.set(k, v);
}
const resolver = new Resolver(known);

if (positionals[0] === "serve") {
  console.log(`known scripts: ${known.size - projectCount} genesis + ${projectCount} from projects`);
  startServer(new Explorer(url, resolver), Number(values.port), url, projects);
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
