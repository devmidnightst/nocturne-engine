import express from "express";
import { searchWeb, readPages } from "./web-search.js";

// set these in .env, never commit a real key
const AI_BASE = () => (process.env.AI_API_BASE || "https://emis.zxs-is-very.cool").replace(/\/+$/, "");
const AI_KEY = () => process.env.AI_API_KEY || "";

const HEADERS_TIMEOUT = 120_000;
const IDLE_TIMEOUT = 120_000;

// every search hits outside engines from this server's ip, and hammering them
// is how the ip gets flagged, so each visitor gets a small budget
const SEARCH_WINDOW = 5 * 60_000;
const SEARCH_LIMIT = 30;
const searchHits = new Map();

function overSearchLimit(ip) {
	const now = Date.now();
	const recent = (searchHits.get(ip) ?? []).filter((t) => now - t < SEARCH_WINDOW);
	if (recent.length >= SEARCH_LIMIT) {
		searchHits.set(ip, recent);
		return true;
	}
	recent.push(now);
	searchHits.set(ip, recent);
	if (searchHits.size > 5000) searchHits.delete(searchHits.keys().next().value);
	return false;
}

export function createAiRouter() {
	const router = express.Router();

	router.post("/chat", express.json({ limit: "2mb" }), async (req, res) => {
		if (!AI_KEY()) return res.status(503).json({ error: "ai is not configured. set AI_API_KEY on the server." });
		// stop the upstream call (and its token bill) as soon as the visitor goes away.
		// req "close" fires once the body is read, so it has to be res "close".
		const upstreamAbort = new AbortController();
		res.on("close", () => {
			if (!res.writableFinished) upstreamAbort.abort(new Error("client went away"));
		});
		let timer = setTimeout(() => upstreamAbort.abort(new Error("the model took too long to answer")), HEADERS_TIMEOUT);
		try {
			const upstream = await fetch(`${AI_BASE()}/v1/chat/completions`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${AI_KEY()}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(req.body),
				signal: upstreamAbort.signal,
			});
			res.status(upstream.status);
			const ct = upstream.headers.get("content-type");
			if (ct) res.setHeader("content-type", ct);
			if (req.body?.stream) {
				res.setHeader("cache-control", "no-cache");
				res.setHeader("x-accel-buffering", "no");
			}
			if (!upstream.body) return res.end();
			const reader = upstream.body.getReader();
			const idle = () => {
				clearTimeout(timer);
				timer = setTimeout(() => upstreamAbort.abort(new Error("the model stopped sending")), IDLE_TIMEOUT);
			};
			idle();
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				idle();
				if (res.destroyed) break;
				if (!res.write(value)) {
					await new Promise((r) => {
						const done = () => {
							res.off("drain", done);
							res.off("close", done);
							r();
						};
						res.once("drain", done);
						res.once("close", done);
					});
				}
			}
			res.end();
		} catch (err) {
			const reason = upstreamAbort.signal.reason?.message ?? err.message;
			if (!res.headersSent) res.status(502).json({ error: reason });
			else if (!res.destroyed) {
				if (req.body?.stream) res.write(`data: ${JSON.stringify({ error: { message: reason } })}\n\n`);
				res.end();
			}
		} finally {
			clearTimeout(timer);
		}
	});

	router.get("/search", async (req, res) => {
		const q = String(req.query.q || "").slice(0, 2000);
		if (!q.trim()) return res.json({ results: [], engine: null, query: "" });
		if (overSearchLimit(req.ip)) {
			return res.status(429).json({ error: "too many web searches, wait a few minutes", results: [] });
		}
		try {
			const found = await searchWeb(q);
			const results = req.query.read === "1" && found.results.length ? await readPages(found.results) : found.results;
			res.json({ ...found, results });
		} catch (err) {
			res.status(502).json({ error: "web search is unavailable right now, every search engine refused this server", detail: err.message, results: [] });
		}
	});

	return router;
}
