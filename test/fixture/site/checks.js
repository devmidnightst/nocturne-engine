// runs inside the proxied page. every check resolves to true or an error string.
// results land in <pre id="results"> as json so the e2e runner can read them.

(function () {
	var ORIGIN = location.origin;
	var HOST = location.host;
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
		return withTimeout(Promise.resolve().then(fn), 8000).then(
			function (ok) {
				results[name] = ok === true ? true : "failed: " + JSON.stringify(ok);
			},
			function (err) {
				results[name] = "error: " + (err && err.message ? err.message : String(err));
			}
		);
	}

	var checks = [
		check("location is the real site", function () {
			return location.href.indexOf("/~/sj/") === -1 && location.protocol === "http:" ? true : location.href;
		}),
		check("document.domain / origin", function () {
			return document.location.origin === ORIGIN && window.origin === ORIGIN ? true : window.origin;
		}),
		check("fetch relative url", function () {
			return fetch("/api/echo?x=1")
				.then(function (r) {
					return r.json();
				})
				.then(function (j) {
					return j.path === "/api/echo" && j.host === HOST ? true : j;
				});
		}),
		check("fetch sends the site's own referer", function () {
			return fetch("/api/echo")
				.then(function (r) {
					return r.json();
				})
				.then(function (j) {
					return j.referer && j.referer.indexOf(ORIGIN) === 0 ? true : j.referer;
				});
		}),
		check("redirects are followed", function () {
			return fetch("/redirect")
				.then(function (r) {
					return r.json();
				})
				.then(function (j) {
					return j.query === "?redirected=1" ? true : j;
				});
		}),
		check("xhr", function () {
			return new Promise(function (resolve, reject) {
				var x = new XMLHttpRequest();
				x.open("GET", "/api/echo?xhr=1");
				x.onload = function () {
					var j = JSON.parse(x.responseText);
					resolve(j.query === "?xhr=1" ? true : j);
				};
				x.onerror = function () {
					reject(new Error("xhr error"));
				};
				x.send();
			});
		}),
		check("websocket, server speaks first (discord gateway pattern)", function () {
			return new Promise(function (resolve, reject) {
				var ws = new WebSocket("ws://" + HOST + "/ws");
				var gotHello = false;
				ws.onmessage = function (e) {
					var data = JSON.parse(e.data);
					if (data.hello) {
						gotHello = data.origin === ORIGIN || data.origin;
						ws.send(JSON.stringify({ ping: 42 }));
					} else if (data.ping === 42) {
						ws.close();
						resolve(gotHello === true ? true : { origin: gotHello });
					}
				};
				ws.onerror = function () {
					reject(new Error("ws error"));
				};
			});
		}),
		check("json POST with custom headers (discord login)", function () {
			return new Promise(function (resolve, reject) {
				var x = new XMLHttpRequest();
				x.open("POST", "/api/login");
				x.setRequestHeader("Content-Type", "application/json");
				x.setRequestHeader("X-Fingerprint", "fp123");
				x.onload = function () {
					var j = JSON.parse(x.responseText);
					var ok = j.body === '{"login":"a","password":"b"}' && j.type === "application/json" && j.fingerprint === "fp123" && j.origin === ORIGIN;
					resolve(ok ? true : j);
				};
				x.onerror = function () {
					reject(new Error("xhr error"));
				};
				x.send(JSON.stringify({ login: "a", password: "b" }));
			});
		}),
		check("websocket, server close code reaches the page (discord qr login)", function () {
			return new Promise(function (resolve, reject) {
				var ws = new WebSocket("ws://" + HOST + "/ws-close");
				ws.onmessage = function (e) {
					ws.send(JSON.stringify({ op: "init" }));
				};
				ws.onclose = function (e) {
					resolve(e.code === 4003 && e.reason === "timeout" ? true : { code: e.code, reason: e.reason, clean: e.wasClean });
				};
			});
		}),
		check("websocket, page close sends a close frame", function () {
			return new Promise(function (resolve) {
				var ws = new WebSocket("ws://" + HOST + "/ws-close-report");
				ws.onmessage = function () {
					ws.close(4000, "bye");
				};
				ws.onclose = function (e) {
					var mine = { code: e.code, reason: e.reason };
					setTimeout(function () {
						var r = new WebSocket("ws://" + HOST + "/ws-close-result");
						r.onmessage = function (m) {
							var j = JSON.parse(m.data);
							r.close();
							// the page gets its own code back. the server has to see a real close
							// frame (1006 means the connection was just cut). libcurl can only send
							// an empty close frame, so 1005 (no code) is the best it can do.
							var serverOk = j && (j.code === 4000 || j.code === 1005);
							resolve(serverOk && mine.code === 4000 && mine.reason === "bye" ? true : { server: j, page: mine });
						};
					}, 300);
				};
			});
		}),
		check("websocket, dropped connection fires close 1006", function () {
			return new Promise(function (resolve) {
				var ws = new WebSocket("ws://" + HOST + "/ws-drop");
				var opened = false;
				ws.onopen = function () {
					opened = true;
				};
				ws.onclose = function (e) {
					resolve(opened && e.code === 1006 && ws.readyState === 3 ? true : { opened: opened, code: e.code, state: ws.readyState });
				};
			});
		}),
		check("websocket, refused handshake fires error then close", function () {
			return new Promise(function (resolve) {
				var ws = new WebSocket("ws://" + HOST + "/ws-reject");
				var errored = false;
				ws.onerror = function () {
					errored = true;
				};
				ws.onclose = function (e) {
					resolve(errored && e.code === 1006 && ws.readyState === 3 ? true : { errored: errored, code: e.code, state: ws.readyState });
				};
			});
		}),
		check("discord qr login handshake (rsa, close 1000, ticket POST)", function () {
			var subtle = crypto.subtle;
			var b64 = function (buf) {
				return btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));
			};
			var unb64 = function (s) {
				return Uint8Array.from(atob(s), function (c) {
					return c.charCodeAt(0);
				});
			};
			var b64url = function (buf) {
				return b64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
			};
			return subtle
				.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt", "decrypt"])
				.then(function (keys) {
					var decrypt = function (s) {
						return subtle.decrypt({ name: "RSA-OAEP" }, keys.privateKey, unb64(s)).then(function (b) {
							return new TextDecoder().decode(b);
						});
					};
					return new Promise(function (resolve) {
						var ws = new WebSocket("ws://" + HOST + "/ws-qr");
						var seen = [];
						var ticket = null;
						var hb = null;
						ws.onmessage = function (e) {
							var msg = JSON.parse(e.data);
							seen.push(msg.op);
							if (msg.op === "hello") {
								hb = setInterval(function () {
									if (ws.readyState === 1) ws.send('{"op":"heartbeat"}');
								}, msg.heartbeat_interval);
								subtle.exportKey("spki", keys.publicKey).then(function (spki) {
									ws.send(JSON.stringify({ op: "init", encoded_public_key: b64(spki) }));
								});
							} else if (msg.op === "nonce_proof") {
								decrypt(msg.encrypted_nonce)
									.then(function (nonce) {
										return subtle.digest("SHA-256", new TextEncoder().encode(nonce));
									})
									.then(function (hash) {
										ws.send(JSON.stringify({ op: "nonce_proof", proof: b64url(hash) }));
									});
							} else if (msg.op === "pending_login") {
								ticket = msg.ticket;
							}
						};
						ws.onclose = function (e) {
							clearInterval(hb);
							// discord only trades the ticket when the gateway finished cleanly
							if (e.code !== 1000 || !ticket) return resolve({ code: e.code, reason: e.reason, seen: seen });
							fetch("/api/remote-auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket: ticket }) })
								.then(function (r) {
									return r.json();
								})
								.then(function (j) {
									return decrypt(j.encrypted_token);
								})
								.then(function (token) {
									resolve(token === "token-" + ticket ? true : { token: token });
								}, function (err) {
									resolve("ticket exchange failed: " + err);
								});
						};
					});
				});
		}),
		check("cookies round trip", function () {
			return fetch("/api/setcookie")
				.then(function () {
					return fetch("/api/echo");
				})
				.then(function (r) {
					return r.json();
				})
				.then(function (j) {
					var ok = (j.cookie || "").indexOf("nocturne_test=yes") !== -1 && document.cookie.indexOf("nocturne_test=yes") !== -1;
					return ok ? true : { server: j.cookie, doc: document.cookie };
				});
		}),
		check("classic worker", function () {
			return new Promise(function (resolve) {
				var w = new Worker("/worker.js");
				w.onmessage = function (e) {
					resolve(e.data.path === "/api/echo" && e.data.href === ORIGIN + "/worker.js" ? true : e.data);
				};
				w.onerror = function (e) {
					resolve("worker error " + (e.message || ""));
				};
			});
		}),
		check("module worker", function () {
			return new Promise(function (resolve) {
				var w = new Worker("/mworker.mjs", { type: "module" });
				w.onmessage = function (e) {
					resolve(e.data.value === "dep-ok" ? true : e.data);
				};
				w.onerror = function (e) {
					resolve("worker error " + (e.message || ""));
				};
			});
		}),
		check("blob worker", function () {
			return new Promise(function (resolve) {
				var src = "postMessage(self.location.protocol + '|' + typeof fetch)";
				var w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
				w.onmessage = function (e) {
					resolve(e.data === "blob:|function" ? true : e.data);
				};
				w.onerror = function (e) {
					resolve("worker error " + (e.message || ""));
				};
			});
		}),
		check("dynamic import()", function () {
			return import("/lazy.mjs").then(function (m) {
				return m.default === "lazy-ok" ? true : m;
			});
		}),
		check("static es module graph", function () {
			return new Promise(function (resolve) {
				var tries = 0;
				(function poll() {
					if (window.__moduleValue === "dep-ok") return resolve(true);
					if (++tries > 40) return resolve(String(window.__moduleValue));
					setTimeout(poll, 100);
				})();
			});
		}),
		check("eval sees the real location", function () {
			// indirect eval so the rewriter has to handle it at runtime
			var e = eval;
			return e("location.host") === HOST ? true : e("location.host");
		}),
		check("new Function sees the real location", function () {
			return new Function("return location.origin")() === ORIGIN ? true : "wrong";
		}),
		check("history.pushState keeps the real path", function () {
			history.pushState({}, "", "/pushed?a=1");
			var ok = location.pathname === "/pushed" && location.search === "?a=1";
			history.replaceState({}, "", "/");
			return ok ? true : location.href;
		}),
		check("toString returns original source", function () {
			var fn = function () {
				return location.href;
			};
			var s = fn.toString();
			return s.indexOf("$scramjet") === -1 && s.indexOf("location.href") !== -1 ? true : s;
		}),
		check("keyword glue (scramjet #185)", function () {
			var g = window.__glue;
			return g && g.returnOk && g.typeofOk ? true : g ? { returnOk: g.returnOk, typeofOk: g.typeofOk } : "glue.js did not run";
		}),
		check("setAttribute with a non string name (scramjet #184)", function () {
			// the dom coerces the name to a string. scramjet used to call .toLowerCase() on it and throw
			var d = document.createElement("div");
			d.setAttribute({ toString: function () { return "data-n"; } }, "x");
			return d.getAttribute("data-n") === "x" ? true : d.outerHTML;
		}),
		check("same origin child iframe", function () {
			return new Promise(function (resolve) {
				function onMsg(e) {
					if (!e.data || !e.data.child) return;
					window.removeEventListener("message", onMsg);
					resolve(e.data.child === ORIGIN + "/child.html" && e.data.parentHost === HOST ? true : e.data);
				}
				window.addEventListener("message", onMsg);
				document.getElementById("child").src = "/child.html";
			});
		}),
	];

	Promise.all(checks).then(function () {
		document.getElementById("results").textContent = JSON.stringify(results, null, 1);
		document.title = "fixture done";
	});
})();
