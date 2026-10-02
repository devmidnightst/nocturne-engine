import { createEngine, versionInfo } from "./engine.js";
import { resolveInput } from "./omnibox.js";
import { settings, bookmarks, history, session, icons, SEARCH_ENGINES } from "./store.js";
import { _nrc, _nrp } from "./net-resolver.js";

_nrp().catch(() => {});

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
	bootStatus: $("bs-0"),
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

function makeTab({ id, url = "", title = "", type = "browser" } = {}) {
	return { id: id || newId(), url, title, iframe: null, handle: null, loading: false, health: null, openerId: null, type, gameId: null, gameImg: null, aiDiv: null, messages: null };
}

function makeGameTab(game) {
	const tab = makeTab({ title: game.name, type: "game" });
	tab.gameId = game.id;
	tab.loading = true;
	if (game.image_token && typeof Lumin !== "undefined") {
		Lumin.getImageUrl(game.image_token).then((url) => { tab.gameImg = url; scheduleRender(); }).catch(() => {});
	}
	return tab;
}

function makeAiTab() {
	const tab = makeTab({ title: "AI", type: "ai" });
	tab.messages = [];
	return tab;
}

function makeGamesTab() {
	return makeTab({ title: "games", type: "games" });
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
				tab.loading ? el("span", { class: "fav spinner" })
					: tab.type === "ai" ? el("span", { class: "fav ai-fav" }, "✦")
					: tab.type === "games" ? el("span", { class: "fav games-fav" }, "▦")
					: tab.type === "game" ? (tab.gameImg ? el("span", { class: "fav img" }, el("img", { src: tab.gameImg, alt: "" })) : el("span", { class: "fav" }, "▶"))
					: tab.url ? favicon(tab.url) : el("span", { class: "fav img blank" }, el("img", { src: "/img/logo.svg", alt: "" })),
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
	const isBrowser = !active?.type || active?.type === "browser";
	ui.bookmark.classList.toggle("on", isBrowser && !!url && bookmarks.has(url));
	ui.bookmark.disabled = !isBrowser || !url;
}

function syncChrome() {
	const url = active?.url ?? "";
	const isSpecial = active?.type === "game" || active?.type === "ai" || active?.type === "games";
	if (document.activeElement !== ui.address) {
		if (active?.type === "ai") ui.address.value = "AI";
		else if (active?.type === "games") ui.address.value = "games";
		else if (active?.type === "game") ui.address.value = active.title;
		else ui.address.value = url;
	}
	ui.mobileUrl.textContent = active?.type === "ai" ? "AI"
		: active?.type === "games" ? "games"
		: active?.type === "game" ? active.title
		: (url ? hostOf(url) : "search or type a url");
	document.title = "Browse";
	setLoading(!!active?.loading);
	updateBookmarkButton();
	for (const id of ["back", "forward", "reload"]) $(id).disabled = isSpecial || !active?.handle || !url;
}

function ensureFrame(tab) {
	if (tab.type === "game") { _startGameFrame(tab); return null; }
	if (tab.type === "ai") { if (!tab.aiDiv) _createAiDiv(tab); return null; }
	if (tab.handle) return tab.handle;
	const iframe = el("iframe", {
		class: "tab-frame",
		id: `frame-${tab.id}`,
		title: "viewport",
		allow: FRAME_ALLOW,
		allowfullscreen: "",
	});
	ui.frames.append(iframe);
	tab.iframe = iframe;
	tab.handle = engine.createTab(iframe, tabEvents(tab));
	return tab.handle;
}

async function _startGameFrame(tab) {
	if (tab.iframe) return;
	tab.loading = true;
	tab.aiDiv?.remove();
	tab.aiDiv = null;
	scheduleRender();
	try {
		if (!(await _ensureLumin())) throw new Error("lumin");
		const res = await Promise.race([
			Lumin.getGameUrl(tab.gameId),
			new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 20000)),
		]);
		const url = typeof res === "string" ? res : res?.url;
		if (!url) throw new Error("no url");
		if (!tabs.includes(tab) || tab.iframe) return;
		const iframe = el("iframe", {
			class: "tab-frame",
			id: `frame-${tab.id}`,
			title: tab.title,
			allow: "autoplay; fullscreen; pointer-lock; gamepad; clipboard-read; clipboard-write; keyboard-map; accelerometer; gyroscope",
			allowfullscreen: "",
		});
		iframe.src = url;
		ui.frames.append(iframe);
		tab.iframe = iframe;
		tab.loading = false;
		showFrames();
		scheduleRender();
	} catch {
		tab.loading = false;
		if (tabs.includes(tab)) _gameError(tab);
		scheduleRender();
	}
}

function _gameError(tab) {
	const retry = el("button", { class: "games-browser-more" }, "try again");
	const div = el("div", { class: "tab-frame games-browser-frame game-error" },
		el("p", { class: "games-browser-status" }, `couldn't load ${tab.title || "this game"}`),
		retry,
	);
	retry.addEventListener("click", () => {
		if (tab._gameStarting) return;
		tab._gameStarting = true;
		_startGameFrame(tab).then(() => { tab._gameStarting = false; });
	});
	ui.frames.append(div);
	tab.aiDiv = div;
	showFrames();
}

function showFrames() {
	for (const t of tabs) {
		if (t.iframe) {
			const shown = t === active && (!!t.url || t.type === "game");
			t.iframe.classList.toggle("active", shown);
			t.iframe.id = t === active ? "frame" : `frame-${t.id}`;
		}
		if (t.aiDiv) {
			t.aiDiv.classList.toggle("active", t === active);
		}
	}
	const isSpecial = active?.type === "game" || active?.type === "ai" || active?.type === "games";
	ui.homeView.hidden = (!!active?.url && !!engine) || isSpecial;
}

function activate(tab) {
	if (!tab) return;
	const changed = active !== tab;
	active = tab;
	if (tab.type === "game") {
		if (!tab.iframe && !tab._gameStarting) { tab._gameStarting = true; _startGameFrame(tab).then(() => { tab._gameStarting = false; }); }
	} else if (tab.type === "ai") {
		if (!tab.aiDiv) _createAiDiv(tab);
	} else if (tab.type === "games") {
		if (!tab.aiDiv) _createGamesDiv(tab);
	} else if (tab.url && !tab.handle && engine) {
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
	if (!tab.url && tab.type === "browser") $("hero-input").focus({ preventScroll: true });
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
	const row = ui.tabList.querySelector(`[data-id="${tab.id}"]`);
	const finish = () => {
		tab.aiDiv?.remove();
		tab.handle?.destroy();
		tab.iframe?.remove();
		tabs.splice(tabs.indexOf(tab), 1);
		if (!tabs.length) tabs.push(makeTab());
		if (tab === active) {
			active = null;
			activate(tabs.find((t) => t.id === tab.openerId) ?? tabs[Math.min(i, tabs.length - 1)]);
		} else {
			scheduleRender();
			saveSession();
		}
	};
	if (row) {
		row.classList.add("closing");
		row.addEventListener("animationend", finish, { once: true });
	} else {
		finish();
	}
}

function navigate(raw, { tab, newTab = false } = {}) {
	const url = resolveInput(raw);
	if (!url) return;
	if (!engine) { toast("engine is still starting up — try again in a moment"); return; }
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
	if (action === "mode") {
		await _sT();
		reloadActive();
	}
});

async function _sT() {
	const next = engine._tK === "ep" ? "lc" : "ep";
	toast(`switching to ${next}`);
	try {
		await engine._sT(next);
		$("cfg-e1").value = next;
		toast(`now using ${next}`);
	} catch (err) {
		console.error(err);
		toast(`couldn't start ${next}: ${err.message}`, 4000);
	}
}

window.addEventListener("message", async (e) => {
	if (e.origin !== location.origin || !e.data || typeof e.data._m9k !== "string") return;
	const tab = tabs.find((t) => t.iframe && t.iframe.contentWindow === e.source) ?? active;
	if (e.data._m9k === "home") showHome(tab);
	if (e.data._m9k === "_m9-st") {
		await _sT();
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
	tabIndicator.style.transition = "none";
	selectTab(tab);
	requestAnimationFrame(() => {
		ui.panel.classList.add("open");
		requestAnimationFrame(() => { tabIndicator.style.transition = ""; });
	});
}

function closePanel() {
	ui.panel.classList.remove("open");
	setTimeout(() => (ui.panel.hidden = true), 200);
}

const tabOrder = ["settings", "history", "bookmarks", "account", "about"];
const tabIndicator = $("tab-indicator");

function moveIndicator(btn) {
	if (!btn) return;
	const nav = btn.parentElement;
	const navRect = nav.getBoundingClientRect();
	const btnRect = btn.getBoundingClientRect();
	tabIndicator.style.left = (btnRect.left - navRect.left) + "px";
	tabIndicator.style.width = btnRect.width + "px";
}

function selectTab(tab) {
	const idx = tabOrder.indexOf(tab);
	if (idx === -1) return;
	const buttons = ui.panel.querySelectorAll("[data-tab]");
	let activeBtn = null;
	for (const b of buttons) {
		const isActive = b.dataset.tab === tab;
		b.classList.toggle("active", isActive);
		if (isActive) activeBtn = b;
	}
	const bodies = ui.panel.querySelectorAll("[data-body]");
	for (const body of bodies) {
		body.style.transform = `translateX(-${idx * 100}%)`;
		body.style.opacity = body.dataset.body === tab ? "1" : "0";
		body.style.pointerEvents = body.dataset.body === tab ? "" : "none";
	}
	requestAnimationFrame(() => moveIndicator(activeBtn));
	if (tab === "history") renderHistory();
	if (tab === "bookmarks") renderPanelBookmarks();
	if (tab === "settings") renderSettings();
	if (tab === "about") renderAbout();
	if (tab === "account") renderAccount();
}

let _luminReady = false;

async function _ensureLumin() {
	if (_luminReady) return true;
	if (typeof Lumin === "undefined") return false;
	try {
		await Lumin.init({ headless: true });
		_luminReady = true;
		return true;
	} catch { return false; }
}

const _G_LIMIT = 60;

async function _gTabLoadPage(tab, page) {
	const grid = tab._gGrid;
	const more = tab._gMore;
	const status = tab._gStatus;
	if (!grid) return;
	if (page === 1) {
		tab._gGen = (tab._gGen || 0) + 1;
		tab._gSeen = new Set();
		tab._gDone = false;
		tab._gBusy = false;
	}
	if (tab._gBusy || tab._gDone) return;
	const gen = tab._gGen;
	const query = tab._gQuery;
	tab._gBusy = true;
	if (more) more.hidden = true;
	if (status && page === 1) status.textContent = "loading...";
	try {
		const opts = { page, limit: _G_LIMIT };
		if (query) opts.q = query;
		const result = await Lumin.getGames(opts);
		if (gen !== tab._gGen) return;
		const games = Array.isArray(result?.games) ? result.games : [];
		if (page === 1) grid.replaceChildren();
		let added = 0;
		for (const g of games) {
			if (!g || g.id == null || tab._gSeen.has(g.id)) continue;
			tab._gSeen.add(g.id);
			grid.append(_gCard(g, tab));
			added++;
		}
		tab._gPage = page;
		const pages = Number(result?.pages);
		const total = Number(result?.total);
		if (Number.isFinite(pages) && pages > 0) tab._gDone = page >= pages;
		else if (Number.isFinite(total) && total > 0) tab._gDone = tab._gSeen.size >= total;
		else tab._gDone = games.length === 0;
		if (!added) tab._gDone = true;
		if (!query && Number.isFinite(total) && total > 0 && tab._gSearch) tab._gSearch.placeholder = `search ${total.toLocaleString()} games...`;
		if (status) status.textContent = tab._gSeen.size ? "" : "no games found";
		tab._gBusy = false;
		if (more) more.hidden = tab._gDone;
		_gFill(tab);
	} catch {
		if (gen !== tab._gGen) return;
		tab._gBusy = false;
		if (page === 1) {
			if (status) status.textContent = "couldn't load games";
			if (more) { more.textContent = "try again"; more.hidden = false; }
		} else if (more) {
			more.textContent = "couldn't load more, try again";
			more.hidden = false;
		}
		tab._gRetry = page;
		return;
	}
	if (more) more.textContent = "load more";
	tab._gRetry = 0;
}

function _gFill(tab) {
	const grid = tab._gGrid;
	if (!grid || tab._gDone || tab._gBusy || !tab.aiDiv?.classList.contains("active")) return;
	if (grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 800) _gTabLoadPage(tab, tab._gPage + 1);
}

function _createGamesDiv(tab) {
	const div = el("div", { class: "tab-frame games-browser-frame" });

	const header = el("div", { class: "games-browser-header" });
	const search = el("input", {
		class: "games-browser-search",
		type: "search",
		placeholder: "search games...",
		autocomplete: "off",
		spellcheck: "false",
	});
	header.append(search);

	const status = el("p", { class: "games-browser-status" }, "loading...");
	const grid = el("div", { class: "games-browser-grid" });
	const more = el("button", { class: "games-browser-more" }, "load more");
	more.hidden = true;

	div.append(header, status, grid, more);

	tab.aiDiv = div;
	tab._gGrid = grid;
	tab._gMore = more;
	tab._gStatus = status;
	tab._gSearch = search;
	tab._gPage = 0;
	tab._gQuery = "";
	tab._gImgs = typeof IntersectionObserver === "function"
		? new IntersectionObserver((entries) => {
			for (const e of entries) {
				if (!e.isIntersecting) continue;
				tab._gImgs.unobserve(e.target);
				e.target._gLoadImg?.();
			}
		}, { root: grid, rootMargin: "400px 0px" })
		: null;

	let searchTimer;
	search.addEventListener("input", () => {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			const q = search.value.trim();
			if (q === tab._gQuery) return;
			tab._gQuery = q;
			grid.scrollTop = 0;
			if (_luminReady) _gTabLoadPage(tab, 1);
		}, 300);
	});
	grid.addEventListener("scroll", () => _gFill(tab), { passive: true });
	more.addEventListener("click", () => {
		if (!_luminReady) return _gStart(tab);
		if (tab._gRetry) return _gTabLoadPage(tab, tab._gRetry);
		_gTabLoadPage(tab, tab._gPage + 1);
	});
	new ResizeObserver(() => _gFill(tab)).observe(grid);

	ui.frames.append(div);

	_gStart(tab);

	return div;
}

function _gStart(tab) {
	const status = tab._gStatus;
	const more = tab._gMore;
	if (status) status.textContent = "loading...";
	if (more) more.hidden = true;
	_ensureLumin().then((ok) => {
		if (ok) return _gTabLoadPage(tab, 1);
		if (status) status.textContent = "games unavailable";
		if (more) { more.textContent = "try again"; more.hidden = false; }
	});
}

function _gCard(game, tab) {
	const card = el("button", { class: "gcard", title: game.name, "data-gid": game.id });
	const img = el("img", { class: "gcard-img", alt: game.name, loading: "lazy" });
	img.src = "/img/logo.svg";
	img.style.opacity = "0.25";
	if (game.image_token && typeof Lumin !== "undefined") {
		card._gLoadImg = () => {
			Lumin.getImageUrl(game.image_token).then((url) => { img.src = url; img.style.opacity = ""; }).catch(() => {});
		};
		if (tab?._gImgs) tab._gImgs.observe(card);
		else card._gLoadImg();
	}
	const label = el("span", { class: "gcard-label" }, game.name);
	card.append(img, label);
	card.addEventListener("click", () => _gOpen(game));
	return card;
}

function _gOpen(game) {
	const existing = tabs.find((t) => t.type === "game" && t.gameId === game.id);
	if (existing) return activate(existing);
	const tab = makeGameTab(game);
	tabs.splice(active ? tabs.indexOf(active) + 1 : tabs.length, 0, tab);
	activate(tab);
}

const _aiModels = [
	{ id: "claude-sonnet-5",                     label: "claude sonnet 5",           p: "anthropic" },
	{ id: "claude-opus-5",                        label: "claude opus 5",             p: "anthropic" },
	{ id: "claude-opus-4-8",                      label: "claude opus 4.8",           p: "anthropic" },
	{ id: "claude-fable-5-1",                     label: "claude fable 5.1",          p: "anthropic" },
	{ id: "gpt-5.6-luna",                         label: "gpt 5.6 luna",              p: "openai" },
	{ id: "gpt-6-astra",                          label: "gpt 6 astra",               p: "openai" },
	{ id: "gpt-5.6-sol",                          label: "gpt 5.6 sol",               p: "openai" },
	{ id: "gpt-5.6-terra",                        label: "gpt 5.6 terra",             p: "openai" },
	{ id: "gpt-5.5",                              label: "gpt 5.5",                   p: "openai" },
	{ id: "gpt-5.4-mini",                         label: "gpt 5.4 mini",              p: "openai" },
	{ id: "gpt-4.1",                              label: "gpt 4.1",                   p: "openai" },
	{ id: "gpt-4o",                               label: "gpt 4o",                    p: "openai" },
	{ id: "kimi-k3",                              label: "kimi k3",                   p: "moonshot" },
	{ id: "kimi-k2.7-code",                       label: "kimi k2.7 code",            p: "moonshot" },
	{ id: "grok-4.6",                             label: "grok 4.6",                  p: "xai" },
	{ id: "deepseek-v4-pro",                      label: "deepseek v4 pro",           p: "deepseek" },
	{ id: "deepseek-v4-flash",                    label: "deepseek v4 flash",         p: "deepseek" },
	{ id: "deepseek-v3.2",                        label: "deepseek v3.2",             p: "deepseek" },
	{ id: "glm-5.3",                              label: "glm 5.3",                   p: "zai" },
	{ id: "gemini-2.5-flash-lite",                label: "gemini 2.5 flash",          p: "google" },
	{ id: "gemma-4-26b",                          label: "gemma 4 26b",               p: "google" },
	{ id: "qwen-3.8-max",                         label: "qwen 3.8 max",              p: "qwen" },
	{ id: "qwen-3.7-plus",                        label: "qwen 3.7 plus",             p: "qwen" },
	{ id: "command-a-plus",                       label: "command a+",                p: "cohere" },
	{ id: "llama-3.3-70b-instruct",               label: "llama 3.3 70b",             p: "meta" },
	{ id: "mistral-small-3.2-24b-instruct-2506",  label: "mistral small 3.2",         p: "mistral" },
];

function _mkAiDropdown(models, defaultId) {
	const wrap = el("div", { class: "ai-dd" });
	let current = models.find(m => m.id === defaultId) ?? models[0];

	const trigger = el("button", { class: "ai-dd-trigger", type: "button" });
	const dot = el("span", { class: "ai-dd-dot" });
	const label = el("span", { class: "ai-dd-label" });
	const chev = el("span", { class: "ai-dd-chev" });
	chev.innerHTML = `<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>`;
	trigger.append(dot, label, chev);

	const panel = el("div", { class: "ai-dd-panel" });

	function pick(m) {
		current = m;
		label.textContent = m.label;
		dot.dataset.p = m.p;
		panel.querySelectorAll(".ai-dd-opt").forEach(o =>
			o.classList.toggle("sel", o.dataset.id === m.id));
	}

	for (const m of models) {
		const opt = el("button", { class: "ai-dd-opt", type: "button", "data-id": m.id });
		const odot = el("span", { class: "ai-dd-dot", "data-p": m.p });
		opt.append(odot, document.createTextNode(m.label));
		opt.addEventListener("click", () => { pick(m); panel.classList.remove("open"); wrap.classList.remove("open"); });
		panel.append(opt);
	}

	trigger.addEventListener("click", (e) => {
		e.stopPropagation();
		const open = panel.classList.toggle("open");
		wrap.classList.toggle("open", open);
	});
	document.addEventListener("click", () => {
		panel.classList.remove("open");
		wrap.classList.remove("open");
	}, { capture: true, passive: true });

	pick(current);
	wrap.append(trigger, panel);
	Object.defineProperty(wrap, "value", { get: () => current.id });
	return wrap;
}

function _aiMd(text) {
	let h = text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
	h = h.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
		const langTag = lang ? `<span class="ai-code-lang">${lang}</span>` : "";
		return `<div class="ai-code-wrap">${langTag}<button class="ai-copy-btn" type="button">copy</button><pre><code>${code.trim()}</code></pre></div>`;
	});
	h = h.replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`);
	h = h.replace(/\*\*(.+?)\*\*/g, (_, t) => `<strong>${t}</strong>`);
	h = h.replace(/\*(.+?)\*/g, (_, t) => `<em>${t}</em>`);
	h = h.replace(/^### (.+)$/gm, (_, t) => `<h4>${t}</h4>`);
	h = h.replace(/^## (.+)$/gm, (_, t) => `<h3>${t}</h3>`);
	h = h.replace(/^# (.+)$/gm, (_, t) => `<h3>${t}</h3>`);
	h = h.replace(/^> (.+)$/gm, (_, t) => `<blockquote>${t}</blockquote>`);
	h = h.replace(/^---$/gm, () => `<hr>`);
	h = h.replace(/((?:^- .+\n?)+)/gm, (block) => {
		const items = block.trim().replace(/^- (.+)$/gm, (_, t) => `<li>${t}</li>`);
		return `<ul>${items}</ul>`;
	});
	h = h.replace(/:::(\w*)[^\n]*\n([\s\S]*?):::/g, (_, _type, content) =>
		`<div class="ai-box">${content.trim()}</div>`);
	h = h.replace(/\n\n+/g, "</p><p>");
	h = `<p>${h}</p>`;
	h = h.replace(/<p>([\s\S]*?)<\/p>/g, (_, inner) => {
		if (/^<(?:pre|div|h[34]|ul|blockquote|hr)/.test(inner.trim())) return inner;
		return `<p>${inner}</p>`;
	});
	h = h.replace(/(?<!<\/pre>)\n/g, "<br>");
	return h;
}

function _createAiDiv(tab) {
	const div = el("div", { class: "tab-frame ai-frame" });

	const header = el("div", { class: "ai-header" });
	const sel = _mkAiDropdown(_aiModels, "claude-sonnet-5");

	const wsLabel = el("label", { class: "ai-ws-label" });
	const wsCheck = el("input", { type: "checkbox" });
	const wsSlider = el("span", { class: "ai-ws-slider" });
	const wsText = el("span", { class: "ai-ws-text" }, "web");
	wsLabel.append(wsCheck, wsSlider, wsText);

	const clearBtn = el("button", { class: "ai-clear-btn", type: "button" });
	clearBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>`;
	clearBtn.title = "clear chat";
	clearBtn.addEventListener("click", () => {
		tab.messages = [];
		msgs.replaceChildren();
	});
	header.append(sel, wsLabel, clearBtn);

	const msgs = el("div", { class: "ai-messages" });
	msgs.addEventListener("click", (e) => {
		const btn = e.target.closest(".ai-copy-btn");
		if (!btn) return;
		const code = btn.closest(".ai-code-wrap")?.querySelector("code")?.textContent ?? "";
		navigator.clipboard.writeText(code).then(() => {
			btn.textContent = "copied!";
			setTimeout(() => (btn.textContent = "copy"), 1800);
		}).catch(() => {});
	});

	const inputArea = el("div", { class: "ai-input-area" });
	const textarea = el("textarea", { class: "ai-input", placeholder: "message...", rows: "1", spellcheck: "false" });
	const autoResize = () => {
		textarea.style.height = "auto";
		textarea.style.height = Math.min(textarea.scrollHeight, 140) + "px";
	};
	textarea.addEventListener("input", autoResize);
	textarea.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			const text = textarea.value.trim();
			if (text) { textarea.value = ""; autoResize(); _aiSend(tab, text, msgs, sel, wsCheck); }
		}
	});
	const sendBtn = el("button", { class: "ai-send", type: "button" });
	sendBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>`;
	sendBtn.addEventListener("click", () => {
		const text = textarea.value.trim();
		if (text) { textarea.value = ""; autoResize(); _aiSend(tab, text, msgs, sel, wsCheck); }
	});
	inputArea.append(textarea, sendBtn);

	div.append(header, msgs, inputArea);
	tab.aiDiv = div;
	ui.frames.append(div);
	return div;
}

async function _aiSend(tab, text, msgs, sel, wsCheck) {
	tab.messages.push({ role: "user", content: text });
	const userDiv = el("div", { class: "ai-msg user" });
	userDiv.innerHTML = _aiMd(text);
	msgs.append(userDiv);
	msgs.scrollTop = msgs.scrollHeight;

	let searchCtx = "";
	if (wsCheck?.checked) {
		try {
			const sr = await fetch(`/api/ai/search?q=${encodeURIComponent(text)}`);
			const { results } = await sr.json();
			if (results?.length) {
				searchCtx = "\n\nWeb search results:\n" + results.map((r) =>
					`[${r.title}](${r.url}): ${r.snippet}`).join("\n");
			}
		} catch {}
	}

	const thinkRow = el("div", { class: "ai-think-row" });
	thinkRow.innerHTML = `<span class="ai-thinking">thinking...</span>`;
	msgs.append(thinkRow);
	msgs.scrollTop = msgs.scrollHeight;

	const model = sel?.value || "claude-sonnet-5";
	const history = tab.messages.slice(-20).map((m, i) =>
		(m.role === "user" && i === tab.messages.length - 1 && searchCtx)
			? { role: m.role, content: m.content + searchCtx }
			: { role: m.role, content: m.content }
	);

	let aiDiv = null;
	try {
		const res = await fetch("/api/ai/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model, messages: history, stream: true, max_tokens: 4096 }),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		let full = "";
		const reader = res.body.getReader();
		const dec = new TextDecoder();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = dec.decode(value, { stream: true });
			for (const line of chunk.split("\n")) {
				if (!line.startsWith("data: ")) continue;
				const data = line.slice(6).trim();
				if (data === "[DONE]") { reader.cancel(); break; }
				try {
					const delta = JSON.parse(data).choices?.[0]?.delta?.content;
					if (delta) {
						full += delta;
						if (!aiDiv) {
							thinkRow.remove();
							aiDiv = el("div", { class: "ai-msg ai" });
							msgs.append(aiDiv);
						}
						aiDiv.innerHTML = _aiMd(full);
						msgs.scrollTop = msgs.scrollHeight;
					}
				} catch {}
			}
		}
		if (!aiDiv) thinkRow.remove();
		tab.messages.push({ role: "assistant", content: full });
	} catch (err) {
		thinkRow.remove();
		const errDiv = el("div", { class: "ai-msg ai" });
		errDiv.innerHTML = `<span class="ai-err">error: ${err.message}</span>`;
		msgs.append(errDiv);
	}
}

function openGameFullscreen(src, title) {
	const existing = document.querySelector(".game-overlay");
	if (existing) existing.remove();
	const overlay = el("div", { class: "game-overlay" },
		el("div", { class: "game-fullscreen-bar" },
			el("span", {}, title),
			el("button", { onclick: () => overlay.remove() }, "exit fullscreen")
		),
		el("iframe", { src, allowfullscreen: "", allow: "fullscreen; autoplay" })
	);
	document.body.appendChild(overlay);
	const onKey = (e) => {
		if (e.key === "Escape") { overlay.remove(); document.removeEventListener("keydown", onKey); }
	};
	document.addEventListener("keydown", onKey);
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
	$("cfg-e1").value = engine?._tK ?? s._m;
	$("set-adblock").checked = s.blockAds;
	$("set-rewriterlogs").checked = s.rewriterLogs;
	$("cfg-s1").value = s._srvUrl;
	$("cfg-s1").placeholder = _nrc() || "auto";
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
		["version", "v1.0.0"],
		["engine", `${versionInfo.version} (${versionInfo.build})`],
		["runtime", globalThis[atob("JHNjcmFtamV0Q29udHJvbGxlcg==")]?.VERSION],
		["mode", engine?._tK ?? settings.get()._m],
	];
	$("about-versions").replaceChildren(...rows.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]));
}

let currentUser = null;
async function fetchUser() {
	try {
		const res = await fetch("/api/auth/me");
		const data = await res.json();
		currentUser = data.user;
	} catch { currentUser = null; }
}

function renderAccount() {
	const box = $("account-section");
	if (!box) return;
	if (!currentUser) {
		box.replaceChildren(
			el("div", { class: "account-section" },
				el("p", { style: "color:var(--muted);font-size:14px" }, "you're not logged in"),
				el("a", { href: "/auth.html", class: "auth-btn", style: "text-align:center;text-decoration:none;display:block;margin-top:8px" }, "log in"),
				el("a", { href: "/auth.html?view=signup", class: "auth-btn", style: "text-align:center;text-decoration:none;display:block;margin-top:8px;background:var(--surface);color:var(--text);border:1px solid var(--line)" }, "sign up")
			)
		);
		return;
	}
	const section = el("div", { class: "account-section" },
		el("div", { class: "account-info" },
			el("div", { class: "account-avatar" }, currentUser.username[0]),
			el("div", { class: "account-details" },
				el("span", { class: "account-name" }, currentUser.username),
				el("span", { class: "account-email" }, currentUser.email)
			)
		),
		el("div", { class: "account-actions", id: "account-actions" },
			el("button", { onclick: () => showChangePw() }, "change password"),
			el("button", { class: "danger", onclick: () => doLogout() }, "log out")
		)
	);
	box.replaceChildren(section);
}

function showChangePw() {
	const actions = $("account-actions");
	if (!actions) return;
	const errEl = el("div", { class: "auth-error" });
	const okEl = el("div", { class: "auth-success" });
	const form = el("form", { class: "change-pw-form" },
		el("label", {},
			el("span", {}, "current password"),
			el("input", { type: "password", name: "current", required: true })
		),
		el("label", {},
			el("span", {}, "new password"),
			el("input", { type: "password", name: "password", required: true, minLength: 8 })
		),
		el("label", {},
			el("span", {}, "confirm new password"),
			el("input", { type: "password", name: "confirm", required: true, minLength: 8 })
		),
		el("div", { class: "change-pw-actions" },
			el("button", { type: "submit", class: "save-pw" }, "save"),
			el("button", { type: "button", onclick: () => renderAccount() }, "cancel")
		),
		errEl, okEl
	);
	form.addEventListener("submit", async (e) => {
		e.preventDefault();
		errEl.textContent = "";
		okEl.textContent = "";
		const fd = new FormData(form);
		if (fd.get("password") !== fd.get("confirm")) { errEl.textContent = "passwords don't match"; return; }
		const btn = form.querySelector(".save-pw");
		btn.disabled = true;
		try {
			const res = await fetch("/api/auth/change-password", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ current: fd.get("current"), password: fd.get("password") }),
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.error);
			okEl.textContent = "password changed";
			setTimeout(() => renderAccount(), 1200);
		} catch (ex) {
			errEl.textContent = ex.message;
		} finally {
			btn.disabled = false;
		}
	});
	actions.replaceChildren(form);
}

async function doLogout() {
	try {
		await fetch("/api/auth/logout", { method: "POST" });
	} catch {}
	currentUser = null;
	renderAccount();
	toast("logged out");
}

fetchUser();

$("cfg-e1").addEventListener("change", async (e) => {
	const kind = e.target.value;
	if (!engine || kind === engine._tK) return;
	try {
		await engine._sT(kind);
		toast(`now using ${kind}`);
	} catch (err) {
		toast(`couldn't start ${kind}: ${err.message}`, 4000);
		e.target.value = engine._tK;
	}
});
$("set-search").addEventListener("change", (e) => settings.set({ searchEngine: e.target.value }));
$("set-adblock").addEventListener("change", (e) => settings.set({ blockAds: e.target.checked }));
$("set-rewriterlogs").addEventListener("change", (e) => settings.set({ rewriterLogs: e.target.checked }));
$("cfg-s1").addEventListener("change", (e) => {
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

function openAiTab() {
	const existing = tabs.find((t) => t.type === "ai");
	if (existing) return activate(existing);
	const tab = makeAiTab();
	tabs.splice(active ? tabs.indexOf(active) + 1 : tabs.length, 0, tab);
	activate(tab);
}
$("ai-btn").addEventListener("click", openAiTab);

function openGamesTab() {
	const existing = tabs.find((t) => t.type === "games");
	if (existing) return activate(existing);
	const tab = makeGamesTab();
	tabs.splice(active ? tabs.indexOf(active) + 1 : tabs.length, 0, tab);
	activate(tab);
}
$("games-btn").addEventListener("click", openGamesTab);

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

Object.defineProperty(window, "__nc_a3c8", { value: (frameEl, go) => {
	const tab = tabs.find((t) => t.iframe && t.iframe === frameEl);
	if (!tab || !engine) return false;
	const target = go ? resolveInput(go) : null;
	setTimeout(() => (target ? navigate(target, { tab }) : showHome(tab)));
	return true;
}, enumerable: false, configurable: true });

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

	ui.boot.classList.add("done");
	setTimeout(() => (ui.boot.hidden = true), 250);

	if (tabs.length) {
		activate(restoredActive ?? tabs[tabs.length - 1]);
	} else {
		openTab();
	}

	const engStatus = $("engine-status");
	if (engStatus) engStatus.hidden = false;

	try {
		engine = await createEngine({ onRewriteError: () => renderDiag() }, (s) => (ui.bootStatus.textContent = s));
	} catch (err) {
		console.error("[app] boot failed", err);
		if (engStatus) engStatus.textContent = `engine failed: ${err.message}`;
		toast(`engine failed to start: ${err.message}`, 6000);
		return;
	}

	if (engStatus) engStatus.hidden = true;
	toast("ready to browse");
	(window.requestIdleCallback ?? setTimeout)(prefetchIcons, { timeout: 3000 });

	const target = go ? resolveInput(go) : null;
	if (target) {
		const tab = makeTab();
		tabs.push(tab);
		navigate(target, { tab });
	} else if (active?.type === "browser" && active.url && !active.handle) {
		ensureFrame(active).go(active.url);
	} else {
		for (const t of tabs) {
			if (t.type === "browser" && t.url && !t.handle) {
				ensureFrame(t).go(t.url);
				if (t !== active) activate(t);
				break;
			}
		}
	}
}

if (!nestedInShell) boot();
