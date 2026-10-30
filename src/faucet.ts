import { execFile } from "node:child_process";
import { ccc } from "@ckb-ccc/core";
import { rpc } from "./rpc.ts";
import { offckbAccounts } from "./accounts.ts";

// The devnet faucet: sends CKB from one of offckb's prefunded test accounts.
//
// offckb funds 20 accounts in the devnet genesis (42,000,000 CKB each) and ships their keys in
// its package (account/account.json); they're public and only worth anything on a local devnet.
// The faucet uses #18: offckb gives it no role, unlike #0-#2 (its example accounts) and #19
// (`offckb deploy`'s default deployer), so claims never drain an account your workflow uses.
// Sending goes through `offckb transfer`, so transactions are built and signed exactly as
// offckb does it. This is the only part of the explorer that writes to the chain, and it
// refuses to run unless the node says it's a devnet.

export const FAUCET_ACCOUNT = 18;
const ACCOUNT_INDEX = FAUCET_ACCOUNT;
export const MIN_CKB = 61; // a plain secp256k1 cell needs 61 bytes, so 61 CKB
export const MAX_CKB = 1_000_000;
const DEVNET_PREFIX = { addressPrefix: "ckt" } as unknown as ccc.Client;

type Account = { privkey: string; address: string };
export type Claim = { hash: string; to: string; amount: number; time: number };

export class Faucet {
  private account: Account | null = null;
  private problem: string | null = null;
  private claims: Claim[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private url: string) {
    const accounts = offckbAccounts();
    this.account = accounts?.[ACCOUNT_INDEX] ?? null;
    if (!accounts) this.problem = "Couldn't find offckb's test accounts, so the faucet is off.";
    else if (!this.account) this.problem = `offckb's account list has no account #${ACCOUNT_INDEX}.`;
  }

  hasAccount() {
    return !!this.account;
  }

  // Forget claims from a chain that `offckb clean` wiped.
  reset() {
    this.claims = [];
  }

  // Also used by the broadcast tool: nothing writes unless this is a devnet.
  async devnetProblem() {
    const info = await rpc<{ chain: string }>(this.url, "get_blockchain_info");
    return info.chain === "ckb_dev" ? null : `The node is on "${info.chain}", not a devnet, so nothing is sent.`;
  }

  private async devnetCheck(): Promise<string | null> {
    if (this.problem) return this.problem;
    const info = await rpc<{ chain: string }>(this.url, "get_blockchain_info");
    return info.chain === "ckb_dev" ? null : `The node is on "${info.chain}", not a devnet, so the faucet is off.`;
  }

  async status() {
    const reason = await this.devnetCheck();
    let balance: string | null = null;
    if (!reason && this.account) {
      const script = (await ccc.Address.fromString(this.account.address, DEVNET_PREFIX)).script;
      const res = await rpc<{ capacity: string } | null>(this.url, "get_cells_capacity", [
        { script: { code_hash: script.codeHash, hash_type: script.hashType, args: script.args }, script_type: "lock" },
      ]);
      balance = res ? BigInt(res.capacity).toString() : "0";
    }
    const claims = await Promise.all(this.claims.slice().reverse().map(async (c) => {
      const tx = await rpc<{ tx_status: { status: string; block_number: string | null } } | null>(this.url, "get_transaction", [c.hash]);
      return { ...c, status: tx?.tx_status.status ?? "unknown", blockNumber: tx?.tx_status.block_number ? Number(BigInt(tx.tx_status.block_number)) : null };
    }));
    return {
      available: !reason,
      reason,
      account: this.account ? { index: ACCOUNT_INDEX, address: this.account.address } : null,
      balance,
      min: MIN_CKB,
      max: MAX_CKB,
      claims,
    };
  }

  // Claims run one at a time: each waits until the previous transfer is committed, so two
  // transfers never pick the same input (the node would reject the second, PoolRejectedRBF).
  claim(to: string, amount: number): Promise<Claim> {
    const run = this.queue.then(() => this.send(to, amount));
    this.queue = run.then((c) => this.committed(c.hash), () => undefined);
    return run;
  }

  async check(to: string, amount: number): Promise<string | null> {
    const reason = await this.devnetCheck();
    if (reason) return reason;
    if (!Number.isInteger(amount) || amount < MIN_CKB || amount > MAX_CKB)
      return `Choose a whole amount from ${MIN_CKB} to ${MAX_CKB.toLocaleString("en-US")} CKB.`;
    try {
      await ccc.Address.fromString(to, DEVNET_PREFIX);
    } catch {
      return "That isn't a devnet address. It should start with ckt1.";
    }
    if (!to.startsWith("ckt1")) return "That isn't a devnet address. It should start with ckt1.";
    return null;
  }

  private send(to: string, amount: number): Promise<Claim> {
    return new Promise((resolve, reject) => {
      // The key goes in the environment, not the command line, so it doesn't show up in `ps`.
      execFile("offckb", ["transfer", "--network", "devnet", to, String(amount)], {
        env: { ...process.env, OFFCKB_PRIVATE_KEY: this.account!.privkey },
        cwd: process.env.HOME ?? "/",
        timeout: 90_000,
      }, (err, stdout, stderr) => {
        const hash = stdout.match(/txHash:\s*(0x[0-9a-f]{64})/i)?.[1];
        if (hash) {
          const claim = { hash, to, amount, time: Date.now() };
          this.claims.push(claim);
          if (this.claims.length > 100) this.claims.shift();
          return resolve(claim);
        }
        const out = `${stderr}\n${stdout}`.trim();
        const message = out.match(/(PoolRejected\w*|Error[^\n]*|error[^\n]*)/)?.[0] ?? (err?.message || "offckb transfer failed.");
        reject(new Error(message.slice(0, 300)));
      });
    });
  }

  private async committed(hash: string) {
    for (let i = 0; i < 90; i++) {
      const tx = await rpc<{ tx_status: { status: string } } | null>(this.url, "get_transaction", [hash]).catch(() => null);
      const s = tx?.tx_status.status;
      if (s === "committed" || s === "rejected" || s === "unknown") return;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
