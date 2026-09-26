// minimal raw wisp client for tests: speaks just enough of the protocol to open
// streams, send bytes and see what comes back, so tests can act like a hostile
// or buggy client that a real transport would never be.

import WebSocket from "ws";

const packet = (type, id, payload) => {
	const b = Buffer.alloc(5 + payload.length);
	b[0] = type;
	b.writeUInt32LE(id, 1);
	payload.copy(b, 5);
	return b;
};

export const CLOSE = { Voluntary: 0x02, NetworkError: 0x03, UnreachableHost: 0x42, HostBlocked: 0x48, ConnThrottled: 0x49 };

export function openWisp(url) {
	const ws = new WebSocket(url, ["wisp-v2"]);
	ws.binaryType = "nodebuffer";
	const streams = new Map();
	const stream = (id) => {
		if (!streams.has(id)) streams.set(id, { data: Buffer.alloc(0), closed: null, waiters: [] });
		return streams.get(id);
	};
	const wake = (s) => s.waiters.splice(0).forEach((fn) => fn());
	ws.on("message", (m) => {
		const type = m[0];
		const id = m.readUInt32LE(1);
		if (id === 0) return;
		const s = stream(id);
		if (type === 0x02) s.data = Buffer.concat([s.data, m.subarray(5)]);
		if (type === 0x04) s.closed = m[5];
		wake(s);
	});
	const ready = new Promise((resolve, reject) => {
		ws.once("open", () => {
			// wisp v2 handshake: our INFO packet, version 2.0, no extensions
			ws.send(packet(0x05, 0, Buffer.from([2, 0])));
			resolve();
		});
		ws.once("error", reject);
	});
	return {
		ws,
		ready,
		connect(id, host, port) {
			const h = Buffer.from(host);
			const p = Buffer.alloc(3 + h.length);
			p[0] = 0x01;
			p.writeUInt16LE(port, 1);
			h.copy(p, 3);
			ws.send(packet(0x01, id, p));
		},
		send(id, data) {
			ws.send(packet(0x02, id, Buffer.from(data)));
		},
		/** resolves with the stream state once pred(state) holds, or after ms */
		until(id, pred, ms = 3000) {
			const s = stream(id);
			return new Promise((resolve) => {
				const t = setTimeout(() => resolve(s), ms);
				const check = () => (pred(s) ? (clearTimeout(t), resolve(s)) : s.waiters.push(check));
				check();
			});
		},
		close: () => ws.close(),
	};
}
