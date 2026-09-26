// nocturne engine: /api/diagnose, explains why a site failed to load.
//
// epoxy and libcurl only see "the wisp stream closed", which looks the same
// whether the domain does not exist, the port is closed or the server blocked
// it. this endpoint repeats the cheap parts of what wisp does (dns lookup, the
// same ip policy, a bare tcp connect) so the error page can say which one it
// was. it never sends a byte to the target and follows the same ssrf rules as
// the wisp server.

import dns from "node:dns/promises";
import net from "node:net";
import ipaddr from "ipaddr.js";

// same ranges wisp-js refuses (src/server/filter.mjs), so the answer matches what wisp does
const LOOPBACK = ["loopback", "unspecified"];
const PRIVATE = ["broadcast", "linkLocal", "carrierGradeNat", "private", "reserved"];

function ipBlocked(ip, wisp) {
	let addr;
	try {
		addr = ipaddr.parse(ip);
	} catch {
		return false;
	}
	const range = addr.range();
	if (!wisp.allowLoopbackIps && LOOPBACK.includes(range)) return true;
	if (!wisp.allowPrivateIps && PRIVATE.includes(range)) return true;
	return false;
}

function tcpProbe(host, port, timeoutMs) {
	return new Promise((resolve) => {
		const socket = net.connect({ host, port });
		const done = (result) => {
			socket.destroy();
			resolve(result);
		};
		socket.setTimeout(timeoutMs, () => done("timeout"));
		socket.once("connect", () => done("open"));
		socket.once("error", (err) => done(err.code || "error"));
	});
}

// small per ip limiter so the endpoint cannot be used as a port scanner
function limiter(perMinute) {
	const hits = new Map();
	setInterval(() => hits.clear(), 60_000).unref();
	return (key) => {
		const n = (hits.get(key) ?? 0) + 1;
		hits.set(key, n);
		return n <= perMinute;
	};
}

export function createDiagnoseHandler(config) {
	const allow = limiter(20);

	return async (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		if (!allow(req.ip)) return res.status(429).json({ kind: "rate-limited" });

		const host = String(req.query.host || "").toLowerCase().replace(/^\[|\]$/g, "");
		const port = Number(req.query.port || 443);
		if (!host || host.length > 253 || !Number.isInteger(port) || port < 1 || port > 65535) {
			return res.status(400).json({ kind: "bad-request" });
		}
		if (config.wisp.portBlacklist.includes(port)) return res.json({ kind: "blocked", reason: "port" });

		let addresses;
		if (net.isIP(host)) {
			addresses = [host];
		} else {
			try {
				addresses = (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address);
			} catch (err) {
				return res.json({ kind: "dns", code: err.code });
			}
		}

		const usable = addresses.filter((ip) => !ipBlocked(ip, config.wisp));
		if (!usable.length) return res.json({ kind: "blocked", reason: "address" });

		const result = await tcpProbe(usable[0], port, 5000);
		if (result === "open") return res.json({ kind: "reachable" });
		if (result === "timeout") return res.json({ kind: "timeout" });
		if (result === "ECONNREFUSED") return res.json({ kind: "refused" });
		return res.json({ kind: "unreachable", code: result });
	};
}
