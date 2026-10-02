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
	await context.addInitScript(
		([t, wisp]) => {
			localStorage.setItem("_p8q2:settings", JSON.stringify({ _m: t === "libcurl" ? "lc" : "ep", _srvUrl: wisp, blockAds: true }));
		},
		[transport, base.replace("http", "ws") + "/wisp/"]
	);
	const extraCa = process.env.UMBRELLA_E2E_EXTRA_CA || process.env.NOCTURNE_E2E_EXTRA_CA;
	if (extraCa) {
		const pem = fs.readFileSync(extraCa, "utf8");
		await context.route("**/assets/r/transport.alt.mjs", async (route) => {
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
				return document.getElementById("frame")?.contentDocument?.title === "media done";
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
					return document.getElementById("frame")?.contentDocument?.title?.startsWith("lone ");
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
	await page.waitForFunction(() => document.getElementById("frame")?.contentDocument?.body?.innerText?.includes("child"), null, { timeout: 30_000 });
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
	await page.waitForFunction(() => document.getElementById("frame")?.contentDocument?.title === "hang", null, { timeout: 30_000 });
	await page.waitForTimeout(1000);
	await page.fill("#address", fixtureUrl + "soak-heavy.html");
	await page.press("#address", "Enter");
	try {
		await page.waitForFunction(() => document.getElementById("frame")?.contentDocument?.title === "heavy done", null, { timeout: 20_000 });
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
			() => {
				const doc = document.getElementById("frame")?.contentDocument;
				return !!doc?.getElementById("retry") && doc.title.includes("doesn't seem to exist");
			},
			null,
			{ timeout: 30_000 }
		);
		const title = await proxyFrame(page).title();
		pass(`unknown host shows the error page ("${title.trim()}")`);
	} catch {
		fail("unknown host did not show the error page");
	}
	await context.close();
}

async function runShell() {
	console.log("\nshell");
	const { context, page } = await newShell("libcurl");
	const frameText = () => page.evaluate(() => document.getElementById("frame")?.contentDocument?.body?.innerText ?? "");
	const waitChild = () => page.waitForFunction(() => document.getElementById("frame")?.contentDocument?.body?.innerText?.includes("child"), null, { timeout: 30_000 });
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

		// a deploy that changes sw.js installs a new worker while the shell stays
		// open. the controller kept posting to the old, dead worker, so every
		// proxied page fell through to the server's 404 until a reload.
		// playwright can't route the worker script, so change the file on disk
		// for a moment, the way a git pull would.
		const swPath = new URL("../public/sw.js", import.meta.url);
		const swSource = fs.readFileSync(swPath, "utf8");
		try {
			fs.writeFileSync(swPath, `${swSource}\n// deploy ${Date.now()}\n`);
			const swapped = await page.evaluate(async () => {
				const changed = new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", () => r(true), { once: true }));
				const reg = await navigator.serviceWorker.getRegistration("/");
				await reg.update();
				return Promise.race([changed, new Promise((r) => setTimeout(() => r(false), 10_000))]);
			});
			if (!swapped) fail("the updated service worker never took over");
			await page.waitForTimeout(500);
		} finally {
			fs.writeFileSync(swPath, swSource);
		}
		await go(fixtureUrl + "child.html?after-sw-update");
		const updated = await page
			.waitForFunction(
				() => {
					const f = document.getElementById("frame");
					if (!f?.contentWindow?.location.href.includes("after-sw-update")) return null;
					const text = f.contentDocument?.body?.innerText;
					return text ? text.trim() : null;
				},
				null,
				{ timeout: 20_000 }
			)
			.then((h) => h.jsonValue())
			.catch(() => "timed out");
		updated === "child" ? pass("browsing keeps working after a new service worker is deployed") : fail(`after a service worker update the page showed: ${updated.slice(0, 60)}`);

		await page.evaluate(() => (document.getElementById("frame").src = "/"));
		await page.waitForTimeout(3000);
		const nested = await page.evaluate(() => !!document.getElementById("frame")?.contentDocument?.getElementById("address"));
		!nested && page.frames().length === 2 ? pass("the shell never shows up inside its own frame") : fail("the shell loaded inside its own frame (two address bars)");
	} catch (err) {
		fail(`shell checks: ${err.message}`);
	}
	await context.close();
}

// side tabs: every tab keeps its own live frame, links that want a new tab
// land in the sidebar instead of a new browser tab, and a reload brings back
// every tab.
async function runTabs() {
	console.log("\ntabs");
	const { context, page } = await newShell("libcurl");
	const rows = () =>
		page.$$eval(".tab-row", (r) => r.map((x) => ({ url: x.title, active: x.classList.contains("active") })));
	const tabFrame = () => page.frames().find((f) => f.parentFrame() === page.mainFrame() && f.url().includes("tab.html"));
	const waitRows = (n) => page.waitForFunction((n) => document.querySelectorAll(".tab-row").length === n, n, { timeout: 15_000 });
	try {
		await page.goto(`${base}/?go=${encodeURIComponent(fixtureUrl + "tab.html")}`);
		await page.waitForFunction(() => document.getElementById("frame")?.contentDocument?.title === "tab fixture", null, { timeout: 30_000 });
		try {
			await page.waitForSelector(".tab-row.active .fav img", { timeout: 10_000 });
			pass("the tab shows the site's own icon");
		} catch {
			fail("the tab never showed the site's icon");
		}

		await tabFrame().evaluate(() => (window.__alive = true));
		await tabFrame().click("#blank");
		await waitRows(2);
		const afterBlank = await rows();
		afterBlank[1]?.url === fixtureUrl + "child.html?from-blank" && afterBlank[1].active && context.pages().length === 1
			? pass("a target=_blank link opens a sidebar tab, not a browser tab")
			: fail(`target=_blank link: ${JSON.stringify(afterBlank)}, ${context.pages().length} browser tabs`);

		await page.click(".tab-row >> nth=0");
		const alive = await page.evaluate(() => document.getElementById("frame")?.contentWindow?.__alive === true);
		alive ? pass("switching tabs keeps the page alive (no reload)") : fail("switching back reloaded the page");

		await tabFrame().click("#plain", { button: "middle" });
		await waitRows(3);
		const afterMiddle = await rows();
		afterMiddle[0].active && afterMiddle[2]?.url === fixtureUrl + "child.html?from-middle"
			? pass("middle click opens a background tab after the other one")
			: fail(`middle click: ${JSON.stringify(afterMiddle)}`);

		await page.reload();
		await page.waitForSelector("#boot", { state: "hidden", timeout: 30_000 });
		await page.waitForFunction(() => document.getElementById("frame")?.contentDocument?.title === "tab fixture", null, { timeout: 30_000 });
		const restored = await rows();
		restored.length === 3 && restored[0].active && restored[2].url === fixtureUrl + "child.html?from-middle"
			? pass("a reload brings back every tab and the active one")
			: fail(`reload restored ${JSON.stringify(restored)}`);

		await page.keyboard.press("Alt+w");
		await waitRows(2);
		pass("alt+w closes the current tab");
	} catch (err) {
		fail(`tab checks: ${err.message}`);
	}
	await context.close();
}

async function runBlocker() {
	console.log("\ncontent blocker");
	const { context, page } = await newShell("epoxy");
	await page.goto(`${base}/?go=${encodeURIComponent(fixtureUrl + "child.html")}`);
	await page.waitForFunction(() => document.getElementById("frame")?.contentDocument?.body?.innerText?.includes("child"), null, { timeout: 30_000 });
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
		let errorPage = false;
		try {
			title = await proxyFrame(page).title();
			errorPage = await proxyFrame(page).evaluate(() => !!document.querySelector("main.card #retry"));
		} catch {
			// frame gone
		}
		const shot = `e2e-${new URL(url).hostname}.png`;
		await page.screenshot({ path: shot });
		title && !errorPage ? pass(`${url} loaded ("${title}", screenshot ${shot})`) : fail(`${url} did not load (title "${title}")`);
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
	await runTabs();
	await runBlocker();
	await runRealSites();
} finally {
	await browser.close();
	umbrella.close();
	fixture.close();
}

console.log(failures ? `\n${failures} failed` : "\nall e2e checks passed");
process.exit(failures ? 1 : 0);
