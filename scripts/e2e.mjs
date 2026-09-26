// nocturne engine end to end suite.
//
//   npm run test:e2e
//
// boots the nocturne server and a local fixture site, drives a real chromium
// through the proxy and checks that the rewriter handled everything on the
// fixture page (see test/fixture/site/checks.js). runs once per transport.
//
// env:
//   CHROME_PATH                 chromium binary (defaults to playwright's lookup)
//   NOCTURNE_E2E_EXTRA_CA       pem bundle to trust inside epoxy, for networks that
//                               re-sign tls (corporate proxies, ci sandboxes)
//   NOCTURNE_E2E_URLS           comma separated real urls to smoke test as well

import fs from "node:fs";

// the fixture runs on 127.0.0.1, which wisp refuses by default (ssrf guard)
process.env.WISP_ALLOW_LOOPBACK_IPS = "1";
process.env.WISP_LOG_LEVEL = "NONE";

const { chromium } = await import("playwright-core");
const { createServer } = await import("../src/server.js");
const { startFixture } = await import("../test/fixture/server.js");

const fixture = await startFixture(0);
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`;
const nocturne = createServer();
await new Promise((r) => nocturne.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${nocturne.address().port}`;

const browser = await chromium.launch({
	executablePath: process.env.CHROME_PATH || (fs.existsSync("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined),
	args: ["--no-sandbox"],
});

let failures = 0;
const pass = (m) => console.log(`  \x1b[32mpass\x1b[0m ${m}`);
const fail = (m) => {
	failures++;
	console.log(`  \x1b[31mFAIL\x1b[0m ${m}`);
};

async function newShell(transport) {
	const context = await browser.newContext();
	await context.addInitScript((t) => {
		localStorage.setItem("nocturne:settings", JSON.stringify({ transport: t, blockAds: true }));
	}, transport);
	const extraCa = process.env.NOCTURNE_E2E_EXTRA_CA;
	if (extraCa) {
		const pem = fs.readFileSync(extraCa, "utf8");
		await context.route("**/transports/epoxy.mjs", async (route) => {
			const res = await route.fetch();
			const body = (await res.text()).replace(
				"this.client = new EpoxyClient(this.wisp, options);",
				`options.pem_files = [${JSON.stringify(pem)}]; this.client = new EpoxyClient(this.wisp, options);`
			);
			await route.fulfill({ response: res, body });
		});
	}
	const page = await context.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	return { context, page, errors };
}

const proxyFrame = (page) => page.frames().find((f) => f.parentFrame() === page.mainFrame());

async function runFixture(transport) {
	console.log(`\nfixture checks over ${transport}`);
	const { context, page } = await newShell(transport);
	await page.goto(`${base}/?go=${encodeURIComponent(fixtureUrl)}`);
	try {
		await page.waitForFunction(
			() => {
				const f = document.getElementById("frame");
				try {
					return f.contentDocument?.title === "fixture done";
				} catch {
					return false;
				}
			},
			null,
			{ timeout: 60_000 }
		);
	} catch {
		fail("fixture page never finished (timed out)");
		await context.close();
		return;
	}
	const text = await proxyFrame(page).innerText("#results");
	const results = JSON.parse(text);
	for (const [name, value] of Object.entries(results)) {
		value === true ? pass(name) : fail(`${name}: ${value}`);
	}
	const address = await page.inputValue("#address");
	address.startsWith(fixtureUrl) ? pass("omnibox shows the real url") : fail(`omnibox shows ${address}`);
	await context.close();
}

async function runErrorPage() {
	console.log("\nerror pages");
	const { context, page } = await newShell("epoxy");
	await page.goto(`${base}/?go=${encodeURIComponent("http://nocturne-does-not-exist.invalid/")}`);
	try {
		await page.waitForFunction(
			() => document.getElementById("frame").contentDocument?.title?.includes("Nocturne Engine"),
			null,
			{ timeout: 30_000 }
		);
		const title = await proxyFrame(page).title();
		pass(`unknown host shows a nocturne error page ("${title}")`);
	} catch {
		fail("unknown host did not show the nocturne error page");
	}
	await context.close();
}

async function runBlocker() {
	console.log("\ncontent blocker");
	const { context, page } = await newShell("epoxy");
	await page.goto(`${base}/?go=${encodeURIComponent(fixtureUrl + "child.html")}`);
	await page.waitForFunction(() => document.getElementById("frame").contentDocument?.body?.innerText?.includes("child"), null, { timeout: 30_000 });
	const res = await proxyFrame(page).evaluate(async () => {
		const t = Date.now();
		const r = await fetch("https://securepubads.g.doubleclick.net/tag/js/gpt.js");
		return { status: r.status, len: (await r.text()).length, ms: Date.now() - t };
	});
	res.status === 200 && res.len === 0 ? pass(`ad script answered locally in ${res.ms}ms`) : fail(`ad request not blocked: ${JSON.stringify(res)}`);
	await context.close();
}

async function runRealSites() {
	const urls = (process.env.NOCTURNE_E2E_URLS || "").split(",").map((s) => s.trim()).filter(Boolean);
	if (!urls.length) return;
	console.log("\nreal site smoke tests");
	for (const url of urls) {
		const { context, page, errors } = await newShell("epoxy");
		await page.goto(`${base}/?go=${encodeURIComponent(url)}`);
		await page.waitForTimeout(15_000);
		let title = "";
		try {
			title = await proxyFrame(page).title();
		} catch {
			// frame gone
		}
		const shot = `e2e-${new URL(url).hostname}.png`;
		await page.screenshot({ path: shot });
		title && !title.includes("Nocturne Engine") ? pass(`${url} loaded ("${title}", screenshot ${shot})`) : fail(`${url} did not load (title "${title}")`);
		if (errors.length) console.log(`       shell errors: ${errors.slice(0, 3).join(" | ")}`);
		await context.close();
	}
}

try {
	await runFixture("epoxy");
	await runFixture("libcurl");
	await runErrorPage();
	await runBlocker();
	await runRealSites();
} finally {
	await browser.close();
	nocturne.close();
	fixture.close();
}

console.log(failures ? `\n${failures} failed` : "\nall e2e checks passed");
process.exit(failures ? 1 : 0);
