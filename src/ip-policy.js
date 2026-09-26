// umbrella: which addresses the proxy may connect to (the ssrf guard).
//
// wisp-js 0.5.0 has its own check, but it looks at ipaddr.js range names as
// is, so an ipv4 address wrapped in ipv6 (::ffff:127.0.0.1, 64:ff9b::a9fe:a9fe)
// comes out as "ipv4Mapped" / "rfc6052" and sails through, and ipv6 private
// ranges (fc00::/7) are not on its list at all. on a dual stack vps that means
// any user could reach services bound to localhost or the cloud metadata ip.
// this module is the one place that decides, for wisp and /api/diagnose both.

import ipaddr from "ipaddr.js";

// ranges that are public internet even though ipaddr.js gives them their own name
const PUBLIC = new Set(["unicast", "as112", "as112v6", "amt", "6to4", "teredo"]);
const LOOPBACK = new Set(["loopback", "unspecified"]);
// ipv6 forms that carry an ipv4 address inside, judged by that ipv4 address
const EMBEDS_V4 = new Set(["ipv4Mapped", "rfc6145", "rfc6052"]);

function embeddedV4(addr) {
	const bytes = addr.toByteArray();
	return new ipaddr.IPv4(bytes.slice(-4));
}

/** normalizes an address string, unwrapping ipv4 carried inside ipv6. null if it isn't an ip. */
export function parseIp(ip) {
	if (typeof ip !== "string" || !ipaddr.isValid(ip)) return null;
	let addr;
	try {
		addr = ipaddr.parse(ip.replace(/^\[|\]$/g, ""));
	} catch {
		return null;
	}
	if (addr.kind() === "ipv6" && EMBEDS_V4.has(addr.range())) addr = embeddedV4(addr);
	return addr;
}

/** true when the proxy must not connect to this ip under the given wisp config */
export function ipBlocked(ip, { allowLoopbackIps = false, allowPrivateIps = false } = {}) {
	const addr = parseIp(ip);
	// not an ip at all: refuse, the caller should have resolved it first
	if (!addr) return true;
	const range = addr.range();
	if (LOOPBACK.has(range)) return !allowLoopbackIps;
	if (PUBLIC.has(range)) return false;
	return !allowPrivateIps;
}
