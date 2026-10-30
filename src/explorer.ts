import { ccc } from "@ckb-ccc/core";
import { getBlock, rpc, rpcBatch, type RpcBlock, type RpcOutput, type RpcScript, type RpcTransaction } from "./rpc.ts";
import { Resolver, type Resolved } from "./resolver.ts";
import { clusterData, dataHash, decodeByType, scriptHash, sporeContent, type Decoded } from "./decode.ts";
import { ChainIndex, parseCellbaseWitness, type BlockSummary, type TxSummary } from "./chain.ts";
import { decodeSince, difficultyOf, epochOf, parseWitness, type Since } from "./txfields.ts";
import type { KnownScript } from "./scripts.ts";
import { ACCOUNT_ROLES, MINER_ARGS, offckbAccounts } from "./accounts.ts";
import { FAUCET_ACCOUNT } from "./faucet.ts";
import { Tools } from "./tools.ts";

const ZERO_HASH = "0x" + "0".repeat(64);
const hex = (n: number | bigint) => "0x" + n.toString(16);
const num = (h: string) => Number(BigInt(h));

export type ScriptView = RpcScript & { resolved: Resolved; bytes: number; hash: string };
export type CellStatus = { state: "live" } | { state: "spent"; by: string | null } | { state: "pending" };
export type CellView = {
  capacity: string; // shannons, decimal string
  lock: ScriptView;
  type: ScriptView | null;
  address: string;
  dataLength: number;
  dataPreview: string; // hex, first 256 bytes
  dataHash: string | null;
  occupied: number; // bytes, i.e. minimum CKB
  decoded: Decoded | null;
  outPoint?: { txHash: string; index: number };
  status?: CellStatus;
  blockNumber?: number;
  since?: Since;
};
export type Unresolved = { unresolved: string };

type RpcInput = { previous_output: { tx_hash: string; index: string }; since: string };
type FullTx = RpcTransaction & {
  version: string;
  cell_deps: { out_point: { tx_hash: string; index: string }; dep_type: string }[];
  header_deps: string[];
  inputs: RpcInput[];
  witnesses: string[];
};
type FullHeader = {
  number: string; hash: string; parent_hash: string; timestamp: string; epoch: string; compact_target: string;
  nonce: string; version: string; transactions_root: string; proposals_hash: string; extra_hash: string; dao: string;
};
type FullBlock = { header: FullHeader; transactions: FullTx[]; proposals: string[]; uncles: { header: FullHeader }[] };
type TxStatus = { status: string; block_number: string | null; block_hash?: string | null; reason?: string | null };
type TxResponse = { transaction: FullTx | null; cycles?: string | null; tx_status: TxStatus };
type IndexerCell = { block_number: string; out_point: { tx_hash: string; index: string }; output: RpcOutput; output_data: string | null };
type SearchKey = Record<string, unknown>;
type GroupedTx = { tx_hash: string; block_number: string; cells: [string, string][] };
type PoolEntry = { cycles: string; size: string; fee: string; timestamp: string; ancestors_count: string };
type EconomicState = {
  issuance: { primary: string; secondary: string };
  miner_reward: { primary: string; secondary: string; committed: string; proposal: string };
  txs_fee: string;
  finalized_at: string;
};

// Just the script, without the extra fields a ScriptView carries.
const rpcScript = (s: RpcScript): RpcScript => ({ code_hash: s.code_hash, hash_type: s.hash_type, args: s.args });
const scriptBytes = (s: RpcScript) => 32 + 1 + (s.args.length - 2) / 2;
const toCcc = (s: RpcScript) => ccc.Script.from({ codeHash: s.code_hash, hashType: s.hash_type as ccc.HashType, args: s.args });
// Address encoding only needs the prefix, not a network connection.
const DEVNET_PREFIX = { addressPrefix: "ckt" } as unknown as ccc.Client;
const addressOf = (s: RpcScript) => ccc.Address.fromScript(toCcc(s), DEVNET_PREFIX).toString();

// Serialized size of a transaction as the node counts it for fees (the extra 4 bytes are its
// offset in the block). CCC can't take the RPC's snake_case JSON directly, hence the mapping.
function txSize(t: FullTx) {
  const s = (x: RpcScript | null) => x && { codeHash: x.code_hash, hashType: x.hash_type as ccc.HashType, args: x.args };
  return ccc.Transaction.from({
    version: t.version,
    cellDeps: t.cell_deps.map((d) => ({ outPoint: { txHash: d.out_point.tx_hash, index: d.out_point.index }, depType: d.dep_type === "dep_group" ? "depGroup" : "code" })),
    headerDeps: t.header_deps,
    inputs: t.inputs.map((i) => ({ previousOutput: { txHash: i.previous_output.tx_hash, index: i.previous_output.index }, since: i.since })),
    outputs: t.outputs.map((o) => ({ capacity: o.capacity, lock: s(o.lock)!, type: s(o.type) })),
    outputsData: t.outputs_data,
    witnesses: t.witnesses,
  }).toBytes().length + 4;
}

const page = <T>(all: T[], pageNo: number, size: number) => {
  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(1, pageNo), pages);
  // Newest first: page 1 is the end of the array.
  const end = total - (p - 1) * size;
  return { page: p, pages, size, total, items: all.slice(Math.max(0, end - size), end).reverse() };
};

export class Explorer {
  // Full blocks for detail pages. Small, since the index keeps the summaries.
  private blocks = new Map<number, RpcBlock | null>();
  private tags = new Map<string, string[]>();
  readonly index: ChainIndex;

  constructor(private url: string, private resolver: Resolver) {
    this.index = new ChainIndex(url, (b) => this.summarize(b as unknown as FullBlock), () => {
      this.blocks.clear();
      this.tags.clear();
      this.txs.clear();
      this.scriptHashes.clear();
    });
  }

  // Every lock and type script seen on the chain, by script hash, so search can take a lock
  // hash or type hash as the CKB Explorer does. Filled while the index reads each block.
  private scriptHashes = new Map<string, { script: RpcScript; role: "lock" | "type" }>();

  async tip() {
    await this.index.sync();
    return this.index.tip;
  }

  // Knowledge Size, as the CKB Explorer's banner calls it: CKBytes held by every live cell,
  // i.e. the chain's state. The tip header's DAO field packs four u64s (C, AR, S, U); U is
  // the total occupied capacity in shannons.
  //
  // Like mainnet, offckb's devnet genesis has an 8.4 billion CKB cell of which 60% is counted
  // as occupied because it's expected to be burnt. The CKB Explorer subtracts that 5.04 billion
  // (talk.nervos.org/t/7138), so we do the same whenever this chain's genesis has that cell.
  burnt: bigint | null = null;
  async knowledgeSize() {
    if (this.burnt === null) {
      const genesis = await getBlock(this.url, 0);
      const has = genesis?.transactions[0]?.outputs.some((o) => BigInt(o.capacity) === 8_400_000_000n * 100_000_000n);
      this.burnt = has ? 5_040_000_000n * 100_000_000n : 0n;
    }
    const header = await rpc<{ dao: string; number: string }>(this.url, "get_tip_header");
    const u = Buffer.from(header.dao.slice(2), "hex").readBigUInt64LE(24) - this.burnt;
    return { bytes: Number(u / 100_000_000n), block: num(header.number) };
  }

  // Whether offckb's test account list could be read (it can't inside offckb's plugin sandbox).
  hasAccounts() {
    return !!offckbAccounts();
  }

  // The CKB version the devnet node runs, e.g. "0.208.0 (585395c 2026-07-14)".
  private version: string | null = null;
  async nodeVersion() {
    this.version ??= (await rpc<{ version: string }>(this.url, "local_node_info")).version;
    return this.version;
  }

  private async block(n: number) {
    if (!this.blocks.has(n)) {
      if (this.blocks.size > 500) this.blocks.delete(this.blocks.keys().next().value!);
      this.blocks.set(n, await getBlock(this.url, n));
    }
    return this.blocks.get(n)!;
  }

  private timestampOf(block: RpcBlock) {
    return num((block.header as unknown as { timestamp: string }).timestamp);
  }

  private summarize(b: FullBlock): { block: BlockSummary; txs: TxSummary[] } {
    for (const t of b.transactions)
      for (const o of t.outputs)
        for (const [role, sc] of [["lock", o.lock], ["type", o.type]] as const) {
          if (!sc) continue;
          const h = scriptHash(sc);
          if (!this.scriptHashes.has(h)) this.scriptHashes.set(h, { script: rpcScript(sc), role });
        }
    const number = num(b.header.number);
    const timestamp = num(b.header.timestamp);
    const consumed = b.transactions.slice(1).reduce((a, t) => a + t.inputs.length, 0);
    const created = b.transactions.reduce((a, t) => a + t.outputs.length, 0);
    return {
      block: {
        number, hash: b.header.hash, timestamp, txs: b.transactions.length - 1,
        miner: parseCellbaseWitness(b.transactions[0]?.witnesses[0])?.lock ?? null,
        liveCellsChange: created - consumed,
      },
      txs: b.transactions.slice(1).map((t) => ({
        hash: t.hash, blockNumber: number, timestamp, inputs: t.inputs.length, outputs: t.outputs.length,
        capacity: t.outputs.reduce((a, o) => a + BigInt(o.capacity), 0n).toString(),
        tags: this.tagsFor(t),
      })),
    };
  }

  // ---- home -----------------------------------------------------------------------------

  async home() {
    const tip = await this.tip();
    const recent = this.index.blocks.slice(-21).reverse();
    // Median, not mean: the devnet only mines while `offckb node` runs, so the gap across a
    // restart would otherwise swamp the real block time.
    const gaps = recent.slice(1).map((b, i) => recent[i].timestamp - b.timestamp).sort((a, b) => a - b);
    const [info, epoch, pool, scripts] = await Promise.all([
      rpc<{ chain: string; difficulty: string }>(this.url, "get_blockchain_info"),
      rpc<{ number: string; start_number: string; length: string }>(this.url, "get_current_epoch"),
      rpc<{ pending: string; proposed: string; min_fee_rate: string }>(this.url, "tx_pool_info"),
      Promise.all(this.resolver.all().filter((s) => s.source !== "genesis").map((s) => this.scriptSummary(s))),
    ]);
    return {
      chain: info.chain,
      tip,
      tipTimestamp: recent[0]?.timestamp ?? null,
      blockTime: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null,
      epoch: { number: num(epoch.number), index: tip - num(epoch.start_number), length: num(epoch.length) },
      difficulty: BigInt(info.difficulty).toString(),
      transactionCount: this.index.txs.length,
      pool: { pending: num(pool.pending), proposed: num(pool.proposed), minFeeRate: num(pool.min_fee_rate) },
      knownScripts: { genesis: this.resolver.all().filter((s) => s.source === "genesis").length, project: scripts.length },
      blocks: recent.slice(0, 10).map((b) => this.blockRow(b)),
      transactions: this.index.txs.slice(-10).reverse(),
      scripts,
      resets: this.index.resets,
      charts: this.chartData(),
    };
  }

  // Two series for the home charts: seconds between each of the last 100 blocks, and how many
  // transactions landed in each of up to 40 equal stretches of the chain's history.
  private chartData() {
    const blocks = this.index.blocks;
    const last = blocks.slice(-101);
    const blockTimes = last.slice(1).map((b, i) => ({ n: b.number, s: Math.max(0, b.timestamp - last[i].timestamp) / 1000 }));
    // Genesis has timestamp 0, so the first real interval would be decades long.
    if (blockTimes[0]?.n === 1) blockTimes.shift();
    const buckets = Math.min(40, blocks.length);
    const per = Math.ceil(blocks.length / buckets);
    const activity = [];
    for (let from = 0; from < blocks.length; from += per) {
      const slice = blocks.slice(from, from + per);
      activity.push({ from, to: from + slice.length - 1, txs: slice.reduce((a, b) => a + b.txs, 0), start: slice[0].timestamp, end: slice.at(-1)!.timestamp });
    }
    return { blockTimes, activity };
  }

  // A project script is only usable if the cell its deployment points at is still live.
  // After `offckb clean` the deployment file still lists it, but the chain doesn't have it.
  private async scriptSummary(s: KnownScript) {
    const deployed = s.location ? (await this.liveState(s.location.txHash, s.location.index)) === "live" : false;
    const [asType, asLock] = await Promise.all([this.countCells(s, "type"), this.countCells(s, "lock")]);
    return { name: s.name, source: s.source, codeHash: s.codeHash, hashType: s.hashType, location: s.location, deployed, asType, asLock };
  }

  // ---- lists ----------------------------------------------------------------------------

  private blockRow(b: BlockSummary) {
    return { ...b, miner: b.miner ? addressOf(b.miner) : null };
  }

  async blockList(pageNo: number, size: number) {
    await this.tip();
    const p = page(this.index.blocks, pageNo, size);
    // Rewards are only known once a block is finalized, 11 blocks later on a devnet.
    const states = await rpcBatch<EconomicState | null>(this.url, p.items.map((b) => ["get_block_economic_state", [b.hash]]));
    return {
      ...p,
      items: p.items.map((b, i) => ({ ...this.blockRow(b), reward: states[i] ? minerReward(states[i]!).toString() : null })),
    };
  }

  async transactionList(pageNo: number, size: number) {
    await this.tip();
    return page(this.index.txs, pageNo, size);
  }

  // Transactions the node has accepted but not yet put in a block.
  async pool() {
    const [info, raw] = await Promise.all([
      rpc<{ pending: string; proposed: string; orphan: string; min_fee_rate: string; total_tx_size: string; total_tx_cycles: string }>(this.url, "tx_pool_info"),
      rpc<{ pending: Record<string, PoolEntry>; proposed: Record<string, PoolEntry> }>(this.url, "get_raw_tx_pool", [true]),
    ]);
    const entries = [
      ...Object.entries(raw.pending).map(([hash, e]) => ({ hash, status: "pending", e })),
      ...Object.entries(raw.proposed).map(([hash, e]) => ({ hash, status: "proposed", e })),
    ];
    const txs = await Promise.all(entries.map(({ hash }) => rpc<TxResponse | null>(this.url, "get_transaction", [hash])));
    return {
      info: {
        pending: num(info.pending), proposed: num(info.proposed), orphan: num(info.orphan),
        minFeeRate: num(info.min_fee_rate), totalSize: num(info.total_tx_size), totalCycles: num(info.total_tx_cycles),
      },
      transactions: entries.map(({ hash, status, e }, i) => {
        const t = txs[i]?.transaction;
        const size = num(e.size);
        return {
          hash, status, fee: BigInt(e.fee).toString(), size, cycles: num(e.cycles), timestamp: num(e.timestamp),
          feeRate: size ? Number((BigInt(e.fee) * 1000n) / BigInt(size)) : null,
          inputs: t?.inputs.length ?? null, outputs: t?.outputs.length ?? null, tags: t ? this.tagsFor(t) : [],
        };
      }).sort((a, b) => b.timestamp - a.timestamp),
    };
  }

  // ---- transaction ----------------------------------------------------------------------

  async transaction(hash: string) {
    const tip = await this.tip();
    const res = await rpc<TxResponse | null>(this.url, "get_transaction", [hash]);
    if (!res) return null;
    // The node remembers recently rejected transactions and why, but not their contents.
    if (!res.transaction) {
      if (res.tx_status.status === "rejected") return { hash, status: "rejected", reason: res.tx_status.reason ?? null, rejected: true };
      return null;
    }
    const tx = res.transaction;
    const blockNumber = res.tx_status.block_number ? num(res.tx_status.block_number) : null;
    const block = blockNumber !== null ? await this.block(blockNumber) : null;
    const cellbase = tx.inputs.length === 1 && tx.inputs[0].previous_output.tx_hash === ZERO_HASH;

    const inputs: (CellView | Unresolved)[] = await Promise.all(tx.inputs.map(async ({ previous_output: p, since }) => {
      if (p.tx_hash === ZERO_HASH) return { unresolved: "Cellbase: newly mined CKB, no input cell" };
      const prev = await rpc<TxResponse | null>(this.url, "get_transaction", [p.tx_hash]);
      const i = num(p.index);
      const out = prev?.transaction?.outputs[i];
      if (!out) return { unresolved: `${p.tx_hash}:${i}` };
      return { ...this.cell(out, prev!.transaction!.outputs_data[i]), outPoint: { txHash: p.tx_hash, index: i }, since: decodeSince(since) };
    }));

    const outputs = await Promise.all(tx.outputs.map(async (o, i) => {
      const outPoint = { txHash: tx.hash, index: i };
      return { ...this.cell(o, tx.outputs_data[i]), outPoint, status: await this.status(outPoint, o.lock, blockNumber) };
    }));

    const resolvedInputs = inputs.filter((c): c is CellView => "capacity" in c);
    const fee = !cellbase && resolvedInputs.length === inputs.length
      ? resolvedInputs.reduce((a, c) => a + BigInt(c.capacity), 0n) - outputs.reduce((a, c) => a + BigInt(c.capacity), 0n)
      : null;
    const size = txSize(tx);

    return {
      hash: tx.hash,
      blockNumber,
      blockHash: block?.header.hash ?? null,
      timestamp: block ? this.timestampOf(block) : null,
      confirmations: blockNumber !== null ? tip - blockNumber : null,
      status: res.tx_status.status,
      cellbase,
      version: num(tx.version),
      fee: fee?.toString() ?? null,
      size,
      // Same unit the node's min fee rate uses: shannons per 1000 bytes.
      feeRate: fee !== null ? Number((fee * 1000n) / BigInt(size)) : null,
      cycles: res.cycles ? num(res.cycles) : null,
      cellDeps: tx.cell_deps.map((d) => {
        const txHash = d.out_point.tx_hash;
        const index = num(d.out_point.index);
        const provides = this.resolver.all().filter((s) => s.location?.txHash === txHash && s.location.index === index);
        return { txHash, index, depType: d.dep_type, provides: provides.map((s) => ({ name: s.name, source: s.source, codeHash: s.codeHash, hashType: s.hashType })) };
      }),
      headerDeps: await Promise.all(tx.header_deps.map(async (h) => {
        const header = await rpc<{ number: string } | null>(this.url, "get_header", [h]);
        return { hash: h, number: header ? num(header.number) : null };
      })),
      witnesses: tx.witnesses.map(parseWitness),
      changes: cellbase ? [] : balanceChanges(resolvedInputs, outputs),
      inputs,
      outputs,
    };
  }

  // The transaction exactly as the node returns it, for copying or saving.
  async rawTransaction(hash: string) {
    const res = await rpc<TxResponse | null>(this.url, "get_transaction", [hash]);
    return res?.transaction ?? null;
  }

  // ---- block ----------------------------------------------------------------------------

  async blockDetail(id: string) {
    const tip = await this.tip();
    const hash = /^0x[0-9a-f]{64}$/i.test(id) ? id.toLowerCase() : Number(id) <= tip ? this.index.blocks[Number(id)]?.hash : null;
    if (!hash) return null;
    const [withCycles, packed, state] = await rpcBatch<unknown>(this.url, [
      ["get_block", [hash, null, true]],
      ["get_block", [hash, "0x0"]],
      ["get_block_economic_state", [hash]],
    ]) as [{ block: FullBlock; cycles: string[] | null } | null, string | null, EconomicState | null];
    if (!withCycles) return null;
    const b = withCycles.block;
    const h = b.header;
    const n = num(h.number);
    const cellbase = parseCellbaseWitness(b.transactions[0]?.witnesses[0]);
    const reward = state && {
      total: minerReward(state).toString(),
      base: BigInt(state.miner_reward.primary).toString(),
      secondary: BigInt(state.miner_reward.secondary).toString(),
      committed: BigInt(state.miner_reward.committed).toString(),
      proposal: BigInt(state.miner_reward.proposal).toString(),
      fees: BigInt(state.txs_fee).toString(),
    };
    const cycles = withCycles.cycles ?? [];
    return {
      number: n,
      hash: h.hash,
      parentHash: h.parent_hash,
      timestamp: num(h.timestamp),
      epoch: epochOf(h.epoch),
      confirmations: tip - n,
      tip,
      miner: cellbase ? addressOf(cellbase.lock) : null,
      minerMessage: cellbase?.message || null,
      reward,
      finalizedIn: reward ? null : Math.max(0, n + 11 - tip),
      difficulty: difficultyOf(h.compact_target).toString(),
      nonce: BigInt(h.nonce).toString(),
      size: packed ? (packed.length - 2) / 2 : null,
      cycles: cycles.reduce((a, c) => a + num(c), 0),
      proposals: b.proposals,
      uncles: b.uncles.map((u) => ({ hash: u.header.hash, number: num(u.header.number) })),
      header: h,
      transactions: b.transactions.map((t, i) => ({
        hash: t.hash,
        cellbase: i === 0,
        inputs: i === 0 ? 0 : t.inputs.length,
        outputs: t.outputs.length,
        capacity: t.outputs.reduce((a, o) => a + BigInt(o.capacity), 0n).toString(),
        cycles: i === 0 ? null : cycles[i - 1] ? num(cycles[i - 1]) : null,
        tags: i === 0 ? [] : this.tagsFor(t),
      })),
    };
  }

  // ---- indexer helpers ------------------------------------------------------------------

  // Everything the built-in indexer has for a search key, newest first, 1,000 per request.
  // A devnet is small enough to read whole, which gives exact totals and real pagination.
  private async indexerAll<T>(method: "get_cells" | "get_transactions", key: SearchKey, max = 50_000): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    while (out.length < max) {
      const params: unknown[] = [key, "desc", "0x3e8"];
      if (cursor) params.push(cursor);
      const res = await rpc<{ objects: T[]; last_cursor: string }>(this.url, method, params);
      out.push(...res.objects);
      if (res.objects.length < 1000) break;
      cursor = res.last_cursor;
    }
    return out;
  }

  // Committed transactions never change, so they're cached (until a chain reset).
  private txs = new Map<string, FullTx>();
  private async fullTx(hash: string): Promise<FullTx | null> {
    if (!this.txs.has(hash)) {
      const res = await rpc<TxResponse | null>(this.url, "get_transaction", [hash]);
      if (!res?.transaction || res.tx_status.status !== "committed") return res?.transaction ?? null;
      if (this.txs.size > 5000) this.txs.delete(this.txs.keys().next().value!);
      this.txs.set(hash, res.transaction);
    }
    return this.txs.get(hash)!;
  }

  // How much CKB a lock gained or lost in one transaction: its outputs minus the inputs it spent.
  private async lockChange(t: GroupedTx): Promise<bigint> {
    const tx = await this.fullTx(t.tx_hash);
    if (!tx) return 0n;
    let change = 0n;
    for (const [io, index] of t.cells) {
      const i = num(index);
      if (io === "output") change += BigInt(tx.outputs[i].capacity);
      else {
        const prev = tx.inputs[i].previous_output;
        const src = await this.fullTx(prev.tx_hash);
        if (src) change -= BigInt(src.outputs[num(prev.index)].capacity);
      }
    }
    return change;
  }

  private txRow(t: GroupedTx) {
    const n = num(t.block_number);
    return { hash: t.tx_hash, blockNumber: n, timestamp: this.index.blocks[n]?.timestamp ?? null };
  }

  // ---- address --------------------------------------------------------------------------

  async address(address: string, tab: string, pageNo: number, size: number) {
    const tip = await this.tip();
    const parsed = await ccc.Address.fromString(address, DEVNET_PREFIX);
    const lock: RpcScript = { code_hash: parsed.script.codeHash, hash_type: parsed.script.hashType, args: parsed.script.args };
    const key = { script: lock, script_type: "lock" };

    const [capacity, rawCells, rawTxs] = await Promise.all([
      rpc<{ capacity: string } | null>(this.url, "get_cells_capacity", [key]),
      this.indexerAll<IndexerCell>("get_cells", key),
      this.indexerAll<GroupedTx>("get_transactions", { ...key, group_by_transaction: true }),
    ]);
    const cells = rawCells.map((c) => this.indexerCell(c, { state: "live" }));

    // Token balances: sum every UDT cell this address holds, per token (its type script).
    const tokens = new Map<string, { standard: string; owner: string; amount: bigint; cells: number; type: ScriptView }>();
    let daoDeposited = 0n;
    let daoWithdrawing = 0n;
    for (const c of cells) {
      if (c.decoded?.kind === "dao-deposit") daoDeposited += BigInt(c.capacity);
      if (c.decoded?.kind === "dao-withdrawing") daoWithdrawing += BigInt(c.capacity);
      if (c.decoded?.kind !== "udt" || !c.type) continue;
      const t = tokens.get(c.type.hash) ?? { standard: c.decoded.standard, owner: c.decoded.owner, amount: 0n, cells: 0, type: c.type };
      t.amount += BigInt(c.decoded.amount);
      t.cells += 1;
      tokens.set(c.type.hash, t);
    }
    const sameLock = (s: RpcScript | null) => !!s && s.code_hash === lock.code_hash && s.hash_type === lock.hash_type && s.args === lock.args;

    let list: unknown = null;
    if (tab === "cells") {
      list = page(cells.slice().reverse(), pageNo, size);
    } else if (tab === "tokens") {
      list = [...tokens.values()].map((t) => ({ ...t, amount: t.amount.toString() }));
    } else {
      const p = page(rawTxs.slice().reverse(), pageNo, size);
      list = { ...p, items: await Promise.all(p.items.map(async (t) => ({ ...this.txRow(t), change: (await this.lockChange(t)).toString() }))) };
    }

    return {
      address: parsed.toString(),
      lock: { ...lock, resolved: this.resolver.resolve(lock), bytes: scriptBytes(lock), hash: scriptHash(lock) },
      balance: capacity ? BigInt(capacity.capacity).toString() : "0",
      occupied: cells.reduce((a, c) => a + c.occupied, 0),
      daoDeposited: daoDeposited.toString(),
      daoWithdrawing: daoWithdrawing.toString(),
      blocksMined: this.index.blocks.filter((b) => sameLock(b.miner)).length,
      account: (() => {
        const a = offckbAccounts()?.find((x) => x.address === parsed.toString());
        if (a) return { index: a.index, role: a.index === FAUCET_ACCOUNT ? "funds this explorer's faucet" : ACCOUNT_ROLES[a.index] ?? null };
        return lock.args === MINER_ARGS ? { index: null, role: "the devnet miner: block rewards are paid here" } : null;
      })(),
      counts: { transactions: rawTxs.length, cells: cells.length, tokens: tokens.size },
      tab: tab === "cells" || tab === "tokens" ? tab : "transactions",
      list,
      tip,
    };
  }

  // ---- script ---------------------------------------------------------------------------

  async script(codeHash: string, hashType: string, tab: string, pageNo: number, size: number) {
    await this.tip();
    const known = this.resolver.lookup(codeHash, hashType);
    const script: RpcScript = { code_hash: codeHash.toLowerCase(), hash_type: hashType, args: "0x" };
    // JS contracts are found twice over: as themselves and behind ckb_js_vm.
    const prefixes = this.resolver.usagePrefixes({ codeHash: script.code_hash, hashType });
    const search = (role: "type" | "lock") => prefixes.map((prefix) => ({ script: prefix, script_type: role, script_search_mode: "prefix" }));

    const [asType, asLock] = await Promise.all((["type", "lock"] as const).map(async (role) =>
      (await Promise.all(search(role).map((k) => this.indexerAll<IndexerCell>("get_cells", { ...k, with_data: false })))).flat()));
    const txs = new Map<string, GroupedTx>();
    for (const list of await Promise.all([...search("type"), ...search("lock")].map((k) => this.indexerAll<GroupedTx>("get_transactions", { ...k, group_by_transaction: true }))))
      for (const t of list) txs.set(t.tx_hash, t);
    const allTxs = [...txs.values()].sort((a, b) => num(a.block_number) - num(b.block_number));

    const location = known?.location ?? null;
    const locationLive = location ? (await this.liveState(location.txHash, location.index)) === "live" : null;
    const capacityOf = (cells: IndexerCell[]) => cells.reduce((a, c) => a + BigInt(c.output.capacity), 0n).toString();

    // Cells were listed without data (faster for big locks); fetch it for the page shown.
    const cellPage = async (cells: IndexerCell[]) => {
      const p = page(cells.slice().reverse(), pageNo, size);
      const items = await Promise.all(p.items.map(async (c) => {
        const tx = await this.fullTx(c.out_point.tx_hash);
        const data = tx?.outputs_data[num(c.out_point.index)] ?? "0x";
        return this.indexerCell({ ...c, output_data: data }, { state: "live" });
      }));
      return { ...p, items };
    };

    let list: unknown = null;
    const which = ["type", "lock", "transactions", "code"].includes(tab) ? tab : asType.length || !asLock.length ? "type" : "lock";
    if (which === "type") list = await cellPage(asType);
    else if (which === "lock") list = await cellPage(asLock);
    else if (which === "transactions") list = page(allTxs, pageNo, size);
    else if (location) {
      const tx = await this.fullTx(location.txHash);
      const out = tx?.outputs[location.index];
      list = out ? { ...this.cell(out, tx!.outputs_data[location.index]), outPoint: location, status: locationLive ? { state: "live" } : { state: "spent", by: null } } : null;
    }
    if (which === "transactions") {
      const p = list as ReturnType<typeof page<GroupedTx>>;
      list = { ...p, items: p.items.map((t) => this.txRow(t)) };
    }

    return {
      codeHash: script.code_hash,
      hashType,
      name: known?.name ?? null,
      source: known?.source ?? null,
      location,
      locationLive,
      counts: { type: asType.length, lock: asLock.length, transactions: allTxs.length },
      capacity: { type: capacityOf(asType), lock: capacityOf(asLock) },
      tab: which,
      list,
    };
  }

  // ---- scripts and accounts -------------------------------------------------------------

  async scripts() {
    await this.tip();
    const all = await Promise.all(this.resolver.all().map(async (s) => ({
      name: s.name,
      source: s.source,
      codeHash: s.codeHash,
      hashType: s.hashType,
      location: s.location,
      live: s.location ? (await this.liveState(s.location.txHash, s.location.index)) === "live" : null,
      asType: await this.countCells(s, "type"),
      asLock: await this.countCells(s, "lock"),
    })));
    // Your projects first, then genesis, each by name.
    return all.sort((a, b) => Number(a.source === "genesis") - Number(b.source === "genesis") || a.name.localeCompare(b.name));
  }

  async accounts() {
    await this.tip();
    const list = offckbAccounts();
    if (!list) return { available: false, accounts: [] };
    const accounts = await Promise.all(list.map(async (a) => {
      const parsed = (await ccc.Address.fromString(a.address, DEVNET_PREFIX)).script;
      const lock = { code_hash: parsed.codeHash, hash_type: parsed.hashType, args: parsed.args };
      const key = { script: lock, script_type: "lock" };
      const [capacity, cells, txs] = await Promise.all([
        rpc<{ capacity: string } | null>(this.url, "get_cells_capacity", [key]),
        this.indexerAll<unknown>("get_cells", { ...key, with_data: false }),
        this.indexerAll<unknown>("get_transactions", { ...key, group_by_transaction: true }),
      ]);
      const role = a.index === FAUCET_ACCOUNT ? "Funds this explorer's faucet" : ACCOUNT_ROLES[a.index] ?? null;
      return { index: a.index, role, address: a.address, balance: capacity ? BigInt(capacity.capacity).toString() : "0", cells: cells.length, transactions: txs.length };
    }));
    return { available: true, faucet: FAUCET_ACCOUNT, accounts };
  }

  // ---- tokens (sUDT / xUDT) -------------------------------------------------------------

  // Every live sUDT and xUDT cell on the chain, grouped by token (its full type script).
  private async udtTokens() {
    const scripts = this.resolver.all().filter((s) => s.name === "sudt" || s.name === "xudt");
    const cells = (await Promise.all(scripts.map((s) => this.indexerAll<IndexerCell>("get_cells", {
      script: { code_hash: s.codeHash, hash_type: s.hashType, args: "0x" }, script_type: "type", script_search_mode: "prefix",
    })))).flat().map((c) => this.indexerCell(c, { state: "live" }));
    type Token = { type: ScriptView; standard: string; owner: string; supply: bigint; cells: CellView[]; holders: Map<string, bigint> };
    const tokens = new Map<string, Token>();
    for (const c of cells) {
      if (c.decoded?.kind !== "udt" || !c.type) continue;
      const t: Token = tokens.get(c.type.hash) ?? { type: c.type, standard: c.decoded.standard, owner: c.decoded.owner, supply: 0n, cells: [], holders: new Map() };
      const amount = BigInt(c.decoded.amount);
      t.supply += amount;
      t.cells.push(c);
      t.holders.set(c.address, (t.holders.get(c.address) ?? 0n) + amount);
      tokens.set(c.type.hash, t);
    }
    return tokens;
  }

  // The issuer of a UDT is a lock hash; name it when it's one of offckb's accounts.
  private issuerOf(ownerLockHash: string) {
    for (const a of offckbAccounts() ?? []) {
      const secp = this.resolver.all().find((x) => x.name === "secp256k1_blake160_sighash_all");
      if (!secp) return null;
      const lock = { code_hash: secp.codeHash, hash_type: secp.hashType, args: a.args };
      if (scriptHash(lock) === ownerLockHash) return { address: a.address, account: a.index };
    }
    return null;
  }

  async tokens() {
    await this.tip();
    const tokens = await this.udtTokens();
    const list = await Promise.all([...tokens.entries()].map(async ([hash, t]) => {
      const txs = await this.indexerAll<GroupedTx>("get_transactions", { script: rpcScript(t.type), script_type: "type", script_search_mode: "exact", group_by_transaction: true });
      return {
        hash, standard: t.standard, type: t.type, owner: t.owner, issuer: this.issuerOf(t.owner),
        supply: t.supply.toString(), holders: [...t.holders.values()].filter((v) => v > 0n).length, cells: t.cells.length,
        transactions: txs.length, created: txs.length ? this.txRow(txs.at(-1)!) : null,
      };
    }));
    return list.sort((a, b) => b.holders - a.holders || b.transactions - a.transactions);
  }

  async token(hash: string, tab: string, pageNo: number, size: number) {
    await this.tip();
    const t = (await this.udtTokens()).get(hash.toLowerCase());
    if (!t) return null;
    const txs = await this.indexerAll<GroupedTx>("get_transactions", { script: rpcScript(t.type), script_type: "type", script_search_mode: "exact", group_by_transaction: true });
    const holders = [...t.holders.entries()].filter(([, v]) => v > 0n).sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));
    const which = tab === "transactions" ? "transactions" : "holders";
    const list = which === "holders"
      ? (() => {
        // Holders are ranked, so page 1 is the top of the list (page() expects oldest first).
        const p = page(holders.slice().reverse(), pageNo, size);
        return { ...p, items: p.items.map(([address, amount]) => ({ address, amount: amount.toString(), share: t.supply ? Number((amount * 10000n) / t.supply) / 100 : 0 })) };
      })()
      : (() => { const p = page(txs.slice().reverse(), pageNo, size); return { ...p, items: p.items.map((x) => this.txRow(x)) }; })();
    return {
      hash: hash.toLowerCase(), standard: t.standard, type: t.type, owner: t.owner, issuer: this.issuerOf(t.owner),
      supply: t.supply.toString(), holders: holders.length, cells: t.cells.length, transactions: txs.length,
      created: txs.length ? this.txRow(txs.at(-1)!) : null, tab: which, list,
    };
  }

  // ---- NFTs (Spore) ---------------------------------------------------------------------

  private async sporeCells(name: "spore" | "spore_cluster") {
    const scripts = this.resolver.all().filter((s) => s.name === name);
    return (await Promise.all(scripts.map((s) => this.indexerAll<IndexerCell>("get_cells", {
      script: { code_hash: s.codeHash, hash_type: s.hashType, args: "0x" }, script_type: "type", script_search_mode: "prefix",
    })))).flat();
  }

  private sporeView(c: IndexerCell) {
    const content = sporeContent(c.output_data ?? "0x");
    const cell = this.indexerCell(c, { state: "live" });
    return {
      id: c.output.type!.args,
      owner: cell.address,
      contentType: content?.contentType ?? "unknown",
      size: content?.bytes.length ?? 0,
      text: content && /^(text\/|application\/json)/.test(content.contentType) ? new TextDecoder().decode(content.bytes.slice(0, 600)) : null,
      clusterId: content?.clusterId ?? null,
      capacity: cell.capacity,
      blockNumber: num(c.block_number),
      outPoint: cell.outPoint,
    };
  }

  async nfts() {
    await this.tip();
    const [clusterCells, sporeCellList] = await Promise.all([this.sporeCells("spore_cluster"), this.sporeCells("spore")]);
    const spores = sporeCellList.map((c) => this.sporeView(c));
    const clusters = clusterCells.map((c) => {
      const data = clusterData(c.output_data ?? "0x");
      const id = c.output.type!.args;
      return {
        id, name: data?.name ?? "Unnamed cluster", description: data?.description ?? "",
        owner: this.indexerCell(c, { state: "live" }).address, blockNumber: num(c.block_number),
        spores: spores.filter((s) => s.clusterId === id).length,
      };
    });
    return {
      clusters: clusters.sort((a, b) => b.blockNumber - a.blockNumber),
      spores: spores.sort((a, b) => b.blockNumber - a.blockNumber),
    };
  }

  // A spore and its history: minted, transferred (its cell is consumed and recreated), melted.
  async spore(id: string) {
    await this.tip();
    const all = await this.sporeCells("spore");
    const cell = all.find((c) => c.output.type!.args === id.toLowerCase());
    const sporeScript = this.resolver.all().find((s) => s.name === "spore");
    const type = cell?.output.type ?? (sporeScript ? { code_hash: sporeScript.codeHash, hash_type: sporeScript.hashType, args: id.toLowerCase() } : null);
    if (!type) return null;
    const txs = await this.indexerAll<GroupedTx>("get_transactions", { script: type, script_type: "type", script_search_mode: "exact", group_by_transaction: true });
    if (!cell && !txs.length) return null;
    const history = txs.slice().reverse().map((t) => {
      const ins = t.cells.some(([io]) => io === "input");
      const outs = t.cells.some(([io]) => io === "output");
      return { ...this.txRow(t), event: ins && outs ? "Transferred" : outs ? "Minted" : "Melted" };
    });
    return { id: id.toLowerCase(), live: !!cell, spore: cell ? this.sporeView(cell) : null, history };
  }

  // The raw bytes, for <img>. The server only serves image types, with a sandboxing CSP.
  async sporeContentOf(id: string) {
    const cell = (await this.sporeCells("spore")).find((c) => c.output.type!.args === id.toLowerCase());
    return cell ? sporeContent(cell.output_data ?? "0x") : null;
  }

  // ---- Nervos DAO -----------------------------------------------------------------------

  // AR, the DAO's accumulated rate, is the second u64 of a header's DAO field (RFC 0023).
  private async header(n: number) {
    const h = await rpc<{ dao: string; epoch: string; number: string }>(this.url, "get_header_by_number", [hex(n)]);
    return { ar: Buffer.from(h.dao.slice(2), "hex").readBigUInt64LE(8), epoch: epochOf(h.epoch) };
  }

  async dao(tab: string, pageNo: number, size: number) {
    const tip = await this.tip();
    const daoScript = this.resolver.all().find((s) => s.name === "dao");
    if (!daoScript) return null;
    const type = { code_hash: daoScript.codeHash, hash_type: daoScript.hashType, args: "0x" };
    const [raw, txs, tipHeader] = await Promise.all([
      this.indexerAll<IndexerCell>("get_cells", { script: type, script_type: "type", script_search_mode: "exact" }),
      this.indexerAll<GroupedTx>("get_transactions", { script: type, script_type: "type", script_search_mode: "exact", group_by_transaction: true }),
      this.header(tip),
    ]);

    // Compensation (RFC 0023): the capacity that isn't occupied grows with AR, so a deposit
    // made at AR_d is worth free * AR_now / AR_d + occupied. A withdrawing cell stops at the AR
    // of the block that requested the withdrawal. Withdrawal completes once a whole number of
    // 180-epoch cycles has passed since the deposit.
    const cells = await Promise.all(raw.map(async (c) => {
      const cell = this.indexerCell(c, { state: "live" });
      const withdrawing = cell.decoded?.kind === "dao-withdrawing";
      const depositBlock = withdrawing && cell.decoded?.kind === "dao-withdrawing" ? cell.decoded.depositBlock : num(c.block_number);
      const [dep, end] = await Promise.all([this.header(depositBlock), withdrawing ? this.header(num(c.block_number)) : Promise.resolve(tipHeader)]);
      const capacity = BigInt(cell.capacity);
      const free = capacity - BigInt(cell.occupied) * 100_000_000n;
      const compensation = free > 0n ? (free * end.ar) / dep.ar - free : 0n;
      let unlock: { number: number; index: number; length: number } | null = null;
      if (withdrawing) {
        const frac = (e: { number: number; index: number; length: number }) => e.number + (e.length ? e.index / e.length : 0);
        const cycles = Math.max(1, Math.ceil((frac(end.epoch) - frac(dep.epoch)) / 180));
        unlock = { number: dep.epoch.number + cycles * 180, index: dep.epoch.index, length: dep.epoch.length };
      }
      return {
        address: cell.address, capacity: capacity.toString(), status: withdrawing ? "withdrawing" : "deposited",
        depositBlock, blockNumber: num(c.block_number), compensation: compensation.toString(), unlock, outPoint: cell.outPoint,
      };
    }));

    const sum = (f: (c: (typeof cells)[number]) => boolean) => cells.filter(f).reduce((a, c) => a + BigInt(c.capacity), 0n).toString();
    const byAddress = new Map<string, { address: string; deposited: bigint; compensation: bigint; cells: number }>();
    for (const c of cells) {
      const d = byAddress.get(c.address) ?? { address: c.address, deposited: 0n, compensation: 0n, cells: 0 };
      d.deposited += BigInt(c.capacity);
      d.compensation += BigInt(c.compensation);
      d.cells++;
      byAddress.set(c.address, d);
    }
    const depositors = [...byAddress.values()].sort((a, b) => (b.deposited > a.deposited ? 1 : -1))
      .map((d) => ({ ...d, deposited: d.deposited.toString(), compensation: d.compensation.toString() }));

    // How long 180 epochs takes on this devnet, from its own block time and epoch length.
    const recent = this.index.blocks.slice(-21);
    const gaps = recent.slice(1).map((b, i) => b.timestamp - recent[i].timestamp).sort((a, b) => a - b);
    const blockMs = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;

    const which = tab === "depositors" || tab === "transactions" ? tab : "deposits";
    let list: unknown;
    if (which === "deposits") list = page(cells.slice().sort((a, b) => a.blockNumber - b.blockNumber), pageNo, size);
    else if (which === "depositors") list = page(depositors.slice().reverse(), pageNo, size);
    else {
      const p = page(txs.slice().reverse(), pageNo, size);
      list = { ...p, items: await Promise.all(p.items.map(async (t) => ({ ...this.txRow(t), action: await this.daoAction(t.tx_hash, daoScript.codeHash) }))) };
    }
    return {
      deposited: sum((c) => c.status === "deposited"),
      withdrawing: sum((c) => c.status === "withdrawing"),
      compensation: cells.reduce((a, c) => a + BigInt(c.compensation), 0n).toString(),
      depositors: depositors.length,
      cells: cells.length,
      transactions: txs.length,
      epoch: tipHeader.epoch,
      lockPeriodMs: blockMs ? 180 * tipHeader.epoch.length * blockMs : null,
      tab: which,
      list,
    };
  }

  // What a DAO transaction did: deposit, withdrawal request (phase 1) or withdrawal (phase 2).
  private async daoAction(hash: string, daoCodeHash: string) {
    const tx = await this.fullTx(hash);
    if (!tx) return "—";
    const isDao = (o: RpcOutput) => o.type?.code_hash === daoCodeHash;
    const outs = tx.outputs.map((o, i) => ({ o, d: tx.outputs_data[i] })).filter((x) => isDao(x.o));
    if (outs.some((x) => /^0x0{16}$/.test(x.d))) return "Deposit";
    if (outs.length) return "Withdrawal request";
    return "Withdrawal";
  }

  tools() {
    return new Tools(this.url, this.resolver);
  }

  // ---- charts -------------------------------------------------------------------------

  // Series for the Charts page, all from this chain: block time, activity, live cells and
  // Knowledge Size over its history, and the fee rates its transactions actually paid.
  async charts() {
    const tip = await this.tip();
    const blocks = this.index.blocks;
    const last = blocks.slice(-501);
    const blockTimes = last.slice(1).map((b, i) => ({ n: b.number, s: Math.max(0, b.timestamp - last[i].timestamp) / 1000 })).filter((p) => p.n > 1);

    // Up to 60 equal stretches of history.
    const buckets = Math.min(60, blocks.length);
    const per = Math.ceil(blocks.length / buckets);
    const activity: { from: number; to: number; txs: number }[] = [];
    const liveCells: { n: number; cells: number }[] = [];
    let running = 0;
    for (let from = 0; from < blocks.length; from += per) {
      const slice = blocks.slice(from, from + per);
      running += slice.reduce((a, b) => a + b.liveCellsChange, 0);
      activity.push({ from, to: from + slice.length - 1, txs: slice.reduce((a, b) => a + b.txs, 0) });
      liveCells.push({ n: slice.at(-1)!.number, cells: running });
    }

    // Knowledge Size at 40 points in history, from each header's DAO field (U, minus the
    // genesis cell that's due to be burnt, as on the home banner).
    await this.knowledgeSize();
    const sample = Array.from(new Set(Array.from({ length: 40 }, (_, i) => Math.round((tip * (i + 1)) / 40))));
    const headers = await rpcBatch<{ dao: string; number: string }>(this.url, sample.map((n) => ["get_header_by_number", [hex(n)]]));
    const knowledge = headers.map((h) => ({ n: num(h.number), bytes: Number((Buffer.from(h.dao.slice(2), "hex").readBigUInt64LE(24) - this.burnt!) / 100_000_000n) }));

    // Fee rate of the last 100 transactions: fee (inputs minus outputs) per 1,000 bytes.
    // Genesis transactions pay no fee, so they're left out.
    const recent = this.index.txs.filter((t) => t.blockNumber > 0).slice(-100);
    const fees = (await Promise.all(recent.map(async (t) => {
      const tx = await this.fullTx(t.hash);
      if (!tx) return null;
      let input = 0n;
      for (const i of tx.inputs) {
        const src = await this.fullTx(i.previous_output.tx_hash);
        if (!src) return null;
        input += BigInt(src.outputs[num(i.previous_output.index)].capacity);
      }
      const fee = input - tx.outputs.reduce((a, o) => a + BigInt(o.capacity), 0n);
      const size = txSize(tx);
      return { hash: t.hash, blockNumber: t.blockNumber, fee: fee.toString(), size, feeRate: Number((fee * 1000n) / BigInt(size)), tags: t.tags };
    }))).filter((x): x is NonNullable<typeof x> => !!x);
    const rates = fees.map((f) => f.feeRate).sort((a, b) => a - b);
    const pool = await rpc<{ min_fee_rate: string; pending: string; proposed: string }>(this.url, "tx_pool_info");

    return {
      tip,
      blockTimes,
      activity,
      liveCells,
      knowledge,
      fees,
      feeStats: rates.length ? {
        count: rates.length,
        min: rates[0],
        median: rates[Math.floor(rates.length / 2)],
        mean: Math.round(rates.reduce((a, b) => a + b, 0) / rates.length),
        max: rates.at(-1),
      } : null,
      minFeeRate: num(pool.min_fee_rate),
      pool: num(pool.pending) + num(pool.proposed),
    };
  }

  // ---- search ---------------------------------------------------------------------------

  async search(q: string): Promise<{ route: string } | { error: string }> {
    const query = q.trim().replace(/,/g, "");
    if (/^#?\d+$/.test(query)) return { route: `#/block/${Number(query.replace("#", ""))}` };
    if (/^ck[bt]1[0-9a-z]+$/i.test(query)) return { route: `#/address/${query}` };
    if (/^0x[0-9a-f]{64}$/i.test(query)) {
      const h = query.toLowerCase();
      const tx = await rpc<TxResponse | null>(this.url, "get_transaction", [h]);
      if (tx?.transaction || tx?.tx_status.status === "rejected") return { route: `#/tx/${h}` };
      const block = await rpc<unknown>(this.url, "get_header", [h]);
      if (block) return { route: `#/block/${h}` };
      const script = this.resolver.all().find((s) => s.codeHash === h);
      if (script) return { route: `#/script/${h}/${script.hashType}` };
      // A script hash: a lock goes to its address; a type to its token, or its script page.
      const seen = this.scriptHashes.get(h);
      if (seen?.role === "lock") return { route: `#/address/${addressOf(seen.script)}` };
      if (seen?.role === "type") {
        if ((await this.udtTokens()).has(h)) return { route: `#/token/${h}` };
        return { route: `#/script/${seen.script.code_hash}/${seen.script.hash_type}?tab=type` };
      }
      // A spore id or cluster id is a type script's args.
      for (const name of ["spore", "spore_cluster"] as const) {
        const known = this.resolver.all().filter((k) => k.name === name);
        for (const k of known) {
          const txs = await rpc<{ objects: unknown[] }>(this.url, "get_transactions", [
            { script: { code_hash: k.codeHash, hash_type: k.hashType, args: h }, script_type: "type", script_search_mode: "exact" }, "asc", "0x1"]);
          if (txs.objects.length) return { route: name === "spore" ? `#/spore/${h}` : "#/nfts" };
        }
      }
      return { error: `Nothing on this devnet matches ${short(h)}: it isn't a transaction, block, script, script hash, token, spore or cluster.` };
    }
    return { error: "Search takes a block number, a transaction or block hash, an address, a script or code hash, a token type hash, or a spore or cluster id." };
  }

  // ---- shared ---------------------------------------------------------------------------

  private async liveState(txHash: string, index: number) {
    const res = await rpc<{ status: string }>(this.url, "get_live_cell", [{ tx_hash: txHash, index: hex(index) }, false]);
    return res.status;
  }

  // Counts live cells that use a script, stopping at 100 so a busy lock doesn't stall the page.
  private async countCells(s: { codeHash: string; hashType: string }, role: "lock" | "type"): Promise<{ n: number; more: boolean }> {
    const pages = await Promise.all(this.resolver.usagePrefixes(s).map((script) => {
      const key: SearchKey = { script, script_type: role, script_search_mode: "prefix", with_data: false };
      return rpc<{ objects: unknown[] }>(this.url, "get_cells", [key, "asc", "0x64"]);
    }));
    const n = pages.reduce((a, p) => a + p.objects.length, 0);
    return { n: Math.min(n, 100), more: n >= 100 };
  }

  // Whether an output is still live, and if not, which transaction consumed it.
  private async status(outPoint: { txHash: string; index: number }, lock: RpcScript, createdIn: number | null): Promise<CellStatus> {
    if (createdIn === null) return { state: "pending" };
    if ((await this.liveState(outPoint.txHash, outPoint.index)) === "live") return { state: "live" };

    // The node's built-in indexer lists every transaction that touched this lock, so the
    // spender is the first one after creation with an input pointing back at this cell.
    let cursor: string | undefined;
    for (let pageNo = 0; pageNo < 5; pageNo++) {
      const params: unknown[] = [
        { script: lock, script_type: "lock", filter: { block_range: [hex(createdIn), hex(this.index.tip + 1)] }, group_by_transaction: false },
        "asc",
        "0x64",
      ];
      if (cursor) params.push(cursor);
      const res = await rpc<{ objects: { tx_hash: string; io_type: string; io_index: string }[]; last_cursor: string }>(this.url, "get_transactions", params);
      for (const o of res.objects) {
        if (o.io_type !== "input") continue;
        const spender = await rpc<TxResponse | null>(this.url, "get_transaction", [o.tx_hash]);
        const input = spender?.transaction?.inputs[num(o.io_index)];
        if (input && input.previous_output.tx_hash === outPoint.txHash && num(input.previous_output.index) === outPoint.index)
          return { state: "spent", by: o.tx_hash };
      }
      if (res.objects.length < 100) break;
      cursor = res.last_cursor;
    }
    return { state: "spent", by: null };
  }

  private indexerCell(c: IndexerCell, status: CellStatus): CellView {
    return {
      ...this.cell(c.output, c.output_data ?? "0x"),
      outPoint: { txHash: c.out_point.tx_hash, index: num(c.out_point.index) },
      blockNumber: num(c.block_number),
      status,
    };
  }

  private tagsFor(tx: RpcTransaction): string[] {
    if (!this.tags.has(tx.hash)) {
      const tags = new Set<string>();
      tx.outputs.forEach((o, i) => {
        const cell = this.cell(o, tx.outputs_data[i]);
        const tag = tagOf(cell.decoded) ?? scriptTag(cell.type?.resolved);
        if (tag) tags.add(tag);
      });
      this.tags.set(tx.hash, [...tags]);
    }
    return this.tags.get(tx.hash)!;
  }

  private cell(out: RpcOutput, data: string): CellView {
    const lock = { ...out.lock, resolved: this.resolver.resolve(out.lock), bytes: scriptBytes(out.lock), hash: scriptHash(out.lock) };
    const type = out.type
      ? { ...out.type, resolved: this.resolver.resolve(out.type), bytes: scriptBytes(out.type), hash: scriptHash(out.type) }
      : null;
    const dataLength = (data.length - 2) / 2;
    const hashOfData = dataLength ? dataHash(data) : null;

    const code = this.resolver.codeCell(hashOfData, type?.hash ?? null);
    const decoded: Decoded | null = code
      ? { kind: "code", name: code.script.name, source: code.script.source, matchedBy: code.matchedBy, codeHash: code.script.codeHash, hashType: code.script.hashType }
      : decodeByType(out.type, type?.resolved ?? null, data);

    return {
      capacity: BigInt(out.capacity).toString(),
      lock,
      type,
      address: addressOf(out.lock),
      dataLength,
      dataPreview: data.slice(0, 2 + 512),
      dataHash: hashOfData,
      occupied: 8 + lock.bytes + (type?.bytes ?? 0) + dataLength,
      decoded,
    };
  }
}

const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

const minerReward = (s: EconomicState) =>
  BigInt(s.miner_reward.primary) + BigInt(s.miner_reward.secondary) + BigInt(s.miner_reward.committed) + BigInt(s.miner_reward.proposal);

// Net effect of a transaction on each address: CKB and every token it holds.
function balanceChanges(inputs: CellView[], outputs: CellView[]) {
  const by = new Map<string, { address: string; lockName: string | null; ckb: bigint; tokens: Map<string, { standard: string; type: ScriptView; amount: bigint }> }>();
  const apply = (c: CellView, sign: 1n | -1n) => {
    const e = by.get(c.address) ?? { address: c.address, lockName: c.lock.resolved.inner?.name ?? c.lock.resolved.name, ckb: 0n, tokens: new Map() };
    e.ckb += sign * BigInt(c.capacity);
    if (c.decoded?.kind === "udt" && c.type) {
      const t = e.tokens.get(c.type.hash) ?? { standard: c.decoded.standard, type: c.type, amount: 0n };
      t.amount += sign * BigInt(c.decoded.amount);
      e.tokens.set(c.type.hash, t);
    }
    by.set(c.address, e);
  };
  inputs.forEach((c) => apply(c, -1n));
  outputs.forEach((c) => apply(c, 1n));
  return [...by.values()].map((e) => ({
    address: e.address,
    lockName: e.lockName,
    ckb: e.ckb.toString(),
    tokens: [...e.tokens.values()].filter((t) => t.amount !== 0n).map((t) => ({ standard: t.standard, type: t.type, amount: t.amount.toString() })),
  }));
}

// Cells we can't decode still say something when their type is one of your own scripts
// (or a JS contract run by ckb_js_vm): the feed shows the contract's name.
function scriptTag(r: Resolved | undefined): string | null {
  if (r?.inner?.name) return `${r.inner.name} cell`;
  if (r?.name && r.source !== "genesis") return `${r.name} cell`;
  return null;
}

function tagOf(d: Decoded | null): string | null {
  if (!d) return null;
  switch (d.kind) {
    case "code": return `Deployed ${d.name}`;
    case "dao-deposit": return "DAO deposit";
    case "dao-withdrawing": return "DAO withdrawal request";
    case "udt": return d.standard;
    case "spore": return "Spore";
    case "cluster": return "Spore cluster";
    case "type-id": return "Type ID";
    case "invalid": return `Invalid ${d.standard}`;
  }
}
