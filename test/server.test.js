import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";

process.env.TLS_ALLOWED_DOMAINS = "nocturne.lol,*.nocturne.lol";
process.env.WISP_LOG_LEVEL = "NONE";
const { createServer } = await import("../src/server.js");

let server;
let base;
before(async () => {
	server = createServer();
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const get = (p, init) => fetch(base + p, init);

test("engine assets are served with the right types", async () => {
	const cases = {
		"/assets/r/runtime.js": "text/javascript",
		"/assets/r/core.wasm": "application/wasm",
		"/assets/r/api.js": "text/javascript",
		"/assets/r/sw.js": "text/javascript",
		"/assets/r/inject.js": "text/javascript",
		"/assets/r/utils.js": "text/javascript",
		"/assets/r/transport.epoxy.mjs": "text/javascript",
		"/assets/r/transport.alt.mjs": "text/javascript",
		"/assets/r/transport.mjs": "text/javascript",
	};
	for (const [p, type] of Object.entries(cases)) {
		const res = await get(p);
		assert.equal(res.status, 200, p);
		assert.ok(res.headers.get("content-type").startsWith(type), `${p}: ${res.headers.get("content-type")}`);
		assert.equal(res.headers.get("access-control-allow-origin"), "*", p);
		await res.arrayBuffer();
	}
});

test("patched bundles are what gets served", async () => {
	for (const p of ["/assets/r/runtime.js", "/assets/r/inject.js", "/assets/r/utils.js", "/assets/r/transport.mjs"]) {
		const text = await (await get(p)).text();
		assert.ok(text.startsWith("/* p8q2:"), p);
		assert.doesNotMatch(text.slice(0, 200), /umbrella/i, p);
	}
	const etag = (await get("/assets/r/runtime.js")).headers.get("etag");
	const again = await get("/assets/r/runtime.js", { headers: { "if-none-match": etag } });
	assert.equal(again.status, 304);
});

test("service worker is uncached and allowed at the root scope", async () => {
	const res = await get("/sw.js");
	assert.equal(res.headers.get("service-worker-allowed"), "/");
	assert.match(res.headers.get("cache-control"), /no-store/);
	assert.match(await res.text(), /\/assets\/r\/sw\.js/);
});

test("shell pages", async () => {
	const index = await get("/");
	assert.equal(index.status, 200);
	const disguise = await index.text();
	assert.doesNotMatch(disguise, /id="tab-list"/);
	assert.match(disguise, /eC1uZi1yYXc=/);
	const shell = await get("/", { headers: { "x-nf-raw": "1" } });
	assert.equal(shell.status, 200);
	assert.match(await shell.text(), /id="tab-list"/);
	const missing = await get("/definitely/not/here");
	assert.equal(missing.status, 404);
	assert.match(await missing.text(), /<title>404<\/title>/);
});

test("tls ask endpoint", async () => {
	assert.equal((await get("/api/tls-ask?domain=nocturne.lol")).status, 200);
	assert.equal((await get("/api/tls-ask?domain=files.nocturne.lol")).status, 200);
	assert.equal((await get("/api/tls-ask?domain=random.com")).status, 404);
	assert.equal((await get("/api/tls-ask")).status, 404);
});

test("health answers without naming the engine", async () => {
	const body = await (await get("/api/health")).json();
	assert.equal(body.ok, true);
	assert.equal(body.scramjet, undefined);
	assert.equal(body.patches, undefined);
});

test("diagnose follows the wisp ip policy", async () => {
	const loop = await (await get("/api/diagnose?host=127.0.0.1&port=80")).json();
	assert.equal(loop.kind, "blocked");
	const lan = await (await get("/api/diagnose?host=192.168.1.1&port=80")).json();
	assert.equal(lan.kind, "blocked");
	const smtp = await (await get("/api/diagnose?host=example.com&port=25")).json();
	assert.equal(smtp.kind, "blocked");
	const dns = await (await get("/api/diagnose?host=umbrella-nope.invalid&port=443")).json();
	assert.equal(dns.kind, "dns");
	assert.equal((await get("/api/diagnose?host=&port=0")).status, 400);
});

test("wisp endpoint speaks wisp", async () => {
	const ws = new WebSocket(base.replace("http", "ws") + "/wisp/");
	ws.binaryType = "arraybuffer";
	const first = await new Promise((resolve, reject) => {
		ws.once("message", (data) => resolve(new Uint8Array(data)));
		ws.once("error", reject);
	});
	ws.close();
	// wisp packet: type byte 0x03 = CONTINUE, sent for stream 0 right after connect
	assert.equal(first[0], 0x03);
});

test("other websocket paths are refused", async () => {
	const ws = new WebSocket(base.replace("http", "ws") + "/not-wisp");
	const err = await new Promise((resolve) => ws.once("error", resolve));
	assert.match(String(err.message), /404/);
});
