// umbrella ai: web search for the ai tab's "Web" toggle.
//
// no search engine has a free keyless api, so this reads their html pages, and
// from a vps that is fragile. duckduckgo answers anything that doesn't look like
// a real browser (down to the tls handshake, which node's fetch can't fake) with
// http 202 and a "bots use DuckDuckGo too" puzzle page. the old code read that
// page as "no results", so search looked broken with nothing in the logs. now:
//   - requests go through impit, which copies chrome's tls and http/2
//     fingerprint, and fall back to node's fetch if it can't load
//   - each engine spots its own block page and reports it as a block
//   - engines are tried in order until one has results, and one that blocked
//     us sits out for a while so we don't dig the hole deeper
//   - results are cached per query
// a self hosted searxng (SEARXNG_URL) or a brave search api key
// (BRAVE_SEARCH_API_KEY) goes first when set; both are more reliable than
// scraping. readPages() then pulls the text of the top results, behind the same
// ssrf guard the proxy uses, so the model has more than a two line snippet.

import dnsCb from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";
import { parse } from "node-html-parser";
import { ipBlocked } from "./ip-policy.js";

const ENGINE_TIMEOUT = 5000;
const MAX_RESULTS = 6;
const CACHE_TTL = 10 * 60_000;
const CACHE_MAX = 200;
const BLOCK_COOLDOWN = 15 * 60_000;
const ERROR_COOLDOWN = 2 * 60_000;
const CHROME_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const PARSE_OPTS = { blockTextElements: { script: false, style: false, noscript: false, pre: true } };

export class SearchBlocked extends Error {}

// ---- http ----

// a tiny cookie jar shared by every search, enough for yahoo's consent cookie
// and duckduckgo's region cookie. impit takes the same interface.
const cookies = new Map();
export const cookieJar = {
	setCookie(header, url) {
		const [pair, ...attrs] = String(header).split(";");
		const eq = pair.indexOf("=");
		if (eq < 1) return;
		const name = pair.slice(0, eq).trim();
		const value = pair.slice(eq + 1).trim();
		let domain = new URL(url).hostname;
		let gone = !value;
		for (const attr of attrs) {
			const [k, v = ""] = attr.split("=");
			const key = k.trim().toLowerCase();
			if (key === "domain" && v.trim()) domain = v.trim().replace(/^\./, "").toLowerCase();
			if (key === "max-age" && Number(v) <= 0) gone = true;
			if (key === "expires" && Date.parse(v) < Date.now()) gone = true;
		}
		const bucket = cookies.get(domain) ?? new Map();
		if (gone) bucket.delete(name);
		else bucket.set(name, value);
		if (bucket.size) cookies.set(domain, bucket);
		else cookies.delete(domain);
		if (cookies.size > 50) cookies.delete(cookies.keys().next().value);
	},
	getCookieString(url) {
		const host = new URL(url).hostname;
		const out = [];
		for (const [domain, bucket] of cookies) {
			if (host !== domain && !host.endsWith(`.${domain}`)) continue;
			for (const [name, value] of bucket) out.push(`${name}=${value}`);
		}
		return out.join("; ");
	},
};

let impitClient;
function getImpit() {
	impitClient ??= import("impit")
		.then(({ Impit }) => new Impit({ browser: "chrome", followRedirects: true, maxRedirects: 5, cookieJar }))
		.catch((err) => {
			console.warn(`[umbrella] web search: impit failed to load (${err.message}), using node fetch`);
			return null;
		});
	return impitClient;
}

async function nodeFetch(url, { method, headers, body, timeout }) {
	const signal = AbortSignal.timeout(timeout);
	for (let hop = 0; hop < 6; hop++) {
		const cookie = cookieJar.getCookieString(url);
		const res = await fetch(url, {
			method,
			body,
			redirect: "manual",
			signal,
			headers: {
				"user-agent": CHROME_UA,
				accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				"accept-language": "en-US,en;q=0.9",
				...(cookie ? { cookie } : {}),
				...headers,
			},
		});
		for (const c of res.headers.getSetCookie?.() ?? []) cookieJar.setCookie(c, url);
		const next = res.headers.get("location");
		if (res.status >= 300 && res.status < 400 && next) {
			await res.body?.cancel();
			url = new URL(next, url).href;
			if (res.status !== 307 && res.status !== 308) {
				method = "GET";
				body = undefined;
				delete headers["content-type"];
			}
			continue;
		}
		return { status: res.status, url, text: await res.text() };
	}
	throw new Error("too many redirects");
}

/** browser-like request. { status, url, text } */
export async function request(url, { method = "GET", headers = {}, body, timeout = ENGINE_TIMEOUT, plain = false } = {}) {
	const client = plain ? null : await getImpit();
	if (!client) return nodeFetch(url, { method, headers: { ...headers }, body, timeout });
	const res = await client.fetch(url, { method, headers, body, timeout, signal: AbortSignal.timeout(timeout + 500) });
	return { status: res.status, url: res.url || url, text: await res.text() };
}

// ---- helpers ----

const clean = (s, max = 400) => {
	const t = String(s ?? "").replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

const SEARCH_HOSTS = /(^|\.)(duckduckgo\.com|bing\.com|search\.yahoo\.com|search\.brave\.com)$/;

function result(title, url, snippet) {
	let u;
	try {
		u = new URL(url);
	} catch {
		return null;
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") return null;
	if (SEARCH_HOSTS.test(u.hostname)) return null;
	return { title: clean(title, 200) || u.hostname, url: u.href, snippet: clean(snippet) };
}

function finish(list) {
	const seen = new Set();
	const out = [];
	for (const r of list) {
		if (!r) continue;
		const key = r.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(r);
		if (out.length >= MAX_RESULTS) break;
	}
	return out;
}

/** collapses whitespace, drops a leading duckduckgo "!bang" and caps the length */
export function normalizeQuery(q) {
	let s = String(q ?? "")
		.replace(/\s+/g, " ")
		.replace(/(^|\s)!+(?=\S)/g, "$1")
		.trim();
	if (s.length > 250) s = s.slice(0, 250).replace(/\s+\S*$/, "");
	return s;
}

// ---- duckduckgo ----

const DDG_BLOCK = /anomaly-modal|id="challenge-form"|anomaly\.js|bots use DuckDuckGo too|error-lite@duckduckgo\.com/i;

function ddgTarget(href) {
	if (!href) return null;
	let u;
	try {
		u = new URL(href, "https://duckduckgo.com/");
	} catch {
		return null;
	}
	if (/(^|\.)duckduckgo\.com$/.test(u.hostname)) return u.pathname === "/l/" ? u.searchParams.get("uddg") : null;
	return u.href;
}

function ddgBlocked(status, html, count) {
	if (count) return false;
	return status === 202 || status === 403 || status === 418 || status === 429 || DDG_BLOCK.test(html);
}

export function parseDuckDuckGoHtml(html, status = 200) {
	const root = parse(html, PARSE_OPTS);
	const list = [];
	for (const el of root.querySelectorAll("div.result")) {
		if (el.classList.contains("result--ad") || el.querySelector(".badge--ad")) continue;
		const a = el.querySelector("a.result__a");
		const url = ddgTarget(a?.getAttribute("href"));
		if (!url) continue;
		list.push(result(a.text, url, el.querySelector(".result__snippet")?.text));
	}
	const results = finish(list);
	return { results, blocked: ddgBlocked(status, html, results.length) };
}

export function parseDuckDuckGoLite(html, status = 200) {
	const root = parse(html, PARSE_OPTS);
	const list = [];
	for (const a of root.querySelectorAll("a.result-link")) {
		const row = a.closest("tr");
		if (row?.classList.contains("result-sponsored")) continue;
		const url = ddgTarget(a.getAttribute("href"));
		if (!url) continue;
		const snippet = row?.nextElementSibling?.querySelector(".result-snippet")?.text;
		list.push(result(a.text, url, snippet));
	}
	const results = finish(list);
	return { results, blocked: ddgBlocked(status, html, results.length) };
}

async function duckduckgo(q) {
	const res = await request("https://html.duckduckgo.com/html/", {
		method: "POST",
		body: new URLSearchParams({ q, b: "", kl: "us-en" }).toString(),
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			origin: "https://html.duckduckgo.com",
			referer: "https://html.duckduckgo.com/",
		},
	});
	return { status: res.status, ...parseDuckDuckGoHtml(res.text, res.status) };
}

async function duckduckgoLite(q) {
	const res = await request("https://lite.duckduckgo.com/lite/", {
		method: "POST",
		body: new URLSearchParams({ q, kl: "us-en" }).toString(),
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			origin: "https://lite.duckduckgo.com",
			referer: "https://lite.duckduckgo.com/",
		},
	});
	return { status: res.status, ...parseDuckDuckGoLite(res.text, res.status) };
}

// ---- brave (html) ----

export function parseBraveHtml(html, status = 200, finalUrl = "") {
	const root = parse(html, PARSE_OPTS);
	const list = [];
	for (const el of root.querySelectorAll('div[data-type="web"]')) {
		const a =
			el.querySelector("a:has(> .title)") ??
			el.querySelectorAll("a[href]").find((x) => /^https?:/.test(x.getAttribute("href")) && !/brave\.com/.test(x.getAttribute("href")));
		if (!a) continue;
		const title = el.querySelector(".title")?.text ?? el.querySelector('[class*="title"]')?.text ?? a.text;
		const snippet =
			el.querySelector(".snippet-description")?.text ??
			el.querySelector('[class*="snippet"] [class*="content"]')?.text ??
			el.querySelector('[class*="description"]')?.text;
		list.push(result(title, a.getAttribute("href"), snippet));
	}
	const results = finish(list);
	const blocked =
		!results.length && (status === 403 || status === 429 || /captcha/i.test(finalUrl) || /captcha|pow-captcha/i.test(html));
	return { results, blocked };
}

async function braveHtml(q) {
	const res = await request(`https://search.brave.com/search?${new URLSearchParams({ q, source: "web" })}`, {
		headers: { cookie: "useLocation=0; summarizer=0; safesearch=moderate" },
	});
	return { status: res.status, ...parseBraveHtml(res.text, res.status, res.url) };
}

// ---- yahoo (bing's index) ----

export function yahooTarget(href) {
	if (!href) return null;
	const i = href.indexOf("/RU=");
	if (i === -1) return href;
	let enc = href.slice(i + 4);
	for (const stop of ["/RK=", "/RS="]) {
		const j = enc.indexOf(stop);
		if (j !== -1) enc = enc.slice(0, j);
	}
	try {
		return decodeURIComponent(enc);
	} catch {
		return null;
	}
}

export function parseYahoo(html, status = 200, finalUrl = "") {
	const root = parse(html, PARSE_OPTS);
	const list = [];
	for (const el of root.querySelectorAll("div.algo-sr, div.algo")) {
		const a = el.querySelector(".compTitle a") ?? el.querySelector("h3 a");
		if (!a) continue;
		const url = yahooTarget(a.getAttribute("href"));
		if (!url || url.includes("bing.com/aclick")) continue;
		const title = a.getAttribute("aria-label") || el.querySelector("h3")?.text || a.text;
		list.push(result(title, url, el.querySelector(".compText")?.text));
	}
	const results = finish(list);
	const blocked =
		!results.length && (status === 403 || status === 429 || /consent\.|guce\./.test(finalUrl) || /captcha/i.test(finalUrl));
	return { results, blocked };
}

async function yahoo(q) {
	const res = await request(`https://search.yahoo.com/search?${new URLSearchParams({ p: q, ei: "UTF-8" })}`);
	return { status: res.status, ...parseYahoo(res.text, res.status, res.url) };
}

// ---- bing ----

export function bingTarget(href) {
	if (!href) return null;
	let u;
	try {
		u = new URL(href, "https://www.bing.com/");
	} catch {
		return null;
	}
	if (!/(^|\.)bing\.com$/.test(u.hostname)) return u.href;
	if (u.pathname !== "/ck/a") return null;
	const enc = u.searchParams.get("u");
	if (!enc) return null;
	try {
		return Buffer.from(enc.startsWith("a1") ? enc.slice(2) : enc, "base64url").toString("utf8");
	} catch {
		return null;
	}
}

const STOP = new Set(["the", "and", "for", "with", "what", "who", "how", "are", "is", "was", "does", "about", "from", "that", "this", "you", "your", "can", "why", "when", "where", "which"]);

/** bing's html sometimes answers a different question, so keep results that mention the query */
function relevant(results, q) {
	const words = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w));
	if (!words.length) return results;
	return results.filter((r) => {
		const hay = `${r.title} ${r.snippet} ${r.url}`.toLowerCase();
		return words.some((w) => hay.includes(w));
	});
}

export function parseBing(html, status = 200, q = "") {
	const root = parse(html, PARSE_OPTS);
	const list = [];
	for (const el of root.querySelectorAll("li.b_algo")) {
		const a = el.querySelector("h2 a");
		if (!a) continue;
		const url = bingTarget(a.getAttribute("href"));
		if (!url) continue;
		const snippet = el.querySelector(".b_caption p")?.text ?? el.querySelector("p")?.text;
		list.push(result(a.text, url, snippet));
	}
	const results = relevant(finish(list), q);
	const blocked = !results.length && (status !== 200 || /captcha|\/challenge/i.test(html) || !html.includes("b_results"));
	return { results, blocked };
}

async function bing(q) {
	const res = await request(`https://www.bing.com/search?${new URLSearchParams({ q, setlang: "en" })}`);
	return { status: res.status, ...parseBing(res.text, res.status, q) };
}

// ---- wikipedia: tiny index, but a json api that never blocks ----

async function wikipedia(q) {
	const params = new URLSearchParams({ action: "query", list: "search", srsearch: q, format: "json", srlimit: "5", utf8: "1" });
	const res = await request(`https://en.wikipedia.org/w/api.php?${params}`, {
		plain: true,
		headers: { accept: "application/json", "user-agent": "Umbrella/1.0 (https://github.com/devmidnightst/umbrella)" },
	});
	if (res.status !== 200) return { status: res.status, results: [], blocked: res.status === 403 || res.status === 429 };
	const hits = JSON.parse(res.text)?.query?.search ?? [];
	const results = finish(
		hits.map((h) =>
			result(
				h.title,
				`https://en.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, "_"))}`,
				parse(h.snippet ?? "").text,
			),
		),
	);
	return { status: res.status, results, blocked: false };
}

// ---- keyed engines (optional) ----

async function searxng(q) {
	const base = process.env.SEARXNG_URL.replace(/\/+$/, "");
	const params = new URLSearchParams({ q, format: "json", safesearch: "0", language: "en-US" });
	const res = await request(`${base}/search?${params}`, { plain: true, headers: { accept: "application/json" } });
	if (res.status === 403) throw new Error("searxng refused json, add json to search.formats in its settings.yml");
	if (res.status !== 200) return { status: res.status, results: [], blocked: res.status === 429 };
	const data = JSON.parse(res.text);
	return { status: res.status, results: finish((data.results ?? []).map((r) => result(r.title, r.url, r.content))), blocked: false };
}

async function braveApi(q) {
	const params = new URLSearchParams({ q, count: "8", text_decorations: "false" });
	const res = await request(`https://api.search.brave.com/res/v1/web/search?${params}`, {
		plain: true,
		headers: { accept: "application/json", "x-subscription-token": process.env.BRAVE_SEARCH_API_KEY },
	});
	if (res.status === 401 || res.status === 403) throw new Error("brave search api rejected the key");
	if (res.status !== 200) return { status: res.status, results: [], blocked: res.status === 429 };
	const data = JSON.parse(res.text);
	const hits = data?.web?.results ?? [];
	return { status: res.status, results: finish(hits.map((r) => result(r.title, r.url, parse(r.description ?? "").text))), blocked: false };
}

export const ENGINES = [
	{ name: "searxng", run: searxng, enabled: () => !!process.env.SEARXNG_URL },
	{ name: "brave-api", run: braveApi, enabled: () => !!process.env.BRAVE_SEARCH_API_KEY },
	{ name: "duckduckgo", run: duckduckgo },
	{ name: "duckduckgo-lite", run: duckduckgoLite },
	{ name: "brave", run: braveHtml },
	{ name: "yahoo", run: yahoo },
	{ name: "bing", run: bing },
	{ name: "wikipedia", run: wikipedia },
];

// ---- the chain ----

const sitOut = new Map();
const cache = new Map();
const inFlight = new Map();
const pageCache = new Map();

export function resetSearchState() {
	sitOut.clear();
	cache.clear();
	inFlight.clear();
	pageCache.clear();
}

/**
 * searches engine by engine until one has results.
 * resolves { results, engine, query }; results is [] only when every engine
 * that answered said "no results". rejects when every engine failed or blocked.
 */
export function searchWeb(rawQuery, opts = {}) {
	const query = normalizeQuery(rawQuery);
	if (!query) return Promise.resolve({ results: [], engine: null, query });
	const hit = cache.get(query);
	if (hit && Date.now() - hit.at < CACHE_TTL) return Promise.resolve(hit.value);
	if (inFlight.has(query)) return inFlight.get(query);
	const job = runEngines(query, opts).finally(() => inFlight.delete(query));
	inFlight.set(query, job);
	return job;
}

async function runEngines(query, { engines = ENGINES, deadline = 12_000 } = {}) {
	const started = Date.now();
	const failures = [];
	let answered = false;
	for (const engine of engines) {
		if (engine.enabled && !engine.enabled()) continue;
		if ((sitOut.get(engine.name) ?? 0) > Date.now()) continue;
		if (Date.now() - started > deadline) {
			failures.push("out of time");
			break;
		}
		try {
			const { results, blocked, status } = await engine.run(query);
			if (results.length) {
				const value = { results, engine: engine.name, query };
				cache.set(query, { at: Date.now(), value });
				if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
				return value;
			}
			if (blocked) {
				sitOut.set(engine.name, Date.now() + BLOCK_COOLDOWN);
				failures.push(`${engine.name} blocked (${status})`);
				console.warn(`[umbrella] web search: ${engine.name} blocked this server (http ${status}), skipping it for 15 minutes`);
			} else {
				answered = true;
			}
		} catch (err) {
			sitOut.set(engine.name, Date.now() + ERROR_COOLDOWN);
			failures.push(`${engine.name}: ${err.message}`);
			console.warn(`[umbrella] web search: ${engine.name} failed: ${err.message}`);
		}
	}
	if (answered) return { results: [], engine: null, query };
	const err = new SearchBlocked(failures.length ? failures.join("; ") : "every search engine is cooling down");
	err.failures = failures;
	throw err;
}

// ---- reading result pages ----

function guardedLookup(hostname, options, callback) {
	dnsCb.lookup(hostname, { ...options, all: true }, (err, addresses) => {
		if (err) return callback(err);
		const ok = addresses.filter((a) => !ipBlocked(a.address));
		if (!ok.length) return callback(Object.assign(new Error(`${hostname} resolves to a blocked address`), { code: "EBLOCKED" }));
		if (options?.all) return callback(null, ok);
		callback(null, ok[0].address, ok[0].family);
	});
}

function decodeBody(buf, encoding) {
	const loose = { finishFlush: zlib.constants.Z_SYNC_FLUSH };
	if (encoding === "gzip" || encoding === "x-gzip") return zlib.gunzipSync(buf, loose);
	if (encoding === "deflate") return zlib.inflateSync(buf, loose);
	if (encoding === "br") return zlib.brotliDecompressSync(buf, { finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH });
	return buf;
}

/** fetches one page as text, refusing private addresses at connect time (so dns rebinding can't sneak past) */
export function fetchPage(url, { timeout = 5000, maxBytes = 1_500_000, hops = 0 } = {}) {
	return new Promise((resolve, reject) => {
		let u;
		try {
			u = new URL(url);
		} catch {
			return reject(new Error("bad url"));
		}
		if ((u.protocol !== "http:" && u.protocol !== "https:") || u.port || u.username) return reject(new Error("unsupported url"));
		// node skips the lookup hook for ip literals, so those are checked here
		const literal = u.hostname.replace(/^\[|\]$/g, "");
		if (net.isIP(literal) && ipBlocked(literal)) return reject(new Error(`${literal} is a blocked address`));
		const lib = u.protocol === "https:" ? https : http;
		const req = lib.get(
			u,
			{
				lookup: guardedLookup,
				timeout,
				headers: {
					"user-agent": CHROME_UA,
					accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8",
					"accept-language": "en-US,en;q=0.9",
					"accept-encoding": "gzip, deflate, br",
				},
			},
			(res) => {
				const { statusCode: status, headers } = res;
				if (status >= 300 && status < 400 && headers.location) {
					res.resume();
					if (hops >= 3) return reject(new Error("too many redirects"));
					return resolve(fetchPage(new URL(headers.location, u).href, { timeout, maxBytes, hops: hops + 1 }));
				}
				const type = String(headers["content-type"] ?? "");
				if (status !== 200 || !/text\/html|application\/xhtml|text\/plain/i.test(type)) {
					res.resume();
					return reject(new Error(`http ${status} ${type.split(";")[0]}`));
				}
				const chunks = [];
				let size = 0;
				res.on("data", (c) => {
					size += c.length;
					if (size > maxBytes) return res.destroy();
					chunks.push(c);
				});
				res.on("close", () => {
					try {
						const buf = decodeBody(Buffer.concat(chunks), headers["content-encoding"]);
						const charset = /charset=([\w-]+)/i.exec(type)?.[1] ?? "utf-8";
						let text;
						try {
							text = new TextDecoder(charset).decode(buf);
						} catch {
							text = buf.toString("utf8");
						}
						resolve({ url: u.href, type, text });
					} catch (err) {
						reject(err);
					}
				});
				res.on("error", reject);
			},
		);
		const timer = setTimeout(() => req.destroy(new Error("timed out")), timeout);
		req.on("close", () => clearTimeout(timer));
		req.on("timeout", () => req.destroy(new Error("timed out")));
		req.on("error", reject);
	});
}

const NOISE = "nav, header, footer, aside, form, svg, iframe, button, select, template, [role=navigation], [role=banner], [role=contentinfo], [aria-hidden=true], .cookie, .cookies, .advert, .ads, .sidebar, .comments";

/** readable text of a page, without menus, footers and scripts */
export function extractText(html, max = 3000) {
	const root = parse(html, PARSE_OPTS);
	for (const el of root.querySelectorAll(NOISE)) el.remove();
	const body = root.querySelector("body") ?? root;
	const main = root.querySelector("article") ?? root.querySelector("main") ?? root.querySelector("[role=main]");
	const pick = main && main.text.trim().length > 400 ? main : body;
	const text = pick.structuredText
		.split("\n")
		.map((l) => l.replace(/\s+/g, " ").trim())
		.filter((l) => l.length > 1)
		.join("\n");
	return text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/, "")}\u2026` : text;
}

/** copies of the results with a `content` excerpt on the first few, giving up on slow pages */
export async function readPages(results, { count = 3, max = 3000, deadline = 6000 } = {}) {
	const out = results.map((r) => ({ ...r }));
	const jobs = out.slice(0, count).map(async (r) => {
		const hit = pageCache.get(r.url);
		if (hit && Date.now() - hit.at < CACHE_TTL) {
			if (hit.content) r.content = hit.content;
			return;
		}
		const page = await fetchPage(r.url);
		const text = /text\/plain/i.test(page.type) ? clean(page.text, max) : extractText(page.text, max);
		const content = text.length > 200 ? text : "";
		pageCache.set(r.url, { at: Date.now(), content });
		if (pageCache.size > CACHE_MAX) pageCache.delete(pageCache.keys().next().value);
		if (content) r.content = content;
	});
	let timer;
	await Promise.race([
		Promise.allSettled(jobs),
		new Promise((resolve) => {
			timer = setTimeout(resolve, deadline);
		}),
	]);
	clearTimeout(timer);
	return out;
}
