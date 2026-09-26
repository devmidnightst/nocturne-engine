// nocturne engine: shell ui. owns the omnibox, panels and recovery banner,
// and drives the engine from engine.js.

import { createEngine, versionInfo } from "./engine.js";
import { resolveInput } from "./omnibox.js";
import { settings, bookmarks, history, SEARCH_ENGINES, defaultWispUrl } from "./store.js";

const $ = (id) => document.getElementById(id);

const ui = {
	bar: $("bar"),
	address: $("address"),
	omnibox: $("omnibox"),
	progress: $("progress"),
	bookmark: $("bookmark"),
	homeView: $("home-view"),
	frameWrap: $("frame-wrap"),
	frame: $("frame"),
	boot: $("boot"),
	bootStatus: $("boot-status"),
	panel: $("panel"),
	banner: $("banner"),
	toast: $("toast"),
};

const QUICK_LINKS = [
	{ name: "Discord", url: "https://discord.com/app", color: "#5865f2" },
	{ name: "YouTube", url: "https://www.youtube.com", color: "#ff3d3d" },
	{ name: "Spotify", url: "https://open.spotify.com", color: "#1ed760" },
	{ name: "Reddit", url: "https://www.reddit.com", color: "#ff5700" },
	{ name: "GitHub", url: "https://github.com", color: "#c9d1d9" },
	{ name: "Wikipedia", url: "https://en.wikipedia.org", color: "#e6e6e6" },
];

let engine = null;
let currentUrl = "";
let currentTitle = "";
let pendingGo = null;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

let toastTimer;
function toast(msg, ms = 2600) {
	ui.toast.textContent = msg;
	ui.toast.classList.add("show");
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => ui.toast.classList.remove("show"), ms);
}

function el(tag, props = {}, ...children) {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (k === "class") node.className = v;
		else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
		else if (v !== undefined && v !== null) node.setAttribute(k, v);
	}
	for (const c of children) node.append(c);
	return node;
}

function hostOf(url) {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

function originOf(url) {
	try {
		return new URL(url).origin;
	} catch {
		return null;
	}
}

function favicon(url) {
	// first letter badge, avoids leaking every visited host to a favicon service
	const letter = (hostOf(url)[0] || "?").toUpperCase();
	return el("span", { class: "fav" }, letter);
}

// ---------------------------------------------------------------------------
// view state
// ---------------------------------------------------------------------------

function showHome() {
	currentUrl = "";
	ui.address.value = "";
	ui.homeView.hidden = false;
	ui.frameWrap.hidden = true;
	hideBanner();
	setLoading(false);
	updateBookmarkButton();
	renderHomeLists();
	document.title = "Nocturne Engine";
	try {
		ui.frame.src = "about:blank";
	} catch {
		// ignore
	}
	history_replace(null);
	$("hero-input").focus({ preventScroll: true });
}

function showFrame() {
	ui.homeView.hidden = true;
	ui.frameWrap.hidden = false;
}

let loadingTimer;
function setLoading(on) {
	ui.progress.classList.toggle("active", on);
	clearTimeout(loadingTimer);
	// never leave the bar spinning forever if a load event gets lost
	if (on) loadingTimer = setTimeout(() => ui.progress.classList.remove("active"), 30_000);
}

function history_replace(url) {
	// mirror the proxied url into ?go= so a refresh or shared link reopens it
	const next = url ? `/?go=${encodeURIComponent(url)}` : "/";
	if (location.pathname + location.search !== next) window.history.replaceState(null, "", next);
}

function navigate(raw) {
	const url = resolveInput(raw);
	if (!url) return;
	if (!engine) {
		pendingGo = url;
		return;
	}
	hideBanner();
	showFrame();
	currentUrl = url;
	ui.address.value = url;
	ui.address.blur();
	engine.go(url);
	history_replace(url);
}

function updateBookmarkButton() {
	ui.bookmark.classList.toggle("on", !!currentUrl && bookmarks.has(currentUrl));
	ui.bookmark.disabled = !currentUrl;
}

// ---------------------------------------------------------------------------
// engine events
// ---------------------------------------------------------------------------

const engineEvents = {
	onUrl(url) {
		if (!url || url === "about:blank") return;
		currentUrl = url;
		if (document.activeElement !== ui.address) ui.address.value = url;
		history.add(url, currentTitle);
		history_replace(url);
		updateBookmarkButton();
	},
	onTitle(title) {
		currentTitle = title || "";
		document.title = currentTitle ? `${currentTitle} | Nocturne` : "Nocturne Engine";
		if (currentUrl) history.setTitle(currentUrl, currentTitle);
	},
	onLoading: setLoading,
	onError(info) {
		// subresource failures are normal noise, only surface navigations
		if (info.destination === "document" || info.destination === "iframe") setLoading(false);
	},
	onHealth(info) {
		if (!info.looksBlank || (info.errors === 0 && info.rewriteErrors === 0)) return;
		const origin = originOf(info.url);
		showBanner(
			"this page might be broken",
			`it loaded blank with ${info.errors} script error${info.errors === 1 ? "" : "s"}` +
				(info.rewriteErrors ? ` and ${info.rewriteErrors} rewriter failure${info.rewriteErrors === 1 ? "" : "s"}` : "") +
				".",
			origin
		);
	},
	onRewriteError() {
		renderDiag();
	},
};

// ---------------------------------------------------------------------------
// recovery banner
// ---------------------------------------------------------------------------

let bannerOrigin = null;
function showBanner(title, detail, origin) {
	bannerOrigin = origin;
	$("banner-title").textContent = title;
	$("banner-detail").textContent = detail;
	const compatBtn = ui.banner.querySelector('[data-action="compat"]');
	compatBtn.textContent = engine?.isCompat(origin) ? "turn off compat mode" : "compat mode";
	compatBtn.hidden = !origin;
	ui.banner.hidden = false;
}

function hideBanner() {
	ui.banner.hidden = true;
}

ui.banner.addEventListener("click", async (e) => {
	const action = e.target.closest("[data-action]")?.dataset.action;
	if (!action) return;
	if (action === "dismiss") return hideBanner();
	if (action === "reload") {
		hideBanner();
		return engine?.reload();
	}
	if (action === "compat" && bannerOrigin) {
		const on = !engine.isCompat(bannerOrigin);
		engine.setCompat(bannerOrigin, on);
		toast(on ? `compat mode on for ${hostOf(bannerOrigin)}` : `compat mode off for ${hostOf(bannerOrigin)}`);
		hideBanner();
		renderSettings();
		return engine.reload();
	}
	if (action === "transport") {
		hideBanner();
		await switchTransport();
		engine.reload();
	}
});

async function switchTransport() {
	const next = engine.transportKind === "epoxy" ? "libcurl" : "epoxy";
	toast(`switching to ${next}`);
	try {
		await engine.setTransport(next);
		$("set-transport").value = next;
		toast(`now using ${next}`);
	} catch (err) {
		console.error(err);
		toast(`couldn't start ${next}: ${err.message}`, 4000);
	}
}

// messages from nocturne error pages inside the frame
window.addEventListener("message", async (e) => {
	if (e.origin !== location.origin || !e.data || typeof e.data.__nocturne !== "string") return;
	if (e.data.__nocturne === "home") showHome();
	if (e.data.__nocturne === "switch-transport") {
		await switchTransport();
		engine.reload();
	}
});

// ---------------------------------------------------------------------------
// home screen
// ---------------------------------------------------------------------------

function renderQuick() {
	const wrap = $("quick");
	wrap.replaceChildren(
		...QUICK_LINKS.map((q) =>
			el(
				"button",
				{ class: "quick-item glass", style: `--accent:${q.color}`, onclick: () => navigate(q.url) },
				el("span", { class: "quick-dot" }),
				q.name
			)
		)
	);
}

function linkItem(item, onRemove) {
	const li = el("li");
	const a = el(
		"button",
		{ class: "link-row", title: item.url, onclick: () => (closePanel(), navigate(item.url)) },
		favicon(item.url),
		el("span", { class: "link-text" }, el("b", {}, item.title || hostOf(item.url)), el("small", {}, item.url))
	);
	li.append(a);
	if (onRemove) li.append(el("button", { class: "icon-btn small", "aria-label": "remove", onclick: onRemove }, "✕"));
	return li;
}

function renderHomeLists() {
	const list = bookmarks.all();
	$("bookmarks-card").hidden = list.length === 0;
	$("bookmarks-list").replaceChildren(...list.slice(0, 12).map((b) => linkItem(b)));
}

// ---------------------------------------------------------------------------
// panel
// ---------------------------------------------------------------------------

function openPanel(tab = "settings") {
	ui.panel.hidden = false;
	selectTab(tab);
	requestAnimationFrame(() => ui.panel.classList.add("open"));
}

function closePanel() {
	ui.panel.classList.remove("open");
	setTimeout(() => (ui.panel.hidden = true), 200);
}

function selectTab(tab) {
	for (const b of ui.panel.querySelectorAll("[data-tab]")) b.classList.toggle("active", b.dataset.tab === tab);
	for (const body of ui.panel.querySelectorAll("[data-body]")) body.hidden = body.dataset.body !== tab;
	if (tab === "history") renderHistory();
	if (tab === "bookmarks") renderPanelBookmarks();
	if (tab === "settings") renderSettings();
	if (tab === "about") renderAbout();
}

ui.panel.querySelector(".tabs").addEventListener("click", (e) => {
	const tab = e.target.closest("[data-tab]")?.dataset.tab;
	if (tab) selectTab(tab);
});
$("panel-close").addEventListener("click", closePanel);
$("menu-btn").addEventListener("click", () => (ui.panel.hidden ? openPanel() : closePanel()));

function renderHistory() {
	const list = history.all();
	$("history-list").replaceChildren(
		...(list.length ? list.map((h) => linkItem(h)) : [el("li", { class: "empty" }, "nothing here yet")])
	);
}

function renderPanelBookmarks() {
	const list = bookmarks.all();
	$("panel-bookmarks").replaceChildren(
		...(list.length
			? list.map((b) =>
					linkItem(b, () => {
						bookmarks.remove(b.url);
						renderPanelBookmarks();
						renderHomeLists();
						updateBookmarkButton();
					})
				)
			: [el("li", { class: "empty" }, "star a page to save it here")])
	);
}

function renderSettings() {
	const s = settings.get();
	$("set-transport").value = engine?.transportKind ?? s.transport;
	$("set-adblock").checked = s.blockAds;
	$("set-rewriterlogs").checked = s.rewriterLogs;
	$("set-wisp").value = s.wispUrl;
	$("set-wisp").placeholder = defaultWispUrl();
	const search = $("set-search");
	if (!search.options.length) {
		for (const [id, eng] of Object.entries(SEARCH_ENGINES)) search.append(new Option(eng.name, id));
	}
	search.value = s.searchEngine;
	$("compat-list").replaceChildren(
		...(s.compatSites.length
			? s.compatSites.map((origin) =>
					el(
						"li",
						{ class: "chip" },
						hostOf(origin),
						el(
							"button",
							{
								class: "chip-x",
								"aria-label": `remove ${origin}`,
								onclick: () => {
									engine?.setCompat(origin, false);
									renderSettings();
								},
							},
							"✕"
						)
					)
				)
			: [el("li", { class: "muted" }, "none")])
	);
	renderDiag();
}

function renderDiag() {
	const d = engine?.diag?.();
	const box = $("diag");
	if (!d) return (box.textContent = "");
	box.replaceChildren(
		el("div", {}, `rewriter failures: ${d.rewriteErrors}, keyword glue fixes: ${d.glueFixes}, blocked requests: ${engine.blocker.blocked}`),
		...d.lastErrors
			.slice(-5)
			.reverse()
			.map((e) => el("code", {}, `${e.url}\n${e.message}`))
	);
}

function renderAbout() {
	const rows = [
		["engine", "Nocturne Engine 1.0.0"],
		["scramjet", `${versionInfo.version} (${versionInfo.build})`],
		["controller", globalThis.$scramjetController.VERSION],
		["transport", engine?.transportKind ?? settings.get().transport],
	];
	$("about-versions").replaceChildren(...rows.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]));
}

$("set-transport").addEventListener("change", async (e) => {
	const kind = e.target.value;
	if (!engine || kind === engine.transportKind) return;
	try {
		await engine.setTransport(kind);
		toast(`now using ${kind}`);
	} catch (err) {
		toast(`couldn't start ${kind}: ${err.message}`, 4000);
		e.target.value = engine.transportKind;
	}
});
$("set-search").addEventListener("change", (e) => settings.set({ searchEngine: e.target.value }));
$("set-adblock").addEventListener("change", (e) => settings.set({ blockAds: e.target.checked }));
$("set-rewriterlogs").addEventListener("change", (e) => settings.set({ rewriterLogs: e.target.checked }));
$("set-wisp").addEventListener("change", (e) => {
	const v = e.target.value.trim();
	if (v && (!/^wss?:\/\//.test(v) || !v.endsWith("/"))) {
		toast("wisp url must start with ws:// or wss:// and end with /", 4000);
		e.target.value = settings.get().wispUrl;
		return;
	}
	settings.set({ wispUrl: v });
	toast("wisp server saved, reload to apply");
});
$("clear-history").addEventListener("click", () => {
	history.clear();
	renderHistory();
});
$("clear-data").addEventListener("click", async () => {
	if (!confirm("clear cookies, cache and storage for every proxied site? you'll be logged out everywhere.")) return;
	await engine?.clearData();
	toast("proxied site data cleared");
});
$("about-link").addEventListener("click", () => openPanel("about"));

// ---------------------------------------------------------------------------
// bar
// ---------------------------------------------------------------------------

ui.omnibox.addEventListener("submit", (e) => {
	e.preventDefault();
	navigate(ui.address.value);
});
$("hero-form").addEventListener("submit", (e) => {
	e.preventDefault();
	navigate($("hero-input").value);
	$("hero-input").value = "";
});
ui.address.addEventListener("focus", () => ui.address.select());
$("back").addEventListener("click", () => engine?.back());
$("forward").addEventListener("click", () => engine?.forward());
$("reload").addEventListener("click", () => (currentUrl ? engine?.reload() : null));
$("home").addEventListener("click", showHome);
$("newtab").addEventListener("click", () => {
	if (!currentUrl) return toast("open a page first");
	window.open(`/?go=${encodeURIComponent(currentUrl)}`, "_blank", "noopener");
});
ui.bookmark.addEventListener("click", () => {
	if (!currentUrl) return;
	const added = bookmarks.toggle(currentUrl, currentTitle);
	toast(added ? "bookmarked" : "bookmark removed");
	updateBookmarkButton();
	renderHomeLists();
});

document.addEventListener("keydown", (e) => {
	if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") {
		e.preventDefault();
		ui.address.focus();
	}
	if (e.key === "Escape") {
		if (!ui.panel.hidden) closePanel();
		else if (document.activeElement === ui.address) {
			ui.address.value = currentUrl;
			ui.address.blur();
		}
	}
});

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

async function boot() {
	renderQuick();
	renderHomeLists();
	$("engine-version").textContent = `Nocturne Engine · scramjet ${versionInfo.version}`;

	const go = new URLSearchParams(location.search).get("go");
	if (go) pendingGo = resolveInput(go);

	try {
		engine = await createEngine(ui.frame, engineEvents, (s) => (ui.bootStatus.textContent = s));
	} catch (err) {
		console.error("[nocturne] boot failed", err);
		ui.bootStatus.textContent = `couldn't start the engine: ${err.message}`;
		ui.boot.classList.add("failed");
		return;
	}

	ui.boot.classList.add("done");
	setTimeout(() => (ui.boot.hidden = true), 250);

	if (pendingGo) {
		const target = pendingGo;
		pendingGo = null;
		navigate(target);
	} else {
		showHome();
	}
}

boot();
