import { value } from "./dep.mjs";
postMessage({ value, href: self.location.href });
