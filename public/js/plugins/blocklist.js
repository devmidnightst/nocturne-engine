export const BLOCKED_HOSTS = [
	"doubleclick.net",
	"googlesyndication.com",
	"googleadservices.com",
	"adservice.google.com",
	"pagead2.googlesyndication.com",
	"amazon-adsystem.com",
	"adnxs.com",
	"adsrvr.org",
	"criteo.com",
	"criteo.net",
	"taboola.com",
	"outbrain.com",
	"pubmatic.com",
	"rubiconproject.com",
	"openx.net",
	"casalemedia.com",
	"media.net",
	"moatads.com",
	"adform.net",
	"smartadserver.com",
	"yieldmo.com",
	"sharethrough.com",
	"popads.net",
	"propellerads.com",
	"adsterra.com",
	"zedo.com",
	"google-analytics.com",
	"analytics.google.com",
	"googletagservices.com",
	"scorecardresearch.com",
	"quantserve.com",
	"hotjar.com",
	"mouseflow.com",
	"fullstory.com",
	"clarity.ms",
	"segment.io",
	"mixpanel.com",
	"amplitude.com",
	"branch.io",
	"bat.bing.com",
	"ads.linkedin.com",
	"analytics.tiktok.com",
	"ads-twitter.com",
	"static.ads-twitter.com",
	"pixel.facebook.com",
	"securepubads.g.doubleclick.net",
	"imasdk.googleapis.com",
	"adsafeprotected.com",
	"doubleverify.com",
	"serving-sys.com",
	"advertising.com",
	"adcolony.com",
	"applovin.com",
	"unityads.unity3d.com",
	"inmobi.com",
	"teads.tv",
	"33across.com",
	"indexww.com",
	"lijit.com",
	"sovrn.com",
	"triplelift.com",
	"gumgum.com",
	"spotxchange.com",
	"springserve.com",
	"bidswitch.net",
	"smaato.net",
	"revcontent.com",
	"mgid.com",
	"exoclick.com",
	"juicyads.com",
	"trafficjunky.net",
	"hilltopads.net",
	"popcash.net",
	"onclickads.net",
	"adcash.com",
	"a-ads.com",
	"bidvertiser.com",
	"infolinks.com",
	"admaven.com",
	"ad-maven.com",
	"monetag.com",
	"pubfuture.com",
	"ezoic.net",
	"googleoptimize.com",
	"newrelic.com",
	"nr-data.net",
	"chartbeat.com",
	"chartbeat.net",
	"parsely.com",
	"crazyegg.com",
	"heap.io",
	"heapanalytics.com",
	"kissmetrics.com",
	"mc.yandex.ru",
	"adskeeper.com",
	"adskeeper.co.uk",
];

export const BLOCKED_PATHS = [
	["discord.com", /^\/api\/v\d+\/science\b/],
	["discord.com", /^\/api\/v\d+\/metrics\b/],
	["youtube.com", /^\/(api\/stats\/ads|pagead\/|ptracking|get_midroll_)/],
	["google.com", /^\/pagead\//],
];

let remote = null;
let loading = null;

export function loadFilterLists() {
	loading ??= fetch("/api/filters", { credentials: "same-origin" })
		.then((r) => (r.ok ? r.json() : null))
		.then((j) => {
			if (!j || !Array.isArray(j.block)) return;
			remote = {
				block: new Set(j.block),
				third: new Set(j.third || []),
				allow: new Set(j.allow || []),
			};
		})
		.catch(() => {});
	return loading;
}

function inSet(set, host) {
	for (let h = host; ; ) {
		if (set.has(h)) return true;
		const i = h.indexOf(".");
		if (i === -1) return false;
		h = h.slice(i + 1);
	}
}

export function baseDomain(host) {
	const parts = host.toLowerCase().replace(/\.$/, "").split(".");
	if (parts.length <= 2 || /^[\d.]+$/.test(host)) return parts.join(".");
	const sld = parts[parts.length - 2];
	const take = parts[parts.length - 1].length === 2 && sld.length <= 3 ? 3 : 2;
	return parts.slice(-take).join(".");
}

function hostMatches(host, suffix) {
	return host === suffix || host.endsWith("." + suffix);
}

export function isBlocked(url, site) {
	const host = url.hostname.toLowerCase();
	for (const [h, re] of BLOCKED_PATHS) if (hostMatches(host, h) && re.test(url.pathname + url.search)) return true;
	if (remote && inSet(remote.allow, host)) return false;
	for (const h of BLOCKED_HOSTS) if (hostMatches(host, h)) return true;
	if (!remote) return false;
	if (inSet(remote.block, host)) return true;
	return !!site && inSet(remote.third, host) && baseDomain(host) !== baseDomain(site);
}

const GPT = `(function(){var w=window,o=w.googletag||{},q=(o.cmd&&o.cmd.length)?o.cmd.slice():[];var c=new Proxy(function(){return c},{get:function(t,k){if(k==="then")return undefined;if(k===Symbol.toPrimitive)return function(){return 0};if(k==="length")return 0;if(k===Symbol.iterator)return function(){return [][Symbol.iterator]()};return c},apply:function(){return c}});var run=function(){for(var i=0;i<arguments.length;i++){try{arguments[i].call(w)}catch(e){}}return 0};var b={apiReady:true,pubadsReady:true,cmd:{push:run},getVersion:function(){return""}};w.googletag=new Proxy(b,{get:function(t,k){return k in t?t[k]:c}});run.apply(null,q)})();`;
const ADSBYGOOGLE = `window.adsbygoogle={loaded:true,length:0,push:function(){return 0}};`;
const GA = `(function(){var w=window,n=w.GoogleAnalyticsObject||"ga",old=w[n],q=(old&&old.q)||[];var t={get:function(){},set:function(){},send:function(){}};var ga=function(){var a=arguments[arguments.length-1];if(a&&typeof a==="object"&&typeof a.hitCallback==="function"){try{a.hitCallback()}catch(e){}}};ga.create=function(){return t};ga.getByName=function(){return t};ga.getAll=function(){return[t]};ga.remove=function(){};ga.loaded=true;w[n]=ga;for(var i=0;i<q.length;i++){try{ga.apply(null,q[i])}catch(e){}}})();`;

export function surrogateFor(url) {
	const host = url.hostname.toLowerCase();
	const p = url.pathname;
	if (/\/gpt\.js$|\/pubads_impl/.test(p) && (hostMatches(host, "doubleclick.net") || hostMatches(host, "googletagservices.com"))) return GPT;
	if (/\/adsbygoogle\.js$/.test(p) && hostMatches(host, "googlesyndication.com")) return ADSBYGOOGLE;
	if (/\/(analytics|ga)\.js$/.test(p) && hostMatches(host, "google-analytics.com")) return GA;
	return null;
}
