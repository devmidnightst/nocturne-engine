// umbrella: allowlist for caddy's on_demand_tls "ask" endpoint.
//
// caddy calls GET /api/tls-ask?domain=<host> before issuing a certificate.
// a 200 means yes, anything else means no. without this check anyone could point
// random hostnames at your ip and burn through your lets encrypt rate limits.

import fs from "node:fs";

// rfc 1123 hostname, lowercase, no trailing dot
const HOSTNAME = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export function createDomainAllowlist({ allow = [], file = null } = {}) {
	let fromFile = [];
	let fileMtime = 0;

	function refreshFile() {
		if (!file) return;
		try {
			const stat = fs.statSync(file);
			if (stat.mtimeMs === fileMtime) return;
			fileMtime = stat.mtimeMs;
			fromFile = fs
				.readFileSync(file, "utf8")
				.split(/\r?\n/)
				.map((l) => l.replace(/#.*/, "").trim().toLowerCase())
				.filter(Boolean);
		} catch {
			fromFile = [];
			fileMtime = 0;
		}
	}

	function matches(host, pattern) {
		if (pattern.startsWith("*.")) {
			const base = pattern.slice(2);
			// *.example.com matches a.example.com but not example.com or a.b.example.com
			return host.endsWith("." + base) && !host.slice(0, -base.length - 1).includes(".");
		}
		return host === pattern;
	}

	return {
		isAllowed(domain) {
			if (typeof domain !== "string") return false;
			const host = domain.trim().toLowerCase().replace(/\.$/, "");
			if (!HOSTNAME.test(host)) return false;
			refreshFile();
			return [...allow, ...fromFile].some((p) => matches(host, p));
		},
		size() {
			refreshFile();
			return allow.length + fromFile.length;
		},
	};
}
