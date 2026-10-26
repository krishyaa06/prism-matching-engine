import { Engine, Market, FixSession, FixClient, parse, execReport, toUnits, TAGS } from "../src/index.js";
import { $, esc, toast, Loop, bindLoop, LogView, Kpis, Chart, fit, hexA } from "./pro.js";

const OK = "#34f5c5", BAD = "#ff5c8a", WARN = "#ffb547", ACC2 = "#7c5cff", MUTED = "#5f6884", mono = "JetBrains Mono, monospace";
const S = "BTC-USD", U = (x) => BigInt(toUnits(x)), N = (u) => Number(u) / 1e8;
const fp = (u) => N(u).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fq = (u) => (+N(u).toFixed(4)).toString();
const E = new Engine({ fees: { maker: 1, taker: 5 } }), M = new Market(E, { seed: 42 }), bk = E.book(S);
E.ledger.deposit("you", "USD", U("250000")); E.ledger.deposit("you", "BTC", U("4"));
const START = 250000 + 4 * 65000;
let simT = Date.UTC(2026, 9, 26, 9, 15, 0) / 1000, dayT = 0;
const clock = () => new Date(simT * 1000).toISOString().slice(11, 19);
const log = new LogView($("#log"), 220), wire = new LogView($("#wire"), 120);
const L = (html) => log.html(html, clock()), W = (html) => wire.html(html, clock());

// ---------- FIX session for the human trader ----------
const sess = new FixSession(E, { sender: "PRISM", target: "CLIENT" }), cl = new FixClient({ sender: "CLIENT", target: "PRISM" });
let inHandle = false, clSeq = 0, myFills = 0, dirtyMine = true;
const SKIP = new Set([8, 9, 49, 56, 52, 10, 60]);
function showWire(raw, dir) {
  const m = parse(raw, { verify: false }), t = m.f[35], name = { A: "Logon", D: "NewOrderSingle", F: "CancelRequest", G: "Replace", 8: "ExecutionReport", 9: "CancelReject", 3: "Reject", 2: "ResendRequest" }[t] || t;
  const body = m.list.filter(([k]) => !SKIP.has(k) && k !== 35).map(([k, v]) => `<span class="dim">${TAGS[k] || k}=</span>${esc(v)}`).join(" ");
  const cls = t === "8" ? (m.f[150] === "F" ? "ok" : m.f[150] === "8" ? "bad" : "acc") : t === "9" || t === "3" ? "bad" : "warn";
  W(`<span class="m"><span class="${cls}">${dir} 35=${t} ${name}</span> ${body} <span class="dim">10=${m.f[10]}</span></span>`);
  $("#seq").textContent = `in ${sess.inSeq - 1} · out ${sess.outSeq - 1}`;
}
function send(raw) {
  showWire(raw, "→"); inHandle = true; let out; try { out = sess.handle(raw); } finally { inHandle = false; }
  for (const r of out) { showWire(r, "←"); const f = parse(r, { verify: false }).f; if (f[35] === "8" && f[150] === "8") status("✗ " + (f[58] || "rejected"), "bad"); else if (f[35] === "9") status("✗ " + (f[58] || "cancel rejected"), "bad"); else if (f[35] === "8") status(`✓ ${{ 0: "accepted", F: "filled", 4: "canceled", 5: "replaced", 6: "pending" }[f[150]] || f[150]} ${f[37] || ""}`, "ok"); }
  dirtyMine = true; return out;
}
send(cl.logon());
// unsolicited ExecutionReports: resting orders filled later by other participants
E.on((ev) => { if (ev.type === "report" && ev.account === "you" && !inHandle) { const raw = sess.out("8", execReport(ev)); showWire(raw, "←"); dirtyMine = true; } if (ev.type === "trade" && (ev.buyer === "you" || ev.seller === "you")) myFills++; });

// ---------- ticket ----------
let side = "buy";
for (const b of document.querySelectorAll("#side .btn")) b.onclick = () => { side = b.dataset.v; for (const x of document.querySelectorAll("#side .btn")) x.classList.toggle("on", x === b); };
const syncType = () => { const t = $("#otype").value; $("#pxf").hidden = t === "market" || t === "stop"; $("#spf").hidden = !t.startsWith("stop"); $("#post").disabled = t !== "limit"; if (t === "market") $("#tif").value = "IOC"; };
$("#otype").onchange = syncType;
function status(t, c) { const s = $("#tstat"); s.textContent = t; s.className = "tstat " + (c || ""); }
function order(o) { const id = "u" + ++clSeq; send(cl.order({ clOrdId: id, account: "you", symbol: S, ...o })); return id; }
$("#send").onclick = () => {
  const type = $("#otype").value, o = { side, type, qty: $("#qty").value.trim(), tif: $("#tif").value };
  if (type === "limit" || type === "stop-limit") o.px = $("#px").value.trim(); if (type.startsWith("stop")) o.stopPx = $("#spx").value.trim();
  if ($("#post").checked && type === "limit") o.postOnly = true;
  try { for (const k of ["qty", "px", "stopPx"]) if (o[k] != null) toUnits(o[k]); } catch { return status("✗ invalid number", "bad"); }
  order(o);
};
$("#join").onclick = () => { const b = bk.bids.best(); if (b == null) return toast("No bid to join"); order({ side: "buy", type: "limit", px: fp(b).replace(/,/g, ""), qty: $("#qty").value.trim() || "0.5", tif: "GTC", postOnly: true }); };
$("#lift").onclick = () => { const a = bk.asks.best(); if (a == null) return toast("No offer to lift"); order({ side: "buy", type: "limit", px: fp(a).replace(/,/g, ""), qty: $("#qty").value.trim() || "0.5", tif: "IOC" }); };
function renderMine() {
  dirtyMine = false; const rows = [];
  for (const id of sess.owned) { const o = E.orders.get(id); if (!o || !["new", "partial", "pending"].includes(o.status)) continue; rows.push(o); }
  $("#mine").innerHTML = rows.length ? rows.slice(-8).map((o) => `<div class="row"><span class="${o.side}c">${o.side.toUpperCase()}</span><span>${o.type === "limit" ? fp(o.px) : "stop " + fp(o.stopPx)}</span><span class="dim">${fq(o.leaves)}/${fq(o.qty)}</span><span class="sp"></span><span class="dim">${o.status}</span><button class="btn sm x" data-c="${o.clOrdId}">✕</button></div>`).join("") : `<div class="empty">No working orders. Send one from the ticket.</div>`;
  for (const b of document.querySelectorAll("#mine [data-c]")) b.onclick = () => send(cl.cancel(b.dataset.c, "x" + ++clSeq));
  const usd = E.ledger.get("you", "USD"), btc = E.ledger.get("you", "BTC"), mid = bk.mid() || 0, eq = N(usd.total) + N(btc.total) * N(mid), pnl = eq - START;
  $("#bal").innerHTML = `<div><span>USD</span><b>${fp(usd.avail)}</b><span>held ${fp(usd.held)}</span></div><div><span>BTC</span><b>${fq(btc.avail)}</b><span>held ${fq(btc.held)}</span></div>` +
    `<div><span>Equity (mark)</span><b>${eq.toLocaleString("en-US", { maximumFractionDigits: 0 })}</b><span class="${pnl >= 0 ? "ok" : "bad"}">${pnl >= 0 ? "+" : ""}${pnl.toFixed(0)} USD</span></div><div><span>My fills</span><b>${myFills}</b><span>maker 1 bp · taker 5 bp</span></div>`;
}

// ---------- tape ----------
let pend = [], flashPx = new Map(), stopFlash = [], lastTrade = null;
const win = { buy: 0, sell: 0, vol: 0 };
let vol24 = 0;
E.on((ev) => {
  if (ev.type === "trade") { pend.push(ev); win[ev.takerSide]++; win.vol += N(ev.qty); vol24 += N(ev.qty); lastTrade = { px: ev.px, side: ev.takerSide, t: 1 }; flashPx.set(ev.px, { t: 1, c: ev.takerSide === "buy" ? OK : BAD }); }
  else if (ev.type === "report" && ev.execType === "triggered") { stopFlash.push({ px: ev.stopPx, t: 1.4 }); L(`<span class="warn">STOP FIRED</span> ${ev.account} ${ev.side} ${fq(ev.qty)} <span class="dim">stop ${fp(ev.stopPx)} → market</span>`); }
});
function flushTape() {
  if (!pend.length) return; const by = new Map(); for (const t of pend) { const k = t.taker; if (!by.has(k)) by.set(k, []); by.get(k).push(t); } pend = [];
  for (const ts of by.values()) {
    const t = ts[0], who = t.takerSide === "buy" ? t.buyer : t.seller, q = ts.reduce((a, x) => a + N(x.qty), 0), cls = t.takerSide === "buy" ? "ok" : "bad";
    if (ts.length >= 4) { const pxs = ts.map((x) => x.px); L(`<span class="${cls}">SWEEP</span> ${who} ${t.takerSide} ${q.toFixed(3)} BTC <span class="dim">${ts.length} fills · ${fp(Math.max(...pxs))} → ${fp(Math.min(...pxs))}</span>`); }
    else if (who === "you" || t.buyer === "you" || t.seller === "you" || Math.random() < 0.35) L(`<span class="${cls}">${t.takerSide === "buy" ? "BUY " : "SELL"}</span> ${q.toFixed(4)} @ ${fp(t.px)} <span class="dim">${t.buyer} ← ${t.seller}${ts.length > 1 ? ` · ${ts.length} fills` : ""}</span>`);
  }
}

// ---------- controls ----------
let pulled = false;
$("#pull").onclick = () => {
  pulled = !pulled;
  for (const m of M.makers) { if (pulled) { for (const id of m.quotes.values()) { const o = E.orders.get(id); if (o && ["new", "partial"].includes(o.status)) E.cancel(id); } m.quotes.clear(); m.levels = 0; } else m.levels = 6; }
  if (!pulled) M.requote(true);
  $("#pull").textContent = pulled ? "Restore makers" : "Pull makers"; $("#pull").classList.toggle("on", pulled);
  L(pulled ? `<span class="bad">LIQUIDITY</span> market makers pulled every quote <span class="dim">spread blows out, market orders hit the 2% collar</span>` : `<span class="ok">LIQUIDITY</span> market makers re-quote <span class="dim">post-only ladders around fair value</span>`);
  toast(pulled ? "Makers pulled: only stray limit orders are left in the book" : "Makers are quoting again");
};
function whale(sd) {
  const before = bk.last, r = M.whale(sd, 40), q = N(r.order.cum), after = bk.last;
  L(`<span class="${sd === "buy" ? "ok" : "bad"}">WHALE</span> market ${sd} 40 BTC <span class="dim">filled ${q.toFixed(2)} · ${r.trades.length} trades · ${fp(before)} → ${fp(after)}${r.order.cum < r.order.qty ? " · rest canceled at collar" : ""}</span>`);
  M.fair = M.fair * 0.35 + N(after) * 0.65; // information: fair value partially follows the print
  toast(`Whale ${sd}: ${r.trades.length} fills, ${((N(after) / N(before) - 1) * 100).toFixed(2)}% move`);
}
$("#wsell").onclick = () => whale("sell"); $("#wbuy").onclick = () => whale("buy");
$("#stops").onclick = () => {
  const mid = N(bk.mid()); let n = 0;
  for (let i = 0; i < 10; i++) { const r = E.submit({ account: M.takers[i % M.takers.length], symbol: S, side: "sell", type: "stop", stopPx: (Math.round(mid * (0.9985 - i * 0.0007) * 100) / 100).toFixed(2), qty: (0.4 + (i % 4) * 0.35).toFixed(2) }); if (r.order.status === "pending") n++; }
  L(`<span class="warn">STOPS</span> ${n} sell stops planted 0.15–0.8% below mid <span class="dim">a whale sell now cascades through them</span>`); toast(`${n} sell stops resting below the market`);
};

// ---------- KPIs + charts ----------
const kp = new Kpis($("#kpis"), [
  { key: "mid", label: "Mid", tone: "acc", fmt: (v) => v.toLocaleString("en-US", { maximumFractionDigits: 0 }) },
  { key: "spr", label: "Spread", fmt: (v) => v.toFixed(1) + " bps" }, { key: "ops", label: "Orders / s", fmt: (v) => v.toFixed(0) },
  { key: "tps", label: "Trades / s", fmt: (v) => v.toFixed(1) }, { key: "vol", label: "Volume BTC", fmt: (v) => v.toFixed(1) },
  { key: "lat", label: "Cmd latency", fmt: (v) => v.toFixed(1) + " µs" },
]);
const ch1 = new Chart($("#ch1"), { series: [{ label: "mid", color: "--accent" }, { label: "last", color: ACC2 }], points: 90, min: null, area: false, fmtY: (v) => v.toFixed(0) });
const ch2 = new Chart($("#ch2"), { series: [{ label: "buy", color: OK }, { label: "sell", color: BAD }], points: 90, min: 0, area: false, fmtY: (v) => v.toFixed(0) });
const hist = [];

// ---------- canvas ----------
const prevQty = new Map(), qtyFlash = new Map();
function draw(dt = 0) {
  const { ctx, w, h: H } = fit($("#book")); ctx.clearRect(0, 0, w, H);
  for (const m of [flashPx, qtyFlash]) for (const [k, v] of m) { v.t -= dt * 1.6; if (v.t <= 0) m.delete(k); }
  stopFlash = stopFlash.filter((s) => (s.t -= dt) > 0);
  const narrow = w < 640, top = 40, pad = 14;
  const lad = narrow ? { x: pad, y: top, w: w - pad * 2, h: Math.round((H - top) * 0.56) - 10 } : { x: pad, y: top, w: Math.round(w * 0.44), h: H - top - 16 };
  const dep = narrow ? { x: pad, y: lad.y + lad.h + 18, w: w - pad * 2, h: H - lad.y - lad.h - 30 } : { x: lad.x + lad.w + 26, y: top, w: w - lad.w - pad * 2 - 26, h: H - top - 16 };
  ladder(ctx, lad, narrow); depth(ctx, dep, narrow);
}
function ladder(ctx, r, narrow) {
  const rowsSide = Math.max(4, Math.min(12, Math.floor((r.h - 26) / 2 / 18))), rh = (r.h - 26) / (rowsSide * 2 + 1);
  const asks = bk.asks.depth(rowsSide), bids = bk.bids.depth(rowsSide), maxQ = Math.max(1e-9, ...asks.map((l) => l.qty), ...bids.map((l) => l.qty));
  const mine = new Map(); for (const id of sess.owned) { const o = E.orders.get(id); if (o && ["new", "partial"].includes(o.status)) mine.set(o.px, (mine.get(o.px) || 0) + 1); }
  ctx.font = `600 10px ${mono}`; ctx.fillStyle = MUTED; ctx.textBaseline = "middle";
  const cPx = r.x + (narrow ? 4 : 8), cQ = r.x + r.w * (narrow ? 0.5 : 0.44), cN = r.x + r.w - 4, barX = r.x + r.w * (narrow ? 0.52 : 0.47), barW = r.w * (narrow ? 0.34 : 0.4);
  ctx.textAlign = "left"; ctx.fillText("PRICE", cPx, r.y + 8); ctx.textAlign = "right"; ctx.fillText("SIZE", cQ, r.y + 8); ctx.fillText("ORD", cN, r.y + 8);
  const row = (l, i, isAsk) => {
    const y = r.y + 18 + i * rh, cy = y + rh / 2, c = isAsk ? BAD : OK, p = prevQty.get((isAsk ? "a" : "b") + l.px);
    if (p != null && p !== l.qty) qtyFlash.set((isAsk ? "a" : "b") + l.px, { t: 1, up: l.qty > p }); prevQty.set((isAsk ? "a" : "b") + l.px, l.qty);
    const fl = qtyFlash.get((isAsk ? "a" : "b") + l.px), tr = flashPx.get(l.px);
    if (tr) { ctx.fillStyle = hexA(tr.c, 0.22 * tr.t); ctx.fillRect(r.x, y + 1, r.w, rh - 2); }
    ctx.fillStyle = hexA(c, 0.16 + (fl ? 0.25 * fl.t : 0)); ctx.fillRect(barX, y + 2, Math.max(2, (barW * l.qty) / maxQ), rh - 4);
    ctx.font = `${i === (isAsk ? asks.length - 1 : 0) ? 700 : 500} 11.5px ${mono}`; ctx.textAlign = "left"; ctx.fillStyle = c; ctx.fillText(fp(l.px), cPx, cy);
    ctx.textAlign = "right"; ctx.fillStyle = "#dfe6f5"; ctx.fillText(fq(l.qty), cQ, cy); ctx.fillStyle = MUTED; ctx.font = `500 10px ${mono}`; ctx.fillText(String(l.orders), cN, cy);
    if (mine.has(l.px)) { ctx.fillStyle = WARN; ctx.beginPath(); ctx.arc(r.x + 2, cy, 3, 0, 7); ctx.fill(); }
  };
  [...asks].reverse().forEach((l, i) => row(l, i + (rowsSide - asks.length), true));
  const sy = r.y + 18 + rowsSide * rh + rh / 2, b = bk.bids.best(), a = bk.asks.best();
  ctx.fillStyle = "rgba(255,255,255,.04)"; ctx.fillRect(r.x, sy - rh / 2 + 1, r.w, rh - 2);
  ctx.font = `600 11px ${mono}`; ctx.textAlign = "left"; ctx.fillStyle = lastTrade ? (lastTrade.side === "buy" ? OK : BAD) : MUTED;
  ctx.fillText(bk.last != null ? `${lastTrade?.side === "sell" ? "▼" : "▲"} ${fp(bk.last)}` : "no trades", cPx, sy);
  ctx.textAlign = "right"; ctx.fillStyle = MUTED; ctx.fillText(a != null && b != null ? `spread ${fp(a - b)} · ${(((a - b) / ((a + b) / 2)) * 1e4).toFixed(1)} bps` : "one-sided book", cN, sy);
  bids.forEach((l, i) => row(l, rowsSide + 1 + i, false));
  if (!asks.length && !bids.length) { ctx.textAlign = "center"; ctx.fillStyle = MUTED; ctx.fillText("empty book", r.x + r.w / 2, r.y + r.h / 2); }
}
function depth(ctx, r, narrow) {
  const mid = bk.mid(); if (mid == null) return; const span = 0.009, lo = mid * (1 - span), hi = mid * (1 + span), X = (p) => r.x + ((p - lo) / (hi - lo)) * r.w;
  const cum = (side, n) => { let c = 0; const pts = []; for (const l of side.depth(n)) { if (l.px < lo || l.px > hi) break; c += N(l.qty); pts.push([l.px, c]); } return pts; };
  const B = cum(bk.bids, 200), A = cum(bk.asks, 200), maxC = Math.max(1, ...B.map((p) => p[1]), ...A.map((p) => p[1])) * 1.12, ch = r.h - 34, Y = (c) => r.y + ch - (c / maxC) * (ch - 8);
  ctx.strokeStyle = "rgba(255,255,255,.06)"; ctx.lineWidth = 1; for (let i = 0; i <= 4; i++) { const y = r.y + (ch * i) / 4; ctx.beginPath(); ctx.moveTo(r.x, y); ctx.lineTo(r.x + r.w, y); ctx.stroke(); }
  const area = (pts, c, dir) => {
    if (!pts.length) return; ctx.beginPath(); ctx.moveTo(X(mid), Y(0)); let prev = 0;
    for (const [px, cc] of pts) { ctx.lineTo(X(px), Y(prev)); ctx.lineTo(X(px), Y(cc)); prev = cc; }
    ctx.lineTo(dir < 0 ? r.x : r.x + r.w, Y(prev)); ctx.lineTo(dir < 0 ? r.x : r.x + r.w, Y(0)); ctx.closePath();
    const g = ctx.createLinearGradient(0, r.y, 0, r.y + ch); g.addColorStop(0, hexA(c, 0.42)); g.addColorStop(1, hexA(c, 0.04)); ctx.fillStyle = g; ctx.fill(); ctx.strokeStyle = c; ctx.lineWidth = 1.6; ctx.stroke();
  };
  area(B, OK, -1); area(A, BAD, 1);
  ctx.setLineDash([3, 4]); ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.beginPath(); ctx.moveTo(X(mid), r.y); ctx.lineTo(X(mid), r.y + ch); ctx.stroke(); ctx.setLineDash([]);
  // resting stops = hidden liquidity demand, drawn as triangles on the axis
  for (const o of bk.stops) { const x = X(o.stopPx); if (x < r.x || x > r.x + r.w) continue; ctx.fillStyle = o.side === "sell" ? WARN : ACC2; ctx.beginPath(); ctx.moveTo(x, r.y + ch - 1); ctx.lineTo(x - 4, r.y + ch + 7); ctx.lineTo(x + 4, r.y + ch + 7); ctx.fill(); }
  for (const s of stopFlash) { const x = X(s.px); ctx.strokeStyle = hexA(WARN, s.t / 1.4); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, r.y + ch, 6 + (1.4 - s.t) * 22, 0, 7); ctx.stroke(); }
  ctx.font = `500 10px ${mono}`; ctx.fillStyle = MUTED; ctx.textBaseline = "alphabetic";
  const ticks = narrow ? [lo, mid, hi] : [lo, (lo + mid) / 2, mid, (mid + hi) / 2, hi];
  ticks.forEach((p, i) => { ctx.textAlign = i === 0 ? "left" : i === ticks.length - 1 ? "right" : "center"; ctx.fillText((N(p) / 1000).toFixed(2) + "k", X(p), r.y + ch + 20); });
  ctx.textAlign = "left"; ctx.fillStyle = OK; ctx.fillText("■ bids", r.x, r.y + r.h - 1); ctx.fillStyle = BAD; ctx.fillText("■ asks", r.x + 56, r.y + r.h - 1); ctx.fillStyle = WARN; ctx.fillText("▲ stops", r.x + 112, r.y + r.h - 1);
  ctx.textAlign = "right"; ctx.fillStyle = MUTED; ctx.fillText(`cumulative BTC · ±${(span * 100).toFixed(1)}%`, r.x + r.w, r.y + r.h - 1);
  ctx.textAlign = "right"; ctx.fillText(maxC.toFixed(0), r.x + r.w, r.y + 10);
}

// ---------- loop ----------
let acc = 0, lat = 0, o0 = 0;
function tick(dt, chart = true) {
  simT += dt; dayT += dt;
  const c0 = E.stats.orders + E.stats.cancels, t0 = performance.now(); M.step(dt); const el = performance.now() - t0, n = E.stats.orders + E.stats.cancels - c0;
  if (n > 0) lat = lat ? lat * 0.97 + ((el * 1000) / n) * 0.03 : (el * 1000) / n;
  if (dayT >= 120) { dayT = 0; const ex = E.endOfDay(); L(`<span class="acc">SESSION ROLL</span> ${ex.length} DAY orders expired <span class="dim">GTC orders and stops carry over</span>`); }
  flushTape(); acc += dt;
  if (acc >= 1) {
    const mid = bk.mid(), { bid, ask } = bk.bbo();
    if (chart) { hist.push([N(mid), N(bk.last ?? mid)]); if (hist.length > 90) hist.shift(); const all = hist.flat(), mn = Math.min(...all), mx = Math.max(...all), p = Math.max(5, (mx - mn) * 0.12); ch1.min = mn - p; ch1.max = mx + p; ch1.set([hist.map((x) => x[0]), hist.map((x) => x[1])]); ch2.push(win.buy / acc, win.sell / acc); }
    kp.set({ mid: N(mid), spr: bid != null && ask != null ? ((ask - bid) / mid) * 1e4 : 0, ops: (E.stats.orders - o0) / acc, tps: (win.buy + win.sell) / acc, vol: vol24, lat });
    kp.tone("spr", bid != null && ask != null && ((ask - bid) / mid) * 1e4 > 15 ? "bad" : ""); o0 = E.stats.orders;
    win.buy = win.sell = win.vol = 0; acc = 0; dirtyMine = true;
    const okL = E.ledger.verify().ok; $("#clock").textContent = innerWidth < 640 ? `BTC-USD · ${clock()} · ${E.stats.trades.toLocaleString()} trades` : `BTC-USD · ${clock()} UTC · ${E.stats.trades.toLocaleString()} trades · ledger ${okL ? "balanced" : "BROKEN"}`;
  }
  if (dirtyMine) renderMine();
}
for (let i = 0; i < 600; i++) tick(0.1); // prewarm 60 s
log.clear(); L(`<span class="acc">OPEN</span> BTC-USD continuous trading <span class="dim">3 makers · 6 takers · stops · FIX session CLIENT↔PRISM logged on</span>`);
$("#px").value = fp(bk.bids.best()).replace(/,/g, ""); $("#spx").value = (N(bk.mid()) * 0.997).toFixed(2);
const loop = new Loop((dt) => { tick(dt); draw(dt); });
bindLoop(loop, $("#sim")); draw(); loop.start();
setTimeout(() => { order({ side: "buy", type: "limit", px: fp(bk.bids.best()).replace(/,/g, ""), qty: "0.5", tif: "GTC", postOnly: true }); }, 1200);
setTimeout(() => $("#stops").click(), 2600);
setTimeout(() => whale("sell"), 4600);
addEventListener("resize", () => draw());
