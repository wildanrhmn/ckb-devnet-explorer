# Capstone: CKB Devnet Explorer

My capstone for the CKBuilders program (Nervos Network, developer track, August to November 2026):
a block explorer for local [OffCKB](https://github.com/ckb-devrel/offckb) devnets, built over weeks 9 to 13.

- Repository: https://github.com/wildanrhmn/ckb-devnet-explorer
- Run it: `npx github:wildanrhmn/ckb-devnet-explorer serve` inside a project deployed with `offckb deploy`
- Weekly reports: https://github.com/wildanrhmn/ckbuilders (weeks 9 to 13)

## The problem

When you build on CKB you spend most of your time on a local devnet started by `offckb node`. The official
[CKB Explorer](https://explorer.nervos.org) can't see that chain, and its backend (Rails, PostgreSQL,
Redis and a block syncer) is too heavy to point at a chain that `offckb clean` wipes all the time. So during
weeks 1 to 8 I read raw RPC JSON: my own scripts were 32-byte code hashes, cell data was hex, and when a
transaction failed I had to dig through the node's output.

I raised the idea with RetricSu (the author of OffCKB) on September 17. He confirmed it wasn't duplicated and
was a real gap: the official explorer's node mode is generic and his `ckb-tui` shows very little. Neon
approved it on September 28 as a standalone tool that could move into offckb later.

## What I built

A single Node process that reads the devnet node directly and serves an explorer that looks and works like
the official one, plus what's only useful on a devnet.

**Everything the official explorer has that makes sense on a devnet**
- Home with chain stats, block time and activity charts, latest blocks and transactions
- Paginated blocks and transactions, and the tx pool
- Block pages (miner, reward breakdown, size, cycles, proposals, raw header)
- Transaction pages (fee rate, size, cycles, balance changes per address, every input and output,
  cell deps, header deps, witnesses, raw JSON)
- Address pages (balance, occupied capacity, DAO deposits, blocks mined, transactions, cells, tokens)
- Script pages and a list of every known script
- Tokens (sUDT and xUDT with supply, issuer and holders), NFTs (spores with their content and history,
  clusters), the Nervos DAO (deposits, compensation, unlock epochs)
- Charts, tools (address and script conversion, ckbhash, a molecule decoder, broadcast with a dry run)
  and one search box for every kind of id

**What only a devnet explorer can do**
- Name your own scripts from each project's `deployment/scripts.json`, including JS contracts behind
  `ckb_js_vm`, and flag a deployment whose code cell isn't on the chain any more
- Decode every cell and show what its capacity pays for (capacity field, lock, type, data, unused)
- Show why the node rejected a transaction
- Notice `offckb clean` and rebuild by itself
- A faucet, and offckb's 20 test accounts with the role offckb gives each

It follows the official explorer's design system (MIT) in its own devnet blue, with light and dark themes and
a phone layout. The Nervos logo and CKB token icon are used unmodified, as the Nervos media kit allows.

## How it went, week by week

| Week | Focus | Result |
|------|-------|--------|
| 9 (Oct 4) | Plan and foundation | RPC client and the script name resolver, as a CLI that prints transactions with names (`652bd53`) |
| 10 (Oct 11) | Web UI | Transaction feed and cell view with the capacity bar, plain HTML/JS served by the same process (`d9a1282`) |
| 11 (Oct 18) | Reading cells | Code cells recognised by data hash and type hash (RFC 0022), decoders for DAO, sUDT, xUDT, Spore and Type ID, live/spent status, then a first redesign (`0c717d2`, `981f619`) |
| 12 (Oct 25) | One command | An `npx` launcher, JS contract support, header deps; tested on a fresh Mac setup with a JS counter contract (`bdc14d0`, `e6a88f6`) |
| 13 (Nov 1) | Parity and integration | Every devnet-relevant page of the official explorer on its design system, faucet, tools, charts, dark mode, README; RetricSu's offckb integration PR (`b5133c1` to `ef7a0e8`) |

## How it works

There's no database. Detail pages ask the node for exactly what they need; for lists and totals the server
keeps a small in-memory index of blocks and transactions, read in JSON-RPC batches (about 0.3 s for 4,500
blocks) and rebuilt when the chain is reset. Tokens, NFTs and DAO cells come from the node's built-in indexer
by type script. Script names come from `offckb system-scripts` and each project's `deployment/scripts.json`.

A few things that needed working out:

- **Recognising code cells.** RFC 0022: a script with a `data*` hash type loads code from the cell whose data
  hash equals its code hash; with `type`, from the cell whose type script hashes to it. Hashing every cell's
  data and type script against the known scripts labels both your deployments and the genesis cells.
- **JS contracts.** A cell guarded by a JS contract carries `ckb_js_vm`'s code hash; the contract's sits in the
  args. Counting usage needs a second indexer search with that prefix.
- **Knowledge Size.** The CKB Explorer's headline number is U, the fourth field of a header's DAO data. offckb's
  devnet genesis has the same 8.4 billion CKB cell as mainnet, 60% of which counts as occupied because it's
  due to be burnt, so the explorer subtracts that 5.04 billion as the official one does.
- **DAO compensation** (RFC 0023): free capacity grows with AR, the accumulated rate in each header, so a
  deposit is worth `free * AR_now / AR_deposit`; a withdrawal completes after whole 180-epoch cycles.
- **The faucet.** offckb ships its test accounts' keys in its package. Its code names #0-#2 Alice, Bob and
  Carol and makes #19 the default deployer, so the faucet uses #18. Claims wait for the previous one to
  commit, because two transfers built back to back pick the same input and the node rejects the second.

More in [ARCHITECTURE.md](ARCHITECTURE.md).

## Results

- Tested against a real devnet (CKB 0.208.0, OffCKB 0.4.11 and 0.4.13) with my own work from the program:
  the carrot and sUDT Rust contracts, a JS counter contract, DAO deposits and a withdrawal request, xUDT,
  spores and clusters.
- Most pages answer in about 10 ms; the heaviest, an address with 5,500 cells and a script used by
  5,557 cells, in under a quarter of a second.
- About 5,350 lines: TypeScript on the server, plain JavaScript modules in the browser, no build step,
  two runtime dependencies (`@ckb-ccc/core`, `@ckb-ccc/spore`) plus `tsx`.

## Into offckb

RetricSu is adding sandboxed local plugins to offckb ([ckb-devrel/offckb#542](https://github.com/ckb-devrel/offckb/pull/542))
with this explorer as the first one, and opened [PR #1](https://github.com/wildanrhmn/ckb-devnet-explorer/pull/1)
here: a versioned public CLI contract (`--system-scripts`, `--host`, `--json`, `--bridge`) so offckb can run
the explorer in its sandbox. I rebased it onto the current code and added a commit so the explorer runs
read-only and CSP-clean there (offckb's RPC gateway only forwards read methods and its pages allow scripts from
files only). It's mergeable and waiting for him to mark it ready.

## What's left

- Merge PR #1 and, if offckb wants it, publish `ckb-devnet-explorer@0.3.0` to npm
- The final DAO withdrawal (phase 2), which needs the 180-epoch lock period to pass on the devnet
  (about 18.8 days at its block time)
- Decoding the data of JS contracts, e.g. the counter's u64

## Thanks

Neon for the program and for letting the capstone be a standalone tool, and RetricSu for confirming the gap
in September and now bringing the explorer into offckb.
