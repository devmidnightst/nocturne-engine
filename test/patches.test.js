import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildPatchedScramjet,
	buildPatchedControllerInject,
	buildPatchedUtils,
} from "../src/scramjet-patches.js";
import { buildPatchedLibcurl } from "../src/libcurl-patches.js";

test("every patch applies to the pinned bundles", () => {
	for (const build of [buildPatchedScramjet, buildPatchedControllerInject, buildPatchedUtils, buildPatchedLibcurl]) {
		const { applied, skipped } = build();
		assert.deepEqual(skipped, [], `${build.name} skipped ${JSON.stringify(skipped)}`);
		assert.ok(applied.length > 0);
	}
});

test("a different scramjet build is left untouched", () => {
	const { code, applied, skipped } = buildPatchedScramjet('version:"9.9.9";console.log(1)');
	assert.equal(code, 'version:"9.9.9";console.log(1)');
	assert.equal(applied.length, 0);
	assert.ok(skipped.length > 0);
});

test("a different libcurl-transport version is left untouched", () => {
	const { code, applied, skipped } = buildPatchedLibcurl("console.log(1)", "9.9.9");
	assert.equal(code, "console.log(1)");
	assert.equal(applied.length, 0);
	assert.ok(skipped.length > 0);
});

test("the patched libcurl bundle still parses", () => {
	// a syntax error in a patch would only show up in the browser otherwise
	const { code } = buildPatchedLibcurl();
	const file = path.join(os.tmpdir(), `nocturne-libcurl-${process.pid}.mjs`);
	fs.writeFileSync(file, code);
	try {
		assert.doesNotThrow(() => execFileSync(process.execPath, ["--check", file], { stdio: "pipe" }));
	} finally {
		fs.rmSync(file, { force: true });
	}
});

function modifiersSupported() {
	try {
		new RegExp("(?i:a)");
		return true;
	} catch {
		return false;
	}
}

test("rewriter no longer glues its wrapper onto keywords (scramjet #185)", () => {
	const helper = fileURLToPath(new URL("./helpers/rewrite.mjs", import.meta.url));
	const args = [...(modifiersSupported() ? [] : ["--js-regexp-modifiers"]), helper];
	const inputs = [
		"function f(a){return(a).postMessage}",
		'if ("function" != typeof(x).postMessage) y()',
		"for(k in(o).postMessage);",
	];
	const result = JSON.parse(execFileSync(process.execPath, [...args, JSON.stringify(inputs)], { encoding: "utf8" }));
	for (const out of result.out) {
		assert.doesNotMatch(out, /(return|typeof|in)\$scramjet/, out);
	}
	assert.equal(result.out[0], "function f(a){return $scramjet$wrappostmessag((a)).postMessage}");
	// same byte length as the unfixed output, so scramjet's source maps still line up
	assert.equal(result.out[0].length, "function f(a){return$scramjet$wrappostmessage((a)).postMessage}".length);
	assert.equal(result.R1, "function");
	assert.equal(result.R2, "function");
	assert.ok(result.diag.glueFixes >= 3);
});
