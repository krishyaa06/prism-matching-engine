// Fixed-point amounts: every price, quantity and balance is an integer count of 1e-8 units.
export const SCALE = 100000000n, SCALE_N = 1e8;
export function toUnits(v) {
  if (typeof v === "number") { if (!isFinite(v)) throw new Error("bad amount " + v); v = v.toFixed(8); }
  const m = /^(-?)(\d*)(?:\.(\d{0,8})(0*|\d*))?$/.exec(String(v).trim()); if (!m || (m[2] === "" && !m[3])) throw new Error("bad amount " + v);
  if (m[4] && /[1-9]/.test(m[4])) throw new Error("precision: more than 8 decimals in " + v);
  const n = Number(BigInt(m[2] || "0") * SCALE + BigInt((m[3] || "").padEnd(8, "0"))); return m[1] ? -n : n;
}
export function fmt(units, dp = 8) {
  const b = BigInt(units), neg = b < 0n, a = neg ? -b : b, i = a / SCALE, f = (a % SCALE).toString().padStart(8, "0").slice(0, dp);
  return (neg ? "-" : "") + i.toLocaleString("en-US") .replace(/,/g, "") + (dp ? "." + f : "");
}
// notional in quote units = px * qty / 1e8 (exact when tick*lot is a multiple of 1e8, enforced per symbol)
export const notional = (px, qty) => (BigInt(px) * BigInt(qty)) / SCALE;
export const fee = (amount, bps) => (amount * BigInt(bps)) / 10000n;
