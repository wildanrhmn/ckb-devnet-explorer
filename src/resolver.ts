import { key, type KnownScript } from "./scripts.ts";
import type { RpcScript } from "./rpc.ts";

const HASH_TYPES: Record<number, string> = { 0: "data", 1: "type", 2: "data1", 4: "data2" };

export class Resolver {
  constructor(private known: Map<string, KnownScript>) {}

  describe(script: RpcScript | null): string {
    if (!script) return "-";
    const hit = this.known.get(key(script.code_hash, script.hash_type));
    if (!hit) return `unknown (${script.code_hash.slice(0, 10)}…)`;
    const label = hit.source === "genesis" ? `${hit.name} (genesis)` : `${hit.name} (${hit.source})`;
    // JS contracts are run by ckb_js_vm: the lock/type points at the interpreter, and the
    // real contract's code hash sits in the args right after 2 flag bytes.
    if (hit.name === "ckb_js_vm") return `${label} -> ${this.innerJsScript(script.args)}`;
    return label;
  }

  private innerJsScript(args: string): string {
    const hex = args.replace(/^0x/, "");
    if (hex.length < (2 + 32 + 1) * 2) return "?";
    const codeHash = "0x" + hex.slice(4, 68);
    const hashType = HASH_TYPES[parseInt(hex.slice(68, 70), 16)] ?? "?";
    return this.describe({ code_hash: codeHash, hash_type: hashType, args: "0x" });
  }
}
