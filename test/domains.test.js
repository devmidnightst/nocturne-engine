import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDomainAllowlist } from "../src/domains.js";

test("exact and wildcard matches", () => {
	const a = createDomainAllowlist({ allow: ["nocturne.lol", "*.nocturne.lol"] });
	assert.equal(a.isAllowed("nocturne.lol"), true);
	assert.equal(a.isAllowed("NOCTURNE.LOL."), true);
	assert.equal(a.isAllowed("speed.nocturne.lol"), true);
	assert.equal(a.isAllowed("a.b.nocturne.lol"), false);
	assert.equal(a.isAllowed("evilnocturne.lol"), false);
	assert.equal(a.isAllowed("nocturne.lol.evil.com"), false);
});

test("rejects junk", () => {
	const a = createDomainAllowlist({ allow: ["nocturne.lol"] });
	for (const bad of ["", "localhost", "-x.com", "a..com", "x".repeat(300) + ".com", undefined, "nocturne.lol/x"]) {
		assert.equal(a.isAllowed(bad), false, String(bad));
	}
});

test("domains file is re-read when it changes", async () => {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nocturne-")), "domains.txt");
	fs.writeFileSync(file, "one.com\n# comment\n");
	const a = createDomainAllowlist({ file });
	assert.equal(a.isAllowed("one.com"), true);
	assert.equal(a.isAllowed("two.com"), false);
	await new Promise((r) => setTimeout(r, 20));
	fs.writeFileSync(file, "two.com\n");
	fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
	assert.equal(a.isAllowed("two.com"), true);
	assert.equal(a.isAllowed("one.com"), false);
});
