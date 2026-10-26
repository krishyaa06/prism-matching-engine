// FIX 4.4 over TCP. Frames are split on the CheckSum field, each connection gets its own session and sequence numbers.
import net from "node:net";
import { FixSession, pretty } from "../fix.js";
export function createFixGateway(engine, { log = () => {}, sender = "PRISM" } = {}) {
  return net.createServer((sock) => {
    const sess = new FixSession(engine, { sender }), peer = `${sock.remoteAddress}:${sock.remotePort}`; let buf = "";
    log(`connect ${peer}`);
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
      buf += chunk; let m;
      while ((m = /10=\d{3}\x01/.exec(buf))) {
        const raw = buf.slice(0, m.index + m[0].length); buf = buf.slice(m.index + m[0].length);
        log(`<< ${pretty(raw)}`); for (const out of sess.handle(raw)) { log(`>> ${pretty(out)}`); sock.write(out); }
      }
      if (buf.length > 65536) sock.destroy();
    });
    sock.on("close", () => log(`disconnect ${peer}`)); sock.on("error", () => {});
  });
}
