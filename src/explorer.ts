import { getBlock, getTipNumber, rpc, type RpcOutput, type RpcScript, type RpcTransaction } from "./rpc.ts";
import { Resolver, type Resolved } from "./resolver.ts";

const ZERO_HASH = "0x" + "0".repeat(64);

export type ScriptView = RpcScript & { resolved: Resolved; bytes: number };
export type CellView = {
  capacity: string; // shannons, decimal string
  lock: ScriptView;
  type: ScriptView | null;
  dataLength: number;
  dataPreview: string; // hex, first 256 bytes
  occupied: number; // bytes, i.e. minimum CKB
  outPoint?: { txHash: string; index: number };
};
export type TxView = {
  hash: string;
  blockNumber: number | null;
  status: string;
  cellbase: boolean;
  inputs: (CellView | { unresolved: string })[];
  outputs: CellView[];
};

const scriptBytes = (s: RpcScript) => 32 + 1 + (s.args.length - 2) / 2;

// Devnet blocks never change once mined, until `offckb clean` wipes the chain.
// Cache by number and drop everything if the tip ever goes backwards.
export class Explorer {
  private blocks = new Map<number, Awaited<ReturnType<typeof getBlock>>>();
  private lastTip = -1;

  constructor(private url: string, private resolver: Resolver) {}

  async tip() {
    const tip = await getTipNumber(this.url);
    if (tip < this.lastTip) this.blocks.clear();
    this.lastTip = tip;
    return tip;
  }

  private async block(n: number) {
    if (!this.blocks.has(n)) this.blocks.set(n, await getBlock(this.url, n));
    return this.blocks.get(n)!;
  }

  async recentTransactions(limit: number, maxBlocks = 5000) {
    const tip = await this.tip();
    const found: { hash: string; blockNumber: number; outputs: number; timestamp: number }[] = [];
    for (let n = tip; n >= 0 && n > tip - maxBlocks && found.length < limit; n -= 50) {
      const numbers = Array.from({ length: Math.min(50, n + 1) }, (_, i) => n - i);
      const blocks = await Promise.all(numbers.map((b) => this.block(b)));
      for (const block of blocks) {
        if (!block) continue;
        for (const tx of block.transactions.slice(1)) {
          if (found.length >= limit) break;
          found.push({
            hash: tx.hash,
            blockNumber: Number(BigInt(block.header.number)),
            outputs: tx.outputs.length,
            timestamp: Number(BigInt((block.header as any).timestamp)),
          });
        }
      }
    }
    return { tip, transactions: found };
  }

  async transaction(hash: string): Promise<TxView | null> {
    const res = await rpc<{ transaction: RpcTransaction & { inputs: { previous_output: { tx_hash: string; index: string } }[] }; tx_status: { status: string; block_number: string | null } } | null>(
      this.url, "get_transaction", [hash]);
    if (!res?.transaction) return null;
    const tx = res.transaction;
    const cellbase = tx.inputs.length === 1 && tx.inputs[0].previous_output.tx_hash === ZERO_HASH;

    const inputs = await Promise.all(tx.inputs.map(async ({ previous_output: p }) => {
      if (p.tx_hash === ZERO_HASH) return { unresolved: "cellbase (newly mined CKB)" };
      const prev = await rpc<{ transaction: RpcTransaction } | null>(this.url, "get_transaction", [p.tx_hash]);
      const i = Number(BigInt(p.index));
      const out = prev?.transaction.outputs[i];
      if (!out) return { unresolved: `${p.tx_hash}:${i}` };
      return { ...this.cell(out, prev!.transaction.outputs_data[i]), outPoint: { txHash: p.tx_hash, index: i } };
    }));

    return {
      hash: tx.hash,
      blockNumber: res.tx_status.block_number ? Number(BigInt(res.tx_status.block_number)) : null,
      status: res.tx_status.status,
      cellbase,
      inputs,
      outputs: tx.outputs.map((o, i) => ({ ...this.cell(o, tx.outputs_data[i]), outPoint: { txHash: tx.hash, index: i } })),
    };
  }

  async blockTransactions(n: number) {
    const block = await this.block(n);
    if (!block) return null;
    return {
      number: n,
      hash: block.header.hash,
      transactions: block.transactions.map((t, i) => ({ hash: t.hash, cellbase: i === 0, outputs: t.outputs.length })),
    };
  }

  private cell(out: RpcOutput, data: string): CellView {
    const lock = { ...out.lock, resolved: this.resolver.resolve(out.lock), bytes: scriptBytes(out.lock) };
    const type = out.type ? { ...out.type, resolved: this.resolver.resolve(out.type), bytes: scriptBytes(out.type) } : null;
    const dataLength = (data.length - 2) / 2;
    return {
      capacity: BigInt(out.capacity).toString(),
      lock,
      type,
      dataLength,
      dataPreview: data.slice(0, 2 + 512),
      occupied: 8 + lock.bytes + (type?.bytes ?? 0) + dataLength,
    };
  }
}
