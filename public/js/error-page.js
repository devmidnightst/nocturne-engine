const escape = (s) =>
	String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

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
		hint: "the tunnel to the umbrella server dropped. reload, or switch transport in settings.",
	},
];

const UNKNOWN = {
	id: "unknown",
	title: "this page couldn't be loaded",
	hint: "something went wrong while fetching the page.",
};

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
:root{color-scheme:light dark;--bg:#fff;--surface:#f6f6f7;--hover:#ececee;--line:#dcdce0;--text:#1c1c1f;--muted:#6b6b73;--accent:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#1b1b1d;--surface:#242427;--hover:#2e2e32;--line:#3a3a3f;--text:#e8e8ea;--muted:#9d9da6;--accent:#7aa2f7}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;
font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:var(--bg);color:var(--text)}
.card{width:min(560px,100%)}
.brand{font-size:13px;color:var(--muted)}
.brand i{display:none}
h1{font-size:22px;margin:8px 0 6px;font-weight:600}
p{margin:0 0 14px;color:var(--muted)}
code,.url{font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
.url{display:block;padding:8px 10px;border-radius:6px;background:var(--surface);border:1px solid var(--line);margin-bottom:16px}
details{margin-top:14px;color:var(--muted)}
details code{display:block;white-space:pre-wrap;margin-top:8px;padding:8px 10px;border-radius:6px;background:var(--surface);border:1px solid var(--line)}
.row{display:flex;gap:8px;flex-wrap:wrap}
button{appearance:none;border:1px solid var(--line);background:var(--surface);color:var(--text);
padding:7px 14px;border-radius:6px;font:inherit;cursor:pointer}
button:hover{background:var(--hover)}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--bg)}
button.primary:hover{filter:brightness(1.08)}
`;

export function renderErrorPage({ url, error, kind = classifyError(error), status = 502 }) {
	const detail = String(error?.stack || error?.message || error || "").slice(0, 1500);
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(kind.title)} | Umbrella</title><style>${STYLE}</style></head>
<body><main class="card">
<div class="brand"><i></i>umbrella</div>
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
const send = (action) => parent.postMessage({ __umbrella: action }, location.origin);
document.getElementById("retry").onclick = () => location.reload();
document.getElementById("transport").onclick = () => send("switch-transport");
document.getElementById("home").onclick = () => send("home");
</script></body></html>`;
	return {
		body: html,
		status,
		statusText: "Umbrella Error",
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
		hint: "this address is on umbrella's ad and tracker list. you can turn blocking off in settings.",
	};
	return renderErrorPage({ url, error: "blocked by content blocker", kind, status: 403 });
}
