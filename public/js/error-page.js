// nocturne engine: branded error pages rendered inside the proxy frame.
//
// stock scramjet answers a failed navigation with a bare "Internal Service
// Worker Error" string. these pages say what actually went wrong and give the
// user something to click. they talk to the shell with postMessage.

const escape = (s) =>
	String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ordered, first match wins. libcurl reports curl error codes, epoxy reports
// hyper errors. both collapse most network failures into "the stream closed",
// which is what /api/diagnose is for (see diagnoseKind below).
const KINDS = [
	{
		id: "dns",
		test: /(error code 6:|lookup|resolve host|getaddrinfo|ENOTFOUND|name or service|no such host|dns)/i,
		title: "that site doesn't seem to exist",
		hint: "the server couldn't find this domain. check the spelling, or the site might be down.",
	},
	{
		id: "blocked",
		test: /(HostBlocked|host blocked|access denied|forbidden by the server)/i,
		title: "this address is blocked by the server",
		hint: "the wisp server refuses private, loopback and some port ranges for safety.",
	},
	{
		id: "refused",
		test: /(refused|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH)/i,
		title: "the site refused the connection",
		hint: "the site is up but not accepting connections right now. try again in a bit.",
	},
	{
		id: "timeout",
		test: /(error code 28:|timed? ?out|ETIMEDOUT|deadline)/i,
		title: "the site took too long to answer",
		hint: "could be the site, could be the network. retrying usually works.",
	},
	{
		id: "tls",
		test: /(error code (35|51|53|54|58|59|60|77|80|83|90|91):|tls|ssl|certificate|handshake|x509|rustls)/i,
		title: "secure connection failed",
		hint: "the site's tls setup didn't work with this transport. switching transport in settings often fixes it.",
	},
	{
		id: "transport",
		test: /(wisp|websocket|transport|socket (is )?closed|ws:|wss:)/i,
		title: "lost connection to the proxy server",
		hint: "the tunnel to the nocturne server dropped. reload, or switch transport in settings.",
	},
];

const UNKNOWN = {
	id: "unknown",
	title: "this page couldn't be loaded",
	hint: "something went wrong while fetching the page.",
};

// transport errors that only mean "the connection went away", where asking the
// server what happened gives a much better answer
// (a wisp stream the server closes mid tls handshake shows up as "handshake eof")
const AMBIGUOUS =
	/(IncompleteMessage|connection closed before message completed|handshake eof|UnexpectedEof|error code (7|35|52|55|56):|Could not connect)/i;

export function classifyError(error) {
	const text = String(error?.message ?? error ?? "");
	return KINDS.find((k) => k.test.test(text)) ?? UNKNOWN;
}

export function needsDiagnosis(error, kind) {
	return kind.id === "unknown" || AMBIGUOUS.test(String(error?.message ?? error ?? ""));
}

const DIAGNOSED = {
	dns: "dns",
	blocked: "blocked",
	refused: "refused",
	timeout: "timeout",
	unreachable: "refused",
};

// asks the nocturne server to repeat the dns + tcp part of the connection.
// resolves to a kind, or null when the site is reachable (so the failure is
// somewhere in tls / http and the transport's own message is the best we have)
export async function diagnoseKind(targetUrl) {
	let url;
	try {
		url = new URL(targetUrl);
	} catch {
		return null;
	}
	const port = url.port || (url.protocol === "https:" || url.protocol === "wss:" ? 443 : 80);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 7000);
	try {
		const res = await fetch(`/api/diagnose?host=${encodeURIComponent(url.hostname)}&port=${port}`, {
			signal: controller.signal,
		});
		if (!res.ok) return null;
		const { kind } = await res.json();
		const id = DIAGNOSED[kind];
		return id ? KINDS.find((k) => k.id === id) : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

const STYLE = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;
font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
background:radial-gradient(1200px 600px at 50% -10%,#2a2150 0%,#0b0a14 55%,#07060d 100%);color:#e8e6f5}
.card{width:min(560px,100%);padding:28px;border-radius:20px;background:rgba(255,255,255,.05);
border:1px solid rgba(255,255,255,.1);backdrop-filter:blur(18px);box-shadow:0 20px 60px rgba(0,0,0,.45)}
.brand{display:flex;gap:10px;align-items:center;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#a69ee0}
.brand i{width:10px;height:10px;border-radius:50%;background:linear-gradient(135deg,#b9a7ff,#6f5cff);box-shadow:0 0 12px #7b68ff}
h1{font-size:22px;margin:14px 0 6px;font-weight:650}
p{margin:0 0 14px;color:#b9b5d3}
code,.url{font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
.url{display:block;padding:10px 12px;border-radius:10px;background:rgba(0,0,0,.35);color:#d8d3ff;margin-bottom:16px}
details{margin-top:14px;color:#8f8aad}
details code{display:block;white-space:pre-wrap;margin-top:8px;padding:10px 12px;border-radius:10px;background:rgba(0,0,0,.35)}
.row{display:flex;gap:10px;flex-wrap:wrap}
button{appearance:none;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.07);color:#eee;
padding:9px 14px;border-radius:12px;font:inherit;cursor:pointer}
button.primary{background:linear-gradient(135deg,#8b7bff,#5b48f0);border-color:transparent;color:#fff}
button:hover{filter:brightness(1.12)}
`;

// markup is injected with the target url as data, never as script source
export function renderErrorPage({ url, error, kind = classifyError(error), status = 502 }) {
	const detail = String(error?.stack || error?.message || error || "").slice(0, 1500);
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(kind.title)} | Nocturne Engine</title><style>${STYLE}</style></head>
<body><main class="card">
<div class="brand"><i></i>nocturne engine</div>
<h1>${escape(kind.title)}</h1>
<p>${escape(kind.hint)}</p>
<span class="url">${escape(url)}</span>
<div class="row">
<button class="primary" id="retry">try again</button>
<button id="transport">switch transport</button>
<button id="home">home</button>
</div>
<details><summary>technical details</summary><code>${escape(kind.id)}: ${escape(detail)}</code></details>
</main>
<script>
const send = (action) => parent.postMessage({ __nocturne: action }, location.origin);
document.getElementById("retry").onclick = () => location.reload();
document.getElementById("transport").onclick = () => send("switch-transport");
document.getElementById("home").onclick = () => send("home");
</script></body></html>`;
	return {
		body: html,
		status,
		statusText: "Nocturne Error",
		headers: [
			["content-type", "text/html; charset=utf-8"],
			["cache-control", "no-store"],
		],
	};
}

export function renderBlockedPage(url) {
	const kind = {
		id: "adblock",
		title: "blocked by the ad blocker",
		hint: "this address is on nocturne's ad and tracker list. you can turn blocking off in settings.",
	};
	return renderErrorPage({ url, error: "blocked by content blocker", kind, status: 403 });
}
