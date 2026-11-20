// Penaltı Düellosu sunucusu — sıfır bağımlılık (sadece Node.js 18+)
// Oda verisini bellekte tutar; istemcilere Server-Sent Events (SSE) ile canlı iletir.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ROOM_TTL = 6 * 60 * 60 * 1000; // 6 saat hareketsiz oda silinir
const MAX_ROOMS = 5000;
const rooms = new Map(); // code -> { A, B, subs:Set<res>, t }

const room = (code) => {
  let r = rooms.get(code);
  if (!r) { r = { A: null, B: null, subs: new Set(), t: Date.now() }; rooms.set(code, r); }
  return r;
};
const send = (res, r, data) => res.write(`data: ${JSON.stringify({ r, data })}\n\n`);
const json = (res, status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const validCode = (c) => typeof c === "string" && /^[a-z0-9]{4,12}$/.test(c);

const indexHtml = () => fs.readFileSync(path.join(__dirname, "public", "index.html"));

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    return res.end(indexHtml());
  }
  if (url.pathname === "/healthz") return json(res, 200, { ok: true, rooms: rooms.size });

  if (req.method === "GET" && url.pathname === "/api/events") {
    const code = url.searchParams.get("code");
    if (!validCode(code)) return json(res, 400, { error: "bad code" });
    res.writeHead(200, {
      "content-type": "text/event-stream", "cache-control": "no-cache, no-transform",
      connection: "keep-alive", "x-accel-buffering": "no",
    });
    const r = room(code);
    r.subs.add(res);
    res.write("retry: 1500\n\n");
    send(res, "A", r.A); send(res, "B", r.B);
    req.on("close", () => r.subs.delete(res));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/set") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on("end", () => {
      let m;
      try { m = JSON.parse(body); } catch { return json(res, 400, { error: "bad json" }); }
      const { code, r, data } = m || {};
      if (!validCode(code) || (r !== "A" && r !== "B")) return json(res, 400, { error: "bad args" });
      if (!data || typeof data.uid !== "string" || data.uid.length > 64 || !Array.isArray(data.moves) || typeof data.gen !== "number")
        return json(res, 400, { error: "bad data" });
      if (!rooms.has(code) && rooms.size >= MAX_ROOMS) return json(res, 503, { error: "full" });
      const rm = room(code);
      if (rm[r] && rm[r].uid !== data.uid) return json(res, 403, { error: "slot taken" }); // başkasının yerine yazılamaz
      if (r === "B" && !rm.A) return json(res, 404, { error: "no room" });
      rm[r] = { uid: data.uid, gen: data.gen, moves: data.moves, seen: data.seen };
      rm.t = Date.now();
      rm.subs.forEach((s) => send(s, r, rm[r]));
      json(res, 200, { ok: true });
    });
    return;
  }
  json(res, 404, { error: "not found" });
});

setInterval(() => { // SSE bağlantısını canlı tut (proxy zaman aşımına karşı)
  rooms.forEach((r) => r.subs.forEach((s) => s.write(": ping\n\n")));
}, 15000);
setInterval(() => { // eski odaları temizle
  const now = Date.now();
  rooms.forEach((r, c) => { if (!r.subs.size && now - r.t > ROOM_TTL) rooms.delete(c); });
}, 10 * 60 * 1000);

server.listen(PORT, () => console.log("Penaltı Düellosu http://localhost:" + PORT));
