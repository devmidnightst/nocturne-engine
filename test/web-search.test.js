import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import {
	parseDuckDuckGoHtml,
	parseDuckDuckGoLite,
	parseBraveHtml,
	parseYahoo,
	parseBing,
	bingTarget,
	yahooTarget,
	normalizeQuery,
	searchWeb,
	resetSearchState,
	SearchBlocked,
	extractText,
	fetchPage,
	cookieJar,
} from "../src/web-search.js";
import { createAiRouter } from "../src/ai.js";

// markup below follows real duckduckgo captures from 2026 (html endpoint after a
// POST gives direct links, after a GET gives //duckduckgo.com/l/?uddg= links)
const ddgResult = (href, title, snippet) => `
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body"> <!-- This is the visible part -->
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="${href}">${title}</a>
    </h2>
    <div class="result__extras"><div class="result__extras__url">
      <a class="result__url" href="${href}">example</a>
    </div></div>
    ${snippet == null ? "" : `<a class="result__snippet" href="${href}">${snippet}</a>`}
    <div class="clear"></div>
  </div>
</div>`;

const ddgAd = `
<div class="result results_links results_links_deep result--ad ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_domain=shop.example&amp;ad_provider=bingv7aa">Buy stuff</a>
      <div class="result__badge-wrap"><button class="badge--ad">Ad</button></div>
    </h2>
    <a class="result__snippet" href="https://duckduckgo.com/y.js?ad_domain=shop.example">ad text</a>
  </div>
</div>`;

const ddgPage = (body) => `<!DOCTYPE html><html><head><title>rust lang at DuckDuckGo</title></head><body><div id="links" class="results">${body}</div></body></html>`;

const ddgAnomaly = `<!DOCTYPE html><html><head><title>
    DuckDuckGo
</title></head><body><center id="lite_wrapper">
<form id="img-form" action="//duckduckgo.com/anomaly.js?sv=html&cc=sre&ti=1" target="ifr" method="POST"></form>
<form id="challenge-form" action="//duckduckgo.com/anomaly.js?sv=html&cc=sre&st=1&q=rust lang" method="POST">
<div class="anomaly-modal__mask"><div class="anomaly-modal__modal  is-ie" data-testid="anomaly-modal">
<div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>
<div class="anomaly-modal__description">Please complete the following challenge to confirm this search was made by a human.</div>
</div></div></form>
<p class="feedback-instructions">error-lite@duckduckgo.com</p></center></body></html>`;

beforeEach(() => resetSearchState());

test("duckduckgo html: direct links, ads skipped, titles and snippets stay paired", () => {
	const html = ddgPage(
		ddgAd +
			ddgResult("https://rust-lang.org/", "Rust Programming Language", "<b>Rust</b> is fast &amp; reliable") +
			ddgResult("https://example.com/no-snippet", "No snippet here", null) +
			ddgResult("https://en.wikipedia.org/wiki/Rust_(programming_language)", "Rust &#x27;lang&#x27; &mdash; Wikipedia", "Rust &quot;emphasizes&quot;&nbsp;safety"),
	);
	const { results, blocked } = parseDuckDuckGoHtml(html, 200);
	assert.equal(blocked, false);
	assert.deepEqual(
		results.map((r) => r.url),
		["https://rust-lang.org/", "https://example.com/no-snippet", "https://en.wikipedia.org/wiki/Rust_(programming_language)"],
	);
	assert.equal(results[0].snippet, "Rust is fast & reliable");
	assert.equal(results[1].snippet, "");
	assert.equal(results[2].title, "Rust 'lang' — Wikipedia");
	assert.equal(results[2].snippet, 'Rust "emphasizes" safety');
});

test("duckduckgo html: uddg redirect links are unwrapped once, not twice", () => {
	const target = "https://example.com/search?q=a%26b&page=2";
	const href = `//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&amp;rut=abc123`;
	const { results } = parseDuckDuckGoHtml(ddgPage(ddgResult(href, "Example", "snippet")), 200);
	assert.equal(results.length, 1);
	assert.equal(results[0].url, target);
});

test("duckduckgo html: one bad link doesn't sink the rest", () => {
	const html = ddgPage(ddgResult("//duckduckgo.com/l/?uddg=%E0%A4%A&amp;rut=x", "Broken", "x") + ddgResult("https://ok.example/", "Fine", "y"));
	const { results } = parseDuckDuckGoHtml(html, 200);
	assert.deepEqual(results.map((r) => r.url), ["https://ok.example/"]);
});

test("duckduckgo bot check counts as a block, not as zero results", () => {
	assert.deepEqual(parseDuckDuckGoHtml(ddgAnomaly, 202), { results: [], blocked: true });
	assert.equal(parseDuckDuckGoHtml(ddgAnomaly, 200).blocked, true);
	assert.equal(parseDuckDuckGoHtml(ddgPage(""), 429).blocked, true);
	assert.equal(parseDuckDuckGoHtml(ddgPage('<div class="no-results">No results.</div>'), 200).blocked, false);
});

test("duckduckgo lite: sponsored rows skipped, snippet comes from the next row", () => {
	const html = `<html><head><title>q at DuckDuckGo</title></head><body><table>
<tr class="result-sponsored"><td valign="top">1.&nbsp;</td><td><a rel="nofollow" href="https://duckduckgo.com/y.js?ad_domain=x&amp;ad_provider=bingv7aa" class='result-link'>Ad</a></td></tr>
<tr class="result-sponsored"><td>&nbsp;</td><td class='result-snippet'>ad snippet</td></tr>
<tr><td valign="top">2.&nbsp;</td><td><a rel="nofollow" href="https://www.instagram.com/reel/abc/" class='result-link'>Hotel Krishna&#x27;s</a></td></tr>
<tr><td>&nbsp;&nbsp;&nbsp;</td><td class='result-snippet'>Indulge in &quot;culinary&quot; <b>delights</b></td></tr>
<tr><td>&nbsp;&nbsp;&nbsp;</td><td><span class='link-text'>www.instagram.com/reel/abc/</span></td></tr>
<tr><td>&nbsp;</td><td>&nbsp;</td></tr>
</table></body></html>`;
	const { results, blocked } = parseDuckDuckGoLite(html, 200);
	assert.equal(blocked, false);
	assert.deepEqual(results, [{ title: "Hotel Krishna's", url: "https://www.instagram.com/reel/abc/", snippet: 'Indulge in "culinary" delights' }]);
	assert.equal(parseDuckDuckGoLite(ddgAnomaly.replace("sv=html", "sv=lite"), 200).blocked, true);
});

test("brave html results", () => {
	const html = `<div id="results">
<div class="snippet svelte-abc" data-type="web" data-pos="1">
  <a href="https://nodejs.org/en/blog" class="svelte-abc l1"><div class="site-name-wrapper"><div class="sitename-container">Node.js</div></div><div class="title search-snippet-title line-clamp-1 svelte-abc">Node.js Blog &amp; News</div></a>
  <div class="generic-snippet svelte-abc"><div class="content desktop-default-regular t-primary line-clamp-dynamic svelte-abc">Latest <strong>releases</strong> and news.</div></div>
</div>
<div class="snippet" data-type="ad"><a href="https://ads.example/"><div class="title">ad</div></a></div>
</div>`;
	const { results, blocked } = parseBraveHtml(html, 200);
	assert.equal(blocked, false);
	assert.deepEqual(results, [{ title: "Node.js Blog & News", url: "https://nodejs.org/en/blog", snippet: "Latest releases and news." }]);
	assert.equal(parseBraveHtml("<html>please solve the pow-captcha</html>", 200).blocked, true);
	assert.equal(parseBraveHtml("", 429).blocked, true);
});

test("yahoo results unwrap RU= links and skip bing ads", () => {
	const wrapped = `https://r.search.yahoo.com/_ylt=Awr/RV=2/RE=1/RO=10/RU=${encodeURIComponent("https://www.python.org/downloads/")}/RK=2/RS=abc-`;
	assert.equal(yahooTarget(wrapped), "https://www.python.org/downloads/");
	assert.equal(yahooTarget("https://direct.example/"), "https://direct.example/");
	const html = `<div id="web"><ol>
<li><div class="dd algo algo-sr relsrch Sr"><div class="compTitle options-toggle"><a href="${wrapped}" aria-label="Download Python | Python.org"><h3 class="title"><span>www.python.org</span>Download Python</h3></a></div><div class="compText aAbs"><p>The official home of the <b>Python</b> language.</p></div></div></li>
<li><div class="dd algo algo-sr"><div class="compTitle"><a href="https://www.bing.com/aclick?ld=x"><h3>ad</h3></a></div></div></li>
</ol></div>`;
	const { results } = parseYahoo(html, 200, "https://search.yahoo.com/search?p=python");
	assert.deepEqual(results, [{ title: "Download Python | Python.org", url: "https://www.python.org/downloads/", snippet: "The official home of the Python language." }]);
	assert.equal(parseYahoo("<html></html>", 200, "https://consent.yahoo.com/v2/collectConsent").blocked, true);
});

test("bing ck/a links decode, ads and off topic results drop", () => {
	const target = "https://developer.mozilla.org/en-US/docs/Web/JavaScript";
	const ck = `https://www.bing.com/ck/a?!&&p=abc&ptn=3&u=a1${Buffer.from(target).toString("base64url")}&ntb=1`;
	assert.equal(bingTarget(ck), target);
	assert.equal(bingTarget("https://www.bing.com/aclick?ld=e8"), null);
	const html = `<ol id="b_results">
<li class="b_algo"><h2><a href="${ck}">JavaScript | MDN</a></h2><div class="b_caption"><p>JavaScript (JS) is a lightweight language.</p></div></li>
<li class="b_algo"><h2><a href="https://recipes.example/">Banana bread</a></h2><div class="b_caption"><p>Easy banana bread.</p></div></li>
<li class="b_ad"><h2><a href="https://www.bing.com/aclick?ld=x">Ad</a></h2></li>
</ol>`;
	const { results } = parseBing(html, 200, "javascript docs");
	assert.deepEqual(results.map((r) => r.url), [target]);
	assert.equal(parseBing("<html>captcha</html>", 200, "x").blocked, true);
});

test("queries are tidied and bangs can't redirect duckduckgo", () => {
	assert.equal(normalizeQuery("  what   is\n\nnode  "), "what is node");
	assert.equal(normalizeQuery("!important not working in css"), "important not working in css");
	assert.equal(normalizeQuery("cats !w"), "cats w");
	assert.ok(normalizeQuery("word ".repeat(200)).length <= 250);
});

const engine = (name, fn) => ({ name, run: async (q) => fn(q) });
const hit = (url) => ({ title: url, url, snippet: "" });

test("search falls through blocked engines and benches them", async () => {
	let ddgCalls = 0;
	const engines = [
		engine("ddg", () => {
			ddgCalls++;
			return { status: 202, results: [], blocked: true };
		}),
		engine("other", (q) => ({ status: 200, results: [hit(`https://a.example/${q.length}`)], blocked: false })),
	];
	const first = await searchWeb("hello world", { engines });
	assert.equal(first.engine, "other");
	assert.equal(first.results.length, 1);
	await searchWeb("another query", { engines });
	assert.equal(ddgCalls, 1, "a blocked engine sits out instead of being asked again");
});

test("search reports total failure instead of pretending there were no results", async () => {
	const engines = [
		engine("a", () => ({ status: 202, results: [], blocked: true })),
		engine("b", () => {
			throw new Error("socket hang up");
		}),
	];
	await assert.rejects(searchWeb("nothing works", { engines }), (err) => err instanceof SearchBlocked && /a blocked/.test(err.message) && /socket hang up/.test(err.message));
});

test("an honest empty answer is still an empty result, not an error", async () => {
	const engines = [engine("a", () => ({ status: 200, results: [], blocked: false }))];
	assert.deepEqual(await searchWeb("zxqv nonsense", { engines }), { results: [], engine: null, query: "zxqv nonsense" });
});

test("search results are cached and identical searches share one request", async () => {
	let calls = 0;
	const engines = [
		engine("a", async () => {
			calls++;
			await new Promise((r) => setTimeout(r, 20));
			return { status: 200, results: [hit("https://a.example/")], blocked: false };
		}),
	];
	await Promise.all([searchWeb("same", { engines }), searchWeb("same", { engines }), searchWeb("  same ", { engines })]);
	await searchWeb("same", { engines });
	assert.equal(calls, 1);
});

test("page text skips menus, scripts and footers", () => {
	const html = `<html><head><title>t</title><style>.a{}</style></head><body>
<nav>Home | About | Login</nav><header>Site header</header>
<article><h1>Release notes</h1><p>${"Node 26 ships a new permission model. ".repeat(20)}</p><script>alert("x")</script></article>
<footer>Copyright</footer></body></html>`;
	const text = extractText(html, 500);
	assert.match(text, /^Release notes\nNode 26 ships/);
	assert.doesNotMatch(text, /Home \| About|Site header|Copyright|alert/);
	assert.ok(text.length <= 501);
});

test("page reader refuses private addresses", async () => {
	const srv = http.createServer((req, res) => res.end("<html><body>secret</body></html>"));
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	try {
		await assert.rejects(fetchPage(`http://127.0.0.1:${srv.address().port}/`), /unsupported url|blocked/);
		await assert.rejects(fetchPage("http://localhost/"), /blocked address/);
		await assert.rejects(fetchPage("http://169.254.169.254/latest/meta-data/"), /blocked address/);
		await assert.rejects(fetchPage("http://127.0.0.1/"), /blocked address/);
		await assert.rejects(fetchPage("http://[::1]/"), /blocked address/);
		await assert.rejects(fetchPage("http://[::ffff:127.0.0.1]/"), /blocked address/);
		await assert.rejects(fetchPage("http://10.0.0.5/"), /blocked address/);
		await assert.rejects(fetchPage("file:///etc/passwd"), /unsupported url/);
	} finally {
		srv.close();
	}
});

test("cookie jar keeps, scopes and expires cookies", () => {
	cookieJar.setCookie("YBV=v0.2abc; Domain=.yahoo.com; Path=/; Max-Age=86400", "https://search.yahoo.com/search");
	cookieJar.setCookie("kl=us-en; Path=/", "https://html.duckduckgo.com/html/");
	assert.equal(cookieJar.getCookieString("https://search.yahoo.com/search?p=x"), "YBV=v0.2abc");
	assert.equal(cookieJar.getCookieString("https://html.duckduckgo.com/html/"), "kl=us-en");
	assert.equal(cookieJar.getCookieString("https://example.com/"), "");
	cookieJar.setCookie("YBV=gone; Domain=yahoo.com; Max-Age=0", "https://search.yahoo.com/");
	assert.equal(cookieJar.getCookieString("https://search.yahoo.com/"), "");
});

async function withApp(fn) {
	const app = express();
	app.use("/api/ai", createAiRouter());
	const srv = http.createServer(app);
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	try {
		return await fn(`http://127.0.0.1:${srv.address().port}`);
	} finally {
		srv.close();
	}
}

test("chat: stopping the reply also stops the upstream request", async () => {
	let upstreamClosed;
	const closed = new Promise((r) => (upstreamClosed = r));
	const upstream = http.createServer((req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		const t = setInterval(() => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}\n\n`), 20);
		res.on("close", () => {
			clearInterval(t);
			upstreamClosed();
		});
	});
	await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
	process.env.AI_API_BASE = `http://127.0.0.1:${upstream.address().port}`;
	process.env.AI_API_KEY = "test";
	try {
		await withApp(async (base) => {
			const ac = new AbortController();
			const res = await fetch(`${base}/api/ai/chat`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "m", stream: true, messages: [] }),
				signal: ac.signal,
			});
			const reader = res.body.getReader();
			await reader.read();
			ac.abort();
			const result = await Promise.race([closed.then(() => "closed"), new Promise((r) => setTimeout(() => r("still streaming"), 2000))]);
			assert.equal(result, "closed");
		});
	} finally {
		upstream.closeAllConnections();
		upstream.close();
		delete process.env.AI_API_BASE;
		delete process.env.AI_API_KEY;
	}
});

test("chat: an upstream that can't be reached gives a json error", async () => {
	process.env.AI_API_BASE = "http://127.0.0.1:9";
	process.env.AI_API_KEY = "test";
	try {
		await withApp(async (base) => {
			const res = await fetch(`${base}/api/ai/chat`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "m", messages: [] }),
			});
			assert.equal(res.status, 502);
			assert.ok((await res.json()).error);
		});
	} finally {
		delete process.env.AI_API_BASE;
		delete process.env.AI_API_KEY;
	}
});

test("search route: an empty query answers at once", async () => {
	await withApp(async (base) => {
		const empty = await (await fetch(`${base}/api/ai/search?q=%20`)).json();
		assert.deepEqual(empty.results, []);
	});
});
