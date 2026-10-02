import { test } from "node:test";
import assert from "node:assert/strict";

import { pruneAds, pruneJsonText, pruneHtmlText, isYouTubeHost, YT_API_RE } from "../public/js/plugins/yt-prune.js";
import { isBlocked, surrogateFor, baseDomain } from "../public/js/plugins/blocklist.js";
import { parseFilterList, compileLists } from "../src/filters.js";

const player = () => ({
	responseContext: {},
	playabilityStatus: { status: "OK" },
	streamingData: { formats: [{ itag: 18 }] },
	adPlacements: [{ adPlacementRenderer: {} }],
	playerAds: [{ playerLegacyDesktopWatchAdsRenderer: {} }],
	adSlots: [{ adSlotRenderer: {} }],
	adBreakHeartbeatParams: "abc",
	auxiliaryUi: { messageRenderers: { enforcementMessageViewModel: { title: "Ad blockers are not allowed" } } },
	videoDetails: { videoId: "dQw4w9WgXcQ", title: "a </script> title" },
});

test("player responses lose their ad fields and keep the video", () => {
	const p = player();
	assert.ok(pruneAds(p) >= 5);
	assert.equal(p.adPlacements, undefined);
	assert.equal(p.playerAds, undefined);
	assert.equal(p.adSlots, undefined);
	assert.equal(p.adBreakHeartbeatParams, undefined);
	assert.deepEqual(p.auxiliaryUi.messageRenderers, {});
	assert.equal(p.streamingData.formats[0].itag, 18);
	assert.equal(p.videoDetails.videoId, "dQw4w9WgXcQ");
});

test("feed ads are dropped from item lists", () => {
	const data = {
		contents: [
			{ richItemRenderer: { content: { videoRenderer: { videoId: "a" } } } },
			{ richItemRenderer: { content: { adSlotRenderer: {} } } },
			{ adSlotRenderer: {} },
			{ promotedSparklesWebRenderer: {} },
			{ videoRenderer: { videoId: "b" } },
		],
		masthead: { bannerPromoRenderer: {} },
	};
	assert.equal(pruneAds(data), 4);
	assert.deepEqual(
		data.contents.map((c) => c.richItemRenderer?.content.videoRenderer.videoId ?? c.videoRenderer.videoId),
		["a", "b"]
	);
	assert.equal(data.masthead, undefined);
});

test("json text pruning leaves clean responses alone", () => {
	assert.equal(pruneJsonText(JSON.stringify({ videoDetails: {} })), null);
	assert.equal(pruneJsonText("not json"), null);
	const out = JSON.parse(pruneJsonText(JSON.stringify(player())));
	assert.equal(out.adPlacements, undefined);
	const xssi = pruneJsonText(")]}'\n" + JSON.stringify(player()));
	assert.ok(xssi.startsWith(")]}'\n"));
});

test("inline ytInitialPlayerResponse in the watch page is pruned safely", () => {
	const html =
		`<html><script>var ytInitialPlayerResponse = ${JSON.stringify(player()).replace(/</g, "\\u003c")};var meta = 1;</script>` +
		`<script>window["ytInitialData"] = {"contents":[{"adSlotRenderer":{}},{"videoRenderer":{"title":"x}{\\""}}]};</script></html>`;
	const out = pruneHtmlText(html);
	assert.ok(out);
	assert.ok(!out.includes("adPlacements"));
	assert.ok(!out.includes("adSlotRenderer"));
	assert.ok(!out.includes("</script> title"), "a < inside json must stay escaped");
	assert.ok(out.includes(";var meta = 1;"));
	assert.ok(out.includes('"videoRenderer":{"title":"x}{\\""}'));
	assert.equal(pruneHtmlText("<html>nothing here</html>"), null);
});

test("youtube host and api matching", () => {
	assert.ok(isYouTubeHost("www.youtube.com"));
	assert.ok(isYouTubeHost("music.youtube.com"));
	assert.ok(isYouTubeHost("m.youtube.com"));
	assert.ok(isYouTubeHost("youtubei.googleapis.com"));
	assert.ok(!isYouTubeHost("notyoutube.com"));
	assert.ok(YT_API_RE.test("/youtubei/v1/player"));
	assert.ok(YT_API_RE.test("/youtubei/v1/next"));
	assert.ok(!YT_API_RE.test("/youtubei/v1/log_event"));
});

test("built in blocklist and youtube ad paths", () => {
	const u = (s) => new URL(s);
	assert.ok(isBlocked(u("https://securepubads.g.doubleclick.net/tag/js/gpt.js")));
	assert.ok(isBlocked(u("https://www.youtube.com/api/stats/ads?x=1")));
	assert.ok(isBlocked(u("https://www.youtube.com/pagead/viewthroughconversion/1")));
	assert.ok(!isBlocked(u("https://www.youtube.com/watch?v=1")));
	assert.ok(!isBlocked(u("https://example.com/ads.html")));
});

test("surrogates keep pages that call ad libraries from crashing", () => {
	const gpt = surrogateFor(new URL("https://securepubads.g.doubleclick.net/tag/js/gpt.js"));
	const ga = surrogateFor(new URL("https://www.google-analytics.com/analytics.js"));
	assert.ok(surrogateFor(new URL("https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js")));
	assert.equal(surrogateFor(new URL("https://example.com/gpt.js")), null);

	let ran = 0;
	let hit = 0;
	const window = { googletag: { cmd: [() => ran++] }, ga: Object.assign(() => {}, { q: [["send", "pageview", { hitCallback: () => hit++ }]] }) };
	new Function("window", gpt)(window);
	new Function("window", ga)(window);
	assert.equal(ran, 1);
	window.googletag.cmd.push(() => ran++);
	assert.equal(ran, 2);
	const slot = window.googletag.defineSlot("/1/x", [300, 250], "div").addService(window.googletag.pubads());
	assert.equal(typeof slot, "function");
	window.googletag.enableServices();
	window.googletag.display("div");
	assert.equal(hit, 1);
	window.ga("send", "event", { hitCallback: () => hit++ });
	assert.equal(hit, 2);
});

test("filter list parsing keeps only host rules", () => {
	const list = parseFilterList(`
! easylist style
[Adblock Plus 2.0]
||ads.example.com^
||tracker.example.net^$third-party
||cdn.example.org^$script,third-party
||example.com/ads/*
@@||good.example.com^
@@||okay.example.com^$document
##.ad-banner
example.com##.sponsor
0.0.0.0 hosts.example.com # comment
127.0.0.1 localhost
0.0.0.0 0.0.0.0
plain.example.io
`);
	assert.deepEqual([...list.block].sort(), ["ads.example.com", "hosts.example.com", "plain.example.io"]);
	assert.deepEqual([...list.third], ["tracker.example.net"]);
	assert.deepEqual([...list.allow], ["good.example.com"]);
	const merged = compileLists(["||a.com^$third-party", "||a.com^"]);
	assert.deepEqual(merged.block, ["a.com"]);
	assert.deepEqual(merged.third, []);
});

test("base domain guess handles two part suffixes", () => {
	assert.equal(baseDomain("www.bbc.co.uk"), "bbc.co.uk");
	assert.equal(baseDomain("a.b.example.com"), "example.com");
	assert.equal(baseDomain("example.com"), "example.com");
});

test("filter store downloads, caches and serves the compiled lists", async () => {
	const http = await import("node:http");
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const { createFilterStore } = await import("../src/filters.js");
	const lists = http.createServer((req, res) => {
		if (req.url === "/a.txt") return res.end("||ads.test^\n||track.test^$third-party\n");
		res.statusCode = 404;
		res.end();
	});
	await new Promise((r) => lists.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${lists.address().port}`;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "umbrella-filters-"));
	const cacheFile = path.join(dir, "filters.json");
	const warn = console.warn;
	const log = console.log;
	console.warn = console.log = () => {};
	try {
		const store = createFilterStore({ lists: [`${base}/a.txt`, `${base}/missing.txt`], refreshHours: 24, cacheFile });
		await store.refresh();
		assert.equal(store.size, 2);
		const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
		assert.deepEqual(cached.block, ["ads.test"]);
		assert.deepEqual(cached.third, ["track.test"]);

		const again = createFilterStore({ lists: [], refreshHours: 24, cacheFile });
		const headers = {};
		let sent = "";
		const res = {
			setHeader: (k, v) => (headers[k.toLowerCase()] = v),
			type() {
				return this;
			},
			send: (b) => (sent = b),
			status() {
				return this;
			},
			end() {},
		};
		again.handler({ headers: {} }, res);
		assert.deepEqual(JSON.parse(sent), { block: ["ads.test"], third: ["track.test"], allow: [] });
		assert.ok(headers.etag);
	} finally {
		console.warn = warn;
		console.log = log;
		lists.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
