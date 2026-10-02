import { settings, _dsu } from "./store.js";

export const _R7 = [
	"wss://meowing.mintymints.org/wisp/",
	"wss://korona.thewhitedoveschools.org/wisp/",
	"wss://math-test-k.2805hammandrive.shop/wisp/",
	"wss://math-test-k.akanesucks.cfd/wisp/",
	"wss://math-test-k.cloudmoon.cfd/wisp/",
	"wss://math-test-k.deltarune.cfd/wisp/",
	"wss://math-test-k.diddy.mom/wisp/",
	"wss://math-test-k.dylanis.online/wisp/",
	"wss://math-test-k.dylanmcisass.cfd/wisp/",
	"wss://math-test-k.frogette.cfd/wisp/",
	"wss://math-test-k.frogiee1.cfd/wisp/",
	"wss://math-test-k.frogiesrcade.cfd/wisp/",
	"wss://math-test-k.fucksolo.shop/wisp/",
	"wss://math-test-k.genizy.cfd/wisp/",
	"wss://math-test-k.gn-math.best/wisp/",
	"wss://math-test-k.gn-math.cc/wisp/",
	"wss://math-test-k.gn-math.cfd/wisp/",
	"wss://math-test-k.gn-math.works/wisp/",
	"wss://math-test-k.goguardiansucks.cfd/wisp/",
	"wss://math-test-k.goguardiansucks.shop/wisp/",
	"wss://math-test-k.gooningfor.life/wisp/",
	"wss://math-test-k.hiluminal.cfd/wisp/",
	"wss://math-test-k.hpsschools.org/wisp/",
	"wss://math-test-k.lightspeedisass.shop/wisp/",
	"wss://math-test-k.lightspeedisgay.cfd/wisp/",
	"wss://math-test-k.merrychristmas.cfd/wisp/",
	"wss://math-test-k.recat.cfd/wisp/",
	"wss://math-test-k.recat.life/wisp/",
	"wss://math-test-k.recat.shop/wisp/",
	"wss://math-test-k.sealiesarcade.cfd/wisp/",
	"wss://math-test-k.thewhitedoveschools.org/wisp/",
	"wss://math-test-k.ticonverter.lol/wisp/",
	"wss://math-test-k.useanko.xyz/wisp/",
	"wss://math-test-k.useawp.cfd/wisp/",
	"wss://math-test-k.v2.quest/wisp/",
];

const CACHE_KEY = "_p8q2:nr";
const PROBE_TIMEOUT = 1500;
const SAMPLE_SIZE = 10;
const bad = new Set();

function readCache() {
	try {
		return sessionStorage.getItem(CACHE_KEY) || "";
	} catch {
		return "";
	}
}

function writeCache(url) {
	try {
		if (url) sessionStorage.setItem(CACHE_KEY, url);
		else sessionStorage.removeItem(CACHE_KEY);
	} catch {}
}

export function probe(url, timeout = PROBE_TIMEOUT) {
	return new Promise((resolve, reject) => {
		let ws;
		const started = performance.now();
		const finish = (ok, value) => {
			clearTimeout(timer);
			try {
				ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
				ws.close();
			} catch {}
			ok ? resolve(value) : reject(value);
		};
		const timer = setTimeout(() => finish(false, new Error(`timeout ${url}`)), timeout);
		try {
			ws = new WebSocket(url);
		} catch (err) {
			return finish(false, err);
		}
		ws.binaryType = "arraybuffer";
		ws.onmessage = (e) => {
			const first = e.data instanceof ArrayBuffer ? new Uint8Array(e.data)[0] : -1;
			if (first === 3) finish(true, { url, ms: Math.round(performance.now() - started) });
			else finish(false, new Error(`bad endpoint ${url}`));
		};
		ws.onerror = () => finish(false, new Error(`error ${url}`));
		ws.onclose = () => finish(false, new Error(`closed ${url}`));
	});
}

function sample(list, n) {
	const copy = list.slice();
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[copy[i], copy[j]] = [copy[j], copy[i]];
	}
	return copy.slice(0, n);
}

export function _nrx(url) {
	if (!url) return;
	bad.add(url);
	if (readCache() === url) writeCache("");
}

export function _nrc() {
	return readCache();
}

let _nrpP = null;

export function _nrp() {
	if (_nrpP) return _nrpP;
	_nrpP = _doNrp().finally(() => { _nrpP = null; });
	return _nrpP;
}

async function _doNrp() {
	const own = _dsu();
	const cached = readCache();
	if (cached && !bad.has(cached)) {
		try {
			await probe(cached, 1500);
			return cached;
		} catch {
			_nrx(cached);
		}
	}
	let remaining = _R7.filter((u) => !bad.has(u));
	const firstBatch = [own, ...sample(remaining, SAMPLE_SIZE)];
	remaining = remaining.filter((u) => !firstBatch.includes(u));
	try {
		const { url } = await Promise.any(firstBatch.map((u) => probe(u).catch((err) => (bad.add(u), Promise.reject(err)))));
		if (url !== own) writeCache(url);
		return url;
	} catch {}
	while (remaining.length) {
		const batch = sample(remaining, SAMPLE_SIZE);
		remaining = remaining.filter((u) => !batch.includes(u));
		try {
			const { url } = await Promise.any(batch.map((u) => probe(u).catch((err) => (bad.add(u), Promise.reject(err)))));
			writeCache(url);
			return url;
		} catch {}
	}
	return own;
}

export async function _nr() {
	const custom = (settings.get()._srvUrl || "").trim();
	if (custom) return custom;
	return _nrp();
}
