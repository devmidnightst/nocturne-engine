import express from "express";

// set these in .env, never commit a real key
const AI_BASE = () => (process.env.AI_API_BASE || "https://emis.zxs-is-very.cool").replace(/\/+$/, "");
const AI_KEY = () => process.env.AI_API_KEY || "";

export function createAiRouter() {
	const router = express.Router();

	router.post("/chat", express.json({ limit: "2mb" }), async (req, res) => {
		if (!AI_KEY()) return res.status(503).json({ error: "ai is not configured. set AI_API_KEY on the server." });
		try {
			const upstream = await fetch(`${AI_BASE()}/v1/chat/completions`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${AI_KEY()}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(req.body),
				signal: AbortSignal.timeout(120_000),
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
			req.on("close", () => reader.cancel().catch(() => {}));
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!res.write(value)) await new Promise((r) => res.once("drain", r));
			}
			res.end();
		} catch (err) {
			if (!res.headersSent) res.status(500).json({ error: err.message });
			else res.end();
		}
	});

	router.get("/search", async (req, res) => {
		const q = String(req.query.q || "").trim();
		if (!q) return res.json({ results: [] });
		try {
			const r = await fetch(
				`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
				{
					headers: {
						"User-Agent":
							"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
						Accept: "text/html,application/xhtml+xml",
						"Accept-Language": "en-US,en;q=0.9",
					},
					signal: AbortSignal.timeout(8000),
				}
			);
			const html = await r.text();
			const results = [];
			const titleRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
			const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
			const titles = [];
			const snippets = [];
			let m;
			while ((m = titleRe.exec(html)) !== null && titles.length < 6) {
				const url = decodeURIComponent(m[1].replace(/^\/\/duckduckgo\.com\/l\/\?uddg=([^&]+).*/, "$1"));
				const title = m[2].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").trim();
				if (url.startsWith("http")) titles.push({ url, title });
			}
			while ((m = snippetRe.exec(html)) !== null && snippets.length < 6) {
				snippets.push(m[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").trim());
			}
			for (let i = 0; i < Math.min(titles.length, 5); i++) {
				results.push({ ...titles[i], snippet: snippets[i] || "" });
			}
			res.json({ results });
		} catch (err) {
			res.status(500).json({ error: err.message, results: [] });
		}
	});

	return router;
}
