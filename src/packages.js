// resolve an installed package's folder even when its "exports" map hides
// package.json (scramjet and the controller both do that).

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function packageDir(name) {
	for (const base of require.resolve.paths(name) ?? []) {
		const dir = path.join(base, name);
		if (fs.existsSync(path.join(dir, "package.json"))) return dir;
	}
	throw new Error(`package ${name} is not installed, run npm install`);
}

export function packageVersion(name) {
	return JSON.parse(fs.readFileSync(path.join(packageDir(name), "package.json"), "utf8")).version;
}
