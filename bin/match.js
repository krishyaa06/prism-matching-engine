#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Engine, Market, toUnits, fmt, encode, parse, pretty, describe, FixSession, FixClient } from "../src/index.js";
import { c, table, header, fail, bar, spark } from "../src/lib/cli.js";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n, d) => { const i = rest.indexOf("--" + n); return i >= 0 ? rest[i + 1] : d; };
const pos = rest.filter((x, i) => !x.startsWith("--") && !(rest[i - 1] || "").startsWith("--"));
const HELP = `${c.bold("match")} — Prism Matching Engine: price-time priority CLOB, FIX 4.4, multi-currency ledger

  match demo                               scripted session: order types, STP, replace, stops, settlement
  match book [--symbol BTC-USD --secs 30]  run the agent market and print the L2 ladder + tape
  match fix [examples/orders.fix]          feed FIX messages through a session and print the replies
  match bench [--orders 300000]            throughput and per-order latency percentiles
  match replay [--secs 20]                 record a session, replay the journal, compare state hashes
  match serve [--port 9878]                FIX 4.4 TCP gateway (BTC-USD, ETH-USD, ETH-BTC, EUR-USD)
`;
const U = (x) => BigInt(toUnits(x));
const fund = (e, accts, amt = { USD: "5000000", BTC: "50", ETH: "500", EUR: "2000000" }) => { for (const a of accts) for (const [k, v] of Object.entries(amt)) e.ledger.deposit(a, k, U(v)); };
const dp = (ccy) => (ccy === "USD" || ccy === "EUR" ? 2 : 8);
const tr = (s, n) => fmt(s, n).replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1");
function ladder(e, sym, n = 8) {
  const d = e.book(sym).depth(n), s = e.sym.get(sym), pd = s.tick >= 1e6 ? 2 : 5, max = Math.max(1, ...d.bids.map((l) => l.qty), ...d.asks.map((l) => l.qty)), rows = [];
  for (const l of [...d.asks].reverse()) rows.push(["", "", c.red(fmt(l.px, pd)), c.red(tr(l.qty, 4)), bar(l.qty / max, 16, c.red), c.dim(l.orders + " ord")]);
  const { bid, ask } = e.book(sym).bbo(); rows.push(["", "", c.dim("── spread " + (bid && ask ? tr(ask - bid, pd) + ` (${((ask - bid) / ((ask + bid) / 2) * 1e4).toFixed(1)} bps)` : "—")), "", "", ""]);
  for (const l of d.bids) rows.push([c.dim(l.orders + " ord"), bar(l.qty / max, 16, c.green), c.green(fmt(l.px, pd)), c.green(tr(l.qty, 4)), "", ""]);
  return table(rows, { head: ["", "bids", "price", "qty", "asks", ""] });
}
let PD = {}; const pxd = (sym) => PD[sym] ?? 2;
const ex = (r) => { const col = { new: c.cyan, trade: c.green, canceled: c.yellow, rejected: c.red, replaced: c.magenta, triggered: c.magenta, expired: c.dim }[r.execType] || ((x) => x); return `  ${col(r.execType.padEnd(9))} ${r.orderId.padEnd(4)} ${r.account.padEnd(6)} ${r.side.padEnd(4)} ${(r.ordType || "").padEnd(6)} ${r.lastQty ? `${tr(r.lastQty, 4)} @ ${fmt(r.lastPx, pxd(r.symbol))} (${r.liquidity})` : ""}${r.status !== r.execType ? c.dim(" → " + r.status) : ""}${r.text ? c.dim("  " + r.text) : ""}`; };
try {
  if (!cmd || cmd === "-h" || cmd === "--help") console.log(HELP);
  else if (cmd === "demo") {
    const e = new Engine(); for (const s of e.sym.values()) PD[s.symbol] = s.tick >= 1e6 ? 2 : 5; fund(e, ["alice", "bob", "carol", "dave"]); const t0 = e.snapshot(), S = "BTC-USD";
    const step = (title, req, fn) => { console.log("\n" + c.bold(title)); const r = fn ? fn() : e.submit({ symbol: S, ...req }); for (const x of r.reports) console.log(ex(x)); return r; };
    console.log(header("demo", "BTC-USD · maker 2 bps · taker 10 bps · STP cancel-resting · 2% market collar"));
    step("1. alice and carol rest asks (price-time priority: same price, alice first)", null, () => ({ reports: [...e.submit({ symbol: S, account: "alice", side: "sell", px: "65000", qty: "0.6" }).reports, ...e.submit({ symbol: S, account: "carol", side: "sell", px: "65000", qty: "0.6" }).reports, ...e.submit({ symbol: S, account: "carol", side: "sell", px: "65010", qty: "2" }).reports, ...e.submit({ symbol: S, account: "dave", side: "buy", px: "64990", qty: "1" }).reports] }));
    step("2. bob market-buys 1 BTC: fills alice first, then carol at the same level", { account: "bob", side: "buy", type: "market", qty: "1" });
    step("3. FOK for 5 BTC cannot fill completely, so nothing trades", { account: "bob", side: "buy", px: "65010", qty: "5", tif: "FOK" });
    step("4. post-only bid that would cross is rejected", { account: "bob", side: "buy", px: "65000", qty: "0.1", postOnly: true });
    step("5. self-trade prevention: carol's bid would hit her own ask, the resting ask is canceled", { account: "carol", side: "buy", px: "65000", qty: "0.1" });
    const d = [...e.book(S).bids.orders()].find((o) => o.account === "dave");
    step("6. dave amends 1.0 → 0.5 at the same price (keeps priority), then reprices (re-queues)", null, () => ({ reports: [...e.replace(d.id, { qty: "0.5" }).reports, ...e.replace(d.id, { px: "64995" }).reports] }));
    step("7. alice parks a sell stop at 64,980; bob's IOC sweep trades through it and the stop fires", null, () => ({ reports: [...e.submit({ symbol: S, account: "alice", side: "sell", type: "stop", stopPx: "64980", qty: "0.3" }).reports, ...e.submit({ symbol: S, account: "dave", side: "buy", px: "64975", qty: "1" }).reports, ...e.submit({ symbol: S, account: "bob", side: "sell", px: "64975", qty: "0.9", tif: "IOC" }).reports] }));
    step("8. fat-finger: a bid 20% through the market is rejected by the price band", { account: "bob", side: "buy", px: "78000", qty: "1" });
    step("9. insufficient funds: bob tries to buy 500 BTC", { account: "bob", side: "buy", px: "65000", qty: "500" });
    console.log("\n" + c.bold("10. cross-currency: ETH-BTC and EUR-USD books share the same ledger"));
    for (const x of [...e.submit({ symbol: "ETH-BTC", account: "carol", side: "sell", px: "0.05312", qty: "10" }).reports, ...e.submit({ symbol: "ETH-BTC", account: "alice", side: "buy", type: "market", qty: "4" }).reports, ...e.submit({ symbol: "EUR-USD", account: "dave", side: "sell", px: "1.08421", qty: "250000" }).reports, ...e.submit({ symbol: "EUR-USD", account: "bob", side: "buy", px: "1.08425", qty: "100000", tif: "IOC" }).reports]) console.log(ex(x));
    console.log("\n" + c.bold("BTC-USD book")); console.log(ladder(e, S, 5));
    console.log("\n" + c.bold("Settlement (net movement since the start of the session)"));
    const rows = e.settlement(t0).map((r) => [r.account, r.ccy, (r.net > 0n ? c.green : c.red)((r.net > 0n ? "+" : "") + fmt(r.net, dp(r.ccy)))]); console.log(table(rows, { head: ["account", "ccy", "net"] }));
    const v = e.ledger.verify(); console.log(`\n  ledger ${v.ok ? c.green("✓ balanced") : c.red("✗ unbalanced")} · ${e.ledger.journal.length} journal entries · ${e.stats.trades} trades · state ${e.stateHash().slice(0, 16)}…`);
  } else if (cmd === "book") {
    const sym = flag("symbol", "BTC-USD"), e = new Engine(), fair = { "BTC-USD": 65000, "ETH-USD": 3400, "ETH-BTC": 0.0523, "EUR-USD": 1.0842 }[sym] || fail("unknown symbol " + sym);
    const m = new Market(e, { symbol: sym, fair }), tape = [], prices = []; e.on((ev) => { if (ev.type === "trade") { tape.push(ev); prices.push(ev.px); } });
    const secs = +flag("secs", 30); for (let t = 0; t < secs * 10; t++) m.step(0.1);
    console.log(header(sym, `${secs}s of agent flow · ${e.stats.orders} orders · ${e.stats.trades} trades · ${e.stats.cancels} cancels`) + "\n"); console.log(ladder(e, sym, 8));
    const pd = e.sym.get(sym).tick >= 1e6 ? 2 : 5; console.log(`\n  last ${fmt(e.book(sym).last, pd)}  ${c.dim(spark(prices.slice(-60).map(Number)))}\n`);
    console.log(table(tape.slice(-8).reverse().map((t) => [t.id, t.takerSide === "buy" ? c.green("BUY") : c.red("SELL"), fmt(t.px, pd), tr(t.qty, 4), `${t.buyer} ← ${t.seller}`]), { head: ["trade", "aggr", "price", "qty", "buyer ← seller"] }));
  } else if (cmd === "fix") {
    const e = new Engine(); fund(e, ["alice", "bob", "ALGO1"]); const sess = new FixSession(e, { sender: "PRISM" });
    const lines = readFileSync(pos[0] || new URL("../examples/orders.fix", import.meta.url), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    console.log(header("fix", "FIX 4.4 session · BodyLength + CheckSum recomputed for each line") + "\n");
    for (const l of lines) {
      const fields = l.split("|").map((kv) => kv.split("=")).filter(([t]) => !["8", "9", "10"].includes(t)).map(([t, v]) => [+t, v]), raw = encode(fields);
      console.log(c.cyan("<< ") + describe(raw)); for (const o of sess.handle(raw)) console.log(c.green(">> ") + c.dim(describe(o).replace(/^BeginString=FIX.4.4 BodyLength=\d+ /, "")));
      console.log("");
    }
    const bad = encode([[35, "0"], [49, "ALGO1"], [56, "PRISM"], [34, 8]]).replace(/10=\d+/, "10=000");
    console.log(c.cyan("<< ") + "Heartbeat with a corrupted CheckSum"); for (const o of sess.handle(bad)) console.log(c.red(">> ") + describe(o).replace(/^BeginString=FIX.4.4 BodyLength=\d+ /, ""));
  } else if (cmd === "bench") {
    const N = +flag("orders", 300000), e = new Engine({ retain: 5000 }), accts = Array.from({ length: 50 }, (_, i) => "a" + i); fund(e, accts, { USD: "1000000000", BTC: "100000" });
    let x = 9; const r = () => ((x = (x * 1103515245 + 12345) >>> 0) / 4294967296), lat = new Float64Array(N), resting = [];
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      const k = r(), a = accts[(r() * 50) | 0], t = performance.now();
      if (k < 0.25 && resting.length) { e._cancel(resting.splice((r() * resting.length) | 0, 1)[0]); }
      else { const side = r() < 0.5 ? "buy" : "sell", px = toUnits("65000") + Math.round((r() - 0.5 + (side === "buy" ? -0.08 : 0.08)) * 4000) * 1e6; const o = e._submit({ account: a, symbol: "BTC-USD", side, px, qty: (1 + ((r() * 40) | 0)) * 1e4 * 10, type: k > 0.95 ? "market" : "limit", tif: k > 0.9 && k <= 0.95 ? "IOC" : "GTC" }); if (o.order.status === "new" || o.order.status === "partial") resting.push(o.order.id); }
      lat[i] = performance.now() - t;
    }
    const el = performance.now() - t0, s = [...lat].sort((a, b) => a - b), q = (p) => s[Math.floor(p * (N - 1))] * 1000;
    console.log(header("bench", `${N.toLocaleString()} commands · 50 accounts · BTC-USD · funds holds + double-entry ledger on every fill`) + "\n");
    console.log(table([["throughput", c.bold(Math.round(N / el * 1000).toLocaleString() + " cmds/s")], ["trades", e.stats.trades.toLocaleString()], ["latency p50", q(0.5).toFixed(1) + " µs"], ["latency p99", q(0.99).toFixed(1) + " µs"], ["latency p99.9", q(0.999).toFixed(1) + " µs"], ["resting levels", `${e.book("BTC-USD").bids.prices.length} bid / ${e.book("BTC-USD").asks.prices.length} ask`], ["ledger", e.ledger.verify().ok ? c.green("balanced") : c.red("unbalanced")]], { head: ["metric", "value"] }));
  } else if (cmd === "replay") {
    const e = new Engine(), m = new Market(e), secs = +flag("secs", 20); for (let t = 0; t < secs * 10; t++) m.step(0.1);
    const setup = (x) => { for (const r of e.ledger.journal.filter((j) => j.memo.startsWith("deposit"))) for (const [a, ccy, d] of r.legs) if (a !== "world") x.ledger.deposit(a, ccy, BigInt(d)); };
    const t0 = performance.now(), f = Engine.replay(e.input, {}, setup), ms = performance.now() - t0, a = e.stateHash(), b = f.stateHash();
    console.log(header("replay", `${e.input.length.toLocaleString()} journaled commands re-applied in ${ms.toFixed(0)}ms`) + "\n");
    console.log(`  live    ${a}\n  replay  ${b}\n\n  ${a === b ? c.green("✓ identical state: books, stops, balances and sequence numbers") : c.red("✗ divergence")}`); if (a !== b) process.exit(1);
  } else if (cmd === "serve") {
    const { createFixGateway } = await import("../src/node/fix-gateway.js"), e = new Engine(), port = +flag("port", 9878), m = new Market(e); fund(e, ["CLIENT", "ALGO1", "alice", "bob"]);
    setInterval(() => m.step(0.25), 250);
    createFixGateway(e, { log: (l) => console.log(c.dim(new Date().toISOString().slice(11, 23)) + " " + l) }).listen(port, () => {
      console.log(header("match", `FIX 4.4 gateway on tcp://localhost:${port} · agent market running on BTC-USD`) + "\n");
      const cl = new FixClient({ sender: "CLIENT" }); console.log(c.dim("  try:  node -e \"const s=require('net').connect(" + port + ");s.on('data',d=>console.log(d.toString().replace(/\\x01/g,'|')));s.write('" + pretty(cl.logon()).replace(/\|/g, "\\x01") + "')\"\n"));
    });
  } else fail(`unknown command ${cmd}\n\n${HELP}`);
} catch (e) { fail(e.stack || e.message); }
