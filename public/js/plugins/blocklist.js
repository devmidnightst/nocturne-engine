// nocturne engine: ad + tracker hosts blocked when "block ads & trackers" is on.
//
// kept short on purpose. every entry here is a host that only serves ads or
// analytics, so blocking it should never break the page itself. a host matches
// itself and all of its subdomains.

export const BLOCKED_HOSTS = [
	// ad networks
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
	// analytics / trackers
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
];

// url path patterns for first party telemetry endpoints that are safe to drop.
// [hostSuffix, pathRegex]
export const BLOCKED_PATHS = [
	// discord client telemetry. the client queues events and moves on if it fails.
	["discord.com", /^\/api\/v\d+\/science\b/],
	["discord.com", /^\/api\/v\d+\/metrics\b/],
	// youtube ad + stats pings
	["youtube.com", /^\/(api\/stats\/ads|pagead\/|ptracking)/],
];

function hostMatches(host, suffix) {
	return host === suffix || host.endsWith("." + suffix);
}

export function isBlocked(url) {
	const host = url.hostname.toLowerCase();
	for (const h of BLOCKED_HOSTS) if (hostMatches(host, h)) return true;
	for (const [h, re] of BLOCKED_PATHS) if (hostMatches(host, h) && re.test(url.pathname)) return true;
	return false;
}
