// `npm run check`: sanity check the install before deploying.
// verifies the pinned versions line up and every scramjet patch still applies.

import fs from "node:fs";
import path from "node:path";
import {
	buildPatchedScramjet,
	buildPatchedControllerInject,
	buildPatchedUtils,
	SCRAMJET_VERSION,
} from "./scramjet-patches.js";
import { buildPatchedLibcurl } from "./libcurl-patches.js";
import { packageDir, packageVersion as version } from "./packages.js";

let failed = false;
const ok = (msg) => console.log(`  ok    ${msg}`);
const bad = (msg) => {
	failed = true;
	console.log(`  FAIL  ${msg}`);
};

console.log("umbrella install check\n");

const sj = version("@mercuryworkshop/scramjet");
sj === SCRAMJET_VERSION ? ok(`scramjet ${sj}`) : bad(`scramjet is ${sj}, patches target ${SCRAMJET_VERSION}`);

// the controller build hard codes the scramjet version it accepts and throws at runtime otherwise
const controllerApi = fs.readFileSync(
	path.join(packageDir("@mercuryworkshop/scramjet-controller"), "dist/controller.api.js"),
	"utf8"
);
const expected = controllerApi.match(/var e="([^"]+)",t=\$scramjet\.versionInfo\.version/)?.[1];
expected === sj
	? ok(`controller ${version("@mercuryworkshop/scramjet-controller")} expects scramjet ${expected}`)
	: bad(`controller expects scramjet ${expected}, installed ${sj}`);

// scramjet-utils 0.0.3 was built against older versions. its plugins work, but
// its getScramjet()/getVersionInfo() helpers throw a version mismatch, so the ui never calls them.
const utils = fs.readFileSync(
	path.join(packageDir("@mercuryworkshop/scramjet-utils"), "dist/scramjet-utils.js"),
	"utf8"
);
const utilsWants = utils.match(/a\("@mercuryworkshop\/scramjet","([^"]+)"/)?.[1];
console.log(`  note  scramjet-utils ${version("@mercuryworkshop/scramjet-utils")} was built against scramjet ${utilsWants} (only its plugins are used)`);

for (const name of ["epoxy-transport", "libcurl-transport", "wisp-js", "proxy-transports"]) {
	ok(`${name} ${version(`@mercuryworkshop/${name}`)}`);
}

for (const [name, build] of [
	["scramjet.js", buildPatchedScramjet],
	["controller.inject.js", buildPatchedControllerInject],
	["scramjet-utils.js", buildPatchedUtils],
	["libcurl.mjs", buildPatchedLibcurl],
]) {
	const { applied, skipped } = build();
	for (const id of applied) ok(`patch ${name}: ${id}`);
	for (const s of skipped) bad(`patch ${name}: ${s.id}: ${s.reason}`);
}

console.log(failed ? "\nsomething is off, see above" : "\nall good");
process.exit(failed ? 1 : 0);
