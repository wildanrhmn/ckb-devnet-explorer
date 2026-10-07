import { key, type KnownScript } from "./scripts.ts";
import type { RpcScript } from "./rpc.ts";

const HASH_TYPES: Record<number, string> = { 0: "data", 1: "type", 2: "data1", 4: "data2" };

export type Resolved = {
  name: string | null;
  source: string | null;
  inner?: Resolved;
};

export class Resolver {
  constructor(private known: Map<string, KnownScript>) {}

  resolve(script: RpcScript): Resolved {
    const hit = this.known.get(key(script.code_hash, script.hash_type));
    if (!hit) return { name: null, source: null };
    const resolved: Resolved = { name: hit.name, source: hit.source };
    // JS contracts are run by ckb_js_vm: the lock/type points at the interpreter, and the
    // real contract's code hash sits in the args right after 2 flag bytes.
    if (hit.name === "ckb_js_vm") {
      const inner = this.innerJsScript(script.args);
      if (inner) resolved.inner = this.resolve(inner);
    }
    return resolved;
  }

  describe(script: RpcScript | null): string {
    if (!script) return "-";
    return label(this.resolve(script), script.code_hash);
  }

  private innerJsScript(args: string): RpcScript | null {
    const hex = args.replace(/^0x/, "");
    if (hex.length < (2 + 32 + 1) * 2) return null;
    return {
      code_hash: "0x" + hex.slice(4, 68),
      hash_type: HASH_TYPES[parseInt(hex.slice(68, 70), 16)] ?? "?",
      args: "0x",
    };
  }
}

export function label(r: Resolved, codeHash: string): string {
  if (!r.name) return `unknown (${codeHash.slice(0, 10)}…)`;
  const base = `${r.name} (${r.source})`;
  return r.inner ? `${base} -> ${label(r.inner, "")}` : base;
}
