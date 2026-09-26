// preloaded into the server by scripts/soak.mjs (node --import). answers
// "soak:stats" over the ipc channel with memory numbers taken right after a
// full gc, so a slowly growing heap shows up as a real trend and not gc noise.

process.on("message", (msg) => {
	if (msg !== "soak:stats") return;
	globalThis.gc?.();
	const mem = process.memoryUsage();
	process.send?.({
		type: "soak:stats",
		rss: mem.rss,
		heapUsed: mem.heapUsed,
		external: mem.external,
		arrayBuffers: mem.arrayBuffers,
		resources: process.getActiveResourcesInfo().length,
	});
});
