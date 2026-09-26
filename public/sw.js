// nocturne engine service worker.
//
// scramjet 2.x moved all the heavy lifting (rewriting, cookies, transports) out
// of the service worker and into the controller that lives in the shell page.
// this worker only routes requests under the controller prefix (/~/sj/...) to
// the right controller tab over a MessageChannel.

importScripts("/controller/controller.sw.js");

self.addEventListener("fetch", (event) => {
	if ($scramjetController.shouldRoute(event)) {
		event.respondWith($scramjetController.route(event));
	}
});
