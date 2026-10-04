export type RpcScript = { code_hash: string; hash_type: string; args: string };
export type RpcOutput = { capacity: string; lock: RpcScript; type: RpcScript | null };
export type RpcTransaction = { hash: string; outputs: RpcOutput[]; outputs_data: string[] };
export type RpcBlock = { header: { number: string; hash: string }; transactions: RpcTransaction[] };

let nextId = 1;

export async function rpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: nextId++, jsonrpc: "2.0", method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

export const getTipNumber = async (url: string) =>
  Number(BigInt(await rpc<string>(url, "get_tip_block_number")));

export const getBlock = (url: string, n: number) =>
  rpc<RpcBlock | null>(url, "get_block_by_number", ["0x" + n.toString(16)]);
