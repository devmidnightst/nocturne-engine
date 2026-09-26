// local fixture site for the e2e suite. exercises the parts of a page that a
// proxy rewriter has to get right: location, fetch, xhr, websockets, workers,
// module workers, dynamic import, cookies, history, eval, toString.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";

const SITE = path.join(path.dirname(fileURLToPath(import.meta.url)), "site");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript" };

const readBody = (req) =>
	new Promise((resolve) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks)));
	});

function readRawBody(req, socket, head) {
	const want = Number(req.headers["content-length"]) || 0;
	return new Promise((resolve) => {
		let buf = head;
		if (buf.length >= want) return resolve(buf.subarray(0, want));
		const onData = (c) => {
			buf = Buffer.concat([buf, c]);
			if (buf.length >= want) {
				socket.off("data", onData);
				resolve(buf.subarray(0, want));
			}
		};
		socket.on("data", onData);
	});
}

// a copy of discord's qr login gateway (remote-auth-gateway.discord.gg, v2):
// hello, init (page's rsa public key), nonce_proof both ways, pending_remote_init
// (qr shown), pending_ticket + pending_login (phone approved), then close 1000.
// the page trades the ticket for an rsa encrypted token over a json POST.
const qrSessions = new Map();
const qrEncrypt = (key, text) =>
	crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(text)).toString("base64");

function qrGateway(ws, req) {
	if (req.headers.origin == null) return ws.close(4002, "no origin");
	let key = null;
	let nonce = null;
	ws.send(JSON.stringify({ op: "hello", heartbeat_interval: 1000, timeout_ms: 120000 }));
	ws.on("message", (raw, isBinary) => {
		if (isBinary) return ws.close(4001, "decode error");
		const msg = JSON.parse(String(raw));
		if (msg.op === "heartbeat") return ws.send('{"op":"heartbeat_ack"}');
		if (msg.op === "init") {
			key = crypto.createPublicKey({ key: Buffer.from(msg.encoded_public_key, "base64"), format: "der", type: "spki" });
			nonce = crypto.randomBytes(32).toString("base64url");
			return ws.send(JSON.stringify({ op: "nonce_proof", encrypted_nonce: qrEncrypt(key, nonce) }));
		}
		if (msg.op === "nonce_proof") {
			const want = crypto.createHash("sha256").update(nonce).digest("base64url");
			if (msg.proof !== want) return ws.close(4002, "handshake failure");
			const fingerprint = crypto.createHash("sha256").update(key.export({ format: "der", type: "spki" })).digest("base64url");
			ws.send(JSON.stringify({ op: "pending_remote_init", fingerprint }));
			// the phone scans and approves a moment later
			setTimeout(() => {
				const ticket = crypto.randomBytes(8).toString("hex");
				qrSessions.set(ticket, { key, ticket });
				ws.send(JSON.stringify({ op: "pending_ticket", encrypted_user_payload: qrEncrypt(key, "1:0:0:nocturne") }));
				ws.send(JSON.stringify({ op: "pending_login", ticket }));
				ws.close(1000, "");
			}, 300);
		}
	});
}

export function startFixture(port = 0) {
	const handler = (req, res, body = readBody(req)) => {
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
		if (url.pathname === "/api/login" && req.method === "POST") {
			// discord's login and qr ticket exchange: a json POST with custom headers
			body.then((buf) => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						body: buf.toString(),
						type: req.headers["content-type"] ?? null,
						fingerprint: req.headers["x-fingerprint"] ?? null,
						origin: req.headers.origin ?? null,
					})
				);
			});
			return;
		}
		if (url.pathname === "/api/remote-auth/login" && req.method === "POST") {
			body.then((buf) => {
				const session = qrSessions.get(JSON.parse(buf.toString()).ticket);
				if (!session) {
					res.writeHead(400, { "content-type": "application/json" });
					return res.end('{"message":"bad ticket"}');
				}
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ encrypted_token: qrEncrypt(session.key, "token-" + session.ticket) }));
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
			"content-security-policy": "default-src 'self'; script-src 'self'",
			"x-frame-options": "DENY",
		});
		fs.createReadStream(file).pipe(res);
	};
	const server = http.createServer(handler);

	const wss = new WebSocketServer({ noServer: true });
	let lastClientClose = null;
	server.on("upgrade", (req, socket, head) => {
		// libcurl sends "Upgrade: h2c" on plain http. real servers ignore it and
		// answer normally, but node routes anything with an upgrade header here.
		if (String(req.headers.upgrade).toLowerCase() !== "websocket") {
			const res = new http.ServerResponse(req);
			res.shouldKeepAlive = false;
			res.assignSocket(socket);
			res.on("finish", () => socket.end());
			// node hands the request body over as raw socket data on this path
			return handler(req, res, readRawBody(req, socket, head));
		}
		if (process.env.FIXTURE_DEBUG) console.log("[fixture] upgrade", req.url, JSON.stringify(req.headers));
		if (new URL(req.url, "http://x").pathname === "/ws-reject") {
			// a gateway that refuses the handshake
			socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
			return;
		}
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
			if (new URL(req.url, "http://x").pathname === "/ws-close") {
				// discord's remote auth gateway ends a session by closing with a code
				// (1000 done, 4003 timed out). the page decides what to do from it.
				ws.send(JSON.stringify({ op: "hello" }));
				ws.on("message", () => ws.close(4003, "timeout"));
				return;
			}
			if (new URL(req.url, "http://x").pathname === "/ws-qr") return qrGateway(ws, req);
			if (new URL(req.url, "http://x").pathname === "/ws-drop") {
				// the connection dies without a close frame (server restart, network drop)
				ws.send(JSON.stringify({ op: "hello" }));
				setTimeout(() => ws._socket.destroy(), 200);
				return;
			}
			if (new URL(req.url, "http://x").pathname === "/ws-close-report") {
				// tells the next /ws-close-result socket what close code the page sent
				ws.on("close", (code, reason) => (lastClientClose = { code, reason: String(reason) }));
				ws.send("ready");
				return;
			}
			if (new URL(req.url, "http://x").pathname === "/ws-close-result") {
				ws.send(JSON.stringify(lastClientClose));
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
