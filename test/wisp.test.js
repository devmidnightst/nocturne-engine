// the wisp endpoint with production defaults: loopback and private ranges are
// off limits, however the address is spelled.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import WebSocket from "ws";
import { openWisp, CLOSE } from "./helpers/wisp-client.mjs";
import { ipBlocked } from "../src/ip-policy.js";

process.env.WISP_LOG_LEVEL = "NONE";
delete process.env.WISP_ALLOW_LOOPBACK_IPS;
delete process.env.WISP_ALLOW_PRIVATE_IPS;
const { createServer } = await import("../src/server.js");

let server;
let base;
let target;
before(async () => {
	server = createServer();
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${server.address().port}`;
	// something on localhost the proxy must never reach
	target = net.createServer((s) => s.end("SECRET")).listen(0, "127.0.0.1");
	await new Promise((r) => target.once("listening", r));
});
after(() => {
	server.close();
	target.close();
});

test("ip policy unwraps ipv4 hidden in ipv6", () => {
	const blocked = [
		"127.0.0.1", "0.0.0.0", "10.0.0.1", "192.168.1.1", "172.16.0.1", "100.64.0.1", "169.254.169.254",
		"::1", "::", "fe80::1", "fd00::1", "ff02::1", "224.0.0.1",
		"::ffff:127.0.0.1", "::ffff:7f00:1", "0:0:0:0:0:ffff:7f00:1", "::ffff:a9fe:a9fe", "64:ff9b::7f00:1", "::ffff:0:a00:1",
		"127.1", "0x7f000001", "not an ip",
	];
	for (const ip of blocked) assert.equal(ipBlocked(ip), true, ip);
	for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808"]) assert.equal(ipBlocked(ip), false, ip);
	assert.equal(ipBlocked("::ffff:127.0.0.1", { allowLoopbackIps: true }), false);
	assert.equal(ipBlocked("fd00::1", { allowPrivateIps: true }), false);
	assert.equal(ipBlocked("fd00::1", { allowLoopbackIps: true }), true);
});

test("wisp refuses loopback however it is written", async () => {
	const port = target.address().port;
	const c = openWisp(base.replace("http", "ws") + "/wisp/");
	await c.ready;
	const hosts = ["127.0.0.1", "localhost", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::7f00:1", "127.1", "0x7f000001", "0.0.0.0"];
	hosts.forEach((h, i) => {
		c.connect(i + 1, h, port);
		c.send(i + 1, "hi");
	});
	for (let i = 0; i < hosts.length; i++) {
		const s = await c.until(i + 1, (s) => s.closed !== null);
		assert.equal(s.data.length, 0, `${hosts[i]} leaked data`);
		assert.equal(s.closed, CLOSE.HostBlocked, `${hosts[i]} closed with ${s.closed}`);
	}
	c.close();
});

test("a malformed websocket frame does not take the server down", async () => {
	const sock = net.connect(server.address().port, "127.0.0.1");
	await new Promise((r) => sock.once("connect", r));
	sock.on("error", () => {});
	sock.write(
		"GET /wisp/ HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
			"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
	);
	await new Promise((r) => sock.once("data", r));
	// reserved opcode 3, unmasked: a protocol error the ws library emits as "error"
	sock.write(Buffer.from([0x83, 0x00]));
	await new Promise((r) => sock.once("close", r));
	const health = await fetch(base + "/api/health");
	assert.equal(health.status, 200);
});

test("paths under the wisp path are not raw tcp tunnels", async () => {
	for (const p of ["/wisp/example.com:80", "/wisp/127.0.0.1:22", "/wispx/"]) {
		const ws = new WebSocket(base.replace("http", "ws") + p);
		const err = await new Promise((resolve) => ws.once("error", resolve));
		assert.match(String(err.message), /404/, p);
	}
});
