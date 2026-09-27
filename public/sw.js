importScripts("/controller/controller.sw.js");

const PREFIX = "/~/sj/";
const WAIT_MS = 8000;
const knownControllers = new Set();
let lastRevive = 0;

self.addEventListener("message", (e) => {
	const init = e.data?.$controller$init;
	if (init && typeof init === "object") knownControllers.add(init.id);
});

async function reviveControllers() {
	if (knownControllers.size > 0 || Date.now() - lastRevive < 1000) return;
	lastRevive = Date.now();
	for (const client of await self.clients.matchAll({ type: "window" })) {
		client.postMessage({ $controller$swrevive: {} });
	}
}

async function routeWhenReady(event) {
	const deadline = Date.now() + WAIT_MS;
	while (!$scramjetController.shouldRoute(event) && Date.now() < deadline) {
		await reviveControllers();
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	if ($scramjetController.shouldRoute(event)) return $scramjetController.route(event);
	return fetch(event.request);
}

self.addEventListener("fetch", (event) => {
	const url = new URL(event.request.url);
	if (url.origin === self.location.origin && url.pathname.startsWith(PREFIX)) {
		event.respondWith(routeWhenReady(event));
	}
});
