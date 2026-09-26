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

async function createTransport(kind = settings.get().transport) {
	const url = wispUrl();
	let transport;
	if (kind === "libcurl") {
		const { LibcurlClient } = await import("/transports/libcurl.mjs");
		transport = new LibcurlClient({ wisp: url });
	} else {
		const { default: EpoxyTransport } = await import("/transports/epoxy.mjs");
		transport = new EpoxyTransport({ wisp: url });
	}
	// init up front: the controller calls transport.connect() directly for
	// websockets, and that path does not lazily init like fetch does
	await transport.init();
	transport.nocturneKind = kind;
	return transport;
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
			onUnloading: () => events.onLoading?.(true),
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
