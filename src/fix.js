// FIX 4.4 codec + session layer: BodyLength / CheckSum, MsgSeqNum gap detection, Logon / Heartbeat / TestRequest,
// NewOrderSingle (D), OrderCancelRequest (F), OrderCancelReplaceRequest (G) -> ExecutionReport (8) / OrderCancelReject (9).
import { fmt } from "./decimal.js";
export const SOH = "\x01";
const enc = new TextEncoder();
const sum = (s) => { let x = 0; for (const b of enc.encode(s)) x += b; return x % 256; };
export function encode(fields, { begin = "FIX.4.4" } = {}) {
  const body = fields.map(([t, v]) => `${t}=${v}${SOH}`).join("");
  const head = `8=${begin}${SOH}9=${enc.encode(body).length}${SOH}`;
  return head + body + `10=${String(sum(head + body)).padStart(3, "0")}${SOH}`;
}
export class FixError extends Error { constructor(msg, tag) { super(msg); this.tag = tag; } }
export function parse(raw, { verify = true } = {}) {
  const s = raw.includes(SOH) ? raw : raw.replace(/\|/g, SOH);
  const list = s.split(SOH).filter(Boolean).map((kv) => { const i = kv.indexOf("="); if (i < 1) throw new FixError(`malformed field "${kv}"`); return [+kv.slice(0, i), kv.slice(i + 1)]; });
  const f = {}; for (const [t, v] of list) if (!(t in f)) f[t] = v;
  if (list[0]?.[0] !== 8 || list[1]?.[0] !== 9 || list[2]?.[0] !== 35) throw new FixError("message must start with 8, 9, 35");
  if (verify) {
    const at = s.indexOf(SOH, s.indexOf("9=")) + 1, end = s.lastIndexOf(SOH + "10=") + 1, len = enc.encode(s.slice(at, end)).length;
    if (len !== +f[9]) throw new FixError(`BodyLength ${f[9]} != ${len}`, 9);
    const cs = sum(s.slice(0, end)); if (cs !== +f[10]) throw new FixError(`CheckSum ${f[10]} != ${String(cs).padStart(3, "0")}`, 10);
  }
  return { type: f[35], f, list };
}
// "8=FIX.4.4|9=..|" readable form
export const pretty = (m) => m.split(SOH).filter(Boolean).join("|");
export const TAGS = { 1: "Account", 6: "AvgPx", 8: "BeginString", 9: "BodyLength", 10: "CheckSum", 11: "ClOrdID", 14: "CumQty", 17: "ExecID", 18: "ExecInst", 31: "LastPx", 32: "LastQty", 34: "MsgSeqNum", 35: "MsgType", 37: "OrderID", 38: "OrderQty", 39: "OrdStatus", 40: "OrdType", 41: "OrigClOrdID", 44: "Price", 49: "SenderCompID", 52: "SendingTime", 54: "Side", 55: "Symbol", 56: "TargetCompID", 58: "Text", 59: "TimeInForce", 98: "EncryptMethod", 99: "StopPx", 108: "HeartBtInt", 112: "TestReqID", 150: "ExecType", 151: "LeavesQty", 434: "CxlRejResponseTo", 7: "BeginSeqNo", 16: "EndSeqNo", 45: "RefSeqNum", 373: "SessionRejectReason" };
const ORD = { 1: "market", 2: "limit", 3: "stop", 4: "stop-limit" }, ORD_R = { market: 1, limit: 2, stop: 3, "stop-limit": 4 };
const TIF = { 0: "DAY", 1: "GTC", 3: "IOC", 4: "FOK" }, TIF_R = { DAY: 0, GTC: 1, IOC: 3, FOK: 4 };
const EXEC = { new: "0", canceled: "4", replaced: "5", rejected: "8", trade: "F", expired: "C", triggered: "L" };
const STATUS = { new: "0", partial: "1", filled: "2", canceled: "4", rejected: "8", pending: "A", expired: "C" };
const dec = (u) => { const s = fmt(u, 8); return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s; };
const ts = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").replace("Z", "");

export function toOrder(m, account) {
  const f = m.f; if (!f[11]) throw new FixError("ClOrdID required", 11); if (!f[55]) throw new FixError("Symbol required", 55);
  if (f[54] !== "1" && f[54] !== "2") throw new FixError("Side must be 1 or 2", 54);
  const type = ORD[f[40]]; if (!type) throw new FixError(`unsupported OrdType ${f[40]}`, 40);
  return { clOrdId: f[11], account: f[1] || account, symbol: f[55], side: f[54] === "1" ? "buy" : "sell", type, qty: f[38], px: f[44], stopPx: f[99], tif: f[59] != null ? TIF[f[59]] ?? "?" : undefined, postOnly: (f[18] || "").split(" ").includes("6") };
}
export function newOrderSingle({ clOrdId, account, symbol, side, type = "limit", qty, px, stopPx, tif = "GTC", postOnly }) {
  const f = [[11, clOrdId], [1, account], [55, symbol], [54, side === "buy" ? 1 : 2], [60, ts()], [38, qty], [40, ORD_R[type]]];
  if (px != null) f.push([44, px]); if (stopPx != null) f.push([99, stopPx]); f.push([59, TIF_R[tif]]); if (postOnly) f.push([18, "6"]);
  return f;
}
let execSeq = 0;
export function execReport(r) {
  const f = [[37, r.orderId], [11, r.clOrdId], [17, "E" + ++execSeq], [150, EXEC[r.execType] ?? "I"], [39, STATUS[r.status] ?? "0"], [1, r.account], [55, r.symbol], [54, r.side === "buy" ? 1 : 2], [38, dec(r.qty)]];
  if (r.px && r.ordType !== "market" && r.ordType !== "stop") f.push([44, dec(r.px)]);
  if (r.lastQty) f.push([32, dec(r.lastQty)], [31, dec(r.lastPx)]);
  f.push([151, dec(r.leavesQty)], [14, dec(r.cumQty)], [6, dec(r.avgPx)]); if (r.text) f.push([58, r.text]);
  return f;
}

export class FixSession {
  constructor(engine, { sender = "PRISM", target = "CLIENT", heartbeat = 30 } = {}) { this.e = engine; this.sender = sender; this.target = target; this.hb = heartbeat; this.inSeq = 1; this.outSeq = 1; this.loggedOn = false; this.sent = []; this.owned = new Set(); }
  resolve(f) { const id = f[37] && f[37] !== "NONE" ? f[37] : this.e.byCl.get(f[41]); return id && this.owned.has(id) ? id : null; }
  out(type, fields) { const m = encode([[35, type], [49, this.sender], [56, this.target], [34, this.outSeq++], [52, ts()], ...fields]); this.sent.push(m); return m; }
  // Feed one raw inbound message, get back the raw outbound messages it produced.
  handle(raw) {
    let m; try { m = parse(raw); } catch (e) { return [this.out("3", [[45, this.inSeq], [58, e.message], [373, e.tag === 10 ? 5 : 0]])]; }
    const seq = +m.f[34];
    if (m.type !== "A" && !this.loggedOn) return [this.out("5", [[58, "first message must be Logon"]])];
    if (seq > this.inSeq && m.type !== "4") { const r = [this.out("2", [[7, this.inSeq], [16, 0]])]; return r; } // gap -> ResendRequest
    if (seq < this.inSeq && m.f[43] !== "Y") { this.loggedOn = false; return [this.out("5", [[58, `MsgSeqNum too low, expecting ${this.inSeq} but received ${seq}`]])]; }
    this.inSeq = seq + 1; this.target = m.f[49] || this.target;
    switch (m.type) {
      case "A": this.loggedOn = true; this.hb = +m.f[108] || this.hb; return [this.out("A", [[98, 0], [108, this.hb]])];
      case "0": return [];
      case "1": return [this.out("0", [[112, m.f[112] || ""]])];
      case "5": this.loggedOn = false; return [this.out("5", [])];
      case "D": { let o; try { o = toOrder(m, this.target); } catch (e) { return [this.out("3", [[45, seq], [58, e.message]])]; } const res = this.e.submit(o); if (res.order.status !== "rejected") this.owned.add(res.order.id); return res.reports.map((r) => this.out("8", execReport(r))); }
      case "F": { const id = this.resolve(m.f), r = id ? this.e.cancel(id) : { ok: false, reports: [{ text: "unknown order" }] }; return r.ok ? r.reports.map((x) => this.out("8", execReport({ ...x, clOrdId: m.f[11] }))) : [this.out("9", [[37, m.f[37] || "NONE"], [11, m.f[11]], [41, m.f[41]], [39, 8], [434, 1], [58, r.reports[0].text]])]; }
      case "G": { const id = this.resolve(m.f), r = id ? this.e.replace(id, { qty: m.f[38], px: m.f[44], clOrdId: m.f[11] }) : { ok: false, reports: [{ text: "unknown order" }] }; return r.ok ? r.reports.map((x) => this.out("8", execReport(x))) : [this.out("9", [[37, m.f[37] || "NONE"], [11, m.f[11]], [41, m.f[41]], [39, 8], [434, 2], [58, r.reports[0].text]])]; }
      default: return [this.out("3", [[45, seq], [58, `unsupported MsgType ${m.type}`], [373, 11]])];
    }
  }
}
// Client-side helper: builds correctly sequenced messages.
export class FixClient {
  constructor({ sender = "CLIENT", target = "PRISM" } = {}) { this.sender = sender; this.target = target; this.seq = 1; }
  msg(type, fields = []) { return encode([[35, type], [49, this.sender], [56, this.target], [34, this.seq++], [52, ts()], ...fields]); }
  logon(hb = 30) { return this.msg("A", [[98, 0], [108, hb]]); }
  order(o) { return this.msg("D", newOrderSingle(o)); }
  cancel(orig, cl) { return this.msg("F", [[41, orig], [11, cl]]); }
  replace(orig, cl, { qty, px }) { return this.msg("G", [[41, orig], [11, cl], [38, qty], [44, px], [40, 2]]); }
}
export function describe(raw) { const m = parse(raw, { verify: false }); return m.list.map(([t, v]) => `${TAGS[t] || t}=${v}`).join(" "); }
