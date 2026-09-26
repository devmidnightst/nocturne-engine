// nocturne engine: runtime config, all from env vars so pm2 / systemd / docker
// can set them without touching code. see .env.example for the full list.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// tiny .env loader so `npm start` works without extra deps. real env wins.
function loadDotEnv(file) {
	if (!fs.existsSync(file)) return;
	for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
		if (!m || m[1] in process.env) continue;
		process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
	}
}
loadDotEnv(path.join(ROOT, ".env"));

const env = process.env;

const bool = (v, d) => (v === undefined || v === "" ? d : /^(1|true|yes|on)$/i.test(v));
const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);
const list = (v) =>
	(v || "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);

export const config = {
	env: env.NODE_ENV || "production",
	host: env.HOST || "0.0.0.0",
	port: int(env.PORT, 8080),

	// set when running behind caddy / nginx so req.ip and x-forwarded-* are trusted.
	// "loopback" trusts 127.0.0.1 and ::1 only, which is right for caddy on the same box.
	trustProxy: env.TRUST_PROXY ?? "loopback",

	wisp: {
		path: env.WISP_PATH || "/wisp/",
		// ssrf guard: never let the proxy reach the vps itself or your lan.
		allowPrivateIps: bool(env.WISP_ALLOW_PRIVATE_IPS, false),
		allowLoopbackIps: bool(env.WISP_ALLOW_LOOPBACK_IPS, false),
		allowUdp: bool(env.WISP_ALLOW_UDP, false),
		// -1 means unlimited (wisp-js default)
		streamLimitPerHost: int(env.WISP_STREAM_LIMIT_PER_HOST, -1),
		streamLimitTotal: int(env.WISP_STREAM_LIMIT_TOTAL, -1),
		// block ports that are almost always abuse (smtp) unless you opt out
		portBlacklist: list(env.WISP_PORT_BLACKLIST ?? "25,465,587").map(Number),
		// if set, only pages served from these origins may open wisp sockets.
		// stops other proxy sites from hotlinking your bandwidth.
		allowedOrigins: list(env.WISP_ALLOWED_ORIGINS),
		// biggest single websocket frame a client may send. wisp packets are small,
		// the ws library default of 100 MiB only helps someone trying to eat ram.
		maxPayload: int(env.WISP_MAX_FRAME_BYTES, 4 * 1024 * 1024),
		logLevel: (env.WISP_LOG_LEVEL || "WARN").toUpperCase(),
		dnsServers: list(env.WISP_DNS_SERVERS),
	},

	domains: {
		// hostnames caddy may issue on-demand certs for. supports *.example.com
		allow: list(env.TLS_ALLOWED_DOMAINS),
		// optional file, one hostname per line, re-read when it changes
		file: env.TLS_DOMAINS_FILE ? path.resolve(ROOT, env.TLS_DOMAINS_FILE) : null,
	},

	brand: {
		name: env.BRAND_NAME || "Nocturne Engine",
	},
};
