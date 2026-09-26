// nocturne engine: turn whatever was typed into the omnibox into a url.

import { settings, SEARCH_ENGINES } from "./store.js";

// "example.com", "sub.example.co.uk/path", "localhost:3000", "1.2.3.4:8080"
const LOOKS_LIKE_HOST =
	/^(localhost|(\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\]|([a-z0-9-]+\.)+[a-z][a-z0-9-]{1,62})(:\d{1,5})?([/?#].*)?$/i;

export function searchUrl(query) {
	const engine = SEARCH_ENGINES[settings.get().searchEngine] ?? SEARCH_ENGINES.duckduckgo;
	return engine.url.replace("%s", encodeURIComponent(query));
}

export function resolveInput(raw) {
	const input = String(raw ?? "").trim();
	if (!input) return null;

	// explicit scheme
	if (/^https?:\/\//i.test(input)) {
		try {
			return new URL(input).href;
		} catch {
			return searchUrl(input);
		}
	}

	// bare host, no spaces
	if (!/\s/.test(input) && LOOKS_LIKE_HOST.test(input)) {
		try {
			return new URL(`https://${input}`).href;
		} catch {
			// fall through to search
		}
	}

	return searchUrl(input);
}

// what to show in the omnibox for a url (hide the scheme noise on https)
export function displayUrl(url) {
	if (!url) return "";
	try {
		const u = new URL(url);
		return u.protocol === "https:" ? u.href.replace(/^https:\/\//, "") : u.href;
	} catch {
		return url;
	}
}
