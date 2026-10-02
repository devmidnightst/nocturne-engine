import { pruneHtmlText, pruneJsonText, isYouTubeHost, YT_API_RE } from "./yt-prune.js";

const { ManagedPlugin } = globalThis[atob("JHNjcmFtamV0Q29udHJvbGxlcg==")];

const YT_CSS = `
#masthead-ad, #player-ads, #panels > ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"],
ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer, ytd-banner-promo-renderer, ytd-statement-banner-renderer,
ytd-promoted-sparkles-web-renderer, ytd-promoted-video-renderer, ytd-compact-promoted-video-renderer,
ytd-display-ad-renderer, ytd-action-companion-ad-renderer, ytd-companion-slot-renderer, ytd-search-pyv-renderer,
ytd-brand-video-singleton-renderer, ytd-player-legacy-desktop-watch-ads-renderer, ytd-mealbar-promo-renderer,
ytd-rich-item-renderer:has(> #content > ytd-ad-slot-renderer), ytd-rich-section-renderer:has(ytd-statement-banner-renderer),
tp-yt-paper-dialog:has(ytd-enforcement-message-view-model), ytd-enforcement-message-view-model,
.ytp-ad-module, .ytp-ad-overlay-container, .ytp-ad-image-overlay, .ytp-suggested-action, .ytp-featured-product,
ytm-promoted-sparkles-web-renderer, ytm-companion-ad-renderer, ad-slot-renderer, .ytd-merch-shelf-renderer,
ytmusic-mealbar-promo-renderer, ytmusic-statement-banner-renderer
{ display: none !important; }
`;

const GENERIC_CSS = `
ins.adsbygoogle[data-ad-status="unfilled"], div[id^="google_ads_iframe_"], iframe[id^="google_ads_iframe_"],
iframe[src*="doubleclick.net/"], iframe[src*="googlesyndication.com/"], div[id^="div-gpt-ad"]:empty
{ display: none !important; }
`;

const SKIP_BUTTONS =
	".ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-skip-button-container button, button[id^='skip-button']";

const ANTI_ADBLOCK_RE =
	/\bad[\s-]?block(?:er|ers|ing)?\b[^.!?\n]{0,90}\b(?:detected|enabled|turned on|is on|running|active|installed|not allowed|disable|turn (?:it )?off|pause|whitelist|allow ?list)|\b(?:disable|turn off|pause|deactivate|whitelist|allow ?list|switch off)\b[^.!?\n]{0,60}\bad[\s-]?block|\bad blockers? (?:are|is) not allowed|\busing an? ad[\s-]?blocker|\bblock(?:ing)? ads\b[^.!?\n]{0,60}\b(?:support|disable|whitelist)/i;

const CANDIDATES = [
	"dialog[open]",
	"[role=dialog]",
	"[role=alertdialog]",
	"[aria-modal=true]",
	".fc-ab-root",
	"[class*=modal i]",
	"[class*=popup i]",
	"[class*=overlay i]",
	"[class*=adblock i]",
	"[class*=ad-block i]",
	"[id*=adblock i]",
	"[id*=modal i]",
	"[id*=popup i]",
	"[class*=notice i]",
	"[class*=paywall i]",
].join(",");

function rebuild(res, transform) {
	const source = res.body;
	const body = new ReadableStream({
		async start(controller) {
			try {
				const text = await new Response(source).text();
				let out = null;
				try {
					out = transform(text);
				} catch {
				}
				controller.enqueue(new TextEncoder().encode(out ?? text));
				controller.close();
			} catch (err) {
				controller.error(err);
			}
		},
	});
	const R = res.constructor;
	const headers = new Headers(res.headers);
	headers.delete("content-length");
	headers.delete("content-encoding");
	const next = new R(body, { status: res.status, statusText: res.statusText, headers });
	next.url = res.url;
	next.redirected = res.redirected;
	const raw = res.rawHeaders;
	const drop = (k) => /^(content-length|content-encoding)$/i.test(k);
	if (Array.isArray(raw)) next.rawHeaders = raw.filter(([k]) => !drop(k));
	else if (raw && typeof raw === "object") next.rawHeaders = Object.fromEntries(Object.entries(raw).filter(([k]) => !drop(k)));
	else next.rawHeaders = [...headers];
	return next;
}

function addStyle(win, css) {
	try {
		const doc = win.document;
		const sheet = new win.CSSStyleSheet();
		sheet.replaceSync(css);
		doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
	} catch {
	}
}

export class _AB extends ManagedPlugin {
	constructor({ isEnabled, onNavigate, onAntiAdblock }) {
		super("_ab8", []);
		this.isEnabled = isEnabled;
		this.onNavigate = onNavigate;
		this.onAntiAdblock = onAntiAdblock;
		this.pruned = 0;
	}

	install(frame) {
		super.install(frame);

		this.tap(frame.hooks.fetch.intercept, (ctx) => {
			const { url, destination } = ctx.parsed;
			if (url && destination === "document") this.onNavigate?.(url);
		});

		this.tap(
			frame.hooks.fetch.preresponse,
			(ctx, props) => {
				const { url, destination } = ctx.parsed;
				const res = props.response;
				if (!url || !res?.body || res.status !== 200 || !isYouTubeHost(url.hostname) || !this.isEnabled()) return;
				const doc = destination === "document" || destination === "iframe";
				if (!doc && !YT_API_RE.test(url.pathname)) return;
				const type = res.headers.get("content-type") || "";
				if (doc ? !type.includes("html") : !type.includes("json")) return;
				const prune = doc ? pruneHtmlText : pruneJsonText;
				props.response = rebuild(res, (text) => {
					const out = prune(text);
					if (out !== null) this.pruned++;
					return out;
				});
			},
			{ before: ["scramjet-http-cache"] }
		);

		this.tap(frame.hooks.init.post, ({ window: win, client, isTopLevel }) => {
			if (!this.isEnabled()) return;
			let host = "";
			try {
				host = client.url.hostname;
			} catch {
			}
			if (isYouTubeHost(host)) {
				addStyle(win, YT_CSS);
				this.youtubeSkipper(win);
			} else {
				addStyle(win, GENERIC_CSS);
			}
			if (isTopLevel) this.watchAntiAdblock(win, client);
		});
	}

	youtubeSkipper(win) {
		const tick = () => {
			try {
				const doc = win.document;
				for (const b of doc.querySelectorAll(SKIP_BUTTONS)) b.click();
				const player = doc.querySelector(".html5-video-player.ad-showing, .html5-video-player.ad-interrupting");
				if (player) {
					const video = player.querySelector("video");
					if (video && Number.isFinite(video.duration) && video.duration > 0) {
						video.muted = true;
						video.playbackRate = 16;
						video.currentTime = Math.max(video.duration - 0.1, 0);
					}
				}
				const wall = doc.querySelector("ytd-enforcement-message-view-model");
				if (wall) {
					wall.closest("tp-yt-paper-dialog")?.remove();
					wall.remove();
					doc.querySelector("tp-yt-iron-overlay-backdrop")?.remove();
					const main = doc.querySelector("#movie_player video");
					if (main?.paused) main.play().catch(() => {});
				}
			} catch {
			}
		};
		win.setInterval(tick, 400);
	}

	watchAntiAdblock(win, client) {
		let done = false;
		let timer = 0;
		let observer = null;
		const started = Date.now();

		const visible = (el) => {
			const r = el.getBoundingClientRect();
			if (r.width < 120 || r.height < 40) return false;
			const st = win.getComputedStyle(el);
			return st.visibility !== "hidden" && st.display !== "none" && Number(st.opacity) > 0.05;
		};

		const matches = (el) => {
			const text = el.innerText || "";
			return text.length > 15 && text.length < 2500 && ANTI_ADBLOCK_RE.test(text) && visible(el);
		};

		const scan = () => {
			timer = 0;
			if (done) return;
			try {
				const doc = win.document;
				if (!doc.body) return;
				for (const el of doc.querySelectorAll(CANDIDATES)) {
					if (matches(el)) return report();
				}
				for (const el of doc.body.children) {
					const pos = win.getComputedStyle(el).position;
					if ((pos === "fixed" || pos === "sticky" || pos === "absolute") && matches(el)) return report();
				}
			} catch {
			}
			if (Date.now() - started > 30_000) stop();
		};

		const schedule = () => {
			if (!timer && !done) timer = win.setTimeout(scan, 700);
		};

		const stop = () => {
			done = true;
			observer?.disconnect();
		};

		const report = () => {
			let url = "";
			try {
				url = client.url.href;
			} catch {
			}
			stop();
			if (this.isEnabled()) this.onAntiAdblock?.({ url });
		};

		const begin = () => {
			try {
				observer = new win.MutationObserver(schedule);
				observer.observe(win.document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "open"] });
			} catch {
			}
			schedule();
		};

		try {
			if (win.document.readyState === "loading") {
				client.natives.call("EventTarget.prototype.addEventListener", win, "DOMContentLoaded", begin, { once: true });
			} else begin();
		} catch {
			win.addEventListener("DOMContentLoaded", begin, { once: true });
		}
	}
}
