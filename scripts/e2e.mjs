// umbrella end to end suite.
//
//   npm run test:e2e
//
// boots the umbrella server and a local fixture site, drives a real chromium
// through the proxy and checks that the rewriter handled everything on the
// fixture page (see test/fixture/site/checks.js). runs once per transport.
//
// env:
//   CHROME_PATH                 chromium binary (defaults to playwright's lookup)
//   UMBRELLA_E2E_EXTRA_CA       pem bundle to trust inside epoxy, for networks that
//                               re-sign tls (corporate proxies, ci sandboxes)
//   UMBRELLA_E2E_URLS           comma separated real urls to smoke test as well

import fs from "node:fs";

// the fixture runs on 127.0.0.1, which wisp refuses by default (ssrf guard)
process.env.WISP_ALLOW_LOOPBACK_IPS = "1";
process.env.WISP_LOG_LEVEL = "NONE";

const { chromium } = await import("playwright-core");
const { createServer } = await import("../src/server.js");
const { startFixture } = await import("../test/fixture/server.js");

const fixture = await startFixture(0);
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`;
const umbrella = createServer();
await new Promise((r) => umbrella.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${umbrella.address().port}`;

const browser = await chromium.launch({
	executablePath: process.env.CHROME_PATH || (fs.existsSync("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined),
	// music sites start playback from a click, the e2e run has no user to click
	args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
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
		localStorage.setItem("umbrella:settings", JSON.stringify({ transport: t, blockAds: true }));
	}, transport);
	const extraCa = process.env.UMBRELLA_E2E_EXTRA_CA || process.env.NOCTURNE_E2E_EXTRA_CA;
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

// audio playback: <audio> with range requests, mse fed from fetch/xhr (how
// youtube music streams), web audio and eme. the fixture page is loaded once
// directly first, so a failure that also happens without the proxy is reported
// as a fixture problem instead of a proxy bug.
async function runMedia(transport) {
	console.log(`\naudio playback over ${transport}`);
	const waitDone = (page, getDoc) =>
		page.waitForFunction(getDoc, null, { timeout: 90_000 });
	const direct = await browser.newPage();
	await direct.goto(fixtureUrl + "media.html");
	await waitDone(direct, () => document.title === "media done");
	const baseline = JSON.parse(await direct.innerText("#results"));
	await direct.close();

	const { context, page } = await newShell(transport);
	await page.goto(`${base}/?go=${encodeURIComponent(fixtureUrl + "media.html")}`);
	try {
		await waitDone(page, () => {
			try {
				return document.getElementById("frame").contentDocument?.title === "media done";
			} catch {
				return false;
			}
		});
	} catch {
		fail("media page never finished (timed out)");
		await context.close();
		return;
	}
	const results = JSON.parse(await proxyFrame(page).innerText("#results"));
	for (const [name, value] of Object.entries(results)) {
		if (baseline[name] !== true) console.log(`  \x1b[33mskip\x1b[0m ${name}: fails without the proxy too (${baseline[name]})`);
		else value === true ? pass(name) : fail(`${name}: ${value}`);
	}
	await context.close();
}

// a single websocket message sent after a quiet spell has to reach the server
// on its own. epoxy 3.0.1 held it back until something else was written, which
// is why umbrella routes websockets through libcurl when epoxy is selected.
async function runLoneSend(transport) {
	const { context, page } = await newShell(transport);
	await page.goto(`${base}/?go=${encodeURIComponent(fixtureUrl + "ws-lone.html")}`);
	let title = "";
	try {
		await page.waitForFunction(
			() => {
				try {
					return document.getElementById("frame").contentDocument?.title?.startsWith("lone ");
				} catch {
					return false;
				}
			},
			null,
			{ timeout: 30_000 }
		);
		title = await proxyFrame(page).title();
	} catch {
		title = "timed out";
	}
	const ms = Number(title.match(/^lone ok (\d+)ms/)?.[1] ?? Infinity);
	ms < 1500 ? pass(`websocket lone send over ${transport} (${title.slice(8)})`) : fail(`websocket lone send over ${transport}: ${title}`);
	await context.close();
}

// the fixture, like node and most servers, closes an idle keep alive connection
// after 5 seconds. the next request has to open a fresh one, not hang on the
// dead one. epoxy 3.0.1 hangs here, which is why libcurl is the default.
async function runIdleReuse(transport, { knownBroken = false } = {}) {
	const { context, page } = await newShell(transport);
	await page.goto(`${base}/?go=${encodeURIComponent(fixtureUrl + "child.html")}`);
	await page.waitForFunction(() => document.getElementById("frame").contentDocument?.body?.innerText?.includes("child"), null, { timeout: 30_000 });
	const frame = proxyFrame(page);
	await frame.evaluate(() => fetch("/api/echo?warm=1").then((r) => r.text()));
	await page.waitForTimeout(7000);
	const res = await frame.evaluate(() =>
		Promise.race([
			fetch("/api/echo?after-idle=1").then((r) => `status ${r.status}`),
			new Promise((r) => setTimeout(() => r("hung for 15s"), 15_000)),
		])
	);
	const ok = res === "status 200";
	if (ok) pass(`request after an idle keep alive over ${transport}`);
	else if (knownBroken) console.log(`  \x1b[33mknown\x1b[0m request after an idle keep alive over ${transport}: ${res} (upstream epoxy bug)`);
	else fail(`request after an idle keep alive over ${transport}: ${res}`);
	await context.close();
}

// a page that leaves 20 requests hanging, then a page with 31 parallel requests.
// scramjet never cancels the first page's requests, so before the abort on
// unload in engine.js libcurl's per host connections stayed full and the
// second page froze until the hanging ones timed out.
async function runAbandoned(transport) {
	const { context, page } = await newShell(transport);
	await page.goto(`${base}/?go=${encodeURIComponent(fixtureUrl + "hang.html")}`);
	await page.waitForFunction(() => document.getElementById("frame").contentDocument?.title === "hang", null, { timeout: 30_000 });
	await page.waitForTimeout(1000);
	await page.fill("#address", fixtureUrl + "soak-heavy.html");
	await page.press("#address", "Enter");
	try {
		await page.waitForFunction(() => document.getElementById("frame").contentDocument?.title === "heavy done", null, { timeout: 20_000 });
		const res = JSON.parse(await proxyFrame(page).innerText("#results"));
		res.bad === 0 ? pass(`page after abandoned requests loads over ${transport}`) : fail(`page after abandoned requests over ${transport}: ${JSON.stringify(res)}`);
	} catch {
		fail(`page after abandoned requests over ${transport}: stuck`);
	}
	await context.close();
}

async function runErrorPage() {
	console.log("\nerror pages");
	const { context, page } = await newShell("epoxy");
	await page.goto(`${base}/?go=${encodeURIComponent("http://umbrella-does-not-exist.invalid/")}`);
	try {
		await page.waitForFunction(
			() => document.getElementById("frame").contentDocument?.title?.includes("Umbrella"),
			null,
			{ timeout: 30_000 }
		);
		const title = await proxyFrame(page).title();
		pass(`unknown host shows an umbrella error page ("${title}")`);
	} catch {
		fail("unknown host did not show the umbrella error page");
	}
	await context.close();
}

async function runShell() {
	console.log("\nshell");
	const { context, page } = await newShell("libcurl");
	const frameText = () => page.evaluate(() => document.getElementById("frame").contentDocument?.body?.innerText ?? "");
	const waitChild = () => page.waitForFunction(() => document.getElementById("frame").contentDocument?.body?.innerText?.includes("child"), null, { timeout: 30_000 });
	const go = async (url) => {
		await page.fill("#address", url);
		await page.press("#address", "Enter");
	};
	try {
		await page.goto(`${base}/?go=${encodeURIComponent(fixtureUrl + "child.html")}`);
		await waitChild();
		const path = () => new URL(page.url()).pathname + new URL(page.url()).search;
		path() === "/" ? pass("address bar stays on the bare site while browsing") : fail(`address bar shows ${path()}`);

		// duckduckgo calls replaceState(state, "", undefined) after every search
		await proxyFrame(page).evaluate(() => {
			history.replaceState(null, "", undefined);
			history.pushState(null, "");
		});
		await page.waitForTimeout(300);
		const addr = await page.inputValue("#address");
		addr === fixtureUrl + "child.html" ? pass("history state without a url keeps the page url") : fail(`history state without a url moved the page to ${addr}`);

		// chrome stops an idle service worker after about 30s and the restarted
		// worker has forgotten every tab. the next navigation used to fall
		// through to the server and show its 404 page.
		const cdp = await context.newCDPSession(page);
		await cdp.send("ServiceWorker.enable");
		await cdp.send("ServiceWorker.stopAllWorkers");
		await page.waitForTimeout(300);
		await go(fixtureUrl + "child.html?after-sw-stop");
		await page.waitForTimeout(3000);
		const text = await frameText();
		text.includes("child") ? pass("navigating after the service worker was stopped still loads the page") : fail(`navigating after a service worker stop showed: ${text.slice(0, 60)}`);

		await page.reload();
		await page.waitForSelector("#boot", { state: "hidden", timeout: 30_000 });
		await waitChild();
		const restored = await page.inputValue("#address");
		restored === fixtureUrl + "child.html?after-sw-stop" ? pass("reloading the tab reopens the current site") : fail(`reload opened ${restored}`);

		await page.evaluate(() => (document.getElementById("frame").src = "/"));
		await page.waitForTimeout(3000);
		const nested = await page.evaluate(() => !!document.getElementById("frame").contentDocument?.getElementById("address"));
		!nested && page.frames().length === 2 ? pass("the shell never shows up inside its own frame") : fail("the shell loaded inside its own frame (two address bars)");
	} catch (err) {
		fail(`shell checks: ${err.message}`);
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
	const urls = (process.env.UMBRELLA_E2E_URLS || process.env.NOCTURNE_E2E_URLS || "").split(",").map((s) => s.trim()).filter(Boolean);
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
		title && !title.includes("Umbrella") ? pass(`${url} loaded ("${title}", screenshot ${shot})`) : fail(`${url} did not load (title "${title}")`);
		if (errors.length) console.log(`       shell errors: ${errors.slice(0, 3).join(" | ")}`);
		await context.close();
	}
}

try {
	await runFixture("epoxy");
	await runFixture("libcurl");
	await runMedia("libcurl");
	await runMedia("epoxy");
	console.log("\nwebsocket timing");
	await runLoneSend("epoxy");
	await runLoneSend("libcurl");
	console.log("\nkeep alive reuse");
	await runIdleReuse("libcurl");
	await runIdleReuse("epoxy", { knownBroken: true });
	console.log("\nabandoned requests");
	await runAbandoned("libcurl");
	await runAbandoned("epoxy");
	await runErrorPage();
	await runShell();
	await runBlocker();
	await runRealSites();
} finally {
	await browser.close();
	umbrella.close();
	fixture.close();
}

console.log(failures ? `\n${failures} failed` : "\nall e2e checks passed");
process.exit(failures ? 1 : 0);
