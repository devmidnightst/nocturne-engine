import { settings, wispUrl } from "./store.js";
import {
	ErrorPagePlugin,
	ContentBlockerPlugin,
	RecoveryPlugin,
	ShellBridgePlugin,
} from "./plugins/umbrella-plugins.js";

const { Controller } = globalThis.$scramjetController;
const { defaultConfig, versionInfo } = globalThis.$scramjet;
const { HttpCachePlugin, UrlWatcherPlugin, CatchEscapedLinksPlugin } = globalThis.$scramjetUtils;

export { versionInfo };

const CONTROLLER_CONFIG = {
	prefix: "/~/sj/",
	scramjetPath: "/scramjet/scramjet.js",
	injectPath: "/controller/controller.inject.js",
	wasmPath: "/scramjet/scramjet.wasm",
	virtualWasmPath: "scramjet.wasm.js",
};

export const COMPAT_FLAGS = { destructureRewrites: false, encapsulateWorkers: false };

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const siteFlagKey = (origin) => `^${escapeRegex(origin)}(/|$)`;

function buildScramjetConfig() {
	const s = settings.get();
	const siteFlags = {};
	for (const origin of s.compatSites) siteFlags[siteFlagKey(origin)] = { ...COMPAT_FLAGS };
	return {
		flags: {
			...defaultConfig.flags,
			allowInvalidJs: true,
			allowFailedIntercepts: true,
			sourcemaps: true,
			rewriterLogs: !!s.rewriterLogs,
		},
		siteFlags,
	};
}

async function createLibcurl(url) {
	const { LibcurlClient } = await import("/transports/libcurl.mjs");
	const transport = new LibcurlClient({ wisp: url, connections: [80, 40, 16] });
	await transport.init();
	return transport;
}

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
		await epoxy.init();
		transport = epoxyWithLibcurlSockets(epoxy, url);
	}
	transport.umbrellaKind = kind;
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

	self.__umbrellaRewriteErrorSink = (url, message) =>
		events.onRewriteError?.({ url, message, top: true });

	const blocker = new ContentBlockerPlugin(() => settings.get().blockAds);
	const cache = new HttpCachePlugin();
	const plugins = [
		cache,
		new UrlWatcherPlugin((url) => events.onUrl?.(url)),
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
				transport.abortInFlight?.();
				events.onLoading?.(true);
			},
			onLoaded: () => events.onLoading?.(false),
			onTitle: (t) => events.onTitle?.(t),
		}),
	];
	const frame = controller.createFrame(iframe, { plugins });
	iframe.addEventListener("load", () => events.onLoading?.(false));

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
			return transport.umbrellaKind;
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
			return self.__umbrellaDiag;
		},
		async clearData() {
			await cache.bust();
			controller.cookieJar.clear();
			await controller.persistCookies();
			await new Promise((resolve) => {
				const req = indexedDB.deleteDatabase("__scramjet_controller");
				req.onsuccess = req.onerror = req.onblocked = () => resolve();
			});
			try {
				for (const key of Object.keys(localStorage)) {
					if (!key.startsWith("umbrella:")) localStorage.removeItem(key);
				}
			} catch {
			}
		},
	};
}
