// nocturne engine: scramjet 2.x wiring.
//
// load order (see index.html): scramjet.js -> controller.api.js -> scramjet-utils.js
// are classic scripts that define $scramjet, $scramjetController and
// $scramjetUtils. this module runs after them.
//
// how a proxied request flows in scramjet 2.x:
//   iframe page -> service worker (sw.js) -> MessageChannel -> Controller (this page)
//   -> ScramjetFetchHandler rewrites the request -> transport (epoxy or libcurl)
//   -> wisp websocket -> nocturne server -> the real site
// so the transport and the rewriter both live here, not in the service worker.

import { settings, wispUrl } from "./store.js";
import {
	ErrorPagePlugin,
	ContentBlockerPlugin,
	RecoveryPlugin,
	ShellBridgePlugin,
} from "./plugins/nocturne-plugins.js";

const { Controller } = globalThis.$scramjetController;
const { defaultConfig, versionInfo } = globalThis.$scramjet;
const { HttpCachePlugin, UrlWatcherPlugin, CatchEscapedLinksPlugin } = globalThis.$scramjetUtils;

export { versionInfo };

// these must match where server.js serves the files. they are also scramjet's
// defaults, spelled out so moving a file only means changing it here.
const CONTROLLER_CONFIG = {
	prefix: "/~/sj/",
	scramjetPath: "/scramjet/scramjet.js",
	injectPath: "/controller/controller.inject.js",
	wasmPath: "/scramjet/scramjet.wasm",
	virtualWasmPath: "scramjet.wasm.js",
};

// rewriter features that compat mode turns off for a single site. these are the
// two most involved rewrites, so they are the first suspects when a site breaks.
export const COMPAT_FLAGS = { destructureRewrites: false, encapsulateWorkers: false };

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
// siteFlags keys are regex sources tested against the page url
const siteFlagKey = (origin) => `^${escapeRegex(origin)}(/|$)`;

function buildScramjetConfig() {
	const s = settings.get();
	const siteFlags = {};
	for (const origin of s.compatSites) siteFlags[siteFlagKey(origin)] = { ...COMPAT_FLAGS };
	return {
		flags: {
			...defaultConfig.flags,
			// keep broken js running untouched instead of throwing (scramjet default, stated for clarity)
			allowInvalidJs: true,
			// a failed api intercept logs instead of killing the page
			allowFailedIntercepts: true,
			// source maps make Function.prototype.toString return the original code,
			// which a lot of feature detection and anti tamper code relies on
			sourcemaps: true,
			rewriterLogs: !!s.rewriterLogs,
		},
		siteFlags,
	};
}

async function createLibcurl(url) {
	const { LibcurlClient } = await import("/transports/libcurl.mjs");
	// [total, idle cache, per host]. libcurl's default is 50 / 40 / 6. single page
	// apps hold a few long lived requests to their own host for as long as they
	// run, so leave more room per host than a browser's 6.
	const transport = new LibcurlClient({ wisp: url, connections: [80, 40, 16] });
	await transport.init();
	return transport;
}

// epoxy 3.0.1 holds every websocket frame the page sends until the next one is
// sent (the last frame never leaves the browser). a chat app that sends one
// message and waits for the answer just hangs: discord's IDENTIFY sits there
// until the next heartbeat, and each heartbeat only goes out with the one after
// it, so the gateway never sees a timely heartbeat. so when epoxy is picked, its
// websockets are handed to libcurl, which sends immediately. (epoxy's http also
// hangs after a site closes an idle keep alive connection, which is why libcurl
// is the default, see store.js.)
// libcurl loads the first time a page opens a socket, or when the browser is idle.
function epoxyWithLibcurlSockets(epoxy, url) {
	let libcurl = null;
	const getLibcurl = () => (libcurl ??= createLibcurl(url).catch((err) => ((libcurl = null), Promise.reject(err))));
	(self.requestIdleCallback ?? setTimeout)(() => getLibcurl().catch(() => {}), { timeout: 5000 });

	return {
		get ready() {
			return epoxy.ready;
		},
		init: () => epoxy.init(),
		meta: () => epoxy.meta?.(),
		request: (...args) => epoxy.request(...args),
		connect(wsUrl, protocols, headers, onopen, onmessage, onclose, onerror) {
			let inner = null;
			let closed = null;
			const pending = [];
			getLibcurl().then(
				(t) => {
					if (closed) return onclose(closed[0] ?? 1000, closed[1] ?? "");
					inner = t.connect(wsUrl, protocols, headers, onopen, onmessage, onclose, onerror);
					for (const d of pending.splice(0)) inner[0](d);
				},
				(err) => {
					onerror(String(err?.message ?? err));
					onclose(1006, "");
				}
			);
			return [
				(data) => (inner ? inner[0](data) : pending.push(data)),
				(code, reason) => (inner ? inner[1](code, reason) : (closed = [code, reason])),
			];
		},
	};
}

// scramjet 2.x never tells the transport when a request is abandoned (the
// controller passes no abort signal), so a page's long polls, event streams and
// requests to hosts that never answer keep running after you leave it. libcurl
// allows 6 connections per host, so six of those wedged every later request to
// that site until they timed out (the soak test caught tabs frozen for minutes).
// this tracks every request until its body is done, and the shell aborts the
// lot when the top level page unloads, the way a browser would.
function withAbortableRequests(transport) {
	const inflight = new Set();
	const request = transport.request.bind(transport);
	transport.request = async (remote, method, body, headers, signal) => {
		const ac = new AbortController();
		const onAbort = () => ac.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		inflight.add(ac);
		const done = () => {
			inflight.delete(ac);
			signal?.removeEventListener("abort", onAbort);
		};
		let res;
		try {
			res = await request(remote, method, body, headers, ac.signal);
		} catch (err) {
			done();
			throw err;
		}
		if (res.body instanceof ReadableStream) {
			let ended = false;
			const end = () => ended || ((ended = true), done());
			res.body = res.body.pipeThrough(new TransformStream({ flush: end }));
			ac.signal.addEventListener("abort", end, { once: true });
		} else {
			done();
		}
		return res;
	};
	transport.abortInFlight = () => {
		const n = inflight.size;
		for (const ac of inflight) ac.abort();
		inflight.clear();
		return n;
	};
	return transport;
}

async function createTransport(kind = settings.get().transport) {
	const url = wispUrl();
	let transport;
	if (kind === "libcurl") {
		transport = await createLibcurl(url);
	} else {
		const { default: EpoxyTransport } = await import("/transports/epoxy.mjs");
		const epoxy = new EpoxyTransport({ wisp: url });
		// init up front: the controller calls transport.connect() directly for
		// websockets, and that path does not lazily init like fetch does
		await epoxy.init();
		transport = epoxyWithLibcurlSockets(epoxy, url);
	}
	transport.nocturneKind = kind;
	return withAbortableRequests(transport);
}

async function registerServiceWorker(onStatus) {
	if (!("serviceWorker" in navigator)) {
		throw new Error("this browser has no service worker support (private mode in firefox disables it)");
	}
	onStatus?.("registering service worker");
	const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });

	if (!navigator.serviceWorker.controller) {
		onStatus?.("activating service worker");
		await Promise.race([
			new Promise((resolve) =>
				navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true })
			),
			navigator.serviceWorker.ready.then(
				() => new Promise((r) => setTimeout(r, navigator.serviceWorker.controller ? 0 : 1500))
			),
			new Promise((resolve) => setTimeout(resolve, 10_000)),
		]);
	}
	const sw = navigator.serviceWorker.controller ?? reg.active;
	if (!sw) throw new Error("service worker never became active");
	return sw;
}

/**
 * boots the engine. returns an object the ui drives.
 * events: { onUrl, onTitle, onLoading, onError, onHealth, onRewriteError, onEscapedNavigation }
 */
export async function createEngine(iframe, events = {}, onStatus) {
	const sw = await registerServiceWorker(onStatus);

	onStatus?.("starting transport");
	let transport = await createTransport();

	onStatus?.("starting controller");
	const controller = new Controller({
		serviceworker: sw,
		transport,
		config: CONTROLLER_CONFIG,
		scramjetConfig: buildScramjetConfig(),
	});
	await controller.wait();

	// rewriter failures for scripts the controller fetched (external files) are
	// reported in this realm, since that is where the rewrite runs
	self.__nocturneRewriteErrorSink = (url, message) =>
		events.onRewriteError?.({ url, message, top: true });

	const blocker = new ContentBlockerPlugin(() => settings.get().blockAds);
	const cache = new HttpCachePlugin();
	const plugins = [
		cache,
		new UrlWatcherPlugin((url) => events.onUrl?.(url)),
		// window.open and target=_top links would otherwise leave the proxy shell
		new CatchEscapedLinksPlugin((url) => new URL(`/?go=${encodeURIComponent(url.href)}`, location.origin)),
		blocker,
		new ErrorPagePlugin((info) => events.onError?.(info)),
		new RecoveryPlugin((info) => {
			if (info.type === "page-health") events.onHealth?.(info);
			else if (info.type === "rewrite-error") events.onRewriteError?.(info);
		}),
		new ShellBridgePlugin({
			onNavigateStart: () => events.onLoading?.(true),
			onUnloading: () => {
				// the page is going away, so is everything it was still loading
				transport.abortInFlight?.();
				events.onLoading?.(true);
			},
			onLoaded: () => events.onLoading?.(false),
			onTitle: (t) => events.onTitle?.(t),
		}),
	];
	const frame = controller.createFrame(iframe, { plugins });
	iframe.addEventListener("load", () => events.onLoading?.(false));

	// keep the live config in sync with settings without a reload. the fetch
	// handler holds a reference to controller.scramjetConfig, and every new page
	// gets a fresh copy serialized into its inject script, so mutating it in
	// place applies from the next navigation on.
	function syncConfig() {
		const next = buildScramjetConfig();
		controller.scramjetConfig.flags.rewriterLogs = next.flags.rewriterLogs;
		const sf = controller.scramjetConfig.siteFlags;
		for (const k of Object.keys(sf)) delete sf[k];
		Object.assign(sf, next.siteFlags);
	}
	settings.onChange((next, patch) => {
		if ("rewriterLogs" in patch || "compatSites" in patch) syncConfig();
	});

	return {
		controller,
		frame,
		cache,
		blocker,
		get transportKind() {
			return transport.nocturneKind;
		},
		go(url) {
			events.onLoading?.(true);
			frame.go(url);
		},
		back: () => frame.back(),
		forward: () => frame.forward(),
		reload() {
			events.onLoading?.(true);
			frame.reload();
		},
		async setTransport(kind) {
			const next = await createTransport(kind);
			// requests already in flight finish on the old transport, it gets
			// garbage collected after that
			controller.setTransport(next);
			transport = next;
			settings.set({ transport: kind });
			return kind;
		},
		setCompat(origin, on) {
			const list = new Set(settings.get().compatSites);
			on ? list.add(origin) : list.delete(origin);
			settings.set({ compatSites: [...list] });
		},
		isCompat(origin) {
			return settings.get().compatSites.includes(origin);
		},
		diag() {
			return self.__nocturneDiag;
		},
		async clearData() {
			await cache.bust();
			controller.cookieJar.clear();
			await controller.persistCookies();
			await new Promise((resolve) => {
				const req = indexedDB.deleteDatabase("__scramjet_controller");
				req.onsuccess = req.onerror = req.onblocked = () => resolve();
			});
			// proxied sites' localStorage lives in ours, keep only nocturne's own keys
			try {
				for (const key of Object.keys(localStorage)) {
					if (!key.startsWith("nocturne:")) localStorage.removeItem(key);
				}
			} catch {
				// storage blocked
			}
		},
	};
}
