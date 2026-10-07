# ckb-devnet-explorer

A lightweight explorer for [OffCKB](https://github.com/ckb-devrel/offckb) devnets. No database, no indexer:
it reads your devnet node directly and labels every script by name, including the ones your own projects deploy.

![A spore transaction: the consumed cell on the left, the spore cell and change cell on the right](docs/screenshot.png)

Each cell shows what its capacity pays for. On CKB, 1 CKB of capacity pays for 1 byte, so the bar splits a cell
into its 8-byte capacity field, its lock, its type, its data and whatever capacity is left over.

Work in progress, see [docs/PLAN.md](docs/PLAN.md).

## Run it

Needs Node 22, `offckb` on your PATH, and a running devnet (`offckb node`).

```bash
npm install
npm run serve -- --project ~/path/to/your-ckb-project
```

Then open http://localhost:7070.

`--project` can be passed more than once. Each one should be a project deployed with `offckb deploy`
(the explorer reads its `deployment/scripts.json` to name your scripts).

Other options: `--rpc` (default `http://127.0.0.1:8114`) and `--port` (default `7070`).

There's also a terminal version that prints the latest transactions:

```bash
npm run scan -- --project ~/path/to/your-ckb-project --txs 10
```
