// Matching engine: price-time priority CLOB per symbol with limit / market / IOC / FOK / post-only / stop orders,
// cancel and cancel-replace, self-trade prevention, fat-finger bands, pre-trade funds holds and a deterministic journal.
import { OrderBook } from "./book.js";
import { Ledger } from "./ledger.js";
import { toUnits, notional, fee as feeOf, fmt, SCALE } from "./decimal.js";
import { sha256 } from "./lib/sha256.js";

const U = (v) => (v == null ? v : typeof v === "number" ? v : toUnits(v));
export const DEFAULT_SYMBOLS = [
  { symbol: "BTC-USD", base: "BTC", quote: "USD", tick: "0.01", lot: "0.0001" },
  { symbol: "ETH-USD", base: "ETH", quote: "USD", tick: "0.01", lot: "0.001" },
  { symbol: "ETH-BTC", base: "ETH", quote: "BTC", tick: "0.00001", lot: "0.001" },
  { symbol: "EUR-USD", base: "EUR", quote: "USD", tick: "0.00001", lot: "1" },
];

export class Engine {
  constructor({ symbols = DEFAULT_SYMBOLS, ledger = new Ledger(), fees = { maker: 2, taker: 10 }, band = 0.1, collar = 0.02, stp = "cancel-resting", maxQty = null, retain = 20000 } = {}) {
    this.retain = retain; this.done = [];
    this.ledger = ledger; this.fees = fees; this.band = band; this.collar = collar; this.stp = stp; this.maxQty = maxQty;
    this.sym = new Map(); this.books = new Map(); this.orders = new Map(); this.byCl = new Map();
    this.seq = 0; this.tradeSeq = 0; this.input = []; this.subs = []; this.stats = { orders: 0, trades: 0, cancels: 0, rejects: 0 };
    for (const s of symbols) this.addSymbol(s);
  }
  addSymbol({ symbol, base, quote, tick, lot }) {
    const t = U(tick), l = U(lot); if ((BigInt(t) * BigInt(l)) % SCALE !== 0n) throw new Error(`${symbol}: tick × lot must be a multiple of 1e-8 quote units`);
    this.sym.set(symbol, { symbol, base, quote, tick: t, lot: l }); this.books.set(symbol, new OrderBook(symbol)); this.vol = this.vol || {};
  }
  on(fn) { this.subs.push(fn); return () => (this.subs = this.subs.filter((f) => f !== fn)); }
  emit(e) { for (const f of this.subs) f(e); }
  book(symbol) { return this.books.get(symbol); }

  // ------------------------------------------------------------------ commands
  submit(req) { this.input.push({ op: "submit", req: { ...req } }); return this._submit(req); }
  cancel(id, account) { this.input.push({ op: "cancel", id, account }); return this._cancel(id, account); }
  replace(id, changes) { this.input.push({ op: "replace", id, changes: { ...changes } }); return this._replace(id, changes); }

  _submit(req) {
    const out = [], s = this.sym.get(req.symbol), side = req.side, type = req.type || "limit";
    const o = { id: "O" + ++this.seq, clOrdId: req.clOrdId || "C" + this.seq, account: req.account, symbol: req.symbol, side, type, tif: req.tif || (type === "market" ? "IOC" : "GTC"), postOnly: !!req.postOnly,
      px: U(req.px), stopPx: U(req.stopPx), qty: U(req.qty), leaves: 0, cum: 0, sumN: 0n, hold: 0n, holdPx: null, status: "new", ts: this.seq };
    this.stats.orders++;
    const reject = (text) => { o.status = "rejected"; this.stats.rejects++; const r = this.report(o, "rejected", { text }); out.push(r); return { order: o, reports: out, trades: [] }; };
    if (!s) return reject("unknown symbol");
    if (side !== "buy" && side !== "sell") return reject("side must be buy or sell");
    if (!["limit", "market", "stop", "stop-limit"].includes(type)) return reject("unknown order type");
    if (!["GTC", "IOC", "FOK", "DAY"].includes(o.tif)) return reject("unknown time in force");
    if (!(o.qty > 0) || o.qty % s.lot) return reject(`qty must be a positive multiple of lot ${fmt(s.lot)}`);
    if (this.maxQty && o.qty > U(this.maxQty)) return reject("qty above max order size");
    if (type === "limit" || type === "stop-limit") { if (!(o.px > 0) || o.px % s.tick) return reject(`price must be a positive multiple of tick ${fmt(s.tick)}`); }
    if (type.startsWith("stop") && (!(o.stopPx > 0) || o.stopPx % s.tick)) return reject("stop price must be a multiple of tick");
    if (o.postOnly && type !== "limit") return reject("post-only requires a limit order");
    if (o.postOnly && o.tif !== "GTC" && o.tif !== "DAY") return reject("post-only cannot be IOC/FOK");
    const bk = this.books.get(o.symbol), ref = bk.last ?? bk.mid();
    if (type === "limit" && ref != null && (side === "buy" ? o.px > ref * (1 + this.band) : o.px < ref * (1 - this.band))) return reject(`price outside ${this.band * 100}% band around ${fmt(Math.round(ref), 2)}`);
    // funds hold at the worst price this order could ever trade at
    let worst = o.px;
    if (type === "market") { const best = bk.opposite(side).best(); if (best == null) return reject("no liquidity"); worst = this.collarPx(s, side, best); o.px = worst; }
    if (type === "stop") worst = this.collarPx(s, side, o.stopPx);
    const need = side === "buy" ? this.buyHold(worst, o.qty) : BigInt(o.qty), ccy = side === "buy" ? s.quote : s.base;
    if (!this.ledger.canHold(o.account, ccy, need)) return reject(`insufficient ${ccy}: need ${fmt(need, ccy === "USD" ? 2 : 8)}`);
    this.ledger.hold(o.account, ccy, need, `hold ${o.id}`); o.hold = need; o.holdPx = worst; o.leaves = o.qty;
    this.orders.set(o.id, o); this.byCl.set(o.clOrdId, o.id);
    if (o.postOnly) { const best = bk.opposite(side).best(); if (best != null && (side === "buy" ? o.px >= best : o.px <= best)) { this.releaseAll(o, s); o.status = "rejected"; this.stats.rejects++; out.push(this.report(o, "rejected", { text: "post-only order would take liquidity" })); return { order: o, reports: out, trades: [] }; } }
    out.push(this.report(o, "new"));
    if (type.startsWith("stop")) {
      if (bk.last != null && this.triggered(o, bk.last)) { const trades = []; this.fire(o, s, bk, out, trades); this.runStops(bk, s, out, trades); return { order: o, reports: out, trades }; }
      bk.stops.push(o); o.status = "pending"; return { order: o, reports: out, trades: [] };
    }
    const trades = []; this.execute(o, s, bk, out, trades); this.runStops(bk, s, out, trades);
    return { order: o, reports: out, trades };
  }
  collarPx(s, side, ref) { const p = side === "buy" ? ref * (1 + this.collar) : ref * (1 - this.collar); return Math.max(s.tick, (side === "buy" ? Math.floor(p / s.tick) : Math.ceil(p / s.tick)) * s.tick); }
  buyHold(px, qty) { const n = notional(px, qty); return n + feeOf(n, Math.max(this.fees.maker, this.fees.taker)); }
  triggered(o, last) { return o.side === "buy" ? last >= o.stopPx : last <= o.stopPx; }
  fire(o, s, bk, out, trades) {
    bk.stops = bk.stops.filter((x) => x !== o);
    if (o.type === "stop") { const best = bk.opposite(o.side).best(); if (best == null) { this.releaseAll(o, s); o.status = "canceled"; out.push(this.report(o, "canceled", { text: "stop triggered, no liquidity" })); return; } o.px = o.side === "buy" ? Math.min(this.collarPx(s, "buy", best), o.holdPx) : Math.max(this.collarPx(s, "sell", best), o.holdPx); o.tif = "IOC"; }
    o.status = "new"; out.push(this.report(o, "triggered", { text: `stop ${fmt(o.stopPx, 2)} hit` })); this.execute(o, s, bk, out, trades);
  }
  runStops(bk, s, out, trades) {
    for (let guard = 0; guard < 10000; guard++) {
      const hit = bk.stops.filter((o) => bk.last != null && this.triggered(o, bk.last)).sort((a, b) => a.ts - b.ts)[0];
      if (!hit) return; this.fire(hit, s, bk, out, trades);
    }
  }
  crosses(o, px) { return o.side === "buy" ? px <= o.px : px >= o.px; }
  execute(o, s, bk, out, trades) {
    const opp = bk.opposite(o.side);
    if (o.tif === "FOK") { let avail = 0; for (const px of opp.prices) { if (!this.crosses(o, px)) break; const lv = opp.levels.get(px); for (let i = lv.head; i < lv.q.length && avail < o.leaves; i++) { const m = lv.q[i]; if (!m.dead && (this.stp === "none" || m.account !== o.account)) avail += m.leaves; } if (avail >= o.leaves) break; }
      if (avail < o.leaves) { this.releaseAll(o, s); o.status = "canceled"; out.push(this.report(o, "canceled", { text: "FOK: not enough liquidity to fill completely" })); return; } }
    while (o.leaves > 0 && opp.prices.length && this.crosses(o, opp.prices[0])) {
      const lv = opp.levels.get(opp.prices[0]), m = opp.front(lv);
      if (m.account === o.account && this.stp !== "none") {
        if (this.stp === "cancel-resting") { opp.remove(m); this.releaseAll(m, s); m.status = "canceled"; this.stats.cancels++; out.push(this.report(m, "canceled", { text: "self-trade prevention" })); continue; }
        break; // cancel-taker: remainder of the incoming order is canceled below
      }
      const q = Math.min(o.leaves, m.leaves), px = m.px;
      this.settle(o, m, px, q, s); opp.reduce(m, q);
      const t = { id: "T" + ++this.tradeSeq, symbol: s.symbol, px, qty: q, taker: o.id, maker: m.id, takerSide: o.side, buyer: o.side === "buy" ? o.account : m.account, seller: o.side === "sell" ? o.account : m.account, seq: this.seq };
      trades.push(t); this.stats.trades++; bk.last = px; this.emit({ type: "trade", ...t });
      for (const x of [m, o]) { x.leaves -= q; x.cum += q; x.sumN += notional(px, q); x.status = x.leaves ? "partial" : "filled"; out.push(this.report(x, "trade", { lastPx: px, lastQty: q, liquidity: x === o ? "taker" : "maker" })); }
      if (m.leaves === 0) { m.dead = true; lv.n--; lv.head++; if (lv.n === 0) opp.dropLevel(lv); else opp.compact(lv); this.releaseAll(m, s); }
    }
    if (o.leaves > 0) {
      if (o.tif === "IOC" || o.tif === "FOK" || o.type === "market" || (m0(o, opp) && this.stp === "cancel-taker")) { this.releaseAll(o, s); o.status = "canceled"; this.stats.cancels++; out.push(this.report(o, "canceled", { text: o.type === "market" ? "market order remainder canceled (collar or liquidity)" : o.tif === "IOC" ? "IOC remainder canceled" : "self-trade prevention" })); }
      else { bk.side(o.side).add(o); this.emit({ type: "book", symbol: s.symbol }); }
    } else this.releaseAll(o, s);
    function m0(o, opp) { const p = opp.prices[0]; if (p == null) return false; const lv = opp.levels.get(p), f = opp.front(lv); return f && f.account === o.account && (o.side === "buy" ? p <= o.px : p >= o.px); }
  }
  settle(t, m, px, q, s) {
    const buyer = t.side === "buy" ? t : m, seller = buyer === t ? m : t, n = notional(px, q);
    const bf = feeOf(n, buyer === t ? this.fees.taker : this.fees.maker), sf = feeOf(n, seller === t ? this.fees.taker : this.fees.maker);
    const hq = this.buyHold(buyer.holdPx, q), sq = BigInt(q);
    this.ledger.post(`trade ${s.symbol} ${buyer.id}/${seller.id}`, [
      [buyer.account, s.quote, -hq, "held"], [buyer.account, s.quote, hq - n - bf, "avail"], [seller.account, s.quote, n - sf, "avail"], ["fees", s.quote, bf + sf, "avail"],
      [seller.account, s.base, -sq, "held"], [buyer.account, s.base, sq, "avail"],
    ]);
    buyer.hold -= hq; seller.hold -= sq;
  }
  releaseAll(o, s) { if (o.hold > 0n) { this.ledger.release(o.account, o.side === "buy" ? s.quote : s.base, o.hold, `release ${o.id}`); o.hold = 0n; } }

  _cancel(id, account) {
    const o = this.orders.get(id) || this.orders.get(this.byCl.get(id)); const out = [];
    if (!o || !["new", "partial", "pending"].includes(o.status)) { this.stats.cancelRejects = (this.stats.cancelRejects || 0) + 1; return { ok: false, reports: [{ execType: "cancel-rejected", orderId: id, text: "unknown order or already done" }] }; }
    if (account && o.account !== account) return { ok: false, reports: [{ execType: "cancel-rejected", orderId: id, text: "not your order" }] };
    const s = this.sym.get(o.symbol), bk = this.books.get(o.symbol);
    if (o.status === "pending") bk.stops = bk.stops.filter((x) => x !== o); else bk.side(o.side).remove(o);
    this.releaseAll(o, s); o.status = "canceled"; this.stats.cancels++; out.push(this.report(o, "canceled")); this.emit({ type: "book", symbol: s.symbol });
    return { ok: true, order: o, reports: out };
  }
  // Cancel/replace: a quantity decrease at the same price keeps time priority; anything else re-queues at the back.
  _replace(id, ch) {
    const o = this.orders.get(id) || this.orders.get(this.byCl.get(id));
    if (!o || !["new", "partial"].includes(o.status) || o.type !== "limit") return { ok: false, reports: [{ execType: "cancel-rejected", orderId: id, text: "only resting limit orders can be replaced" }] };
    const s = this.sym.get(o.symbol), bk = this.books.get(o.symbol), px = ch.px != null ? U(ch.px) : o.px, qty = ch.qty != null ? U(ch.qty) : o.qty, leaves = qty - o.cum;
    const rej = (text) => ({ ok: false, reports: [{ execType: "cancel-rejected", orderId: o.id, text }] });
    if (leaves <= 0) return rej("new quantity is not above filled quantity"); if (qty % s.lot || px % s.tick) return rej("tick/lot violation");
    if (ch.clOrdId) { this.byCl.set(ch.clOrdId, o.id); o.clOrdId = ch.clOrdId; }
    if (px === o.px && leaves <= o.leaves) { // in place, keep priority
      const d = o.leaves - leaves; bk.side(o.side).reduce(o, d); o.leaves = leaves; o.qty = qty;
      const keep = o.side === "buy" ? this.buyHold(o.holdPx, leaves) : BigInt(leaves); this.ledger.release(o.account, o.side === "buy" ? s.quote : s.base, o.hold - keep, `amend ${o.id}`); o.hold = keep;
      const r = [this.report(o, "replaced", { text: "quantity reduced, priority kept" })]; this.emit({ type: "book", symbol: s.symbol }); return { ok: true, order: o, reports: r, trades: [] };
    }
    const ccy = o.side === "buy" ? s.quote : s.base, need = o.side === "buy" ? this.buyHold(px, leaves) : BigInt(leaves);
    if (this.ledger.get(o.account, ccy).avail + o.hold < need) return rej("insufficient funds for replace");
    bk.side(o.side).detach(o); this.releaseAll(o, s); this.ledger.hold(o.account, ccy, need, `hold ${o.id}`);
    Object.assign(o, { px, qty, leaves, hold: need, holdPx: px, ts: ++this.seq, status: o.cum ? "partial" : "new" });
    const out = [this.report(o, "replaced", { text: "re-queued (lost priority)" })], trades = []; this.execute(o, s, bk, out, trades); this.runStops(bk, s, out, trades);
    return { ok: true, order: o, reports: out, trades };
  }
  endOfDay() { const out = []; for (const o of this.orders.values()) if (o.tif === "DAY" && ["new", "partial", "pending"].includes(o.status)) { const r = this._cancel(o.id); r.reports.forEach((x) => (x.execType = "expired")); out.push(...r.reports); } return out; }

  report(o, execType, x = {}) {
    const r = { execType, orderId: o.id, clOrdId: o.clOrdId, account: o.account, symbol: o.symbol, side: o.side, ordType: o.type, status: o.status, px: o.px, qty: o.qty, cumQty: o.cum, leavesQty: ["canceled", "rejected", "filled"].includes(o.status) ? 0 : o.leaves, avgPx: o.cum ? Number((o.sumN * SCALE) / BigInt(o.cum)) : 0, ...x };
    if (["filled", "canceled", "rejected", "expired"].includes(o.status) && !o.final) { o.final = true; this.done.push(o); if (this.done.length > this.retain) { const x = this.done.shift(); this.orders.delete(x.id); if (this.byCl.get(x.clOrdId) === x.id) this.byCl.delete(x.clOrdId); } }
    this.emit({ type: "report", ...r }); return r;
  }
  // Deterministic state hash: replaying the same input journal on a fresh engine must reproduce it exactly.
  stateHash() {
    const books = [...this.books.values()].map((b) => [b.symbol, [...b.bids.orders()].map((o) => [o.id, o.px, o.leaves]), [...b.asks.orders()].map((o) => [o.id, o.px, o.leaves]), b.stops.map((o) => o.id), b.last]);
    const bal = [...this.ledger.bal.values()].map((r) => [r.acct, r.ccy, r.avail.toString(), r.held.toString()]).sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1));
    return sha256(JSON.stringify({ books, bal, seq: this.seq, trades: this.tradeSeq }));
  }
  static replay(input, opts, setup) { const e = new Engine(opts); setup?.(e); for (const c of input) c.op === "submit" ? e.submit(c.req) : c.op === "cancel" ? e.cancel(c.id, c.account) : e.replace(c.id, c.changes); return e; }
  // Settlement: net movement per account and currency since a snapshot (e.g. start of day), plus fees.
  snapshot() { return new Map([...this.ledger.bal.values()].map((r) => [r.acct + "/" + r.ccy, r.avail + r.held])); }
  settlement(since) { const rows = []; for (const r of this.ledger.bal.values()) { if (r.acct === "world") continue; const d = r.avail + r.held - (since.get(r.acct + "/" + r.ccy) || 0n); if (d !== 0n) rows.push({ account: r.acct, ccy: r.ccy, net: d }); } return rows.sort((a, b) => (a.account + a.ccy < b.account + b.ccy ? -1 : 1)); }
}
