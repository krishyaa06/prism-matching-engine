// Multi-currency double-entry ledger with holds. Every movement is a balanced journal entry,
// so the sum over all accounts (including the external "world" account) is always zero per currency.
export class Ledger {
  constructor() { this.bal = new Map(); this.journal = []; this.seq = 0; }
  key(acct, ccy) { return acct + "\u0000" + ccy; }
  row(acct, ccy) { const k = this.key(acct, ccy); let r = this.bal.get(k); if (!r) { r = { acct, ccy, avail: 0n, held: 0n }; this.bal.set(k, r); } return r; }
  get(acct, ccy) { const r = this.row(acct, ccy); return { avail: r.avail, held: r.held, total: r.avail + r.held }; }
  post(memo, legs) { // legs: [[acct, ccy, delta(BigInt), bucket("avail"|"held")]]
    const sums = {}; for (const [, ccy, d] of legs) sums[ccy] = (sums[ccy] || 0n) + d;
    for (const [ccy, s] of Object.entries(sums)) if (s !== 0n) throw new Error(`unbalanced entry ${memo}: ${ccy} ${s}`);
    for (const [a, ccy, d, b = "avail"] of legs) { const r = this.row(a, ccy); r[b] += d; if (r[b] < 0n && a !== "world") throw new Error(`negative ${b} ${a} ${ccy}`); }
    this.journal.push({ seq: ++this.seq, memo, legs: legs.map(([a, c, d, b = "avail"]) => [a, c, d.toString(), b]) }); if (this.journal.length > 20000) this.journal.splice(0, 5000);
  }
  deposit(acct, ccy, amt) { this.post(`deposit ${acct}`, [["world", ccy, -amt], [acct, ccy, amt]]); }
  withdraw(acct, ccy, amt) { if (this.row(acct, ccy).avail < amt) throw new Error("insufficient funds"); this.post(`withdraw ${acct}`, [[acct, ccy, -amt], ["world", ccy, amt]]); }
  canHold(acct, ccy, amt) { return this.row(acct, ccy).avail >= amt; }
  hold(acct, ccy, amt, memo = "hold") { this.post(memo, [[acct, ccy, -amt, "avail"], [acct, ccy, amt, "held"]]); }
  release(acct, ccy, amt, memo = "release") { if (amt > 0n) this.post(memo, [[acct, ccy, -amt, "held"], [acct, ccy, amt, "avail"]]); }
  // Invariant: per currency, the sum of avail+held across every account (world included) is zero.
  verify() {
    const t = {}; for (const r of this.bal.values()) t[r.ccy] = (t[r.ccy] || 0n) + r.avail + r.held;
    const bad = Object.entries(t).filter(([, v]) => v !== 0n); return { ok: !bad.length, totals: t, bad };
  }
  accounts() { return [...new Set([...this.bal.values()].map((r) => r.acct))].filter((a) => a !== "world"); }
  balances(acct) { return [...this.bal.values()].filter((r) => r.acct === acct && (r.avail || r.held)).map((r) => ({ ccy: r.ccy, avail: r.avail, held: r.held })); }
}
