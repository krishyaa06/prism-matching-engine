import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { Engine, Market, Ledger, toUnits, fmt, notional, encode, parse, FixSession, FixClient, describe } from "../src/index.js";
import { createFixGateway } from "../src/node/fix-gateway.js";

const U = (x) => BigInt(toUnits(x));
const mk = (opts) => { const e = new Engine(opts); for (const a of ["a", "b", "c"]) { e.ledger.deposit(a, "USD", U("10000000")); e.ledger.deposit(a, "BTC", U("100")); e.ledger.deposit(a, "ETH", U("1000")); } return e; };
const S = "BTC-USD", lim = (account, side, px, qty, x = {}) => ({ account, symbol: S, side, px, qty, ...x });

test("decimal: exact fixed-point parsing, formatting and notional", () => {
  assert.equal(toUnits("65000.25"), 6500025000000); assert.equal(toUnits("0.00000001"), 1); assert.equal(toUnits(".5"), 50000000);
  assert.equal(fmt(toUnits("-12.5"), 2), "-12.50"); assert.throws(() => toUnits("1e5"));
  assert.equal(notional(toUnits("65000.01"), toUnits("0.0001")), U("6.500001"));
  assert.throws(() => toUnits("0.000000001"), /bad amount|precision/);
});
test("price-time priority: better price first, then FIFO within a level", () => {
  const e = mk(); e.submit(lim("a", "sell", "100", "1")); e.submit(lim("b", "sell", "100", "1")); e.submit(lim("c", "sell", "99", "1"));
  const r = e.submit(lim("a", "buy", "100", "2.5", { tif: "IOC" })), makers = r.trades.map((t) => e.orders.get(t.maker).account);
  assert.deepEqual(r.trades.map((t) => fmt(t.px, 0)), ["99", "100"]); // a's own ask was removed by STP, b filled next
  assert.equal(r.reports.find((x) => x.execType === "canceled" && x.text === "self-trade prevention").account, "a");
  assert.deepEqual(r.trades.map((t) => t.seller), ["c", "b"]);
});
test("order types: market collar, IOC remainder, FOK all-or-nothing, post-only", () => {
  const e = mk(); e.submit(lim("a", "sell", "100", "1")); e.submit(lim("a", "sell", "101", "1")); e.submit(lim("a", "sell", "103", "1"));
  const m = e.submit({ account: "b", symbol: S, side: "buy", type: "market", qty: "5" }); // collar = 100 * 1.02 = 102
  assert.equal(m.trades.length, 2); assert.equal(m.order.status, "canceled"); assert.equal(fmt(m.order.cum, 0), "2");
  const f = e.submit(lim("b", "buy", "103", "2", { tif: "FOK" })); assert.equal(f.trades.length, 0); assert.match(f.reports.at(-1).text, /FOK/);
  const f2 = e.submit(lim("b", "buy", "103", "1", { tif: "FOK" })); assert.equal(f2.order.status, "filled");
  e.submit(lim("a", "sell", "105", "1")); assert.equal(e.submit(lim("b", "buy", "105", "1", { postOnly: true })).order.status, "rejected");
  assert.equal(e.submit(lim("b", "buy", "104", "1", { postOnly: true })).order.status, "new");
  assert.equal(e.submit({ account: "b", symbol: "ETH-USD", side: "buy", type: "market", qty: "1" }).reports[0].text, "no liquidity");
});
test("validation: tick, lot, band, funds", () => {
  const e = mk(); e.submit(lim("a", "sell", "100", "1")); e.submit(lim("b", "buy", "100", "0.5"));
  assert.match(e.submit(lim("a", "buy", "100.001", "1")).reports[0].text, /tick/);
  assert.match(e.submit(lim("a", "buy", "100", "0.00001")).reports[0].text, /lot/);
  assert.match(e.submit(lim("a", "buy", "120", "1")).reports[0].text, /band/);
  assert.match(e.submit(lim("a", "buy", "100", "999999")).reports[0].text, /insufficient USD/);
});
test("cancel/replace: qty-down keeps priority, price change re-queues and can match", () => {
  const e = mk(), o1 = e.submit(lim("a", "buy", "100", "2")).order, o2 = e.submit(lim("b", "buy", "100", "1")).order;
  e.replace(o1.id, { qty: "1" }); assert.deepEqual([...e.book(S).bids.orders()].map((o) => o.id), [o1.id, o2.id]);
  e.replace(o1.id, { qty: "1.5" }); assert.deepEqual([...e.book(S).bids.orders()].map((o) => o.id), [o2.id, o1.id], "qty up loses priority");
  for (let i = 0; i < 3; i++) e.replace(o1.id, { px: i % 2 ? "100" : "99" }); assert.equal([...e.book(S).bids.orders()].length, 2, "no ghost entries after repeated re-queues");
  e.submit(lim("c", "sell", "101", "1")); const r = e.replace(o2.id, { px: "101" }); assert.equal(r.trades.length, 1); assert.equal(e.orders.get(o2.id).status, "filled");
  assert.equal(e.cancel(o1.id).ok, true); assert.equal(e.cancel(o1.id).ok, false); assert.equal(e.book(S).bids.prices.length, 0);
});
test("stops trigger on last trade and cascade", () => {
  const e = mk(); e.submit(lim("a", "buy", "100", "5")); e.submit(lim("a", "buy", "99", "5")); e.submit(lim("c", "sell", "100.5", "1")); e.submit(lim("b", "buy", "100.5", "1"));
  e.submit({ account: "b", symbol: S, side: "sell", type: "stop", stopPx: "100", qty: "2" }); e.submit({ account: "c", symbol: S, side: "sell", type: "stop", stopPx: "99", qty: "1" });
  assert.equal(e.book(S).stops.length, 2);
  const r = e.submit(lim("c", "sell", "100", "4.5", { tif: "IOC" }));
  assert.ok(r.reports.some((x) => x.execType === "triggered" && x.account === "b")); assert.ok(r.reports.some((x) => x.execType === "triggered" && x.account === "c"), "second stop fires off the first stop's fills");
  assert.equal(e.book(S).stops.length, 0);
});
test("ledger: holds, maker/taker fees, conservation per currency", () => {
  const e = mk({ fees: { maker: 2, taker: 10 } }); e.submit(lim("a", "sell", "50000", "1")); assert.equal(e.ledger.get("a", "BTC").held, U("1"));
  const b0 = e.ledger.get("b", "USD").avail; e.submit(lim("b", "buy", "50000", "1"));
  assert.equal(b0 - e.ledger.get("b", "USD").avail, U("50050")); assert.equal(e.ledger.get("b", "USD").held, 0n);
  assert.equal(e.ledger.get("fees", "USD").avail, U("60")); assert.equal(e.ledger.get("a", "USD").avail, U("10049990"));
  assert.ok(e.ledger.verify().ok); assert.throws(() => e.ledger.post("bad", [["a", "USD", 5n]]), /unbalanced/);
});
test("agent market keeps the ledger balanced and holds consistent with resting orders", () => {
  const e = new Engine(), m = new Market(e, { seed: 3 }); for (let i = 0; i < 300; i++) m.step(0.1);
  assert.ok(e.stats.trades > 100); assert.ok(e.ledger.verify().ok);
  const held = {}; for (const o of [...e.book(S).bids.orders(), ...e.book(S).asks.orders(), ...e.book(S).stops]) { const k = o.account + (o.side === "buy" ? "USD" : "BTC"); held[k] = (held[k] || 0n) + o.hold; }
  for (const [k, v] of Object.entries(held)) assert.equal(e.ledger.get(k.slice(0, -3), k.slice(-3)).held, v, "held balance == sum of open order holds for " + k);
  const { bid, ask } = e.book(S).bbo(); assert.ok(bid < ask, "book never crossed");
});
test("deterministic replay reproduces the exact state hash", () => {
  const e = new Engine(), m = new Market(e, { seed: 11 }); for (let i = 0; i < 100; i++) m.step(0.1);
  const f = Engine.replay(e.input, {}, (x) => { for (const j of e.ledger.journal.filter((j) => j.memo.startsWith("deposit"))) for (const [a, c, d] of j.legs) if (a !== "world") x.ledger.deposit(a, c, BigInt(d)); });
  assert.equal(f.stateHash(), e.stateHash());
});
test("FIX: BodyLength + CheckSum, session flow, gap detection, cancel reject", () => {
  const raw = encode([[35, "0"], [49, "A"], [56, "B"], [34, 1]]); const m = parse(raw); assert.equal(m.type, "0");
  assert.throws(() => parse(raw.replace(/10=\d+/, "10=001")), /CheckSum/); assert.throws(() => parse(raw.replace("35=0", "35=00")), /BodyLength/);
  const e = mk(), s = new FixSession(e), cl = new FixClient({ sender: "ALGO" });
  assert.match(describe(s.handle(cl.order({ clOrdId: "x", account: "a", symbol: S, side: "sell", px: "100", qty: "1" }))[0]), /MsgType=5/, "must log on first");
  cl.seq = 1; assert.match(describe(s.handle(cl.logon())[0]), /MsgType=A/);
  const r = s.handle(cl.order({ clOrdId: "s1", account: "a", symbol: S, side: "sell", px: "100", qty: "1" })).map((x) => parse(x).f); assert.equal(r[0][150], "0");
  const t = s.handle(cl.order({ clOrdId: "b1", account: "b", symbol: S, side: "buy", px: "100", qty: "0.4", tif: "IOC" })).map((x) => parse(x).f);
  assert.deepEqual(t.map((f) => f[150]), ["0", "F", "F"]); assert.equal(t[2][31], "100"); assert.equal(t[1][151], "0.6");
  const rep = s.handle(cl.replace("s1", "s1b", { qty: "0.8", px: "100" })).map((x) => parse(x).f); assert.equal(rep[0][150], "5"); assert.equal(rep[0][11], "s1b");
  assert.equal(parse(s.handle(cl.cancel("nope", "c9"))[0]).f[35], "9");
  assert.equal(parse(s.handle(cl.cancel("s1b", "c1"))[0]).f[39], "4");
  cl.seq += 3; assert.equal(parse(s.handle(cl.msg("0"))[0]).f[35], "2", "gap -> ResendRequest");
});
test("FIX gateway over TCP", async () => {
  const e = mk(), srv = createFixGateway(e); await new Promise((r) => srv.listen(0, r));
  const sock = net.connect(srv.address().port), cl = new FixClient(); let buf = "";
  const got = new Promise((res) => sock.on("data", (d) => { buf += d; if ((buf.match(/35=8/g) || []).length >= 1 && buf.includes("35=A")) res(); }));
  sock.write(cl.logon() + cl.order({ clOrdId: "t1", account: "a", symbol: S, side: "buy", px: "100", qty: "1" }));
  await got; sock.destroy(); srv.close();
  assert.match(buf, /35=A/); assert.match(buf, /35=8\x01.*11=t1/);
});
