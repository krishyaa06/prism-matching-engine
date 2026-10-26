# Prism Matching Engine — Usage

## Install

```bash
npm install github:krishyaa06/prism-matching-engine
# or run the CLI directly
npx github:krishyaa06/prism-matching-engine --help
```

## JavaScript API

```js
import { Engine, FixSession, FixClient, toUnits } from "prism-matching-engine";

const ex = new Engine({ fees: { maker: 2, taker: 10 }, stp: "cancel-resting" });   // bps
ex.ledger.deposit("alice", "BTC", BigInt(toUnits("2")));
ex.ledger.deposit("bob", "USD", BigInt(toUnits("200000")));

ex.submit({ account: "alice", symbol: "BTC-USD", side: "sell", px: "65000.50", qty: "1.2" });
const r = ex.submit({ account: "bob", symbol: "BTC-USD", side: "buy", type: "market", qty: "0.5" });
r.trades;    // [{ id: "T1", px: 6500050000000, qty: 50000000, buyer: "bob", seller: "alice", ... }]
r.reports;   // execution reports: new / trade / canceled / rejected / replaced / triggered

ex.submit({ account: "alice", symbol: "BTC-USD", side: "sell", type: "stop", stopPx: "64980", qty: "0.3" });
ex.replace("O1", { qty: "1.0" });          // smaller qty keeps queue priority
ex.book("BTC-USD").depth(5);               // { bids: [{ px, qty, orders }], asks: [...] }
ex.ledger.verify();                        // { ok: true } — every currency sums to zero

const again = Engine.replay(ex.input, {}, seedDeposits);
again.stateHash() === ex.stateHash();      // true

const fix = new FixSession(ex), cl = new FixClient();
fix.handle(cl.logon());
fix.handle(cl.order({ clOrdId: "a1", account: "bob", symbol: "BTC-USD", side: "buy", px: "65000.50", qty: "0.1", tif: "IOC" }));
```

| Export | What it does |
|---|---|
| `new Engine({ symbols, fees: { maker, taker }, band, collar, stp, maxQty, retain })` | Exchange core. `stp` is `cancel-resting`, `cancel-taker` or `none`; fees in bps |
| `.submit({ account, symbol, side, type, px, stopPx, qty, tif, postOnly, clOrdId })` | `{ order, reports, trades }`. Types `limit` `market` `stop` `stop-limit`, TIF `GTC` `IOC` `FOK` `DAY` |
| `.cancel(id)` · `.replace(id, { px, qty, clOrdId })` · `.endOfDay()` | Order lifecycle (ids or ClOrdIDs) |
| `.book(sym)` → `bbo()` · `mid()` · `depth(n)` · `stops` · `last` | Order book views |
| `.ledger` → `deposit` · `get(acct, ccy)` · `verify()` · `journal` | Double-entry balances (`avail`, `held`, `total` as BigInt units) |
| `.on(fn)` | Events `trade`, `report`, `book` |
| `.input` · `Engine.replay(input, opts, setup)` · `.stateHash()` · `.settlement()` | Journal, replay, state hash, net settlement |
| `encode` · `parse` · `describe` · `pretty` · `TAGS` · `newOrderSingle` · `execReport` | FIX 4.4 messages |
| `new FixSession(engine, { sender, target })` · `.handle(raw)` · `new FixClient()` | FIX session layer |
| `createFixGateway(engine)` from `src/node/fix-gateway.js` | TCP gateway (`net.Server`) |
| `toUnits` · `fmt` · `notional` · `fee` | Integer 1e-8 fixed-point helpers |
| `new Market(engine, { symbol, fair, vol, seed })` · `.step(dt)` · `.whale(side, qty)` | Agent-based market for demos and benchmarks |

## CLI

```bash
$ npx github:krishyaa06/prism-matching-engine demo
$ npx github:krishyaa06/prism-matching-engine book --secs 30
$ npx github:krishyaa06/prism-matching-engine fix examples/orders.fix
$ npx github:krishyaa06/prism-matching-engine bench --orders 300000
$ npx github:krishyaa06/prism-matching-engine replay
$ npx github:krishyaa06/prism-matching-engine serve --port 9878
```

| Command | Description |
|---|---|
| `match demo` | Scripted session: priority, partials, collar, IOC/FOK/post-only, STP, replace, stops, band, settlement |
| `match book [--symbol BTC-USD --secs 30]` | Run the agent market and print the L2 ladder and tape |
| `match fix [examples/orders.fix]` | Feed FIX messages through a session and print the replies |
| `match bench [--orders 300000]` | Throughput and per-command latency percentiles with the ledger on |
| `match replay [--secs 20]` | Record a session, replay the journal, compare state hashes |
| `match serve [--port 9878]` | FIX 4.4 TCP gateway for BTC-USD, ETH-USD, ETH-BTC, EUR-USD |

## Live simulator

Open [https://krishyaa06.github.io/prism-matching-engine/](https://krishyaa06.github.io/prism-matching-engine/) or serve the repo root locally (`npx serve .`). The simulator imports the same modules from `src/`.
