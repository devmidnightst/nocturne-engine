// audio playback checks, run inside the proxied page. these are the paths
// music sites use: a plain <audio> that streams with range requests, media
// source extensions fed from fetch (youtube music), web audio, and eme.

(function () {
	var results = {};

	function withTimeout(p, ms) {
		return Promise.race([
			p,
			new Promise(function (_, reject) {
				setTimeout(function () {
					reject(new Error("timed out"));
				}, ms);
			}),
		]);
	}

	function check(name, fn) {
		return withTimeout(Promise.resolve().then(fn), 15000).then(
			function (ok) {
				results[name] = ok === true ? true : "failed: " + JSON.stringify(ok);
			},
			function (err) {
				results[name] = "error: " + (err && err.message ? err.message : String(err));
			}
		);
	}

	// resolves once the element has actually played past `until` seconds
	function playsTo(el, until) {
		return new Promise(function (resolve) {
			el.muted = true;
			el.addEventListener("error", function () {
				var e = el.error;
				resolve("media error " + (e ? e.code + " " + e.message : "?"));
			});
			el.addEventListener("timeupdate", function () {
				if (el.currentTime >= until) resolve(true);
			});
			var p = el.play();
			if (p && p.catch)
				p.catch(function (err) {
					resolve("play() rejected: " + err.name + " " + err.message);
				});
		});
	}

	function mseFeed(fetchSegment) {
		var type = 'audio/webm; codecs="opus"';
		if (!window.MediaSource || !MediaSource.isTypeSupported(type)) return Promise.resolve("no mse support for " + type);
		var ms = new MediaSource();
		var audio = new Audio();
		var url = URL.createObjectURL(ms);
		audio.src = url;
		return new Promise(function (resolve) {
			ms.addEventListener("sourceopen", function () {
				var sb = ms.addSourceBuffer(type);
				fetchSegment()
					.then(function (buf) {
						sb.addEventListener("updateend", function () {
							if (ms.readyState === "open") ms.endOfStream();
							playsTo(audio, 1).then(resolve);
						});
						sb.appendBuffer(buf);
					})
					.catch(function (err) {
						resolve("segment fetch failed: " + err.message);
					});
			});
			audio.addEventListener("error", function () {
				resolve("media error before sourceopen " + (audio.error && audio.error.code));
			});
		});
	}

	var checks = [
		check("media: <audio> streams a file with range requests", function () {
			var a = document.createElement("audio");
			a.src = "/media/tone.wav";
			document.body.appendChild(a);
			return playsTo(a, 1);
		}),
		check("media: <audio> seeks (range from the middle)", function () {
			var a = new Audio("/media/tone.webm");
			return new Promise(function (resolve) {
				a.addEventListener("loadedmetadata", function () {
					a.currentTime = 2;
					playsTo(a, 2.5).then(resolve);
				});
				a.addEventListener("error", function () {
					resolve("media error " + (a.error && a.error.code));
				});
			});
		}),
		check("media: fetch keeps the Range header", function () {
			return fetch("/api/range-echo", { headers: { Range: "bytes=10-20" } })
				.then(function (r) {
					return r.json();
				})
				.then(function (j) {
					return j.range === "bytes=10-20" ? true : j;
				});
		}),
		check("media: fetch gets a 206 back", function () {
			return fetch("/media/tone.webm", { headers: { Range: "bytes=0-99" } }).then(function (r) {
				return r.arrayBuffer().then(function (b) {
					return r.status === 206 && b.byteLength === 100 ? true : { status: r.status, len: b.byteLength, cr: r.headers.get("content-range") };
				});
			});
		}),
		check("media: range request after a full download of the same file", function () {
			// music players fetch audio files from cdns in byte ranges. once a full
			// copy is in the proxy's http cache, a range request must still get
			// just its range back, not the whole file.
			return fetch("/media/cdn.webm")
				.then(function (r) {
					return r.arrayBuffer();
				})
				.then(function () {
					return fetch("/media/cdn.webm", { headers: { Range: "bytes=100-199" } });
				})
				.then(function (r) {
					return r.arrayBuffer().then(function (b) {
						return r.status === 206 && b.byteLength === 100 ? true : { status: r.status, len: b.byteLength };
					});
				});
		}),
		check("media: live stream starts before it ends", function () {
			// internet radio never finishes its response, the first bytes have to
			// reach the page right away
			var ac = new AbortController();
			return withTimeout(
				fetch("/media/live", { signal: ac.signal }).then(function (r) {
					return r.body
						.getReader()
						.read()
						.then(function (x) {
							ac.abort();
							return x.value && x.value.length > 0 ? true : "empty first read";
						});
				}),
				5000
			).catch(function (err) {
				ac.abort();
				throw err;
			});
		}),
		check("media: currentSrc is the real url", function () {
			var a = new Audio("/media/tone.wav");
			return new Promise(function (resolve) {
				a.addEventListener("loadedmetadata", function () {
					resolve(a.currentSrc === location.origin + "/media/tone.wav" ? true : a.currentSrc);
				});
				a.addEventListener("error", function () {
					resolve("media error " + (a.error && a.error.code));
				});
			});
		}),
		check("media: mse fed from a GET", function () {
			return mseFeed(function () {
				return fetch("/media/tone.webm").then(function (r) {
					return r.arrayBuffer();
				});
			});
		}),
		check("media: mse fed from a binary POST (youtube videoplayback)", function () {
			return mseFeed(function () {
				var body = new Uint8Array(512);
				for (var i = 0; i < body.length; i++) body[i] = i & 0xff;
				return fetch("/api/videoplayback?itag=251", { method: "POST", body: body }).then(function (r) {
					if (r.headers.get("x-body-length") !== "512") throw new Error("server got " + r.headers.get("x-body-length") + " body bytes");
					return r.arrayBuffer();
				});
			});
		}),
		check("media: mse fed from a streamed fetch body", function () {
			return mseFeed(function () {
				return fetch("/media/tone.webm").then(function (r) {
					var reader = r.body.getReader();
					var parts = [];
					var total = 0;
					return (function pump() {
						return reader.read().then(function (x) {
							if (x.done) {
								var out = new Uint8Array(total);
								var o = 0;
								parts.forEach(function (p) {
									out.set(p, o);
									o += p.length;
								});
								return out;
							}
							parts.push(x.value);
							total += x.value.length;
							return pump();
						});
					})();
				});
			});
		}),
		check("media: mse fed from xhr arraybuffer", function () {
			return mseFeed(function () {
				return new Promise(function (resolve, reject) {
					var x = new XMLHttpRequest();
					x.open("GET", "/media/tone.webm");
					x.responseType = "arraybuffer";
					x.onload = function () {
						resolve(x.response);
					};
					x.onerror = function () {
						reject(new Error("xhr error"));
					};
					x.send();
				});
			});
		}),
		check("media: media element src reads back what was set", function () {
			var ms = new MediaSource();
			var url = URL.createObjectURL(ms);
			var a = new Audio();
			a.src = url;
			var ok = a.src === url;
			var viaAttr = a.getAttribute("src") === url;
			URL.revokeObjectURL(url);
			return ok && viaAttr ? true : { set: url, prop: a.src, attr: a.getAttribute("src") };
		}),
		check("media: blob url audio", function () {
			return fetch("/media/tone.webm")
				.then(function (r) {
					return r.blob();
				})
				.then(function (b) {
					var a = new Audio(URL.createObjectURL(b));
					return playsTo(a, 1);
				});
		}),
		check("media: web audio decodes fetched audio", function () {
			var ctx = new (window.AudioContext || window.webkitAudioContext)();
			return fetch("/media/tone.webm")
				.then(function (r) {
					return r.arrayBuffer();
				})
				.then(function (b) {
					return ctx.decodeAudioData(b);
				})
				.then(function (buf) {
					ctx.close();
					return buf.duration > 3 ? true : buf.duration;
				});
		}),
		check("media: eme clearkey is available", function () {
			if (!navigator.requestMediaKeySystemAccess) return "no eme";
			return navigator
				.requestMediaKeySystemAccess("org.w3.clearkey", [
					{ initDataTypes: ["webm"], audioCapabilities: [{ contentType: 'audio/webm; codecs="opus"' }] },
				])
				.then(function (access) {
					return access.createMediaKeys();
				})
				.then(function (keys) {
					return keys ? true : "no keys";
				});
		}),
	];

	Promise.all(checks).then(function () {
		document.getElementById("results").textContent = JSON.stringify(results, null, 1);
		document.title = "media done";
	});
})();
