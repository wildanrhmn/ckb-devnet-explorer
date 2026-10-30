# CKB Devnet Explorer

**A block explorer for your local [OffCKB](https://github.com/ckb-devrel/offckb) devnet.** It reads the node
directly, so there's no database, no indexer service and no setup, and it knows your own contracts by name.

[![License: MIT](https://img.shields.io/badge/license-MIT-346dff)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022-346dff)](https://nodejs.org)
[![Tested with CKB](https://img.shields.io/badge/tested%20with-CKB%200.208%20%C2%B7%20OffCKB%200.4-346dff)](https://github.com/nervosnetwork/ckb)
![No build step](https://img.shields.io/badge/build%20step-none-346dff)

![The home page: Knowledge Size banner, search, block time and activity charts, latest blocks and transactions](docs/screenshots/home.png)

The official [CKB Explorer](https://explorer.nervos.org) covers mainnet and testnet, but it can't see the chain
running on your machine. This explorer can. It looks and works like the official one, and adds what you need
while you build: your scripts named from `deployment/scripts.json`, every cell's contents decoded, a check
that your deployments are actually on this chain, a faucet, and the reasons the node rejected a transaction.

## Quick start

You need Node 22+, [OffCKB](https://github.com/ckb-devrel/offckb) (`npm i -g @offckb/cli`) and a running devnet.

```bash
offckb node                                          # in one terminal
cd my-ckb-project                                    # a project you deployed with `offckb deploy`
npx github:wildanrhmn/ckb-devnet-explorer serve      # in another
```

Open **http://localhost:7070**. The current folder is used as the project, so your scripts are named straight away.

![A tour: home, a transaction, an address, NFTs, a spore, the Nervos DAO, charts, the faucet, and dark mode](docs/screenshots/tour.gif)

## Highlights

- **Your contracts by name.** Genesis scripts come from `offckb system-scripts`, yours from each project's
  `deployment/scripts.json`. JS contracts run by `ckb-js-vm` are named as the contract, not the VM.
- **Every cell explained.** Contract code, sUDT and xUDT amounts, spores and clusters, Nervos DAO deposits and
  withdrawals, Type ID, plain text. Each cell gets a capacity bar showing what its CKB pays for: the capacity
  field, lock, type, data and what's left over.
- **Made for a devnet.** A "Your Scripts" check flags a deployment that `offckb clean` wiped. Rejected
  transactions show the node's reason. The explorer notices a chain reset and starts over by itself.
- **Everything the official explorer has, minus mainnet-only pages.** Blocks, transactions, the tx pool,
  addresses, scripts, tokens, NFTs, the Nervos DAO, charts, tools and search, all paginated and live.
- **A faucet and test accounts.** Send devnet CKB to any address in one click, and see offckb's 20 prefunded
  accounts with the role offckb gives each.
- **Familiar design.** It follows the official explorer's design system, in its own devnet blue, with light
  and dark themes and a phone layout.

## Features

### Transactions

Fee and fee rate, size, cycles and confirmations up top, with **Parameters** (cell deps, header deps,
witnesses) and **Raw** JSON a click away. Below: what each address gained or paid, then every input and
output. Expand a cell for its capacity bar, decoded contents and scripts. Inputs link back to where they
were created; outputs show whether they're live or which transaction spent them.

![A transaction that mints 400 sUDT with a contract from the author's own project](docs/screenshots/transaction.png)

### Addresses and accounts

Balance, occupied capacity, DAO deposits and blocks mined, then paginated tabs for transactions (with the
CKB change in each), live cells and tokens. offckb's test accounts and the devnet miner are labelled.

![An address page for offckb's test account #0](docs/screenshots/address.png)

### Tokens, NFTs and the Nervos DAO

- **Tokens:** every sUDT and xUDT with total supply, issuer, ranked holders and transactions.
- **NFTs:** live spores in a gallery, with images drawn and text and JSON shown. Each has its full history:
  minted, transferred, melted.
- **Nervos DAO:** deposits and withdrawals with estimated compensation (RFC 0023), the lock period on your
  devnet, and the epoch each withdrawal unlocks at.

![Live spores: a PNG, a JSON document and a text](docs/screenshots/nfts.png)

![The Nervos DAO page with a withdrawal that unlocks at epoch 183](docs/screenshots/dao.png)

### Charts

Block time, transactions, live cells and Knowledge Size over the chain's history, and the fee rates its
transactions actually paid.

![Charts of block time, transactions, live cells and Knowledge Size](docs/screenshots/charts.png)

### Faucet and tools

The **faucet** sends devnet CKB from offckb's test account #18, which offckb doesn't use for anything else.
It refuses to run unless the node is a devnet and only takes requests from your own machine. The **tools**
convert addresses to scripts and back (devnet and mainnet forms), compute ckbhash, decode molecule bytes
(Script, WitnessArgs, Transaction, SporeData and more), and broadcast a signed transaction, with a dry run
that asks the node whether it would accept it without sending anything.

![The devnet faucet](docs/screenshots/faucet.png)

### Search

One box for block numbers and hashes, transactions (including rejected ones), addresses, script code
hashes, lock and type script hashes, token type hashes, and spore and cluster ids. Press `/` or `Ctrl+K`.

### Dark mode and phones

The theme follows your system, with a toggle in the header that remembers your choice. Every page works
at phone width.

<table>
  <tr>
    <td width="62%"><img src="docs/screenshots/dark.png" alt="A transaction page in dark mode"></td>
    <td width="38%"><img src="docs/screenshots/mobile.png" alt="The home and transaction pages on a phone"></td>
  </tr>
</table>

## Compared with the official CKB Explorer

| | CKB Explorer | CKB Devnet Explorer |
|---|---|---|
| Networks | Mainnet, testnet | Your local devnet |
| Setup | Rails backend, PostgreSQL, Redis, a block syncer | One command, reads the node directly |
| After `offckb clean` | n/a | Notices the reset and rebuilds by itself |
| Your own contracts | Code hashes | Named, from `deployment/scripts.json` |
| Deployment check | n/a | Flags scripts whose code cell isn't on the chain |
| Cell contents | Per-type views | Decoded in place, with a capacity bar |
| Rejected transactions | n/a | The node's reason, in plain words |
| Faucet | Testnet faucet site | Built in, devnet only |
| Mainnet-only pages (halving, hard forks, Fiber, RGB++, inscriptions, price data) | Yes | Left out on purpose |

## Usage

```bash
npx github:wildanrhmn/ckb-devnet-explorer serve [options]
```

| Option | Default | |
|--------|---------|---|
| `--project <dir>` | current folder | A project deployed with `offckb deploy`. Repeat it for several projects. |
| `--rpc <url>` | `http://127.0.0.1:8114` | The devnet node. |
| `--port <n>` | `7070` | Port for the web UI. |
| `--txs <n>` | `10` | How many transactions the terminal version prints. |

Without `serve` it prints the latest transactions to the terminal:

```bash
npx github:wildanrhmn/ckb-devnet-explorer --txs 10
```

To install it once instead of fetching it each time:

```bash
npm i -g github:wildanrhmn/ckb-devnet-explorer
ckb-devnet-explorer serve --project ~/path/to/your-ckb-project
```

From a clone:

```bash
git clone https://github.com/wildanrhmn/ckb-devnet-explorer && cd ckb-devnet-explorer
npm install
npm run serve -- --project ~/path/to/your-ckb-project
```

## How it works

```
browser ──HTTP──▶ one Node process ──JSON-RPC──▶ your devnet node (with its built-in indexer)
                     ├─ offckb system-scripts             → genesis script names
                     └─ <project>/deployment/scripts.json → your script names
```

There's no database. Detail pages ask the node for exactly what they need. For lists and totals, the server
keeps a small in-memory index of blocks and transactions: it reads the whole chain in batches (4,500 blocks
take about 0.3 s), follows the tip, and rebuilds itself if the chain is reset. Tokens, NFTs and DAO cells come
from the node's indexer by type script. The front end is plain HTML, CSS and JavaScript modules, with no
build step, and the fonts are bundled, so it works offline.

Details, including the DAO compensation math and how code cells are recognised:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Safety

It only reads, with two exceptions that refuse to run on anything but a devnet and only take JSON requests
from your own machine: the faucet and the transaction broadcast tool. The server listens on all interfaces
by default; keep the port to yourself on shared networks. Spore images are served image-only with a
sandboxing content security policy, since spore content is whatever its minter chose.

## Development

```bash
npm install
npm run serve -- --project ~/path/to/your-ckb-project   # run from source
npm run check                                           # type-check
```

The source is TypeScript run by [tsx](https://tsx.is), also when installed with npx. `src/explorer.ts` builds
every view, `src/server.ts` is the HTTP API, and `src/web/` is the page. [docs/PLAN.md](docs/PLAN.md) has the
scope and history.

Built as my capstone for the [CKBuilders](https://github.com/wildanrhmn/ckbuilders) program by Nervos Network; the write-up is in [docs/CAPSTONE.md](docs/CAPSTONE.md).

## Credits and license

MIT, see [LICENSE](LICENSE).

- The design follows the open-source [CKB Explorer](https://github.com/nervosnetwork/ckb-explorer-frontend) (MIT).
- [Roboto](https://fontsource.org/fonts/roboto) is bundled under the Apache License 2.0.
- The Nervos logo and CKB token icon belong to the Nervos Foundation and are used unmodified, as its
  [media kit](https://www.nervos.org/media-kit) allows; they aren't covered by this project's license. See
  [src/web/brand/NOTICE.md](src/web/brand/NOTICE.md).

This is a community tool, not affiliated with or endorsed by the Nervos Foundation.
