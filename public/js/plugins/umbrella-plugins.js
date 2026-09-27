import { isBlocked } from "./blocklist.js";
import {
	renderErrorPage,
	renderBlockedPage,
	classifyError,
	needsDiagnosis,
	diagnoseKind,
} from "../error-page.js";

const { ManagedPlugin } = globalThis[atob("JHNjcmFtamV0Q29udHJvbGxlcg==")];
const { ScramjetHeaders } = globalThis[atob("JHNjcmFtamV0")];

const isNavigation = (dest) => dest === "document" || dest === "iframe" || dest === "frame";

export class ErrorPagePlugin extends ManagedPlugin {
	constructor(onError) {
		super("umbrella-error-pages", []);
		this.onError = onError;
	}

	install(frame) {
		super.install(frame);
		this.tap(frame.hooks.error.request, async (ctx, props) => {
			const req = ctx.rawrequest;
			let target = req.rawUrl;
			try {
				target = frame.controller.config.codec.decode(
					new URL(req.rawUrl).pathname.slice(frame.prefix.length)
				);
			} catch {
			}
			let kind = classifyError(ctx.error);
			const navigation = isNavigation(req.destination);
			if (navigation && needsDiagnosis(ctx.error, kind)) kind = (await diagnoseKind(target)) ?? kind;
			this.onError?.({ url: target, kind, error: ctx.error, destination: req.destination });
			if (!navigation) return;
			props.setResponse = renderErrorPage({ url: target, error: ctx.error, kind });
		});
	}
}

const EMPTY_TYPES = {
	script: "text/javascript",
	style: "text/css",
	image: "image/gif",
	font: "font/woff2",
};

export class ContentBlockerPlugin extends ManagedPlugin {
	constructor(isEnabled) {
		super("umbrella-content-blocker", []);
		this.isEnabled = isEnabled;
		this.blocked = 0;
	}

	install(frame) {
		super.install(frame);
		this.tap(frame.hooks.fetch.intercept, (ctx, props) => {
			if (props.response || !this.isEnabled()) return;
			const { url, destination } = ctx.parsed;
			if (!url || destination === "document" || !isBlocked(url)) return;

			this.blocked++;
			if (isNavigation(destination)) {
				const page = renderBlockedPage(url.href);
				props.response = { ...page, headers: ScramjetHeaders.fromRawHeaders(page.headers) };
				return;
			}
			props.response = {
				body: "",
				status: 200,
				statusText: "OK",
				headers: ScramjetHeaders.fromRawHeaders([
					["content-type", EMPTY_TYPES[destination] ?? "text/plain"],
					["cache-control", "no-store"],
				]),
			};
		});
	}
}

export class RecoveryPlugin extends ManagedPlugin {
	constructor(report) {
		super("umbrella-recovery", []);
		this.report = report;
	}

	install(frame) {
		super.install(frame);
		this.tap(frame.hooks.init.post, ({ window: win, client, isTopLevel }) => {
			const natives = client.natives;
			const listen = (target, type, fn) => {
				try {
					natives.call("EventTarget.prototype.addEventListener", target, type, fn, { capture: true });
				} catch {
					target.addEventListener(type, fn, { capture: true });
				}
			};

			const state = { errors: 0, rewriteErrors: 0, samples: [] };
			const note = (kind, message) => {
				state.samples.push({ kind, message: String(message).slice(0, 240) });
				if (state.samples.length > 8) state.samples.shift();
			};

			try {
				Object.defineProperty(win, "__nc_s8f3", {
					value: (url, message) => {
						state.rewriteErrors++;
						note("rewrite", `${url || "(inline)"}: ${message}`);
						this.report({ type: "rewrite-error", url, message, top: isTopLevel });
					},
					configurable: true,
					enumerable: false,
					writable: true,
				});
			} catch {
			}

			listen(win, "error", (e) => {
				if (e && e.error === undefined && !e.message) return;
				state.errors++;
				note("error", e.message || e.error);
			});
			listen(win, "unhandledrejection", (e) => {
				state.errors++;
				note("rejection", e.reason?.message ?? e.reason);
			});

			if (!isTopLevel) return;

			listen(win, "load", () => {
				win.setTimeout(() => {
					try {
						const doc = win.document;
						const body = doc.body;
						const text = (body?.innerText || "").trim().length;
						const media = body
							? body.querySelectorAll("img,video,canvas,svg,iframe,picture,embed,object").length
							: 0;
						const looksBlank = !body || (text < 3 && media === 0);
						this.report({
							type: "page-health",
							url: client.url.href,
							title: doc.title,
							looksBlank,
							errors: state.errors,
							rewriteErrors: state.rewriteErrors,
							samples: state.samples.slice(),
						});
					} catch {
					}
				}, 3500);
			});
		});
	}
}

function realUrl(frame, href, base) {
	try {
		const url = new URL(href, base);
		if (url.origin === location.origin && url.pathname.startsWith(frame.prefix)) {
			return new URL(frame.controller.config.codec.decode(url.pathname.slice(frame.prefix.length) + url.search)).href;
		}
		return /^https?:$/.test(url.protocol) ? url.href : null;
	} catch {
		return null;
	}
}

function findIcon(frame, doc, pageUrl) {
	try {
		const page = new URL(pageUrl);
		if (!/^https?:$/.test(page.protocol)) return null;
		let href = null;
		try {
			const link = doc.querySelector('link[rel~="icon" i]');
			href = link?.getAttribute("href") || null;
		} catch {
		}
		if (!href) return new URL("/favicon.ico", page).href;
		if (href.startsWith("data:image/")) return href;
		return realUrl(frame, href, page);
	} catch {
		return null;
	}
}

function linkTarget(e) {
	for (const node of e.composedPath?.() ?? []) {
		if (node?.tagName === "A" || node?.tagName === "AREA") return node.hasAttribute("href") ? node : null;
	}
	return null;
}

export class ShellBridgePlugin extends ManagedPlugin {
	constructor(events) {
		super("umbrella-shell-bridge", []);
		this.events = events;
	}

	install(frame) {
		super.install(frame);
		this.tap(frame.hooks.init.post, ({ window: win, client, isTopLevel }) => {
			if (!isTopLevel) return;
			const add = (type, fn) => {
				try {
					client.natives.call("EventTarget.prototype.addEventListener", win, type, fn);
				} catch {
					win.addEventListener(type, fn);
				}
			};
			const openLink = (e, background) => {
				if (e.defaultPrevented || !this.events.onOpen) return;
				const a = linkTarget(e);
				if (!a || a.hasAttribute("download")) return;
				const url = realUrl(frame, a.getAttribute("href"), client.url.href);
				if (!url) return;
				e.preventDefault();
				this.events.onOpen(url, { background });
			};
			add("click", (e) => {
				if (e.button !== 0 || e.altKey) return;
				const a = linkTarget(e);
				if (!a) return;
				if (e.ctrlKey || e.metaKey) return openLink(e, !e.shiftKey);
				if (e.shiftKey || (a.target || "").toLowerCase() === "_blank") openLink(e, false);
			});
			add("auxclick", (e) => {
				if (e.button === 1) openLink(e, !e.shiftKey);
			});
			this.events.onNavigateStart?.(client.url.href);
			add("DOMContentLoaded", () => this.events.onTitle?.(win.document.title));
			add("load", () => {
				this.events.onTitle?.(win.document.title);
				this.events.onIcon?.(findIcon(frame, win.document, client.url.href));
				this.events.onLoaded?.(client.url.href);
			});
			add("beforeunload", () => this.events.onUnloading?.());
			try {
				const title = win.document.querySelector("title");
				const observe = () =>
					new win.MutationObserver(() => this.events.onTitle?.(win.document.title)).observe(
						win.document.head || win.document.documentElement,
						{ subtree: true, childList: true, characterData: true }
					);
				if (title || win.document.documentElement) observe();
			} catch {
			}
		});
	}
}
