// loads the patched scramjet bundle in node and rewrites the js given on argv.
// run as a child process because scramjet 2.x uses regexp modifiers ((?i:...)),
// which node 22 only parses with --js-regexp-modifiers.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { buildPatchedScramjet, scramjetDistDir } from "../../src/scramjet-patches.js";

globalThis.self = globalThis;
globalThis.location = new URL("http://localhost:8080/");
vm.runInThisContext(buildPatchedScramjet().code);
const sj = globalThis.$scramjet;
sj.setWasm(fs.readFileSync(path.join(scramjetDistDir(), "scramjet.wasm")));

const ctx = {
	config: { ...sj.defaultConfig, flags: { ...sj.defaultConfig.flags, sourcemaps: false } },
	prefix: new URL("http://localhost:8080/~/sj/test/"),
	interface: { codecEncode: encodeURIComponent, codecDecode: decodeURIComponent },
	cookieJar: new sj.CookieJar(),
};
const meta = { origin: new URL("https://example.com/"), base: new URL("https://example.com/") };

const inputs = JSON.parse(process.argv[2]);
const out = inputs.map((js) => String(sj.rewriteJs(js, "test.js", ctx, meta)));

// run a rewritten snippet with stand in helpers to check the semantics survive
globalThis.$scramjet$wrappostmessage = (x) => x;
const probe = String(
	sj.rewriteJs(
		"var t={postMessage(){}}; function f(a){return(a).postMessage} var R1=typeof f(t); var R2=typeof(t).postMessage;",
		"probe.js",
		ctx,
		meta
	)
);
vm.runInThisContext(probe);
process.stdout.write(JSON.stringify({ out, R1: globalThis.R1, R2: globalThis.R2, diag: self.__nc_d7f2 }));
