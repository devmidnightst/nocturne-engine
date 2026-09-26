// nocturne engine soak test.
//
//   npm run test:soak                      30 minutes
//   SOAK_MINUTES=120 npm run test:soak     longer
//
// runs the real server as a child process and keeps one chromium busy against
// it for the whole stretch:
//   - two browsing shells (one starts on epoxy, one on libcurl) that navigate
//     in a loop through the fixture, a heavy page (parallel fetches, big bodies,
//     an abandoned request), error pages and any real sites that are reachable,
//     flipping transport and reloading the shell every so often
//   - two shells (one per transport) parked on a page that holds websockets
//     open the entire run, an echo socket pinged every second and a socket the
//     server pushes to twice a second
// every SOAK_SAMPLE_SECONDS it records server rss / heap after gc / open fds /
// wisp connections, each shell's js heap and dom size, and navigation latency.
// at the end it compares the start of the run to the end and writes a report.
//
// env:
//   SOAK_MINUTES          how long to run (default 30)
//   SOAK_SAMPLE_SECONDS   metrics interval (default 30)
//   SOAK_URLS             comma separated real urls to mix into the loop
//   SOAK_OUT              results folder (default soak-results/<timestamp>)
//   NOCTURNE_E2E_EXTRA_CA pem bundle for networks that re-sign tls
//   CHROME_PATH           chromium binary

import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MINUTES = Number(process.env.SOAK_MINUTES) || 30;
const SAMPLE_MS = (Number(process.env.SOAK_SAMPLE_SECONDS) || 30) * 1000;
const OUT = path.resolve(process.env.SOAK_OUT || path.join(ROOT, "soak-results", new Date().toISOString().replace(/[:.]/g, "-")));
const REAL = (process.env.SOAK_URLS || "").split(",").map((s) => s.trim()).filter(Boolean);
const NAV_TIMEOUT = 45_000;

fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => {
	const line = `[soak ${new Date().toISOString().slice(11, 19)}] ${a.join(" ")}`;
	console.log(line);
	fs.appendFileSync(path.join(OUT, "soak.log"), line + "\n");
};
const jsonl = (file, obj) => fs.appendFileSync(path.join(OUT, file), JSON.stringify(obj) + "\n");

const { chromium } = await import("playwright-core");
const { startFixture } = await import("../test/fixture/server.js");

const fixture = await startFixture(0);
const FIX = `http://127.0.0.1:${fixture.address().port}/`;

// ---------------------------------------------------------------------------
// server as a child process, so its memory and fds are its own
// ---------------------------------------------------------------------------

const freePort = () =>
	new Promise((resolve) => {
		const s = net.createServer().listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	});
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;

let server;
let serverExits = 0;
const serverErrors = [];
function startServer() {
	server = fork(path.join(ROOT, "src/server.js"), [], {
		cwd: ROOT,
		execArgv: ["--expose-gc", "--import", path.join(ROOT, "scripts/soak-probe.mjs")],
		env: {
			...process.env,
			PORT: String(PORT),
			HOST: "127.0.0.1",
			// the fixture runs on 127.0.0.1, which wisp refuses by default
			WISP_ALLOW_LOOPBACK_IPS: "1",
			WISP_LOG_LEVEL: "ERROR",
		},
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	const tee = (stream) =>
		stream.on("data", (d) => {
			fs.appendFileSync(path.join(OUT, "server.log"), d);
			for (const line of String(d).split("\n")) {
				// the boot log lists patch names like "rewrite-error-report", skip those
				if (line.startsWith("[nocturne] /")) continue;
				if (/error|unhandled|uncaught|FATAL/i.test(line)) serverErrors.push(line.slice(0, 300));
			}
		});
	tee(server.stdout);
	tee(server.stderr);
	server.on("exit", (code, sig) => {
		if (stopping) return;
		serverExits++;
		log(`SERVER EXITED code=${code} signal=${sig}, restarting`);
		startServer();
	});
	return new Promise((resolve) => server.once("message", resolve));
}
let stopping = false;
await startServer();
log(`server pid ${server.pid} on ${BASE}, fixture on ${FIX}`);

function serverStats() {
	return new Promise((resolve) => {
		const t = setTimeout(() => resolve(null), 5000);
		const onMsg = (m) => {
			if (m?.type !== "soak:stats") return;
			clearTimeout(t);
			server.off("message", onMsg);
			resolve(m);
		};
		server.on("message", onMsg);
		server.send("soak:stats");
	});
}
function serverFds() {
	try {
		return fs.readdirSync(`/proc/${server.pid}/fd`).length;
	} catch {
		return null;
	}
}
// established tcp connections whose local end is the server port, i.e. every
// websocket (and keep alive http) the browser holds open to nocturne
function wispConnections() {
	const hexPort = PORT.toString(16).toUpperCase().padStart(4, "0");
	let n = 0;
	for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
		try {
			for (const line of fs.readFileSync(file, "utf8").split("\n").slice(1)) {
				const cols = line.trim().split(/\s+/);
				if (cols[1]?.endsWith(":" + hexPort) && cols[3] === "01") n++;
			}
		} catch {
			// no procfs
		}
	}
	return n;
}

// ---------------------------------------------------------------------------
// browser shells
// ---------------------------------------------------------------------------

const browser = await chromium.launch({
	executablePath:
		process.env.CHROME_PATH ||
		(fs.existsSync("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined),
	args: ["--no-sandbox"],
});

async function newShell(name, transport) {
	const context = await browser.newContext();
	await context.addInitScript((t) => {
		// only seed settings on the very first load, so transport flips stick across reloads
		if (!localStorage.getItem("nocturne:settings"))
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
	const shell = { name, context, page, errors: [], crashed: 0 };
	page.on("pageerror", (e) => {
		shell.errors.push(e.message.slice(0, 200));
		jsonl("shell-errors.jsonl", { t: Date.now(), shell: name, message: e.message.slice(0, 500) });
	});
	page.on("console", (m) => {
		if (m.type() === "error" || m.type() === "warning")
			jsonl("console.jsonl", { t: Date.now(), shell: name, type: m.type(), text: m.text().slice(0, 500) });
	});
	page.on("crash", () => {
		shell.crashed++;
		log(`${name}: PAGE CRASHED`);
	});
	shell.cdp = await context.newCDPSession(page);
	await shell.cdp.send("Performance.enable");
	return shell;
}

async function bootShell(shell, url) {
	await shell.page.goto(`${BASE}/?go=${encodeURIComponent(url)}`, { timeout: NAV_TIMEOUT });
	await shell.page.waitForFunction(() => document.getElementById("boot")?.hidden, null, { timeout: NAV_TIMEOUT });
}

async function shellMetrics(shell) {
	try {
		await shell.cdp.send("HeapProfiler.collectGarbage");
		const { metrics } = await shell.cdp.send("Performance.getMetrics");
		const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
		return { heap: m.JSHeapUsedSize, nodes: m.Nodes, listeners: m.JSEventListeners, documents: m.Documents, frames: m.Frames };
	} catch (err) {
		return { error: err.message };
	}
}

// what "done" means for each kind of page in the loop
const TARGETS = [
	{ kind: "fixture", url: FIX, done: (d) => d.title === "fixture done" },
	{ kind: "heavy", url: FIX + "soak-heavy.html", done: (d) => d.title === "heavy done" },
	{ kind: "child", url: FIX + "child.html", done: (d) => d.readyState === "complete" && d.body?.innerText?.includes("child") },
	{ kind: "redirect", url: FIX + "redirect", done: (d) => d.readyState === "complete" && d.body?.innerText?.includes("redirected") },
	{ kind: "error", url: "http://nocturne-soak-does-not-exist.invalid/", done: (d) => d.title?.includes("Umbrella") },
	...REAL.map((url) => ({ kind: "real", url, done: (d) => d.readyState === "complete" && d.title && !d.title.includes("Umbrella") })),
];

async function navigate(shell, target) {
	const { page } = shell;
	// tag the current document so we can tell when a new one has replaced it
	await page.evaluate(() => {
		try {
			document.getElementById("frame").contentWindow.__soakOld = true;
		} catch {
			// cross origin or gone, fine
		}
	});
	const t0 = Date.now();
	await page.fill("#address", target.url);
	await page.press("#address", "Enter");
	let ok = false;
	let detail = "";
	try {
		await page.waitForFunction(
			(src) => {
				const done = new Function("d", `return (${src})(d)`);
				const f = document.getElementById("frame");
				try {
					const w = f.contentWindow;
					if (!w || w.__soakOld) return false;
					return !!done(f.contentDocument);
				} catch {
					return false;
				}
			},
			target.done.toString(),
			{ timeout: NAV_TIMEOUT, polling: 100 }
		);
		ok = true;
	} catch {
		// what did the frame look like when we gave up
		const state = await page
			.evaluate(() => {
				const f = document.getElementById("frame");
				let d = null;
				try {
					d = f.contentDocument;
				} catch {
					// cross origin
				}
				return {
					old: !!f.contentWindow?.__soakOld,
					ready: d?.readyState,
					title: d?.title?.slice(0, 60),
					href: d?.location?.href?.slice(0, 120),
					body: d?.body?.innerText?.slice(0, 120),
				};
			})
			.catch((e) => ({ error: e.message }));
		detail = `timeout ${JSON.stringify(state)}`;
	}
	const ms = Date.now() - t0;
	// look inside the result for the pages that self check
	if (ok && (target.kind === "fixture" || target.kind === "heavy")) {
		const frame = page.frames().find((f) => f.parentFrame() === page.mainFrame());
		try {
			const res = JSON.parse(await frame.innerText("#results"));
			const bad =
				target.kind === "fixture"
					? Object.entries(res).filter(([, v]) => v !== true).map(([k, v]) => `${k}: ${v}`)
					: res.bad || res.error
						? [JSON.stringify(res)]
						: [];
			if (bad.length) {
				ok = false;
				detail = bad.join("; ").slice(0, 400);
			}
		} catch (err) {
			ok = false;
			detail = `results unreadable: ${err.message}`;
		}
	}
	return { ok, ms, detail };
}

// the settings select is only filled in when the panel opens, so read the store
const currentTransport = () => JSON.parse(localStorage.getItem("nocturne:settings") || "{}").transport || "libcurl";

async function flipTransport(shell) {
	const to = await shell.page.evaluate(async (current) => {
		const sel = document.getElementById("set-transport");
		const next = new Function(`return (${current})()`)() === "epoxy" ? "libcurl" : "epoxy";
		sel.value = next;
		sel.dispatchEvent(new Event("change"));
		return next;
	}, currentTransport.toString());
	await shell.page.waitForTimeout(1500);
	return to;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

// SOAK_NAV_TRANSPORTS picks what the two browsing shells start on, SOAK_FLIP how
// many navigations between transport flips (0 = never flip)
const [startA, startB] = (process.env.SOAK_NAV_TRANSPORTS || "epoxy,libcurl").split(",");
const FLIP_EVERY = Number(process.env.SOAK_FLIP ?? 23);
const browsers = [await newShell("nav-a", startA), await newShell("nav-b", startB || startA)];
const wsShells = [await newShell("ws-epoxy", "epoxy"), await newShell("ws-libcurl", "libcurl")];
for (const s of browsers) await bootShell(s, FIX + "child.html");
for (const s of wsShells) await bootShell(s, FIX + "soak-ws.html");
log(`shells up, running for ${MINUTES} minutes`);

const deadline = Date.now() + MINUTES * 60_000;
const navStats = new Map(); // kind -> { ok, fail, ms: [] }
let window_ = []; // latencies since last sample
let navCount = 0;

async function loop(shell, offset) {
	let i = offset;
	while (Date.now() < deadline) {
		const target = TARGETS[i % TARGETS.length];
		i++;
		// libcurl has no way to trust an extra ca, so on re-signing networks real
		// sites only work over epoxy. skip them instead of counting fake failures.
		if (target.kind === "real" && process.env.NOCTURNE_E2E_EXTRA_CA) {
			const kind = await shell.page.evaluate(currentTransport).catch(() => "epoxy");
			if (kind === "libcurl") continue;
		}
		let res;
		try {
			res = await navigate(shell, target);
		} catch (err) {
			res = { ok: false, ms: 0, detail: `runner: ${err.message.split("\n")[0]}` };
		}
		navCount++;
		const st = navStats.get(target.kind) ?? { ok: 0, fail: 0, ms: [], fails: [] };
		res.ok ? st.ok++ : st.fail++;
		if (res.ok) st.ms.push(res.ms);
		else if (st.fails.length < 20) st.fails.push({ t: new Date().toISOString(), shell: shell.name, url: target.url, detail: res.detail });
		navStats.set(target.kind, st);
		if (res.ok) window_.push(res.ms);
		const transportNow = await shell.page.evaluate(currentTransport).catch(() => null);
		jsonl("navs.jsonl", { t: Date.now(), shell: shell.name, transport: transportNow, kind: target.kind, url: target.url, ...res });
		if (!res.ok) log(`${shell.name}: ${target.kind} failed: ${res.detail}`);

		if (FLIP_EVERY && i % FLIP_EVERY === 0) {
			const to = await flipTransport(shell).catch((e) => `error ${e.message}`);
			log(`${shell.name}: switched transport to ${to}`);
		}
		if (i % 60 === 0) {
			log(`${shell.name}: reloading shell`);
			await bootShell(shell, FIX + "child.html").catch((e) => log(`${shell.name}: reload failed ${e.message}`));
		}
		await shell.page.waitForTimeout(250);
	}
}

const samples = [];
async function sample() {
	const [stats, ...pages] = await Promise.all([serverStats(), ...[...browsers, ...wsShells].map(shellMetrics)]);
	const ws = {};
	for (const s of wsShells) {
		ws[s.name] = await s.page
			.frames()
			.find((f) => f.parentFrame() === s.page.mainFrame())
			?.evaluate(() => window.__soak && { ...window.__soak })
			.catch((e) => ({ error: e.message }));
	}
	const lat = [...window_].sort((a, b) => a - b);
	window_ = [];
	const row = {
		t: Date.now(),
		minute: +((Date.now() - (deadline - MINUTES * 60_000)) / 60_000).toFixed(2),
		server: stats && { rss: stats.rss, heapUsed: stats.heapUsed, external: stats.external, resources: stats.resources },
		fds: serverFds(),
		wispConns: wispConnections(),
		navs: navCount,
		navP50: lat[Math.floor(lat.length * 0.5)] ?? null,
		navP95: lat[Math.floor(lat.length * 0.95)] ?? null,
		pages: Object.fromEntries([...browsers, ...wsShells].map((s, i) => [s.name, pages[i]])),
		ws,
		serverExits,
	};
	samples.push(row);
	jsonl("samples.jsonl", row);
	const mb = (b) => (b / 1048576).toFixed(1);
	log(
		`t+${row.minute}m navs=${navCount} p50=${row.navP50}ms p95=${row.navP95}ms ` +
			`server rss=${stats ? mb(stats.rss) : "?"}MB heap=${stats ? mb(stats.heapUsed) : "?"}MB fds=${row.fds} wisp=${row.wispConns} ` +
			`ws-epoxy=${ws["ws-epoxy"]?.echoRecv}/${ws["ws-epoxy"]?.echoSent} ws-libcurl=${ws["ws-libcurl"]?.echoRecv}/${ws["ws-libcurl"]?.echoSent}`
	);
}

const sampler = (async () => {
	while (Date.now() < deadline) {
		await sample().catch((e) => log(`sample failed: ${e.message}`));
		await new Promise((r) => setTimeout(r, Math.min(SAMPLE_MS, Math.max(0, deadline - Date.now()))));
	}
})();

await Promise.all([loop(browsers[0], 0), loop(browsers[1], 3), sampler]);
await sample();

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

stopping = true;
server.kill("SIGTERM");
await browser.close();
fixture.close();

// least squares slope per hour, for "is this still going up"
function slope(points) {
	const pts = points.filter(([, y]) => Number.isFinite(y));
	if (pts.length < 3) return null;
	const n = pts.length;
	const mx = pts.reduce((a, [x]) => a + x, 0) / n;
	const my = pts.reduce((a, [, y]) => a + y, 0) / n;
	const num = pts.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0);
	const den = pts.reduce((a, [x]) => a + (x - mx) ** 2, 0);
	return den ? (num / den) * 60 : null;
}
// skip the first sample or two, the first minutes are warmup (jit, caches)
const steady = samples.filter((s) => s.minute >= Math.min(5, MINUTES / 4));
const series = (fn) => steady.map((s) => [s.minute, fn(s)]);
const firstLast = (fn) => {
	const q = Math.max(1, Math.floor(steady.length / 4));
	const avg = (arr) => arr.map(fn).filter(Number.isFinite).reduce((a, b, _, all) => a + b / all.length, 0);
	return [avg(steady.slice(0, q)), avg(steady.slice(-q))];
};
const MB = 1048576;
const trend = (label, fn, unit, div = 1) => {
	const [a, b] = firstLast(fn);
	const sl = slope(series(fn));
	return `| ${label} | ${(a / div).toFixed(1)} ${unit} | ${(b / div).toFixed(1)} ${unit} | ${sl == null ? "n/a" : ((sl / div) >= 0 ? "+" : "") + (sl / div).toFixed(2) + ` ${unit}/h`} |`;
};

const lines = [];
lines.push(`# nocturne engine soak report`, "");
lines.push(`- duration: ${MINUTES} minutes, ${navCount} navigations, ${samples.length} samples`);
lines.push(`- server restarts (crashes): ${serverExits}`);
lines.push(`- server log lines that look like errors: ${serverErrors.length}`);
lines.push(`- shell page crashes: ${[...browsers, ...wsShells].reduce((a, s) => a + s.crashed, 0)}`);
lines.push(`- uncaught page errors (shell or proxied sites, see shell-errors.jsonl): ${[...browsers, ...wsShells].reduce((a, s) => a + s.errors.length, 0)}`, "");
lines.push(`## navigations`, "", `| page | ok | failed | p50 | p95 |`, `|---|---|---|---|---|`);
for (const [kind, st] of navStats) {
	const ms = st.ms.sort((a, b) => a - b);
	lines.push(`| ${kind} | ${st.ok} | ${st.fail} | ${ms[Math.floor(ms.length * 0.5)] ?? "-"} ms | ${ms[Math.floor(ms.length * 0.95)] ?? "-"} ms |`);
}
lines.push("", `## trends (steady state, first quarter vs last quarter, least squares slope)`, "");
lines.push(`| metric | start | end | slope |`, `|---|---|---|---|`);
lines.push(trend("server rss", (s) => s.server?.rss, "MB", MB));
lines.push(trend("server heap after gc", (s) => s.server?.heapUsed, "MB", MB));
lines.push(trend("server open fds", (s) => s.fds, "fds"));
lines.push(trend("wisp connections", (s) => s.wispConns, "conns"));
lines.push(trend("nav p50", (s) => s.navP50, "ms"));
lines.push(trend("nav p95", (s) => s.navP95, "ms"));
for (const s of [...browsers, ...wsShells]) {
	lines.push(trend(`${s.name} js heap`, (x) => x.pages[s.name]?.heap, "MB", MB));
	lines.push(trend(`${s.name} dom nodes`, (x) => x.pages[s.name]?.nodes, "nodes"));
}
lines.push("", `## long lived websockets`, "");
const lastWs = samples.at(-1)?.ws ?? {};
for (const [name, w] of Object.entries(lastWs)) lines.push(`- ${name}: ${JSON.stringify(w)}`);
const fails = [...navStats].flatMap(([kind, st]) => st.fails.map((f) => ({ kind, ...f })));
if (fails.length) {
	lines.push("", `## failures (first 20 per page)`, "");
	for (const f of fails) lines.push(`- ${f.t} ${f.shell} ${f.url}: ${f.detail}`);
}
if (serverErrors.length) {
	lines.push("", `## server errors (first 30)`, "", "```", ...serverErrors.slice(0, 30), "```");
}
fs.writeFileSync(path.join(OUT, "report.md"), lines.join("\n") + "\n");
console.log("\n" + lines.join("\n"));
log(`results in ${OUT}`);
process.exit(0);
