import { settings, _dsu } from "./store.js";
import { _nr, _nrx } from "./net-resolver.js";
import {
	_EP,
	_CB,
	_RP,
	_SB,
} from "./plugins/core-plugins.js";
import { _CP } from "./plugins/captcha-plugin.js";
import { _CK } from "./plugins/cloak-plugin.js";
import { _AB } from "./plugins/adblock-plugin.js";
import { loadFilterLists } from "./plugins/blocklist.js";

const _nc_ctrl = globalThis[atob("JHNjcmFtamV0Q29udHJvbGxlcg==")];
const _nc_core = globalThis[atob("JHNjcmFtamV0")];
const _nc_util = globalThis[atob("JHNjcmFtamV0VXRpbHM=")];
const { Controller } = _nc_ctrl;
const { defaultConfig, versionInfo } = _nc_core;
const { HttpCachePlugin, UrlWatcherPlugin, CatchEscapedLinksPlugin } = _nc_util;

export { versionInfo };

const _kSP = "scram" + "jetPath";
const _kSCfg = "scram" + "jetConfig";
const CONTROLLER_CONFIG = {
	prefix: "/~/xf/",
	[_kSP]: "/assets/r/runtime.js",
	injectPath: "/assets/r/inject.js",
	wasmPath: "/assets/r/core.wasm",
	virtualWasmPath: "core.wasm.js",
};

export const COMPAT_FLAGS = { destructureRewrites: false, encapsulateWorkers: false };

export const siteKey = (host) => String(host || "").toLowerCase().replace(/^www\./, "");

function adblockOn(url) {
	const s = settings.get();
	if (!s.blockAds) return false;
	if (!url) return true;
	return !s.adblockOff.includes(siteKey(url.hostname));
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const siteFlagKey = (origin) => `^${escapeRegex(origin)}(/|$)`;

function buildEngineConfig() {
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

async function _cL(url) {
	const _m = await import("/assets/r/transport.mjs");
	const _t = new _m[atob("TGliY3VybENsaWVudA==")]({ wisp: url, connections: [80, 40, 16] });
	await _t.init();
	return _t;
}

function _eLs(_ep, url) {
	let _lc = null;
	const _gL = () => (_lc ??= _cL(url).catch((err) => ((_lc = null), Promise.reject(err))));
	(self.requestIdleCallback ?? setTimeout)(() => _gL().catch(() => {}), { timeout: 5000 });

	return {
		get ready() {
			return _ep.ready;
		},
		init: () => _ep.init(),
		meta: () => _ep.meta?.(),
		request: (...args) => _ep.request(...args),
		connect(wsUrl, protocols, headers, onopen, onmessage, onclose, onerror) {
			let inner = null;
			let closed = null;
			const pending = [];
			_gL().then(
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

function _fT(getBase) {
	const inflight = new Set();
	return {
		get ready() {
			return getBase().ready;
		},
		init: () => getBase().init(),
		meta: () => getBase().meta?.(),
		connect: (...args) => getBase().connect(...args),
		async request(remote, method, body, headers, signal) {
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
				res = await getBase().request(remote, method, body, headers, ac.signal);
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
		},
		abortInFlight() {
			const n = inflight.size;
			for (const ac of inflight) ac.abort();
			inflight.clear();
			return n;
		},
	};
}

async function _cT(kind = settings.get()._m) {
	const pinned = !!(settings.get()._srvUrl || "").trim();
	const own = _dsu();
	for (let attempt = 0; attempt < 3; attempt++) {
		const url = await _nr();
		try {
			return await _cTf(kind, url);
		} catch (err) {
			if (pinned || url === own) throw err;
			_nrx(url);
		}
	}
	return _cTf(kind, own);
}

async function _cTf(kind, url) {
	let _t;
	if (kind === "lc") {
		_t = await _cL(url);
	} else {
		const { default: _ET } = await import("/assets/r/transport.alt.mjs");
		const _ep = new _ET({ wisp: url });
		await _ep.init();
		_t = _eLs(_ep, url);
	}
	_t._tK = kind;
	_t._tS = url;
	return _t;
}

const ICON_SIZE = 32;

async function iconDataUrl(blob) {
	const src = URL.createObjectURL(blob);
	try {
		const img = new Image();
		img.src = src;
		await img.decode();
		const w = img.naturalWidth || ICON_SIZE;
		const h = img.naturalHeight || ICON_SIZE;
		const scale = Math.min(ICON_SIZE / w, ICON_SIZE / h);
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = ICON_SIZE;
		canvas
			.getContext("2d")
			.drawImage(img, (ICON_SIZE - w * scale) / 2, (ICON_SIZE - h * scale) / 2, w * scale, h * scale);
		return canvas.toDataURL("image/png");
	} catch {
		return null;
	} finally {
		URL.revokeObjectURL(src);
	}
}

function headerValue(headers, name) {
	if (!headers) return null;
	if (typeof headers.get === "function") return headers.get(name);
	const entries = Array.isArray(headers) ? headers : Object.entries(headers);
	const hit = entries.find(([k]) => String(k).toLowerCase() === name);
	if (!hit) return null;
	return Array.isArray(hit[1]) ? hit[1][0] : hit[1];
}

async function _fIw(_t, url) {
	if (url.startsWith("data:image/")) {
		return iconDataUrl(await (await fetch(url)).blob());
	}
	const ac = new AbortController();
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => {
			ac.abort();
			reject(new Error("icon timed out"));
		}, 8000);
	});
	timeout.catch(() => {});
	const headers = [
		["User-Agent", navigator.userAgent],
		["Accept", "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5"],
	];
	try {
		let target = new URL(url);
		for (let hop = 0; hop < 4; hop++) {
			if (!/^https?:$/.test(target.protocol)) return null;
			const res = await Promise.race([_t.request(target, "GET", null, headers, ac.signal), timeout]);
			const location = res.status >= 300 && res.status < 400 ? headerValue(res.headers, "location") : null;
			if (location) {
				await res.body?.cancel?.().catch(() => {});
				target = new URL(location, target);
				continue;
			}
			if (res.status < 200 || res.status >= 300) return null;
			const bytes = await Promise.race([new Response(res.body).arrayBuffer(), timeout]);
			if (!bytes.byteLength || bytes.byteLength > 512 * 1024) return null;
			const type = (headerValue(res.headers, "content-type") || "").split(";")[0].trim();
			return iconDataUrl(new Blob([bytes], { type }));
		}
		return null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

async function registerServiceWorker(onStatus) {
	if (!("serviceWorker" in navigator)) {
		throw new Error("this browser has no service worker support (private mode in firefox disables it)");
	}
	onStatus?.("starting up");
	const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });

	if (!navigator.serviceWorker.controller) {
		onStatus?.("starting up");
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
	return { sw, reg };
}

function followServiceWorker(controller, reg) {
	const rebind = (worker) => {
		if (!worker || worker === controller.serviceWorkerController) return;
		controller.serviceWorkerController = worker;
		controller.setupMessagePort();
	};
	navigator.serviceWorker.addEventListener("controllerchange", () => rebind(navigator.serviceWorker.controller));
	reg.addEventListener("updatefound", () => {
		const next = reg.installing;
		next?.addEventListener("statechange", () => {
			if (next.state === "activated") rebind(next);
		});
	});
}

export async function createEngine(events = {}, onStatus) {
	const { sw, reg } = await registerServiceWorker(onStatus);

	onStatus?.("starting up");
	let _t = await _cT();

	onStatus?.("starting up");
	const controller = new Controller({
		serviceworker: sw,
		transport: _t,
		config: CONTROLLER_CONFIG,
		[_kSCfg]: buildEngineConfig(),
	});
	await controller.wait();
	followServiceWorker(controller, reg);

	Object.defineProperty(self, "__nc_s8f3", {
		value: (url, message) => events.onRewriteError?.({ url, message, top: true }),
		enumerable: false, configurable: true, writable: true,
	});

	const tabs = new Set();
	if (settings.get().blockAds) loadFilterLists();
	settings.onChange((next, patch) => {
		if (patch.blockAds) loadFilterLists();
	});

	function createTab(iframe, tabEvents = {}) {
		let site = null;
		const setSite = (url) => {
			try {
				site = new URL(url);
			} catch {
			}
		};
		const blocking = () => adblockOn(site);
		const blocker = new _CB(blocking, () => site);
		const cache = new HttpCachePlugin();
		const perFrame = _fT(() => _t);
		const plugins = [
			new _CK(),
			cache,
			new UrlWatcherPlugin((url) => {
				if (url && url !== "about:blank") setSite(url);
				tabEvents.onUrl?.(url);
			}),
			new CatchEscapedLinksPlugin((url) => new URL(`/?go=${encodeURIComponent(url.href)}`, location.origin)),
			new _AB({
				isEnabled: blocking,
				onNavigate: setSite,
				onAntiAdblock: (info) => tabEvents.onAntiAdblock?.(info),
			}),
			blocker,
			new _CP(),
			new _EP((info) => tabEvents.onError?.(info)),
			new _RP((info) => {
				if (info.type === "page-health") tabEvents.onHealth?.(info);
				else if (info.type === "rewrite-error") events.onRewriteError?.(info);
			}),
			new _SB({
				onNavigateStart: () => tabEvents.onLoading?.(true),
				onUnloading: () => {
					perFrame.abortInFlight();
					tabEvents.onLoading?.(true);
				},
				onLoaded: () => tabEvents.onLoading?.(false),
				onTitle: (t) => tabEvents.onTitle?.(t),
				onIcon: (u) => u && tabEvents.onIcon?.(u),
				onOpen: (u, opts) => tabEvents.onOpen?.(u, opts),
			}),
		];
		const frame = controller.createFrame(iframe, { plugins });
		frame.fetchHandler.client.transport = perFrame;
		const onLoad = () => tabEvents.onLoading?.(false);
		iframe.addEventListener("load", onLoad);

		const tab = {
			frame,
			cache,
			blocker,
			perFrame,
			go(url) {
				tabEvents.onLoading?.(true);
				frame.go(url);
			},
			back: () => frame.back(),
			forward: () => frame.forward(),
			reload() {
				tabEvents.onLoading?.(true);
				frame.reload();
			},
			blank() {
				perFrame.abortInFlight();
				try {
					iframe.src = "about:blank";
				} catch {
				}
			},
			destroy() {
				perFrame.abortInFlight();
				iframe.removeEventListener("load", onLoad);
				try {
					iframe.src = "about:blank";
				} catch {
				}
				iframe.remove();
				const i = controller.frames.indexOf(frame);
				if (i !== -1) controller.frames.splice(i, 1);
				tabs.delete(tab);
			},
		};
		tabs.add(tab);
		return tab;
	}

	function syncConfig() {
		const next = buildEngineConfig();
		controller[_kSCfg].flags.rewriterLogs = next.flags.rewriterLogs;
		const sf = controller[_kSCfg].siteFlags;
		for (const k of Object.keys(sf)) delete sf[k];
		Object.assign(sf, next.siteFlags);
	}
	settings.onChange((next, patch) => {
		if ("rewriterLogs" in patch || "compatSites" in patch) syncConfig();
	});

	return {
		controller,
		createTab,
		get _tK() {
			return _t._tK;
		},
		get blocked() {
			let n = 0;
			for (const t of tabs) n += t.blocker.blocked;
			return n;
		},
		async _sT(kind) {
			const next = await _cT(kind);
			controller.setTransport(next);
			_t = next;
			for (const t of tabs) t.frame.fetchHandler.client.transport = t.perFrame;
			settings.set({ _m: kind });
			return kind;
		},
		setAdblock(host, on) {
			const key = siteKey(host);
			const list = new Set(settings.get().adblockOff);
			on ? list.delete(key) : list.add(key);
			settings.set({ adblockOff: [...list] });
		},
		isAdblockOff(host) {
			return settings.get().adblockOff.includes(siteKey(host));
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
			return self.__nc_d7f2;
		},
		fetchIcon: (url) => _fIw(_t, url),
		async clearData() {
			for (const t of tabs) await t.cache.bust();
			if (!tabs.size) await new HttpCachePlugin().bust();
			controller.cookieJar.clear();
			await controller.persistCookies();
			await new Promise((resolve) => {
				const req = indexedDB.deleteDatabase("__nc_e4b7");
				req.onsuccess = req.onerror = req.onblocked = () => resolve();
			});
			try {
				for (const key of Object.keys(localStorage)) {
					if (!key.startsWith("_p8q2:")) localStorage.removeItem(key);
				}
			} catch {
			}
		},
	};
}
