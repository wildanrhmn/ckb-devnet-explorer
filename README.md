# ckb-devnet-explorer

A lightweight explorer for [OffCKB](https://github.com/ckb-devrel/offckb) devnets. No database, no indexer:
it reads your devnet node directly and labels every script by name, including the ones your own projects deploy.

Work in progress, see [docs/PLAN.md](docs/PLAN.md).

## Try it

Needs Node 22, `offckb` on your PATH, and a running devnet (`offckb node`).

```bash
npm install
npm run scan -- --project ~/path/to/your-ckb-project --txs 10
```

`--project` can be passed more than once. Each one should be a project deployed with `offckb deploy`
(it reads `deployment/scripts.json`).
