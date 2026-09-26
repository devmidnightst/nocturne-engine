// umbrella: the wisp websocket endpoint.
//
// wraps wisp-js 0.5.0's ServerConnection and fixes the things in it that let a
// single client hurt the server (every one was reproduced before fixing):
//
//   - ssrf: ipv4 wrapped in ipv6 (::ffff:127.0.0.1) and ipv6 private ranges got
//     past its ip filter. streams now resolve once, get checked by ip-policy.js
//     and connect to that exact checked address, so dns rebinding between the
//     check and the connect can't swap the target either.
//   - WISP_STREAM_LIMIT_PER_HOST crashed the whole process on the first stream
//     (it iterates an object with for..of inside an unawaited async function,
//     which is an unhandled rejection). the limit is counted here instead.
//   - a CONNECT reusing a live stream id replaced the stream without closing
//     it, so its tcp socket stayed open forever. 200 packets leaked 200 fds.
//   - a client ignoring flow control could queue unlimited data per stream.
//   - any path under /wisp/ without the trailing slash opened a raw
//     "wsproxy" tcp tunnel. only the exact wisp path is served now.
//   - a single malformed websocket frame (2 bytes, a reserved opcode) crashed
//     the process: nothing listened for the ws "error" event, so it threw.
//   - ws frames could be up to 100 MiB (the ws default). capped.
//   - WISP_DNS_SERVERS was ignored because wisp-js only reads it in "resolve" mode.

import dns from "node:dns/promises";
import { WebSocketServer } from "ws";
import { server as wisp, packet, logging } from "@mercuryworkshop/wisp-js/server";

import { ipBlocked, parseIp } from "./ip-policy.js";

const { ServerConnection, options } = wisp;
const { close_reasons, stream_types, DataPayload } = packet;

// ---------------------------------------------------------------------------
// dns: resolve once, keep it briefly, hand back the first allowed address
// ---------------------------------------------------------------------------

const DNS_TTL_MS = 30_000;
const DNS_CACHE_MAX = 5000;

export function createResolver({ dnsServers = [] } = {}) {
	const cache = new Map();
	let resolver = null;
	if (dnsServers.length) {
		resolver = new dns.Resolver();
		resolver.setServers(dnsServers);
	}

	async function lookupAll(host) {
		if (!resolver) return (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address);
		const [v4, v6] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
		const out = [...(v4.value ?? []), ...(v6.value ?? [])];
		if (!out.length) throw v4.reason ?? v6.reason ?? new Error("no addresses");
		return out;
	}

	return async function resolve(host) {
		const hit = cache.get(host);
		if (hit && hit.expires > Date.now()) return hit.addresses;
		const addresses = await lookupAll(host);
		cache.delete(host);
		cache.set(host, { addresses, expires: Date.now() + DNS_TTL_MS });
		// map keeps insertion order, so the first key is the oldest
		if (cache.size > DNS_CACHE_MAX) cache.delete(cache.keys().next().value);
		return addresses;
	};
}

// ---------------------------------------------------------------------------
// the connection
// ---------------------------------------------------------------------------

// data packets a stream may have waiting beyond wisp's own buffer before we
// decide the client is ignoring flow control
const MAX_PENDING_PUTS = 256;

export function createWispHandler(cfg) {
	const resolve = createResolver({ dnsServers: cfg.dnsServers });
	const policy = { allowLoopbackIps: cfg.allowLoopbackIps, allowPrivateIps: cfg.allowPrivateIps };
	const portBlocked = (port) => cfg.portBlacklist.includes(port);

	// wisp-js reads these directly. the ip / port / per host checks happen in
	// create_stream below, so its own versions are switched off or kept inert.
	Object.assign(options, {
		allow_private_ips: cfg.allowPrivateIps,
		allow_loopback_ips: cfg.allowLoopbackIps,
		allow_udp_streams: cfg.allowUdp,
		stream_limit_per_host: -1,
		stream_limit_total: -1,
		port_blacklist: null,
		dns_servers: null,
		// caddy on the same box sets x-forwarded-for, so logs show the real client ip
		parse_real_ip: true,
		parse_real_ip_from: ["127.0.0.1", "::1", "::ffff:127.0.0.1"],
	});

	// returns [close reason, address to connect to]
	async function vet(conn, self, type, hostname, port) {
		if (type === stream_types.UDP && !cfg.allowUdp) return [close_reasons.HostBlocked];
		if (type !== stream_types.TCP && type !== stream_types.UDP) return [close_reasons.InvalidInfo];
		if (!Number.isInteger(port) || port < 1 || port > 65535 || portBlocked(port)) return [close_reasons.HostBlocked];
		if (!hostname || hostname.length > 253) return [close_reasons.UnreachableHost];

		const open = Object.values(conn.streams).filter((s) => s !== self);
		if (cfg.streamLimitTotal !== -1 && open.length >= cfg.streamLimitTotal) return [close_reasons.ConnThrottled];
		if (cfg.streamLimitPerHost !== -1 && open.filter((s) => s.umbrellaHost === hostname).length >= cfg.streamLimitPerHost)
			return [close_reasons.ConnThrottled];

		let candidates;
		const literal = parseIp(hostname);
		if (literal) candidates = [hostname];
		else {
			try {
				candidates = await resolve(hostname);
			} catch {
				return [close_reasons.UnreachableHost];
			}
		}
		const ok = candidates.find((ip) => !ipBlocked(ip, policy));
		if (!ok) return [close_reasons.HostBlocked];
		// always connect to the normalized address that was checked
		return [0, parseIp(ok).toString()];
	}

	class UmbrellaConnection extends ServerConnection {
		create_stream(stream_id, type, hostname, port) {
			// a CONNECT for a live id: close the old stream's socket, don't orphan it
			const old = this.streams[stream_id];
			if (old) {
				delete this.streams[stream_id];
				this.detach(old);
				old.close().catch(() => {});
			}

			const SocketImpl = type === stream_types.UDP ? this.UDPSocket : this.TCPSocket;
			// placeholder so data sent before the connect finishes is buffered like
			// upstream does. the real socket is swapped in once the address is vetted.
			const stream = new wisp.ServerStream(stream_id, this, new SocketImpl(hostname, port));
			stream.umbrellaHost = hostname;
			this.streams[stream_id] = stream;

			(async () => {
				const [reason, ip] = await vet(this, stream, type, hostname, port);
				if (this.streams[stream_id] !== stream) return; // replaced or closed meanwhile
				if (reason) {
					logging.info(`(${this.conn_id}) refusing a stream to ${hostname}:${port} (reason ${reason})`);
					await this.close_stream(stream_id, reason, true);
					return;
				}
				stream.socket = new SocketImpl(ip, port);
				try {
					await stream.setup();
				} catch (error) {
					logging.info(`(${this.conn_id}) stream to ${hostname}:${port} failed - ${error}`);
					if (this.streams[stream_id] === stream) await this.close_stream(stream_id, close_reasons.NetworkError);
				}
			})().catch((error) => {
				logging.error(`(${this.conn_id}) stream setup crashed - ${error?.stack || error}`);
				if (this.streams[stream_id] === stream) this.close_stream(stream_id, close_reasons.Unknown).catch(() => {});
			});
		}

		// a closed stream's own tasks still call conn.close_stream(its id) when they
		// wind down. by then a new stream may own that id, so point them at a
		// connection that can still send (for the CLOSE packet) but closes nothing.
		detach(stream) {
			stream.conn = { ws: this.ws, conn_id: this.conn_id, close_stream: async () => {} };
		}

		// upstream deletes the stream from the map after awaiting its close, so a
		// CONNECT reusing the id in between got deleted instead and leaked
		async close_stream(stream_id, reason = null, quiet = false) {
			const stream = this.streams[stream_id];
			if (!stream) return;
			delete this.streams[stream_id];
			this.detach(stream);
			if (reason && !quiet) logging.info(`(${this.conn_id}) closing stream to ${stream.umbrellaHost} for reason ${reason}`);
			await stream.close(reason);
		}

		route_packet(buffer) {
			// peek at DATA packets for streams whose queue is already overflowing
			if (buffer.size >= 5 && buffer.bytes[0] === DataPayload.type) {
				const id = new DataView(buffer.bytes.buffer, buffer.bytes.byteOffset + 1, 4).getUint32(0, true);
				const stream = this.streams[id];
				if (stream && stream.send_buffer.put_callbacks.length > MAX_PENDING_PUTS) {
					logging.warn(`(${this.conn_id}) stream ${id} ignored flow control, closing it`);
					this.close_stream(id, close_reasons.ConnThrottled).catch(() => {});
					return;
				}
			}
			return super.route_packet(buffer);
		}
	}

	const wss = new WebSocketServer({ noServer: true, maxPayload: cfg.maxPayload, perMessageDeflate: false });

	return function handleUpgrade(req, socket, head) {
		wss.handleUpgrade(req, socket, head, (ws) => {
			ws.binaryType = "arraybuffer";
			// bad frames, oversized frames and resets all land here. without a
			// listener the ws library throws and takes the process down.
			ws.on("error", (err) => logging.info(`wisp websocket error - ${err.code || err.message}`));
			const wantsV2 = !!req.headers["sec-websocket-protocol"] && options.wisp_version === 2;
			const conn = new UmbrellaConnection(ws, req.url, { wisp_version: wantsV2 ? 2 : 1 });
			(async () => {
				await conn.setup();
				await conn.run();
			})().catch((error) => {
				try {
					ws.close();
				} catch {
					// already gone
				}
				if (error && error.constructor?.name !== "HandshakeError") logging.error(`wisp connection error - ${error?.stack || error}`);
			});
		});
	};
}
