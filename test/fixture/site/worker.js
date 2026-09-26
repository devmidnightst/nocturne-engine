fetch("/api/echo?from=worker")
	.then((r) => r.json())
	.then((j) => postMessage({ href: self.location.href, path: j.path }))
	.catch((e) => postMessage({ error: String(e) }));
