importScripts("/controller/controller.sw.js");

self.addEventListener("fetch", (event) => {
	if ($scramjetController.shouldRoute(event)) {
		event.respondWith($scramjetController.route(event));
	}
});
