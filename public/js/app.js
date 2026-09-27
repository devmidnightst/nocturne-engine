import { createEngine, versionInfo } from "./engine.js";
import { resolveInput } from "./omnibox.js";
import { settings, bookmarks, history, session, icons, SEARCH_ENGINES, defaultServerUrl } from "./store.js";

const nestedInShell = (() => {
	if (window.self === window.top) return false;
	try {
		if (window.top.location.origin !== location.origin) return false;
		const adopt = window.top.__nc_a3c8;
		if (typeof adopt === "function" && adopt(window.frameElement, new URLSearchParams(location.search).get("go"))) return true;
		window.top.location.replace(location.href);
		return true;
	} catch {
		return false;
	}
})();

const $ = (id) => document.getElementById(id);

const ui = {
	sidebar: $("sidebar"),
	address: $("address"),
	omnibox: $("omnibox"),
	progress: $("progress"),
	bookmark: $("bookmark"),
	homeView: $("home-view"),
	frames: $("frames"),
	boot: $("boot"),
	bootStatus: $("boot-status"),
	panel: $("panel"),
	banner: $("banner"),
	toast: $("toast"),
	tabList: $("tab-list"),
	essentials: $("essentials-grid"),
	tabCount: $("tab-count"),
	mobileUrl: $("mobile-url"),
	scrim: $("scrim"),
	edge: $("edge"),
};


const LEGACY_CURRENT_KEY = "_p8q2:current";
const FRAME_ALLOW =
	"fullscreen; clipboard-read; clipboard-write; autoplay; encrypted-media; picture-in-picture; microphone; camera; display-capture";

let engine = null;
const tabs = [];
let active = null;

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

function icon(path) {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
	p.setAttribute("d", path);
	svg.append(p);
	return svg;
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
	const host = hostOf(url);
	const cached = icons.get(host);
	if (cached?.data) return el("span", { class: "fav img" }, el("img", { src: cached.data, alt: "" }));
	return el("span", { class: "fav" }, (host[0] || "?").toUpperCase());
}

const iconJobs = new Map();
function loadIcon(pageUrl, src) {
	const host = hostOf(pageUrl);
	if (!engine || !host || !src) return;
	const cached = icons.get(host);
	if (cached && (cached.src === src || iconJobs.get(host) === src)) return;
	if (iconJobs.has(host)) return;
	iconJobs.set(host, src);
	engine
		.fetchIcon(src)
		.then((data) => {
			if (data) icons.set(host, src, data);
			else if (!cached) icons.set(host, src, null);
			if (!data) return;
			scheduleRender();
			const open = ui.panel.hidden ? null : ui.panel.querySelector("[data-tab].active")?.dataset.tab;
			if (open === "history") renderHistory();
			if (open === "bookmarks") renderPanelBookmarks();
		})
		.finally(() => iconJobs.delete(host));
}

function prefetchIcons() {
	const urls = [...bookmarks.all().map((b) => b.url), ...tabs.map((t) => t.url)].filter((u) => /^https?:/.test(u));
	for (const url of new Set(urls)) {
		if (!icons.get(hostOf(url))) loadIcon(url, new URL("/favicon.ico", url).href);
	}
}

let idSeq = 0;
const newId = () => `${Date.now().toString(36)}${(idSeq++).toString(36)}`;

function makeTab({ id, url = "", title = "" } = {}) {
	return { id: id || newId(), url, title, iframe: null, handle: null, loading: false, health: null, openerId: null };
}

const tabLabel = (tab) => tab.title || (tab.url ? hostOf(tab.url) : "new tab");

let saveTimer = null;
function writeSession() {
	clearTimeout(saveTimer);
	saveTimer = null;
	session.save({
		tabs: tabs.map(({ id, url, title }) => ({ id, url, title })),
		active: active?.id ?? null,
	});
}

function saveSession() {
	saveTimer ??= setTimeout(writeSession, 100);
}

function restoreSession() {
	const saved = session.load();
	if (saved && Array.isArray(saved.tabs)) {
		for (const t of saved.tabs) {
			if (t && typeof t.url === "string") tabs.push(makeTab(t));
		}
	}
	if (!tabs.length) {
		let legacy = null;
		try {
			legacy = sessionStorage.getItem(LEGACY_CURRENT_KEY);
			sessionStorage.removeItem(LEGACY_CURRENT_KEY);
		} catch {
		}
		if (legacy) tabs.push(makeTab({ url: legacy }));
	}
	return tabs.find((t) => t.id === saved?.active) ?? null;
}

let renderQueued = false;
function scheduleRender() {
	if (renderQueued) return;
	renderQueued = true;
	requestAnimationFrame(() => {
		renderQueued = false;
		renderTabs();
		renderEssentials();
	});
}

function renderTabs() {
	ui.tabList.replaceChildren(
		...tabs.map((tab) =>
			el(
				"li",
				{
					class: `tab-row${tab === active ? " active" : ""}${tab.loading ? " loading" : ""}`,
					role: "tab",
					"aria-selected": String(tab === active),
					draggable: "true",
					title: tab.url || "new tab",
					"data-id": tab.id,
				},
				tab.loading ? el("span", { class: "fav spinner" }) : tab.url ? favicon(tab.url) : el("span", { class: "fav img blank" }, el("img", { src: "/img/logo.svg", alt: "" })),
				el("span", { class: "tab-title" }, tabLabel(tab)),
				el("button", { class: "tab-close", "aria-label": `close ${tabLabel(tab)}`, "data-close": tab.id }, icon("M6 6l12 12M18 6L6 18"))
			)
		)
	);
	ui.tabCount.textContent = tabs.length === 1 ? "1 tab" : `${tabs.length} tabs`;
	$("open-sidebar").setAttribute("aria-label", `show tabs (${tabs.length})`);
	$("mobile-count").textContent = String(Math.min(tabs.length, 99));
}

function renderEssentials() {
	const list = bookmarks.all();
	if (!list.length) {
		ui.essentials.replaceChildren(el("p", { class: "side-hint" }, "star a page to pin it here"));
		return;
	}
	const openUrls = new Set(tabs.map((t) => t.url));
	ui.essentials.replaceChildren(
		...list.slice(0, 24).map((b) =>
			el(
				"button",
				{
					class: `essential${openUrls.has(b.url) ? " open" : ""}${active?.url === b.url ? " current" : ""}`,
					title: `${b.title || hostOf(b.url)}\n${b.url}`,
					onclick: () => openBookmark(b.url),
				},
				favicon(b.url),
				el("span", {}, b.title || hostOf(b.url))
			)
		)
	);
}

function openBookmark(url) {
	const existing = tabs.find((t) => t.url === url);
	if (existing) return activate(existing);
	if (active && !active.url) return navigate(url);
	navigate(url, { newTab: true });
}

let loadingTimer;
function setLoading(on) {
	ui.progress.classList.toggle("active", on);
	clearTimeout(loadingTimer);
	if (on) loadingTimer = setTimeout(() => ui.progress.classList.remove("active"), 30_000);
}

function updateBookmarkButton() {
	const url = active?.url;
	ui.bookmark.classList.toggle("on", !!url && bookmarks.has(url));
	ui.bookmark.disabled = !url;
}

function syncChrome() {
	const url = active?.url ?? "";
	if (document.activeElement !== ui.address) ui.address.value = url;
	ui.mobileUrl.textContent = url ? hostOf(url) : "search or type a url";
	document.title = active?.url && active.title ? `${active.title} | Umbrella` : "Umbrella";
	setLoading(!!active?.loading);
	updateBookmarkButton();
	for (const id of ["back", "forward", "reload"]) $(id).disabled = !active?.handle || !url;
}

function ensureFrame(tab) {
	if (tab.handle) return tab.handle;
	const iframe = el("iframe", {
		class: "tab-frame",
		id: `frame-${tab.id}`,
		title: "Umbrella viewport",
		allow: FRAME_ALLOW,
		allowfullscreen: "",
	});
	ui.frames.append(iframe);
	tab.iframe = iframe;
	tab.handle = engine.createTab(iframe, tabEvents(tab));
	return tab.handle;
}

function showFrames() {
	for (const t of tabs) {
		if (!t.iframe) continue;
		const shown = t === active && !!t.url;
		t.iframe.classList.toggle("active", shown);
		t.iframe.id = t === active ? "frame" : `frame-${t.id}`;
	}
	ui.homeView.hidden = !!active?.url;
}

function activate(tab) {
	if (!tab) return;
	const changed = active !== tab;
	active = tab;
	if (tab.url && !tab.handle && engine) {
		ensureFrame(tab).go(tab.url);
	}
	showFrames();
	if (changed) {
		hideBanner();
		if (tab.health) showHealth(tab.health);
	}
	syncChrome();
	scheduleRender();
	saveSession();
	closeDrawer();
	if (!tab.url) $("hero-input").focus({ preventScroll: true });
}

function openTab(url, { opener = null, background = false } = {}) {
	const tab = makeTab();
	const after = opener ?? active;
	let i = after ? tabs.indexOf(after) + 1 : tabs.length;
	if (opener) {
		while (tabs[i] && tabs[i].openerId === opener.id) i++;
		tab.openerId = opener.id;
	}
	tabs.splice(i, 0, tab);
	if (!url) activate(tab);
	else if (background && engine) {
		tab.url = url;
		ensureFrame(tab).go(url);
		scheduleRender();
		saveSession();
	} else navigate(url, { tab });
	return tab;
}

function closeTab(tab) {
	const i = tabs.indexOf(tab);
	if (i === -1) return;
	tab.handle?.destroy();
	tabs.splice(i, 1);
	if (!tabs.length) tabs.push(makeTab());
	if (tab === active) {
		active = null;
		activate(tabs.find((t) => t.id === tab.openerId) ?? tabs[Math.min(i, tabs.length - 1)]);
	} else {
		scheduleRender();
		saveSession();
	}
}

function navigate(raw, { tab, newTab = false } = {}) {
	const url = resolveInput(raw);
	if (!url || !engine) return;
	if (newTab) {
		tab = makeTab();
		tabs.splice(active ? tabs.indexOf(active) + 1 : tabs.length, 0, tab);
	}
	tab ??= active ?? openTab();
	tab.url = url;
	tab.title = "";
	tab.health = null;
	ensureFrame(tab).go(url);
	ui.address.blur();
	activate(tab);
}

function showHome(tab = active) {
	if (!tab) return;
	tab.url = "";
	tab.title = "";
	tab.health = null;
	tab.loading = false;
	tab.handle?.blank();
	if (tab === active) {
		hideBanner();
		ui.address.value = "";
	}
	activate(tab);
}

function tabEvents(tab) {
	const setTabLoading = (on) => {
		tab.loading = on;
		scheduleRender();
		if (tab === active) setLoading(on);
	};
	return {
		onUrl(url) {
			if (!url || url === "about:blank") return;
			tab.url = url;
			history.add(url, tab.title);
			if (tab === active) syncChrome();
			scheduleRender();
			saveSession();
		},
		onTitle(title) {
			tab.title = title || "";
			if (tab.url) history.setTitle(tab.url, tab.title);
			if (tab === active) document.title = tab.title ? `${tab.title} | Umbrella` : "Umbrella";
			scheduleRender();
			saveSession();
		},
		onLoading: setTabLoading,
		onIcon(src) {
			if (tab.url) loadIcon(tab.url, src);
		},
		onOpen(url, { background = false } = {}) {
			if (tabs.includes(tab)) openTab(url, { opener: tab, background });
		},
		onError(info) {
			if (info.destination === "document" || info.destination === "iframe") setTabLoading(false);
		},
		onHealth(info) {
			if (!info.looksBlank || (info.errors === 0 && info.rewriteErrors === 0)) return;
			tab.health = info;
			if (tab === active) showHealth(info);
		},
	};
}

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

function showHealth(info) {
	showBanner(
		"this page might be broken",
		`it loaded blank with ${info.errors} script error${info.errors === 1 ? "" : "s"}` +
			(info.rewriteErrors ? ` and ${info.rewriteErrors} rewriter failure${info.rewriteErrors === 1 ? "" : "s"}` : "") +
			".",
		originOf(info.url)
	);
}

function hideBanner() {
	ui.banner.hidden = true;
}

function reloadActive() {
	if (active?.url && active.handle) {
		active.health = null;
		active.handle.reload();
	}
}

ui.banner.addEventListener("click", async (e) => {
	const action = e.target.closest("[data-action]")?.dataset.action;
	if (!action) return;
	if (action === "dismiss") {
		if (active) active.health = null;
		return hideBanner();
	}
	hideBanner();
	if (action === "reload") return reloadActive();
	if (action === "compat" && bannerOrigin) {
		const on = !engine.isCompat(bannerOrigin);
		engine.setCompat(bannerOrigin, on);
		toast(on ? `compat mode on for ${hostOf(bannerOrigin)}` : `compat mode off for ${hostOf(bannerOrigin)}`);
		renderSettings();
		return reloadActive();
	}
	if (action === "transport") {
		await switchTransport();
		reloadActive();
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

window.addEventListener("message", async (e) => {
	if (e.origin !== location.origin || !e.data || typeof e.data.__nc_m9d1 !== "string") return;
	const tab = tabs.find((t) => t.iframe && t.iframe.contentWindow === e.source) ?? active;
	if (e.data.__nc_m9d1 === "home") showHome(tab);
	if (e.data.__nc_m9d1 === "switch-transport") {
		await switchTransport();
		tab?.handle?.reload();
	}
});

ui.tabList.addEventListener("click", (e) => {
	const closeId = e.target.closest("[data-close]")?.dataset.close;
	if (closeId) {
		e.stopPropagation();
		return closeTab(tabs.find((t) => t.id === closeId));
	}
	const id = e.target.closest(".tab-row")?.dataset.id;
	if (id) activate(tabs.find((t) => t.id === id));
});
ui.tabList.addEventListener("auxclick", (e) => {
	if (e.button !== 1) return;
	const id = e.target.closest(".tab-row")?.dataset.id;
	if (id) {
		e.preventDefault();
		closeTab(tabs.find((t) => t.id === id));
	}
});

let dragId = null;
ui.tabList.addEventListener("dragstart", (e) => {
	dragId = e.target.closest(".tab-row")?.dataset.id ?? null;
	if (dragId) e.dataTransfer.effectAllowed = "move";
});
ui.tabList.addEventListener("dragover", (e) => {
	if (!dragId) return;
	e.preventDefault();
	const row = e.target.closest(".tab-row");
	for (const r of ui.tabList.children) r.classList.remove("drop-before", "drop-after");
	if (!row || row.dataset.id === dragId) return;
	const box = row.getBoundingClientRect();
	row.classList.add(e.clientY < box.top + box.height / 2 ? "drop-before" : "drop-after");
});
ui.tabList.addEventListener("drop", (e) => {
	if (!dragId) return;
	e.preventDefault();
	const row = e.target.closest(".tab-row");
	const from = tabs.findIndex((t) => t.id === dragId);
	if (row && row.dataset.id !== dragId && from !== -1) {
		const [moved] = tabs.splice(from, 1);
		const box = row.getBoundingClientRect();
		let to = tabs.findIndex((t) => t.id === row.dataset.id);
		if (e.clientY >= box.top + box.height / 2) to++;
		tabs.splice(to, 0, moved);
		saveSession();
	}
	dragId = null;
	scheduleRender();
});
ui.tabList.addEventListener("dragend", () => {
	dragId = null;
	scheduleRender();
});

function applySidebarState() {
	document.body.classList.toggle("collapsed", !!settings.get().sidebarCollapsed);
	const label = settings.get().sidebarCollapsed ? "show sidebar" : "hide sidebar";
	$("collapse").title = label;
	$("collapse").setAttribute("aria-label", label);
}

$("collapse").addEventListener("click", () => {
	document.body.classList.remove("peek");
	settings.set({ sidebarCollapsed: !settings.get().sidebarCollapsed });
	applySidebarState();
});
ui.edge.addEventListener("mouseenter", () => document.body.classList.add("peek"));
ui.sidebar.addEventListener("mouseleave", () => {
	if (document.activeElement && ui.sidebar.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;
	document.body.classList.remove("peek");
});

function openDrawer() {
	document.body.classList.add("drawer");
	ui.scrim.hidden = false;
}

function closeDrawer() {
	document.body.classList.remove("drawer");
	ui.scrim.hidden = true;
}

$("open-sidebar").addEventListener("click", openDrawer);
ui.scrim.addEventListener("click", closeDrawer);
ui.mobileUrl.addEventListener("click", () => {
	openDrawer();
	ui.address.focus();
});
$("mobile-new-tab").addEventListener("click", () => openTab());
$("new-tab").addEventListener("click", () => openTab());


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
$("menu-btn").addEventListener("click", () => {
	closeDrawer();
	ui.panel.hidden ? openPanel() : closePanel();
});

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
						renderEssentials();
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
	$("set-wisp").value = s._srvUrl;
	$("set-wisp").placeholder = defaultServerUrl();
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
		el("div", {}, `rewriter failures: ${d.rewriteErrors}, keyword glue fixes: ${d.glueFixes}, blocked requests: ${engine.blocked}`),
		...d.lastErrors
			.slice(-5)
			.reverse()
			.map((e) => el("code", {}, `${e.url}\n${e.message}`))
	);
}

function renderAbout() {
	const rows = [
		["version", "Umbrella 1.0.0"],
		["engine", `${versionInfo.version} (${versionInfo.build})`],
		["runtime", globalThis[atob("JHNjcmFtamV0Q29udHJvbGxlcg==")]?.VERSION],
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
		toast("server url must start with ws:// or wss:// and end with /", 4000);
		e.target.value = settings.get()._srvUrl;
		return;
	}
	settings.set({ _srvUrl: v });
	toast("server saved, reload to apply");
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

ui.omnibox.addEventListener("submit", (e) => {
	e.preventDefault();
	navigate(ui.address.value);
	closeDrawer();
});
$("hero-form").addEventListener("submit", (e) => {
	e.preventDefault();
	navigate($("hero-input").value);
	$("hero-input").value = "";
});
ui.address.addEventListener("focus", () => ui.address.select());
$("back").addEventListener("click", () => active?.handle?.back());
$("forward").addEventListener("click", () => active?.handle?.forward());
$("reload").addEventListener("click", reloadActive);
$("home").addEventListener("click", () => showHome());
$("newtab").addEventListener("click", () => {
	if (!active?.url) return toast("open a page first");
	window.open(`/?go=${encodeURIComponent(active.url)}`, "_blank", "noopener");
});
ui.bookmark.addEventListener("click", () => {
	if (!active?.url) return;
	const added = bookmarks.toggle(active.url, active.title);
	toast(added ? "bookmarked" : "bookmark removed");
	updateBookmarkButton();
	renderEssentials();
});

document.addEventListener("keydown", (e) => {
	if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") {
		e.preventDefault();
		if (window.matchMedia("(max-width: 640px)").matches) openDrawer();
		else if (settings.get().sidebarCollapsed) document.body.classList.add("peek");
		ui.address.focus();
	}
	if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "t") {
		e.preventDefault();
		openTab();
	}
	if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "w") {
		e.preventDefault();
		if (active) closeTab(active);
	}
	if (e.key === "Escape") {
		if (!ui.panel.hidden) closePanel();
		else if (document.activeElement === ui.address) {
			ui.address.value = active?.url ?? "";
			ui.address.blur();
		} else closeDrawer();
	}
});

window.addEventListener("pagehide", () => {
	if (saveTimer) writeSession();
});

window.__nc_a3c8 = (frameEl, go) => {
	const tab = tabs.find((t) => t.iframe && t.iframe === frameEl);
	if (!tab || !engine) return false;
	const target = go ? resolveInput(go) : null;
	setTimeout(() => (target ? navigate(target, { tab }) : showHome(tab)));
	return true;
};

function cleanAddressBar() {
	if (location.pathname + location.search + location.hash !== "/") window.history.replaceState(null, "", "/");
}

async function boot() {
	applySidebarState();

	const go = new URLSearchParams(location.search).get("go");
	cleanAddressBar();
	const restoredActive = restoreSession();
	renderTabs();
	renderEssentials();

	try {
		engine = await createEngine({ onRewriteError: () => renderDiag() }, (s) => (ui.bootStatus.textContent = s));
	} catch (err) {
		console.error("[umbrella] boot failed", err);
		ui.bootStatus.textContent = `couldn't start the engine: ${err.message}`;
		ui.boot.classList.add("failed");
		return;
	}

	ui.boot.classList.add("done");
	setTimeout(() => (ui.boot.hidden = true), 250);
	(window.requestIdleCallback ?? setTimeout)(prefetchIcons, { timeout: 3000 });

	const target = go ? resolveInput(go) : null;
	if (target) {
		const tab = makeTab();
		tabs.push(tab);
		navigate(target, { tab });
	} else if (tabs.length) {
		activate(restoredActive ?? tabs[tabs.length - 1]);
	} else {
		openTab();
	}
}

if (!nestedInShell) boot();
