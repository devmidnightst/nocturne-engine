// nocturne engine: frame plugins layered on top of the scramjet controller.
//
// each one is a ManagedPlugin, the same plugin type scramjet-utils uses, so it
// installs onto a controller Frame and taps the frame's hooks:
//   frame.hooks.fetch.intercept   answer a request before it hits the network
//   frame.hooks.fetch.request     edit the outgoing request
//   frame.hooks.fetch.response    edit the rewritten response
//   frame.hooks.error.request     replace a failed response
//   frame.hooks.init.post         runs inside every proxied window after scramjet hooks it

import { isBlocked } from "./blocklist.js";
import {
	renderErrorPage,
	renderBlockedPage,
	classifyError,
	needsDiagnosis,
	diagnoseKind,
} from "../error-page.js";

const { ManagedPlugin } = globalThis.$scramjetController;
const { ScramjetHeaders } = globalThis.$scramjet;

const isNavigation = (dest) => dest === "document" || dest === "iframe" || dest === "frame";

// ---------------------------------------------------------------------------
// error pages
// ---------------------------------------------------------------------------

export class ErrorPagePlugin extends ManagedPlugin {
	constructor(onError) {
		super("nocturne-error-pages", []);
		this.onError = onError;
	}

	install(frame) {
		super.install(frame);
		// async: the controller awaits every tap before answering the request
		this.tap(frame.hooks.error.request, async (ctx, props) => {
			const req = ctx.rawrequest;
			let target = req.rawUrl;
			try {
				target = frame.controller.config.codec.decode(
					new URL(req.rawUrl).pathname.slice(frame.prefix.length)
				);
			} catch {
				// keep the raw url
			}
			let kind = classifyError(ctx.error);
			const navigation = isNavigation(req.destination);
			// only spend a round trip on navigations, subresource failures just log
			if (navigation && needsDiagnosis(ctx.error, kind)) kind = (await diagnoseKind(target)) ?? kind;
			this.onError?.({ url: target, kind, error: ctx.error, destination: req.destination });
			if (!navigation) return;
			props.setResponse = renderErrorPage({ url: target, error: ctx.error, kind });
		});
	}
}

// ---------------------------------------------------------------------------
// ad + tracker blocking
// ---------------------------------------------------------------------------

const EMPTY_TYPES = {
	script: "text/javascript",
	style: "text/css",
	image: "image/gif",
	font: "font/woff2",
};

export class ContentBlockerPlugin extends ManagedPlugin {
	constructor(isEnabled) {
		super("nocturne-content-blocker", []);
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
			// an empty 200 keeps most ad loaders from retrying in a loop
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

// ---------------------------------------------------------------------------
// diagnostics + recovery
// ---------------------------------------------------------------------------

// watches every proxied window for uncaught errors and rewriter failures, then
// flags pages that finished loading but rendered nothing so the shell can offer
// recovery options (reload, compat mode, other transport).
export class RecoveryPlugin extends ManagedPlugin {
	constructor(report) {
		super("nocturne-recovery", []);
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

			// rewriter failures inside this realm (eval, inline handlers, dynamic
			// scripts) come in through the sink the patched scramjet bundle calls
			try {
				Object.defineProperty(win, "__nocturneRewriteErrorSink", {
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
				// frozen global, nothing to do
			}

			listen(win, "error", (e) => {
				// resource load errors bubble here too, only count script errors
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
						// page navigated away mid check
					}
				}, 3500);
			});
		});
	}
}

// ---------------------------------------------------------------------------
// shell bridge
// ---------------------------------------------------------------------------

// title + loading signals for the top level page, used by the ui
export class ShellBridgePlugin extends ManagedPlugin {
	constructor(events) {
		super("nocturne-shell-bridge", []);
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
			this.events.onNavigateStart?.(client.url.href);
			add("DOMContentLoaded", () => this.events.onTitle?.(win.document.title));
			add("load", () => {
				this.events.onTitle?.(win.document.title);
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
				// not fatal, title just will not live update
			}
		});
	}
}
