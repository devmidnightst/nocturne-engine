// local fixture site for the e2e suite. exercises the parts of a page that a
// proxy rewriter has to get right: location, fetch, xhr, websockets, workers,
// module workers, dynamic import, cookies, history, eval, toString.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const SITE = path.join(path.dirname(fileURLToPath(import.meta.url)), "site");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript" };

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
	server.on("upgrade", (req, socket, head) => {
		// libcurl sends "Upgrade: h2c" on plain http. real servers ignore it and
		// answer normally, but node routes anything with an upgrade header here.
		if (String(req.headers.upgrade).toLowerCase() !== "websocket") {
			const res = new http.ServerResponse(req);
			res.shouldKeepAlive = false;
			res.assignSocket(socket);
			res.on("finish", () => socket.end());
			return handler(req, res);
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			ws.send(JSON.stringify({ hello: true, origin: req.headers.origin ?? null }));
			ws.on("message", (data) => ws.send(String(data)));
		});
	});

	return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const s = await startFixture(Number(process.env.FIXTURE_PORT) || 4455);
	console.log("fixture on", s.address());
}
