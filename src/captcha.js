import { Router } from "express";

const CAPTCHA_DOMAINS = [
	"hcaptcha.com",
	"js.hcaptcha.com",
	"newassets.hcaptcha.com",
	"imgs.hcaptcha.com",
	"challenges.cloudflare.com",
	"www.google.com/recaptcha",
	"www.gstatic.com/recaptcha",
	"www.recaptcha.net",
];

const SOLVER_BACKENDS = {
	nopecha: {
		name: "NopeCHA",
		async solve(type, sitekey, pageurl, apiKey) {
			const typeMap = { hcaptcha: "hcaptcha", recaptcha2: "recaptcha2", recaptcha3: "recaptcha3", turnstile: "turnstile" };
			const res = await fetch("https://api.nopecha.com/token/", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ key: apiKey, type: typeMap[type] || type, sitekey, url: pageurl }),
			});
			const data = await res.json();
			if (data.error) throw new Error(data.error);
			if (data.data) return data.data;
			const id = data.id;
			for (let i = 0; i < 30; i++) {
				await new Promise((r) => setTimeout(r, 3000));
				const poll = await fetch(`https://api.nopecha.com/token/?key=${apiKey}&id=${id}`);
				const result = await poll.json();
				if (result.error) throw new Error(result.error);
				if (result.data) return result.data;
			}
			throw new Error("solver timed out");
		},
	},
	twocaptcha: {
		name: "2Captcha",
		async solve(type, sitekey, pageurl, apiKey) {
			const method = type === "hcaptcha" ? "hcaptcha" : type === "turnstile" ? "turnstile" : "userrecaptcha";
			const createRes = await fetch(
				`https://2captcha.com/in.php?key=${apiKey}&method=${method}&sitekey=${sitekey}&pageurl=${encodeURIComponent(pageurl)}&json=1`
			);
			const created = await createRes.json();
			if (created.status !== 1) throw new Error(created.request || "failed to create task");
			const id = created.request;
			for (let i = 0; i < 40; i++) {
				await new Promise((r) => setTimeout(r, 5000));
				const poll = await fetch(`https://2captcha.com/res.php?key=${apiKey}&action=get&id=${id}&json=1`);
				const result = await poll.json();
				if (result.status === 1) return result.request;
				if (result.request !== "CAPCHA_NOT_READY") throw new Error(result.request);
			}
			throw new Error("solver timed out");
		},
	},
	capsolver: {
		name: "CapSolver",
		async solve(type, sitekey, pageurl, apiKey) {
			const taskType =
				type === "hcaptcha" ? "HCaptchaTaskProxyLess" :
				type === "turnstile" ? "AntiTurnstileTaskProxyLess" :
				"RecaptchaV2TaskProxyless";
			const createRes = await fetch("https://api.capsolver.com/createTask", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					clientKey: apiKey,
					task: { type: taskType, websiteURL: pageurl, websiteKey: sitekey },
				}),
			});
			const created = await createRes.json();
			if (created.errorId) throw new Error(created.errorDescription || "failed to create task");
			const taskId = created.taskId;
			for (let i = 0; i < 40; i++) {
				await new Promise((r) => setTimeout(r, 3000));
				const poll = await fetch("https://api.capsolver.com/getTaskResult", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ clientKey: apiKey, taskId }),
				});
				const result = await poll.json();
				if (result.status === "ready") return result.solution?.gRecaptchaResponse || result.solution?.token;
				if (result.errorId) throw new Error(result.errorDescription);
			}
			throw new Error("solver timed out");
		},
	},
};

function getSolverConfig() {
	const backend = process.env.CAPTCHA_SOLVER || "";
	const apiKey = process.env.CAPTCHA_API_KEY || "";
	if (!backend || !apiKey) return null;
	const solver = SOLVER_BACKENDS[backend.toLowerCase()];
	if (!solver) return null;
	return { solver, apiKey, name: solver.name };
}

export function createCaptchaRouter() {
	const router = Router();

	const jsonParser = (req, res, next) => {
		if (!req.headers["content-type"]?.includes("application/json")) return next();
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			try {
				req.body = JSON.parse(body);
			} catch {
				req.body = {};
			}
			next();
		});
	};

	router.get("/status", (req, res) => {
		const cfg = getSolverConfig();
		res.json({
			available: !!cfg,
			solver: cfg?.name || null,
			supported: Object.keys(SOLVER_BACKENDS),
		});
	});

	router.post("/solve", jsonParser, async (req, res) => {
		const cfg = getSolverConfig();
		if (!cfg) {
			return res.status(503).json({ error: "no captcha solver configured. set CAPTCHA_SOLVER and CAPTCHA_API_KEY env vars." });
		}

		const { type, sitekey, pageurl } = req.body || {};
		if (!type || !sitekey || !pageurl) {
			return res.status(400).json({ error: "missing type, sitekey, or pageurl" });
		}

		try {
			const token = await cfg.solver.solve(type, sitekey, pageurl, cfg.apiKey);
			res.json({ ok: true, token });
		} catch (err) {
			console.error(`[captcha] ${cfg.name} solve failed:`, err.message);
			res.status(502).json({ error: `solver failed: ${err.message}` });
		}
	});

	router.get("/passthrough", async (req, res) => {
		const url = req.query.url;
		if (!url) return res.status(400).send("missing url param");

		try {
			const parsed = new URL(url);
			const allowed = CAPTCHA_DOMAINS.some((d) => parsed.hostname === d || parsed.hostname.endsWith("." + d));
			if (!allowed) return res.status(403).send("domain not allowed");

			const upstream = await fetch(url, {
				headers: {
					"User-Agent": req.headers["user-agent"] || "Mozilla/5.0",
					Accept: "*/*",
					Referer: req.query.referer || "",
				},
			});

			const ct = upstream.headers.get("content-type") || "application/javascript";
			res.setHeader("Content-Type", ct);
			res.setHeader("Access-Control-Allow-Origin", "*");
			res.setHeader("Cache-Control", "public, max-age=300");

			const body = await upstream.text();
			res.send(body);
		} catch (err) {
			const msg = err.message || "";
			if (msg.includes("allowlist") || msg.includes("egress") || msg.includes("ENOTFOUND")) {
				return res.status(502).send("captcha cdn not reachable from this server (network policy may block it)");
			}
			console.error("[captcha] passthrough failed:", msg);
			res.status(502).send("fetch failed");
		}
	});

	return router;
}
