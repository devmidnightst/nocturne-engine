// the wisp endpoint with loopback allowed (so there is something to connect to)
// and a per host stream limit, the setting that used to crash the process.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { openWisp, CLOSE } from "./helpers/wisp-client.mjs";

process.env.WISP_LOG_LEVEL = "NONE";
process.env.WISP_ALLOW_LOOPBACK_IPS = "1";
process.env.WISP_STREAM_LIMIT_PER_HOST = "3";
const { createServer } = await import("../src/server.js");

let server;
let wispUrl;
let target;
const live = new Set();
before(async () => {
	server = createServer();
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	wispUrl = `ws://127.0.0.1:${server.address().port}/wisp/`;
	// holds every connection open and echoes, so we can count what the proxy keeps open
	target = net.createServer((s) => {
		live.add(s);
		s.on("close", () => live.delete(s));
		s.on("data", (d) => s.write(d));
		s.on("error", () => {});
	});
	await new Promise((r) => target.listen(0, "127.0.0.1", r));
});
after(() => {
	server.close();
	target.close();
});

const waitFor = async (fn, ms = 3000) => {
	const end = Date.now() + ms;
	while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
	return fn();
};

test("per host stream limit refuses extra streams instead of crashing", async () => {
	const port = target.address().port;
	const c = openWisp(wispUrl);
	await c.ready;
	for (let id = 1; id <= 5; id++) c.connect(id, "127.0.0.1", port);
	for (let id = 1; id <= 3; id++) {
		c.send(id, `s${id}`);
		const s = await c.until(id, (s) => s.data.length > 0);
		assert.equal(String(s.data), `s${id}`);
	}
	for (const id of [4, 5]) assert.equal((await c.until(id, (s) => s.closed !== null)).closed, CLOSE.ConnThrottled);
	c.close();
	assert.ok(await waitFor(() => live.size === 0), `${live.size} sockets left open after the wisp connection closed`);
});

test("reusing a stream id closes the old socket instead of leaking it", async () => {
	const port = target.address().port;
	const c = openWisp(wispUrl);
	await c.ready;
	for (let i = 0; i < 60; i++) c.connect(9, "127.0.0.1", port);
	c.send(9, "last");
	const s = await c.until(9, (s) => s.data.includes("last"));
	assert.ok(String(s.data).includes("last"));
	assert.ok(await waitFor(() => live.size <= 1), `${live.size} sockets open for one stream id`);
	// close then reopen the same id straight away: the new stream must survive
	c.ws.send(Buffer.from([0x04, 9, 0, 0, 0, 0x02]));
	c.connect(9, "127.0.0.1", port);
	c.send(9, "again");
	assert.ok(String((await c.until(9, (s) => s.data.includes("again"))).data).includes("again"));
	c.close();
	assert.ok(await waitFor(() => live.size === 0), `${live.size} sockets left open`);
});

test("unresolvable hosts close with unreachable, not a crash", async () => {
	const c = openWisp(wispUrl);
	await c.ready;
	c.connect(1, "umbrella-nope.invalid", 443);
	assert.equal((await c.until(1, (s) => s.closed !== null, 8000)).closed, CLOSE.UnreachableHost);
	c.close();
});
