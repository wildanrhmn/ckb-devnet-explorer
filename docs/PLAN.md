# ckb-devnet-explorer — plan

## Problem
Working on an OffCKB devnet, the only way to look at a block, a transaction or a cell is to curl the RPC
and read raw hex. The tools that exist each cover part of it:

- The official CKB Explorer can point at a devnet node, but it needs a Rails backend, PostgreSQL, Redis and a
  background block syncer. That is a lot to run for a chain that gets wiped with every `offckb clean`.
- `offckb system-scripts` names the genesis scripts, but knows nothing about scripts a project deploys itself.
- `offckb debug --tx-hash` verifies a transaction you already know the hash of. It doesn't help you browse.
- `offckb status` (ckb-tui) shows the mempool and some live info, with limited block/transaction data.

## What this is
A lightweight explorer for OffCKB devnets:

- No database and no indexer. It reads the node's RPC directly, on demand.
- It names every lock and type script: genesis scripts (from `offckb system-scripts`) and the scripts of
  your own projects (from their `deployment/scripts.json`). JS contracts run by ckb-js-vm are resolved
  through to the contract they wrap.
- It decodes cell data (hex / UTF-8 / u128) and recognizes common formats (xUDT amounts, DAO deposits, spores).

## Not in scope
- Testnet or mainnet. The official explorer already covers those.
- Historical indexing, search over all addresses, analytics.
- Writing transactions. This is read-only.

## Plan
| Week | Goal |
|------|------|
| 9  | Repo, plan, core: RPC client + script name resolver as a CLI |
| 10 | Web UI: block list, transaction view |
| 11 | Cell inspector: decoded data, code cells labelled by data hash, xUDT/DAO/spore formats |
| 12 | One-command run, README, demo |
| 13 | Buffer, final report, demo video |
