// nocturne engine: tiny persistent store for settings, bookmarks and history.
// everything lives in localStorage under "nocturne:" keys. every access is
// wrapped because storage can throw (private mode, blocked site data).

const PREFIX = "nocturne:";

function read(key, fallback) {
	try {
		const raw = localStorage.getItem(PREFIX + key);
		return raw == null ? fallback : JSON.parse(raw);
	} catch {
		return fallback;
	}
}

function write(key, value) {
	try {
		localStorage.setItem(PREFIX + key, JSON.stringify(value));
	} catch {
		// storage full or blocked, settings just will not persist
	}
}

export const SEARCH_ENGINES = {
	duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=%s" },
	brave: { name: "Brave Search", url: "https://search.brave.com/search?q=%s" },
	google: { name: "Google", url: "https://www.google.com/search?q=%s" },
	bing: { name: "Bing", url: "https://www.bing.com/search?q=%s" },
	startpage: { name: "Startpage", url: "https://www.startpage.com/do/search?q=%s" },
};

const DEFAULT_SETTINGS = {
	transport: "epoxy", // "epoxy" | "libcurl"
	wispUrl: "", // empty means same origin /wisp/
	searchEngine: "duckduckgo",
	blockAds: true,
	rewriterLogs: false,
	compatSites: [], // origins running in compat mode, see engine.js
};

const listeners = new Set();

export const settings = {
	get() {
		return { ...DEFAULT_SETTINGS, ...read("settings", {}) };
	},
	set(patch) {
		const next = { ...this.get(), ...patch };
		write("settings", next);
		for (const fn of listeners) fn(next, patch);
		return next;
	},
	onChange(fn) {
		listeners.add(fn);
		return () => listeners.delete(fn);
	},
};

export function defaultWispUrl() {
	return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/wisp/`;
}

export function wispUrl() {
	const custom = settings.get().wispUrl.trim();
	return custom || defaultWispUrl();
}

export const bookmarks = {
	all() {
		return read("bookmarks", []);
	},
	has(url) {
		return this.all().some((b) => b.url === url);
	},
	toggle(url, title) {
		const list = this.all();
		const i = list.findIndex((b) => b.url === url);
		if (i === -1) list.unshift({ url, title: title || url, added: Date.now() });
		else list.splice(i, 1);
		write("bookmarks", list.slice(0, 100));
		return i === -1;
	},
	remove(url) {
		write(
			"bookmarks",
			this.all().filter((b) => b.url !== url)
		);
	},
};

export const history = {
	all() {
		return read("history", []);
	},
	add(url, title) {
		if (!/^https?:/.test(url)) return;
		const list = this.all().filter((h) => h.url !== url);
		list.unshift({ url, title: title || "", at: Date.now() });
		write("history", list.slice(0, 200));
	},
	setTitle(url, title) {
		const list = this.all();
		const entry = list.find((h) => h.url === url);
		if (entry && title) {
			entry.title = title;
			write("history", list);
		}
	},
	clear() {
		write("history", []);
	},
};
