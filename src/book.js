// One side of a central limit order book: price levels kept sorted best-first, FIFO queues per level,
// O(1) cancel through lazy deletion and O(log n) level lookup through binary search.
const TOMB = Object.freeze({ dead: true, leaves: 0 });
export class BookSide {
  constructor(isBid) { this.bid = isBid; this.prices = []; this.levels = new Map(); }
  better(a, b) { return this.bid ? a > b : a < b; }
  idx(px) { let lo = 0, hi = this.prices.length; while (lo < hi) { const m = (lo + hi) >> 1; if (this.better(this.prices[m], px)) lo = m + 1; else hi = m; } return lo; }
  best() { return this.prices.length ? this.prices[0] : null; }
  add(o) {
    let lv = this.levels.get(o.px);
    if (!lv) { lv = { px: o.px, q: [], head: 0, qty: 0, n: 0 }; this.levels.set(o.px, lv); this.prices.splice(this.idx(o.px), 0, o.px); }
    lv.q.push(o); lv.qty += o.leaves; lv.n++;
  }
  remove(o) { // o must be resting
    const lv = this.levels.get(o.px); lv.qty -= o.leaves; lv.n--; o.dead = true;
    if (lv.n === 0) this.dropLevel(lv); else this.compact(lv);
  }
  // Pull an order out so the same object can be re-queued (replace): its old slot becomes a tombstone,
  // otherwise the lazily-deleted entry would come back to life when o.dead is reset.
  detach(o) { const lv = this.levels.get(o.px), i = lv.q.indexOf(o, lv.head); if (i >= 0) lv.q[i] = TOMB; this.remove(o); o.dead = false; }
  reduce(o, by) { this.levels.get(o.px).qty -= by; }
  dropLevel(lv) { this.levels.delete(lv.px); const i = this.idx(lv.px); if (this.prices[i] === lv.px) this.prices.splice(i, 1); }
  compact(lv) { if (lv.head > 32 && lv.head * 2 > lv.q.length) { lv.q = lv.q.slice(lv.head); lv.head = 0; } }
  front(lv) { while (lv.head < lv.q.length && lv.q[lv.head].dead) lv.head++; return lv.q[lv.head]; }
  depth(n = 10) { return this.prices.slice(0, n).map((px) => { const lv = this.levels.get(px); return { px, qty: lv.qty, orders: lv.n }; }); }
  *orders() { for (const px of this.prices) { const lv = this.levels.get(px); for (let i = lv.head; i < lv.q.length; i++) if (!lv.q[i].dead) yield lv.q[i]; } }
}
export class OrderBook {
  constructor(symbol) { this.symbol = symbol; this.bids = new BookSide(true); this.asks = new BookSide(false); this.last = null; this.stops = []; }
  side(s) { return s === "buy" ? this.bids : this.asks; }
  opposite(s) { return s === "buy" ? this.asks : this.bids; }
  bbo() { return { bid: this.bids.best(), ask: this.asks.best() }; }
  mid() { const { bid, ask } = this.bbo(); return bid != null && ask != null ? (bid + ask) / 2 : bid ?? ask ?? this.last; }
  depth(n = 10) { return { bids: this.bids.depth(n), asks: this.asks.depth(n) }; }
}
