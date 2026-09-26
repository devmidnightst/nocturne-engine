// nocturne engine: http server.
//
// serves the shell ui, the scramjet runtime (patched, see scramjet-patches.js),
// the controller + transports, and the wisp websocket endpoint that the
// epoxy / libcurl transports tunnel through. one process, pm2 cluster friendly.

import http from "node:http";
import path from "node:path";
import express from "express";
import { logging as wispLogging } from "@mercuryworkshop/wisp-js/server";

import { config, ROOT } from "./config.js";
import {
	buildPatchedScramjet,
	buildPatchedControllerInject,
	buildPatchedUtils,
	scramjetDistDir,
	SCRAMJET_VERSION,
} from "./scramjet-patches.js";
import { buildPatchedLibcurl } from "./libcurl-patches.js";
import { createDomainAllowlist } from "./domains.js";
import { createDiagnoseHandler } from "./diagnose.js";
import { packageDir as pkgDir } from "./packages.js";
import { createWispHandler } from "./wisp.js";

const DIST = {
	scramjet: scramjetDistDir(),
	controller: path.join(pkgDir("@mercuryworkshop/scramjet-controller"), "dist"),
	epoxy: path.join(pkgDir("@mercuryworkshop/epoxy-transport"), "dist"),
};
const PUBLIC = path.join(ROOT, "public");

// ---------------------------------------------------------------------------
// scramjet bundles and the libcurl transport, patched once at boot and served from memory
// ---------------------------------------------------------------------------

const bundles = {
	"/scramjet/scramjet.js": buildPatchedScramjet(),
	"/controller/controller.inject.js": buildPatchedControllerInject(),
	"/utils/scramjet-utils.js": buildPatchedUtils(),
	"/transports/libcurl.mjs": buildPatchedLibcurl(),
};
for (const [route, b] of Object.entries(bundles)) {
	b.etag = `"nocturne-${Buffer.from(route).toString("base64url")}-${b.applied.length}-${b.code.length}"`;
}
const patches = Object.fromEntries(
	Object.entries(bundles).map(([route, b]) => [route, { applied: b.applied, skipped: b.skipped }])
);

// ---------------------------------------------------------------------------
// wisp
// ---------------------------------------------------------------------------

const wispUpgrade = createWispHandler(config.wisp);
wispLogging.set_level(wispLogging[config.wisp.logLevel] ?? wispLogging.WARN);

// ---------------------------------------------------------------------------
// express app
// ---------------------------------------------------------------------------

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", config.trustProxy);
app.set("etag", "strong");

const domains = createDomainAllowlist(config.domains);

// headers for the shell itself. deliberately no x-frame-options / coep here:
// the proxied pages are served by the service worker, not by this server, and
// scramjet strips site csp on its own. these only harden the shell.
app.use((req, res, next) => {
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Referrer-Policy", "same-origin");
	res.setHeader("X-Nocturne-Engine", SCRAMJET_VERSION);
	next();
});

// engine assets: cors open so other nocturne subdomains can reuse them, and a
// short cache because the files only change when package.json pins change.
const assetHeaders = (res, file) => {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
	res.setHeader("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
	if (file.endsWith(".wasm")) res.setHeader("Content-Type", "application/wasm");
	else if (file.endsWith(".mjs") || file.endsWith(".js"))
		res.setHeader("Content-Type", "text/javascript; charset=utf-8");
};
const staticOpts = { setHeaders: assetHeaders, index: false, fallthrough: false };

for (const [route, bundle] of Object.entries(bundles)) {
	app.get(route, (req, res) => {
		assetHeaders(res, route);
		res.setHeader("ETag", bundle.etag);
		if (req.headers["if-none-match"] === bundle.etag) return res.status(304).end();
		res.send(bundle.code);
	});
}
app.use("/scramjet", express.static(DIST.scramjet, staticOpts));
app.use("/controller", express.static(DIST.controller, staticOpts));
app.get("/transports/epoxy.mjs", (req, res) => {
	assetHeaders(res, ".mjs");
	res.sendFile(path.join(DIST.epoxy, "index.mjs"));
});

// the service worker must never be cached, or users get stuck on old versions
app.get("/sw.js", (req, res) => {
	res.setHeader("Service-Worker-Allowed", "/");
	res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
	res.setHeader("Content-Type", "text/javascript; charset=utf-8");
	res.sendFile(path.join(PUBLIC, "sw.js"));
});

// ---- api ----

app.get("/api/health", (req, res) => {
	res.json({
		ok: true,
		name: config.brand.name,
		scramjet: SCRAMJET_VERSION,
		patches,
		uptime: Math.round(process.uptime()),
		pid: process.pid,
	});
});

// explains failed loads for the error page, see diagnose.js
app.get("/api/diagnose", createDiagnoseHandler(config));

// caddy on_demand_tls ask endpoint. caddy only accepts 2xx as "yes".
app.get("/api/tls-ask", (req, res) => {
	const domain = String(req.query.domain || "");
	if (domains.isAllowed(domain)) return res.status(200).send("ok");
	res.status(404).send("unknown domain");
});

// ---- shell ----

app.use(
	express.static(PUBLIC, {
		index: "index.html",
		setHeaders(res, file) {
			if (file.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
			else res.setHeader("Cache-Control", "public, max-age=600");
		},
	})
);

app.use((req, res) => {
	res.status(404).sendFile(path.join(PUBLIC, "404.html"));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
	const status = err.status || err.statusCode || 500;
	if (status >= 500) console.error("[nocturne] request error", req.method, req.url, err);
	if (res.headersSent) return;
	if (status === 404) return res.status(404).sendFile(path.join(PUBLIC, "404.html"));
	res.status(status).type("text/plain").send(status >= 500 ? "internal error" : String(err.message));
});

// ---------------------------------------------------------------------------
// http server + websocket upgrades
// ---------------------------------------------------------------------------

export function createServer() {
	const server = http.createServer(app);
	server.keepAliveTimeout = 65_000; // longer than caddy's idle timeout
	server.headersTimeout = 66_000;

	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url, "http://localhost");
		// exact match: wisp-js treats any other path under it as a raw tcp tunnel ("wsproxy")
		if (url.pathname !== config.wisp.path) {
			socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
			return;
		}
		const allowed = config.wisp.allowedOrigins;
		if (allowed.length) {
			const origin = String(req.headers.origin || "").toLowerCase();
			if (!allowed.includes(origin)) {
				socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
				return;
			}
		}
		socket.on("error", () => {});
		wispUpgrade(req, socket, head);
	});

	return server;
}

function main() {
	const server = createServer();

	server.listen(config.port, config.host, () => {
		const where = `http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}`;
		console.log(`[nocturne] ${config.brand.name} listening on ${where}`);
		for (const [route, b] of Object.entries(bundles)) {
			console.log(`[nocturne] ${route}: ${b.applied.length} patches (${b.applied.join(", ") || "none"})`);
			for (const s of b.skipped) console.warn(`[nocturne] patch skipped in ${route}: ${s.id} (${s.reason})`);
		}
		if (!config.domains.allow.length && !config.domains.file)
			console.log("[nocturne] tls ask endpoint has no domains configured, it will refuse everything");
		// tell pm2 we are ready (wait_ready: true in ecosystem.config.cjs)
		process.send?.("ready");
	});

	// graceful shutdown so `pm2 reload` does not drop in-flight requests
	let closing = false;
	const shutdown = (signal) => {
		if (closing) return;
		closing = true;
		console.log(`[nocturne] ${signal}, closing`);
		server.close(() => process.exit(0));
		server.closeIdleConnections?.();
		setTimeout(() => process.exit(0), 8000).unref();
	};
	// node exits on an unhandled rejection by default. for a proxy that means one
	// odd upstream packet drops every user, so log it and keep serving instead.
	process.on("unhandledRejection", (reason) => {
		console.error("[nocturne] unhandled rejection", reason);
	});

	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("message", (msg) => msg === "shutdown" && shutdown("shutdown message"));
}

// run when started directly (`node src/server.js`) or by pm2. in cluster mode
// pm2 loads this file from its own ProcessContainer, so argv[1] is pm2's script,
// not this one; pm2 always sets pm_id for the processes it starts.
const startedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ROOT, "src/server.js");
if (startedDirectly || process.env.pm_id !== undefined) {
	main();
}

export { app, bundles };
