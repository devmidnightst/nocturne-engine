const PREFIX = "_p8q2:";
const MIGRATE_PREFIXES = ["nocturne:", "_p8q2_old:"];

try {
	for (const key of Object.keys(localStorage)) {
		const old = MIGRATE_PREFIXES.find((p) => key.startsWith(p));
		if (!old) continue;
		const name = PREFIX + key.slice(old.length);
		if (localStorage.getItem(name) == null) localStorage.setItem(name, localStorage.getItem(key));
		localStorage.removeItem(key);
	}
} catch {}

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
	_m: "lc",
	_srvUrl: "",
	searchEngine: "duckduckgo",
	blockAds: true,
	rewriterLogs: false,
	compatSites: [],
	sidebarCollapsed: false,
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

export function _dsu() {
	return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/wisp/`;
}

export function _su() {
	const custom = (settings.get()._srvUrl || "").trim();
	return custom || _dsu();
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

try {
	localStorage.removeItem(PREFIX + "tabs");
} catch {}

export const session = {
	load() {
		try {
			const raw = sessionStorage.getItem(PREFIX + "tabs");
			return raw == null ? null : JSON.parse(raw);
		} catch {
			return null;
		}
	},
	save(data) {
		try {
			sessionStorage.setItem(PREFIX + "tabs", JSON.stringify(data));
		} catch {
		}
	},
};

const ICON_LIMIT = 150;

export const icons = {
	all() {
		return read("icons", {});
	},
	get(host) {
		return this.all()[host] ?? null;
	},
	set(host, src, data) {
		const map = this.all();
		delete map[host];
		map[host] = { src, data };
		const keys = Object.keys(map);
		for (const k of keys.slice(0, Math.max(0, keys.length - ICON_LIMIT))) delete map[k];
		write("icons", map);
	},
};
