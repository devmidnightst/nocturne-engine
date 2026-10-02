const AD_KEYS = new Set([
	"adPlacements",
	"adSlots",
	"playerAds",
	"adBreakHeartbeatParams",
	"enforcementMessageViewModel",
]);

const AD_RENDERERS = new Set([
	"adSlotRenderer",
	"promotedSparklesWebRenderer",
	"promotedSparklesTextSearchRenderer",
	"promotedVideoRenderer",
	"compactPromotedVideoRenderer",
	"searchPyvRenderer",
	"bannerPromoRenderer",
	"statementBannerRenderer",
	"brandVideoSingletonRenderer",
	"brandVideoShelfRenderer",
	"inFeedAdLayoutRenderer",
	"displayAdRenderer",
	"actionCompanionAdRenderer",
	"mealbarPromoRenderer",
]);

const WRAPPERS = ["richItemRenderer", "richSectionRenderer"];

function onlyKey(obj) {
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
	let key = null;
	for (const k in obj) {
		if (key !== null) return null;
		key = k;
	}
	return key;
}

function isAdItem(item) {
	const key = onlyKey(item);
	if (key === null) return false;
	if (AD_RENDERERS.has(key)) return true;
	if (WRAPPERS.includes(key)) {
		const inner = onlyKey(item[key]?.content);
		return inner !== null && AD_RENDERERS.has(inner);
	}
	return false;
}

export function pruneAds(root) {
	let removed = 0;
	const stack = [root];
	while (stack.length) {
		const node = stack.pop();
		if (!node || typeof node !== "object") continue;
		if (Array.isArray(node)) {
			for (let i = node.length - 1; i >= 0; i--) {
				if (isAdItem(node[i])) {
					node.splice(i, 1);
					removed++;
				} else stack.push(node[i]);
			}
			continue;
		}
		for (const k of Object.keys(node)) {
			if (AD_KEYS.has(k) || isAdItem(node[k])) {
				delete node[k];
				removed++;
			} else stack.push(node[k]);
		}
	}
	return removed;
}

const XSSI = ")]}'";

export function pruneJsonText(text) {
	let prefix = "";
	let body = text;
	if (body.startsWith(XSSI)) {
		const nl = body.indexOf("\n");
		prefix = body.slice(0, nl + 1);
		body = body.slice(nl + 1);
	}
	let data;
	try {
		data = JSON.parse(body);
	} catch {
		return null;
	}
	if (!pruneAds(data)) return null;
	return prefix + JSON.stringify(data);
}

function matchBrace(s, start) {
	let depth = 0;
	let inString = false;
	for (let i = start; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (inString) {
			if (c === 92) i++;
			else if (c === 34) inString = false;
			continue;
		}
		if (c === 34) inString = true;
		else if (c === 123 || c === 91) depth++;
		else if (c === 125 || c === 93) {
			if (--depth === 0) return i;
		}
	}
	return -1;
}

const INLINE_RE = /(?:ytInitialPlayerResponse|ytInitialData|playerResponse)"?\]?\s*=\s*\{/g;

export function pruneHtmlText(html) {
	const spans = [];
	for (const m of html.matchAll(INLINE_RE)) {
		const start = m.index + m[0].length - 1;
		const end = matchBrace(html, start);
		if (end === -1) continue;
		spans.push([start, end + 1]);
	}
	if (!spans.length) return null;
	let out = html;
	let changed = false;
	for (let i = spans.length - 1; i >= 0; i--) {
		const [a, b] = spans[i];
		let data;
		try {
			data = JSON.parse(out.slice(a, b));
		} catch {
			continue;
		}
		if (!pruneAds(data)) continue;
		const json = JSON.stringify(data).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
		out = out.slice(0, a) + json + out.slice(b);
		changed = true;
	}
	return changed ? out : null;
}

export function isYouTubeHost(host) {
	host = host.toLowerCase();
	return (
		host === "youtube.com" ||
		host.endsWith(".youtube.com") ||
		host === "youtube-nocookie.com" ||
		host.endsWith(".youtube-nocookie.com") ||
		host === "youtubei.googleapis.com"
	);
}

export const YT_API_RE = /^\/youtubei\/v1\/(player|next|browse|search|reel\/|get_watch)/;
