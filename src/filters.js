// umbrella: ad blocking filter lists.
//
// the client blocker ships a small built in host list. on top of that the server
// pulls the host based rules out of the lists ublock origin enables by default
// (easylist, easyprivacy, peter lowe's) once a day, caches them under data/ and
// hands the client one compact json. scramjet can't run the extension itself,
// so cosmetic and scriptlet rules are skipped here; the youtube specific parts
// live in public/js/plugins/adblock-plugin.js.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DOMAIN_RE = /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/;
const HOSTS_RE = /^(?:0\.0\.0\.0|127\.0\.0\.1)\s+([^\s#]+)/;
const NET_RE = /^(@@)?\|\|([^/^$*|]+)\^(?:\$(.*))?$/;
const MAX_DOMAINS = 250_000;

// rules a host list can't express (paths, wildcards, $script, $domain= ...) are
// dropped. a plain ||host^ blocks everywhere, $third-party only off site.
export function parseFilterList(text, out = { block: new Set(), third: new Set(), allow: new Set() }) {
	for (let line of text.split(/\r?\n/)) {
		line = line.trim().toLowerCase();
		if (!line || line[0] === "!" || line[0] === "#" || line[0] === "[") continue;
		const hosts = HOSTS_RE.exec(line);
		if (hosts) {
			add(out.block, hosts[1]);
			continue;
		}
		if (line.includes("#")) continue;
		if (DOMAIN_RE.test(line)) {
			add(out.block, line);
			continue;
		}
		const m = NET_RE.exec(line);
		if (!m) continue;
		const [, exception, domain, opts = ""] = m;
		const options = opts ? opts.split(",").filter((o) => o !== "important") : [];
		if (exception) {
			if (!options.length) add(out.allow, domain);
			continue;
		}
		if (!options.length) add(out.block, domain);
		else if (options.length === 1 && (options[0] === "third-party" || options[0] === "3p")) add(out.third, domain);
	}
	return out;
}

function add(set, domain) {
	if (set.size >= MAX_DOMAINS || !DOMAIN_RE.test(domain)) return;
	if (/^[\d.]+$/.test(domain) || domain === "localhost" || domain.endsWith(".local")) return;
	set.add(domain);
}

export function compileLists(texts) {
	const out = { block: new Set(), third: new Set(), allow: new Set() };
	for (const t of texts) parseFilterList(t, out);
	for (const d of out.block) out.third.delete(d);
	return { block: [...out.block], third: [...out.third], allow: [...out.allow] };
}

export function createFilterStore({ lists, refreshHours, cacheFile }) {
	let current = { fetchedAt: 0, block: [], third: [], allow: [] };
	let body = "";
	let etag = "";
	let refreshing = null;

	const publish = (data) => {
		current = data;
		body = JSON.stringify({ block: data.block, third: data.third, allow: data.allow });
		etag = `"f-${crypto.createHash("sha1").update(body).digest("base64url").slice(0, 16)}"`;
	};
	publish(current);

	try {
		const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
		if (Array.isArray(cached.block)) publish(cached);
	} catch {
		// no cache yet
	}

	async function refresh() {
		if (!lists.length) return;
		const texts = [];
		for (const url of lists) {
			try {
				const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
				if (res.ok) texts.push(await res.text());
				else console.warn(`[umbrella] filter list ${url}: http ${res.status}`);
			} catch (err) {
				console.warn(`[umbrella] filter list ${url}: ${err.message}`);
			}
		}
		if (!texts.length) return;
		const data = { fetchedAt: Date.now(), ...compileLists(texts) };
		publish(data);
		try {
			fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
			const tmp = `${cacheFile}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(data));
			fs.renameSync(tmp, cacheFile);
		} catch (err) {
			console.warn(`[umbrella] couldn't cache filter lists: ${err.message}`);
		}
		console.log(`[umbrella] filter lists: ${data.block.length} hosts, ${data.third.length} third party, ${data.allow.length} allowed`);
	}

	const stale = () => Date.now() - current.fetchedAt > refreshHours * 3600_000;
	const kick = () => {
		if (refreshing || !stale()) return;
		refreshing = refresh().finally(() => (refreshing = null));
	};

	return {
		start() {
			if (!lists.length) return;
			kick();
			setInterval(kick, 15 * 60_000).unref();
		},
		refresh,
		get size() {
			return current.block.length + current.third.length;
		},
		handler(req, res) {
			res.setHeader("Cache-Control", "public, max-age=3600");
			res.setHeader("ETag", etag);
			if (req.headers["if-none-match"] === etag) return res.status(304).end();
			res.type("application/json").send(body);
		},
	};
}
