// local fixture site for the e2e suite. exercises the parts of a page that a
// proxy rewriter has to get right: location, fetch, xhr, websockets, workers,
// module workers, dynamic import, cookies, history, eval, toString.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const SITE = path.join(path.dirname(fileURLToPath(import.meta.url)), "site");
const TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript",
	".mjs": "text/javascript",
	".webm": "audio/webm",
	".wav": "audio/wav",
};

// 3 seconds of a 440hz sine as 16 bit mono pcm wav, built once
const WAV = (() => {
	const rate = 8000;
	const n = rate * 3;
	const buf = Buffer.alloc(44 + n * 2);
	buf.write("RIFF", 0);
	buf.writeUInt32LE(36 + n * 2, 4);
	buf.write("WAVEfmt ", 8);
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20);
	buf.writeUInt16LE(1, 22);
	buf.writeUInt32LE(rate, 24);
	buf.writeUInt32LE(rate * 2, 28);
	buf.writeUInt16LE(2, 32);
	buf.writeUInt16LE(16, 34);
	buf.write("data", 36);
	buf.writeUInt32LE(n * 2, 40);
	for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), 44 + i * 2);
	return buf;
})();

// answers a Range request the way media cdns do (206 + content-range), so the
// page's <audio> can stream and seek
function sendRanged(req, res, buf, type) {
	const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
	const headers = { "content-type": type, "accept-ranges": "bytes", "cache-control": "no-store" };
	if (!m) {
		res.writeHead(200, { ...headers, "content-length": buf.length });
		return res.end(req.method === "HEAD" ? undefined : buf);
	}
	let start = m[1] === "" ? buf.length - Number(m[2]) : Number(m[1]);
	let end = m[1] === "" || m[2] === "" ? buf.length - 1 : Math.min(Number(m[2]), buf.length - 1);
	if (start < 0) start = 0;
	if (start > end || start >= buf.length) {
		res.writeHead(416, { "content-range": `bytes */${buf.length}` });
		return res.end();
	}
	res.writeHead(206, { ...headers, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${buf.length}` });
	res.end(req.method === "HEAD" ? undefined : buf.subarray(start, end + 1));
}

function readBody(req) {
	if (req.upgradeBody) return req.upgradeBody;
	return new Promise((resolve) => {
		const parts = [];
		req.on("data", (c) => parts.push(c));
		req.on("end", () => resolve(Buffer.concat(parts)));
	});
}

export function startFixture(port = 0) {
	const handler = (req, res) => {
		const url = new URL(req.url, "http://x");
		if (process.env.FIXTURE_DEBUG) console.log("[fixture]", req.method, req.url, JSON.stringify(req.headers));
		if (url.pathname === "/api/echo") {
			res.writeHead(200, { "content-type": "application/json" });
			return res.end(
				JSON.stringify({
					path: url.pathname,
					query: url.search,
					host: req.headers.host,
					origin: req.headers.origin ?? null,
					referer: req.headers.referer ?? null,
					cookie: req.headers.cookie ?? null,
					method: req.method,
				})
			);
		}
		if (url.pathname === "/api/setcookie") {
			res.writeHead(200, { "content-type": "text/plain", "set-cookie": "nocturne_test=yes; Path=/" });
			return res.end("ok");
		}
		if (url.pathname === "/api/blob") {
			// deterministic bytes so the page can verify big bodies arrive intact
			const size = Math.min(Number(url.searchParams.get("size")) || 1024, 16 * 1024 * 1024);
			const buf = Buffer.alloc(size);
			for (let i = 0; i < size; i++) buf[i] = (i * 31 + 7) & 0xff;
			res.writeHead(200, { "content-type": "application/octet-stream", "content-length": size });
			return res.end(buf);
		}
		if (url.pathname === "/api/slow") {
			const ms = Math.min(Number(url.searchParams.get("ms")) || 1000, 30_000);
			const t = setTimeout(() => {
				res.writeHead(200, { "content-type": "text/plain" });
				res.end("slow ok");
			}, ms);
			res.on("close", () => clearTimeout(t));
			return;
		}
		if (url.pathname === "/media/tone.wav") return sendRanged(req, res, WAV, "audio/wav");
		if (url.pathname === "/media/tone.webm") {
			return sendRanged(req, res, fs.readFileSync(path.join(SITE, "tone.webm")), "audio/webm");
		}
		if (url.pathname === "/media/cdn.webm") {
			// like a music cdn: cacheable, answers ranges with 206 and plain GETs with 200
			const buf = fs.readFileSync(path.join(SITE, "tone.webm"));
			if (!req.headers.range) {
				res.writeHead(200, { "content-type": "audio/webm", "content-length": buf.length, "cache-control": "public, max-age=3600", "accept-ranges": "bytes" });
				return res.end(buf);
			}
			return sendRanged(req, res, buf, "audio/webm");
		}
		if (url.pathname === "/media/live") {
			// a live radio stream: 200, no length, no cache headers, never ends
			res.writeHead(200, { "content-type": "audio/mpeg" });
			res.write(Buffer.alloc(4096, 1));
			const t = setInterval(() => res.write(Buffer.alloc(4096, 1)), 250);
			res.on("close", () => clearInterval(t));
			return;
		}
		if (url.pathname === "/api/range-echo") {
			res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
			return res.end(JSON.stringify({ range: req.headers.range ?? null }));
		}
		if (url.pathname === "/api/videoplayback") {
			// youtube's player posts a small binary request body and streams media
			// segments back. echo the body length and send the webm back.
			readBody(req).then((body) => {
				const media = fs.readFileSync(path.join(SITE, "tone.webm"));
				res.writeHead(200, {
					"content-type": "application/vnd.yt-ump",
					"x-body-length": String(body.length),
					"access-control-expose-headers": "x-body-length",
					"content-length": media.length,
				});
				res.end(media);
			});
			return;
		}
		if (url.pathname === "/redirect") {
			res.writeHead(302, { location: "/api/echo?redirected=1" });
			return res.end();
		}
		const file = path.join(SITE, url.pathname === "/" ? "index.html" : path.normalize(url.pathname));
		if (!file.startsWith(SITE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
			res.writeHead(404);
			return res.end("not found");
		}
		res.writeHead(200, {
			"content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
			// real sites send these, scramjet has to strip them for the page to work
			// media sites allow blob: media (mse) in their csp, so the media page does too
			"content-security-policy": file.endsWith("media.html")
				? "default-src 'self'; script-src 'self'; media-src 'self' blob:"
				: "default-src 'self'; script-src 'self'",
			"x-frame-options": "DENY",
		});
		fs.createReadStream(file).pipe(res);
	};
	const server = http.createServer(handler);

	const wss = new WebSocketServer({ noServer: true });
	server.on("upgrade", (req, socket, head) => {
		// libcurl sends "Upgrade: h2c" on plain http. real servers ignore it and
		// answer normally, but node routes anything with an upgrade header here.
		if (String(req.headers.upgrade).toLowerCase() !== "websocket") {
			const res = new http.ServerResponse(req);
			res.shouldKeepAlive = false;
			res.assignSocket(socket);
			res.on("finish", () => socket.end());
			// node stops parsing once it sees an upgrade, so a POST body arrives as
			// `head` plus raw socket data instead of on req
			const len = Number(req.headers["content-length"]) || 0;
			req.upgradeBody = new Promise((resolve) => {
				let buf = head.subarray(0, len);
				if (buf.length >= len) return resolve(buf);
				const feed = (chunk) => {
					buf = Buffer.concat([buf, chunk]).subarray(0, len);
					if (buf.length >= len) {
						socket.off("data", feed);
						resolve(buf);
					}
				};
				socket.on("data", feed);
			});
			return handler(req, res);
		}
		if (process.env.FIXTURE_DEBUG) console.log("[fixture] upgrade", req.url, JSON.stringify(req.headers));
		wss.handleUpgrade(req, socket, head, (ws) => {
			// epoxy sends the request target in absolute form (ws://host/path), which
			// http allows and real servers accept, so only look at the path
			if (new URL(req.url, "http://x").pathname === "/ws-stream") {
				// server pushes on its own, like a chat gateway sending events
				let seq = 0;
				const t = setInterval(() => ws.send(JSON.stringify({ push: ++seq, at: Date.now() })), 500);
				ws.on("close", () => clearInterval(t));
				ws.on("message", (data) => ws.send(String(data)));
				return;
			}
			ws.send(JSON.stringify({ hello: true, origin: req.headers.origin ?? null }));
			ws.on("message", (data) => {
				if (process.env.FIXTURE_DEBUG) console.log("[fixture] ws got", Date.now() % 100000, String(data).length);
				ws.send(String(data));
			});
		});
	});

	return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const s = await startFixture(Number(process.env.FIXTURE_PORT) || 4455);
	console.log("fixture on", s.address());
}
