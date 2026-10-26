// Agent-based market used by the CLI demo, the benchmark and the browser simulator:
// inventory-skewed market makers, Poisson noise takers, stop-loss users and an occasional whale.
import { toUnits } from "./decimal.js";
import { rng } from "./lib/rng.js";

export class Market {
  constructor(engine, { symbol = "BTC-USD", fair = 65000, vol = 0.0006, seed = 7, makers = 3, takers = 6, rate = 12 } = {}) {
    this.e = engine; this.symbol = symbol; this.s = engine.sym.get(symbol); this.fair = fair; this.vol = vol; this.r = rng(seed); this.rate = rate; this.t = 0;
    this.makers = Array.from({ length: makers }, (_, i) => ({ id: "mm" + (i + 1), quotes: new Map(), spread: 2 + i * 1.5, size: 0.4 + i * 0.25, levels: 6, skew: 0 }));
    this.takers = Array.from({ length: takers }, (_, i) => "trader" + (i + 1));
    const L = engine.ledger, { base, quote } = this.s, big = (x) => BigInt(toUnits(x));
    for (const m of this.makers) { L.deposit(m.id, quote, big(40e6)); L.deposit(m.id, base, big(fair > 1000 ? 600 : 6e6)); }
    for (const t of this.takers) { L.deposit(t, quote, big(8e6)); L.deposit(t, base, big(fair > 1000 ? 120 : 1.2e6)); }
    L.deposit("whale", quote, big(1e8)); L.deposit("whale", base, big(fair > 1000 ? 1500 : 1.5e7));
    this.momentum = 0; this.requote(true);
  }
  tick(px) { return Math.max(this.s.tick, Math.round(toUnits(px.toFixed(8)) / this.s.tick) * this.s.tick); }
  lots(q) { return Math.max(1, Math.round(toUnits(q.toFixed(8)) / this.s.lot)) * this.s.lot; }
  inv(m) { return Number(this.e.ledger.get(m.id, this.s.base).total) / 1e8; }
  requote(force = false) {
    for (const m of this.makers) {
      const skew = (this.inv(m) - (this.fair > 1000 ? 600 : 6e6)) * 0.4; // long inventory -> shade quotes down
      for (const side of ["buy", "sell"]) for (let l = 0; l < m.levels; l++) {
        const bps = m.spread + l * (3 + l), px = this.tick(this.fair * (1 + ((side === "buy" ? -1 : 1) * bps - skew * 0.02) / 1e4)), key = side + l, cur = m.quotes.get(key);
        const o = cur && this.e.orders.get(cur);
        if (o && (o.status === "new" || o.status === "partial") && !force && Math.abs(o.px - px) < this.s.tick * 3) continue;
        if (o && (o.status === "new" || o.status === "partial")) this.e.cancel(o.id);
        const r = this.e.submit({ account: m.id, symbol: this.symbol, side, px, qty: this.lots(m.size * (1 + l * 0.6) * (0.7 + this.r() * 0.6)), postOnly: true });
        if (r.order.status !== "rejected") m.quotes.set(key, r.order.id); else m.quotes.delete(key);
      }
    }
  }
  step(dt) {
    this.t += dt; const z = this.r.normal ? this.r.normal() : (this.r() + this.r() + this.r() - 1.5) * 2; this.fair *= Math.exp(this.vol * Math.sqrt(dt) * z); this.momentum = this.momentum * 0.95 + z * 0.05;
    this.requote();
    const out = [];
    let n = 0; const lam = this.rate * dt; let p = Math.exp(-lam), k = p, u = this.r(); while (u > k && n < 50) { n++; p *= lam / n; k += p; }
    for (let i = 0; i < n; i++) out.push(this.noise());
    if (this.r() < 0.03 * dt * 10) out.push(this.placeStop());
    return out;
  }
  noise() {
    const a = this.takers[Math.floor(this.r() * this.takers.length)], bk = this.e.book(this.symbol), mid = bk.mid() / 1e8 || this.fair;
    const side = this.r() < 0.5 + Math.max(-0.2, Math.min(0.2, (this.fair - mid) / mid * 400 + this.momentum)) ? "buy" : "sell", q = this.lots(Math.abs(0.05 + this.r() ** 3 * 1.6));
    const x = this.r();
    if (x < 0.62) return this.e.submit({ account: a, symbol: this.symbol, side, type: "market", qty: q });
    if (x < 0.8) return this.e.submit({ account: a, symbol: this.symbol, side, px: this.tick(mid * (1 + (side === "buy" ? 1 : -1) * 0.0004)), qty: q, tif: "IOC" });
    if (x < 0.95) return this.e.submit({ account: a, symbol: this.symbol, side, px: this.tick(mid * (1 + (side === "buy" ? -1 : 1) * (0.0001 + this.r() * 0.0008))), qty: q, tif: "DAY" });
    return this.e.submit({ account: a, symbol: this.symbol, side, px: this.tick(mid * (1 + (side === "buy" ? 1 : -1) * 0.0003)), qty: q, tif: "FOK" });
  }
  placeStop() {
    const a = this.takers[Math.floor(this.r() * this.takers.length)], mid = this.e.book(this.symbol).mid() / 1e8 || this.fair, sell = this.r() < 0.6;
    return this.e.submit({ account: a, symbol: this.symbol, side: sell ? "sell" : "buy", type: "stop", stopPx: this.tick(mid * (sell ? 0.996 - this.r() * 0.006 : 1.004 + this.r() * 0.006)), qty: this.lots(0.2 + this.r() * 0.8) });
  }
  whale(side, qty) { return this.e.submit({ account: "whale", symbol: this.symbol, side, type: "market", qty: this.lots(qty) }); }
}
