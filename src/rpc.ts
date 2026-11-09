export type RpcScript = { code_hash: string; hash_type: string; args: string };
export type RpcOutput = { capacity: string; lock: RpcScript; type: RpcScript | null };
export type RpcTransaction = { hash: string; outputs: RpcOutput[]; outputs_data: string[] };
export type RpcBlock = { header: { number: string; hash: string }; transactions: RpcTransaction[] };

let nextId = 1;
let active = 0;
const waiting: Array<() => void> = [];
const MAX_CONCURRENT_REQUESTS = 4;
const MAX_BATCH_CALLS = 10;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// offckb's read gateway rejects excess work instead of queueing it. Keep all Explorer
// requests, including the background index, under the same bound.
async function scheduled<T>(run: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT_REQUESTS) await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
  try { return await run(); }
  finally {
    active--;
    waiting.shift()?.();
  }
}

async function request(url: string, body: unknown): Promise<unknown> {
  const payload = JSON.stringify(body);
  for (let attempt = 0; ; attempt++) {
    const { status, text } = await scheduled(async () => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
      return { status: response.status, text: await response.text() };
    });
    if (RETRYABLE_STATUS.has(status) && attempt < 3) {
      await sleep(50 * 2 ** attempt);
      continue;
    }
    let parsed: any;
    try { parsed = JSON.parse(text); } catch {
      const method = Array.isArray(body) ? `batch(${body.length}):${body[0]?.method ?? "unknown"}` : (body as any)?.method ?? "unknown";
      throw new Error(`RPC HTTP ${status} ${method}: invalid JSON response (${text.length} bytes)`);
    }
    if (status < 200 || status >= 300) {
      const detail = typeof parsed?.error === "string" ? parsed.error : parsed?.error?.message;
      throw new Error(`RPC HTTP ${status}${detail ? `: ${detail}` : ""}`);
    }
    return parsed;
  }
}

const errorMessage = (error: any) => typeof error === "string" ? error : error?.message ?? "no response";

export async function rpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const body = await request(url, { id: nextId++, jsonrpc: "2.0", method, params }) as any;
  if (body.error) throw new Error(`${method}: ${errorMessage(body.error)}`);
  return body.result as T;
}

async function rpcBatchPart<T>(url: string, calls: [string, unknown[]][]): Promise<T[]> {
  const first = nextId;
  nextId += calls.length;
  const body = await request(url, calls.map(([method, params], i) => ({ id: first + i, jsonrpc: "2.0", method, params }))) as any;
  if (!Array.isArray(body)) throw new Error(`RPC batch: ${errorMessage(body?.error) || "expected an array response"}`);
  const byId = new Map(body.map((r) => [r.id, r]));
  return calls.map(([method], i) => {
    const r = byId.get(first + i);
    if (!r || r.error) throw new Error(`${method}: ${errorMessage(r?.error)}`);
    return r.result as T;
  });
}

// Small batches also keep full-block JSON below offckb's 16 MiB response limit when
// transactions and witnesses are large. Parts preserve the original call order.
export async function rpcBatch<T>(url: string, calls: [string, unknown[]][]): Promise<T[]> {
  if (!calls.length) return [];
  const parts: [string, unknown[]][][] = [];
  for (let from = 0; from < calls.length; from += MAX_BATCH_CALLS) parts.push(calls.slice(from, from + MAX_BATCH_CALLS));
  return (await Promise.all(parts.map((part) => rpcBatchPart<T>(url, part)))).flat();
}

export const getTipNumber = async (url: string) =>
  Number(BigInt(await rpc<string>(url, "get_tip_block_number")));

export const getBlock = (url: string, n: number) =>
  rpc<RpcBlock | null>(url, "get_block_by_number", ["0x" + n.toString(16)]);

export const getBlockHash = (url: string, n: number) =>
  rpc<string | null>(url, "get_block_hash", ["0x" + n.toString(16)]);
