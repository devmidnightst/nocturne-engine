// nocturne engine: build time fixes for the scramjet 2.0.67-alpha.2 bundles.
//
// scramjet ships as minified iifes. dist/scramjet.js runs in the shell page
// (where the controller rewrites fetched scripts), inside every proxied frame,
// and inside every proxied worker, so patching the file once on the server is
// the only way to fix a bug in all three places at the same time. the
// controller's inject script and scramjet-utils get the same treatment.
//
// every patch is an exact string swap pinned to this one build. if a pattern is
// not found exactly once the patch is skipped and reported, so a version bump
// can never produce a half patched bundle. run `npm run check` after upgrading.

import fs from "node:fs";
import path from "node:path";
import { packageDir } from "./packages.js";

export const SCRAMJET_VERSION = "2.0.67-alpha.2";
export const CONTROLLER_VERSION = "0.0.14";
export const UTILS_VERSION = "0.0.3";

// keywords the rewriter can glue its wrapper call onto (scramjet issue #185).
const GLUE_KEYWORDS = [
	"typeof",
	"return",
	"await",
	"void",
	"delete",
	"throw",
	"case",
	"in",
	"of",
	"new",
	"yield",
	"else",
	"do",
	"instanceof",
	"extends",
];

// prepended to the bundle. runs in every realm that loads scramjet.
// kept as plain es2020 so it parses everywhere scramjet itself does.
const PRELUDE = `
var __nocturneGlueKeywords = ${JSON.stringify(GLUE_KEYWORDS)}.map(function (k) {
	return Array.from(k, function (c) { return c.charCodeAt(0); });
});
var __nocturneMarker = Array.from("$scramjet$", function (c) { return c.charCodeAt(0); });
function __nocturneIsIdent(b) {
	return (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 36 || b === 95 || b > 127;
}
// fixes "typeof$scramjet$wrap(x)" style output in place without changing the
// byte length, so scramjet's own source maps (used for Function.prototype.toString
// and error stacks) stay valid. "kw$scramjet$name(" becomes "kw $scramjet$nam(",
// and the shortened name is aliased back to the real helper below.
function __nocturneFixGlue(bytes) {
	if (!(bytes instanceof Uint8Array)) return bytes;
	var m = __nocturneMarker, fixed = 0;
	for (var i = bytes.indexOf(36); i !== -1; i = bytes.indexOf(36, i + 1)) {
		var j = 0;
		while (j < m.length && bytes[i + j] === m[j]) j++;
		if (j !== m.length) continue;
		var end = i + m.length;
		while (end < bytes.length && __nocturneIsIdent(bytes[end])) end++;
		if (bytes[end] !== 40 || end - i < m.length + 2) continue;
		for (var k = 0; k < __nocturneGlueKeywords.length; k++) {
			var kw = __nocturneGlueKeywords[k], start = i - kw.length;
			if (start < 0) continue;
			var ok = true;
			for (var q = 0; q < kw.length; q++) if (bytes[start + q] !== kw[q]) { ok = false; break; }
			if (!ok || (start > 0 && (__nocturneIsIdent(bytes[start - 1]) || bytes[start - 1] === 46))) continue;
			bytes.copyWithin(i + 1, i, end - 1);
			bytes[i] = 32;
			fixed++;
			break;
		}
	}
	if (fixed && self.__nocturneDiag) self.__nocturneDiag.glueFixes += fixed;
	return bytes;
}
function __nocturneReportRewriteError(url, err) {
	var d = self.__nocturneDiag;
	if (!d) return;
	d.rewriteErrors++;
	var msg = String(err && err.message || err).split("\\n")[0].slice(0, 300);
	d.lastErrors.push({ url: String(url || "(inline)").slice(0, 500), message: msg, at: Date.now() });
	if (d.lastErrors.length > 20) d.lastErrors.shift();
	try { if (typeof self.__nocturneRewriteErrorSink === "function") self.__nocturneRewriteErrorSink(url, msg); } catch (e) {}
}
if (!self.__nocturneDiag) {
	Object.defineProperty(self, "__nocturneDiag", {
		value: { rewriteErrors: 0, glueFixes: 0, lastErrors: [] },
		enumerable: false, configurable: true, writable: true,
	});
}
`;

// appended to the bundle: alias the shortened helper names from __nocturneFixGlue.
const EPILOGUE = `
;(function () {
	try {
		var g = self.$scramjet && self.$scramjet.defaultConfig && self.$scramjet.defaultConfig.globals;
		if (!g) return;
		Object.keys(g).forEach(function (key) {
			var name = g[key];
			if (typeof name !== "string" || name.length < 3) return;
			var alias = name.slice(0, -1);
			if (Object.prototype.hasOwnProperty.call(self, alias)) return;
			Object.defineProperty(self, alias, {
				get: function () { return self[name]; },
				enumerable: false,
				configurable: true,
			});
		});
	} catch (e) {}
})();
`;

/**
 * each patch: { id, why, find, replace } or { id, why, edits: [{ find, replace }] }.
 * every `find` must occur exactly once in the bundle.
 */
export const PATCHES = [
	{
		id: "wasm-module-cache",
		why: "getRewriter() compiled a fresh WebAssembly.Module from the 586kb rewriter wasm on every single js rewrite, even though initSync only ever uses the first one. caching it made each rewrite call about 3x faster in a local benchmark.",
		edits: [
			{
				find: "function h(e,t){let r;if(!(i instanceof Uint8Array))",
				replace:
					"let __nwm,__nwmSrc;function h(e,t){let r;if(!(i instanceof Uint8Array))",
			},
			{
				find: "(0,n.QR)({module:new WebAssembly.Module(i)})",
				replace:
					"(0,n.QR)({module:__nwmSrc===i?__nwm:(__nwmSrc=i,__nwm=new WebAssembly.Module(i))})",
			},
		],
	},
	{
		id: "keyword-glue",
		why: "scramjet #185: `typeof(x).postMessage` and `return(x).postMessage` get rewritten to `typeof$scramjet$wrappostmessage(...)`, a ReferenceError that kills the whole script.",
		find: "let{js:u,map:g,scramtag:d,errors:p}=n;",
		replace: "let{js:u,map:g,scramtag:d,errors:p}=n;u=__nocturneFixGlue(u);",
	},
	{
		id: "rewrite-error-report",
		why: "surface rewriter failures to the nocturne ui instead of only a console.warn that dumps the entire script source.",
		find: 'catch(a){if(o.warn("failed rewriting js for",t||"(unknown)",a.message,"string"!=typeof e?(0,s.hS)(e):e)',
		replace:
			'catch(a){__nocturneReportRewriteError(t,a);if(o.warn("failed rewriting js for",t||"(unknown)",a.message,("string"!=typeof e?(0,s.hS)(e):e).slice(0,400))',
	},
	{
		id: "module-worker-imports",
		why: "with encapsulateWorkers on (the default) a rewritten worker is moved into a data: url. for module workers that breaks every static import, because the rewriter emits root relative specifiers like /~/sj/... and a data: url has no base to resolve them against, so `new Worker(url, { type: \"module\" })` died on load for any worker with an import. module workers now skip the data: wrapper. modules are always strict, so the wrapper is not needed there.",
		find: '(h=(0,s.hS)(h)),(0,i.U5)("encapsulateWorkers",r,a.origin)){let e;',
		replace: '(h=(0,s.hS)(h)),!A&&(0,i.U5)("encapsulateWorkers",r,a.origin)){let e;',
	},
	{
		id: "setattribute-coerce",
		why: "scramjet #184: element.setAttribute(123, x) threw `r.toLowerCase is not a function` because the proxy skipped the string coercion the dom does.",
		find: 'e.Proxy("Element.prototype.setAttribute",{apply(t){let[r,s]=t.args,',
		replace:
			'e.Proxy("Element.prototype.setAttribute",{apply(t){t.args.length&&(t.args[0]=(0,n.Qf)(t.args[0]));let[r,s]=t.args,',
	},
	{
		id: "getresponseheader-coerce",
		why: "same bug as #184 in XMLHttpRequest.prototype.getResponseHeader.",
		find: '"link"===t.args[0].toLowerCase()&&t.return(s(r,e.context))',
		replace: '"link"===`${t.args[0]}`.toLowerCase()&&t.return(s(r,e.context))',
	},
];

// NOCTURNE_DISABLE_PATCHES=all (or a comma list of ids) serves stock bundles,
// handy for checking whether a broken site is a nocturne patch or upstream.
const DISABLED = new Set(
	(process.env.NOCTURNE_DISABLE_PATCHES || "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
);

// applies every patch whose edits all match exactly once. mutates applied/skipped.
function applyPatches(source, patches, applied, skipped) {
	let code = source;
	for (const patch of patches) {
		if (DISABLED.has("all") || DISABLED.has(patch.id)) {
			skipped.push({ id: patch.id, reason: "disabled by NOCTURNE_DISABLE_PATCHES" });
			continue;
		}
		const edits = patch.edits ?? [{ find: patch.find, replace: patch.replace }];
		// every edit in a patch must match exactly once, or the whole patch is skipped
		const bad = edits.find((e) => code.split(e.find).length - 1 !== 1);
		if (bad) {
			const count = code.split(bad.find).length - 1;
			skipped.push({ id: patch.id, reason: `pattern found ${count} times` });
			continue;
		}
		for (const e of edits) code = code.replace(e.find, () => e.replace);
		applied.push(patch.id);
	}
	return code;
}

function stripSourceMap(code) {
	const m = code.match(/\n\/\/# sourceMappingURL=.*\s*$/);
	return m ? code.slice(0, m.index) : code;
}

// ---------------------------------------------------------------------------
// controller.inject.js (runs inside every proxied window)
// ---------------------------------------------------------------------------

export const CONTROLLER_INJECT_PATCHES = [
	{
		id: "websocket-open-order",
		why: "the proxied page's websocket gets its data over one MessagePort and its open event over another (the rpc reply), so a server that talks first (discord's gateway sends HELLO the instant you connect) delivered a message before `open`. the page then replied with ws.send() while readyState was still CONNECTING, which throws. queue data until open fires. also drops the console noise logged for every socket.",
		find: 'return console.warn("connecting"),this.rpc.call("connect",{url:e.href,protocols:t,requestHeaders:o,port:c.port2},[c.port2]).then(e=>{console.log(e),"success"===e.result?r(e.protocol,e.extensions):a(e.error)}),l.onmessage=e=>{let t=e.data;"data"===t.type?i(t.data):"close"===t.type&&s(t.code,t.reason)}',
		replace:
			'let __q=[],__open=!1,__dispatch=e=>{"data"===e.type?i(e.data):"close"===e.type&&s(e.code,e.reason)};return this.rpc.call("connect",{url:e.href,protocols:t,requestHeaders:o,port:c.port2},[c.port2]).then(e=>{if("success"===e.result){__open=!0,r(e.protocol,e.extensions);let t=__q;__q=null;for(let e of t)__dispatch(e)}else __q=null,a(e.error)}),l.onmessage=e=>{__open?__dispatch(e.data):__q&&__q.push(e.data)}',
	},
	{
		id: "websocket-close-reason",
		why: "ws.close(code, reason) dropped the reason on the way to the real socket.",
		find: 'e=>{n(l,{type:"close",code:e})}]}',
		replace: '(e,t)=>{n(l,{type:"close",code:e,reason:t})}]}',
	},
];

export function buildPatchedControllerInject(source) {
	source ??= fs.readFileSync(
		path.join(packageDir("@mercuryworkshop/scramjet-controller"), "dist/controller.inject.js"),
		"utf8"
	);
	const applied = [];
	const skipped = [];
	let code = applyPatches(source, CONTROLLER_INJECT_PATCHES, applied, skipped);
	code = `/* patched by nocturne engine: ${applied.join(", ") || "none"} */\n` + stripSourceMap(code) + "\n";
	return { code, applied, skipped };
}

// ---------------------------------------------------------------------------
// scramjet-utils.js (HttpCachePlugin and friends, runs in the shell page)
// ---------------------------------------------------------------------------

export const UTILS_PATCHES = [
	{
		id: "http-cache-keeps-set-cookie",
		why: "HttpCachePlugin rebuilt every cacheable response through `new Response()`, and the Response constructor silently drops Set-Cookie. so any cacheable GET that set a cookie (login pages, session refreshes) lost it and the proxied site never saw the cookie again. keep the original raw headers on the response the page gets. the cached copy still has no cookies, which is what you want.",
		find: "let{replacement:m,bodyBuffer:g}=await p(t.response);t.response=m;",
		replace: "let{replacement:m,bodyBuffer:g}=await p(t.response);m.rawHeaders=t.response.rawHeaders;t.response=m;",
	},
];

export function buildPatchedUtils(source) {
	source ??= fs.readFileSync(
		path.join(packageDir("@mercuryworkshop/scramjet-utils"), "dist/scramjet-utils.js"),
		"utf8"
	);
	const applied = [];
	const skipped = [];
	let code = applyPatches(source, UTILS_PATCHES, applied, skipped);
	code = `/* patched by nocturne engine: ${applied.join(", ") || "none"} */\n` + stripSourceMap(code) + "\n";
	return { code, applied, skipped };
}

export function scramjetDistDir() {
	return path.join(packageDir("@mercuryworkshop/scramjet"), "dist");
}

/**
 * returns { code, applied: string[], skipped: {id, reason}[] }
 */
export function buildPatchedScramjet(source) {
	source ??= fs.readFileSync(path.join(scramjetDistDir(), "scramjet.js"), "utf8");
	const applied = [];
	const skipped = [];

	if (!source.includes(`version:"${SCRAMJET_VERSION}"`)) {
		return {
			code: source,
			applied,
			skipped: PATCHES.map((p) => ({
				id: p.id,
				reason: `bundle is not scramjet ${SCRAMJET_VERSION}`,
			})),
		};
	}

	let code = applyPatches(source, PATCHES, applied, skipped);

	// the glue fix and the error reporter call helpers defined in the prelude
	const needsPrelude =
		applied.includes("keyword-glue") || applied.includes("rewrite-error-report");

	code = stripSourceMap(code);
	code =
		`/* patched by nocturne engine: ${applied.join(", ") || "none"} */\n` +
		(needsPrelude ? PRELUDE : "") +
		code +
		(applied.includes("keyword-glue") ? EPILOGUE : "") +
		"\n";

	return { code, applied, skipped };
}
