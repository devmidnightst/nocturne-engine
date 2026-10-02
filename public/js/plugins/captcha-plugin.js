const { ManagedPlugin } = globalThis[atob("JHNjcmFtamV0Q29udHJvbGxlcg==")];
const { [atob("U2NyYW1qZXRIZWFkZXJz")]: _SH } = globalThis[atob("JHNjcmFtamV0")];

const CAPTCHA_SCRIPT_PATTERNS = [
	{ pattern: /hcaptcha\.com\/1\/api\.js/i, type: "hcaptcha" },
	{ pattern: /js\.hcaptcha\.com/i, type: "hcaptcha" },
	{ pattern: /google\.com\/recaptcha\/api\.js/i, type: "recaptcha2" },
	{ pattern: /gstatic\.com\/recaptcha/i, type: "recaptcha2" },
	{ pattern: /recaptcha\.net\/recaptcha/i, type: "recaptcha2" },
	{ pattern: /challenges\.cloudflare\.com/i, type: "turnstile" },
];

const CAPTCHA_SELECTORS = {
	hcaptcha: [".h-captcha", "[data-hcaptcha-widget-id]", "iframe[src*='hcaptcha']"],
	recaptcha2: [".g-recaptcha", "[data-sitekey]", "iframe[src*='recaptcha']"],
	turnstile: [".cf-turnstile", "[data-turnstile-widget-id]", "iframe[src*='turnstile']"],
};

function detectCaptchaType(url) {
	for (const { pattern, type } of CAPTCHA_SCRIPT_PATTERNS) {
		if (pattern.test(url)) return type;
	}
	return null;
}

function extractSitekey(doc, type) {
	const selectors = CAPTCHA_SELECTORS[type] || [];
	for (const sel of selectors) {
		try {
			const el = doc.querySelector(sel);
			if (!el) continue;
			const key = el.getAttribute("data-sitekey") || el.dataset.sitekey;
			if (key) return key;
		} catch {}
	}
	return null;
}

function createOverlay(win, doc, info) {
	const overlay = doc.createElement("div");
	Object.assign(overlay.style, {
		position: "fixed", bottom: "20px", right: "20px", zIndex: "2147483647",
		fontFamily: "-apple-system,system-ui,sans-serif", maxWidth: "340px",
	});

	const card = doc.createElement("div");
	Object.assign(card.style, {
		background: "#1a1a2e", color: "#e0e0e0", border: "1px solid #333",
		borderRadius: "12px", padding: "16px", boxShadow: "0 8px 32px rgba(0,0,0,.4)",
		position: "relative",
	});

	const closeBtn = doc.createElement("button");
	Object.assign(closeBtn.style, {
		position: "absolute", top: "8px", right: "10px", background: "none",
		border: "none", color: "#666", fontSize: "18px", cursor: "pointer", padding: "4px",
	});
	closeBtn.textContent = "×";
	closeBtn.onclick = () => overlay.remove();

	const title = doc.createElement("div");
	Object.assign(title.style, {
		fontSize: "14px", fontWeight: "600", margin: "0 0 8px", color: "#fff",
		display: "flex", alignItems: "center", gap: "8px",
	});
	const badge = doc.createElement("span");
	Object.assign(badge.style, {
		background: "#ff6b35", color: "#fff", fontSize: "10px", padding: "2px 6px",
		borderRadius: "4px", textTransform: "uppercase", fontWeight: "700",
	});
	badge.textContent = info.type;
	title.textContent = "captcha detected ";
	title.appendChild(badge);

	const text = doc.createElement("p");
	Object.assign(text.style, {
		fontSize: "12px", color: "#aaa", margin: "0 0 12px", lineHeight: "1.5",
	});
	text.textContent = "this page uses a captcha that may not work here. you can try auto-solving.";

	const actions = doc.createElement("div");
	Object.assign(actions.style, { display: "flex", gap: "8px", flexWrap: "wrap" });

	const status = doc.createElement("div");
	Object.assign(status.style, {
		fontSize: "11px", color: "#888", marginTop: "8px", minHeight: "16px",
	});

	const btnBase = {
		border: "none", borderRadius: "8px", padding: "8px 14px",
		fontSize: "12px", fontWeight: "600", cursor: "pointer",
	};

	const solveBtn = doc.createElement("button");
	Object.assign(solveBtn.style, { ...btnBase, background: "#6c5ce7", color: "#fff" });
	solveBtn.textContent = "try auto-solve";
	solveBtn.onmouseenter = () => { solveBtn.style.opacity = "0.85"; };
	solveBtn.onmouseleave = () => { solveBtn.style.opacity = "1"; };
	solveBtn.onclick = async () => {
		solveBtn.disabled = true;
		status.textContent = "checking solver...";
		try {
			const check = await win.fetch("/api/captcha/status");
			const st = await check.json();
			if (!st.available) {
				status.textContent = "no solver configured. set CAPTCHA_SOLVER + CAPTCHA_API_KEY env vars on the server.";
				solveBtn.disabled = false;
				return;
			}
			status.textContent = `solving with ${st.solver}...`;
			const res = await win.fetch("/api/captcha/solve", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ type: info.type, sitekey: info.sitekey, pageurl: info.pageurl }),
			});
			const result = await res.json();
			if (!res.ok) throw new Error(result.error);
			status.textContent = "solved! injecting token...";
			injectToken(doc, info.type, result.token);
			setTimeout(() => overlay.remove(), 2000);
		} catch (err) {
			status.textContent = "failed: " + err.message;
			solveBtn.disabled = false;
		}
	};

	const dismissBtn = doc.createElement("button");
	Object.assign(dismissBtn.style, {
		...btnBase, background: "#2d2d44", color: "#ccc", border: "1px solid #444",
	});
	dismissBtn.textContent = "dismiss";
	dismissBtn.onmouseenter = () => { dismissBtn.style.opacity = "0.85"; };
	dismissBtn.onmouseleave = () => { dismissBtn.style.opacity = "1"; };
	dismissBtn.onclick = () => overlay.remove();

	actions.append(solveBtn, dismissBtn);
	card.append(closeBtn, title, text, actions, status);
	overlay.appendChild(card);
	return overlay;
}

function injectToken(doc, type, token) {
	if (type === "hcaptcha") {
		const textarea = doc.querySelector("textarea[name='h-captcha-response']");
		if (textarea) {
			textarea.value = token;
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		}
		const iframe = doc.querySelector("iframe[data-hcaptcha-widget-id]");
		if (iframe) iframe.setAttribute("data-hcaptcha-response", token);
		try {
			if (typeof doc.defaultView.hcaptcha !== "undefined") {
				const id = doc.querySelector(".h-captcha")?.dataset?.hcaptchaWidgetId;
				if (id) doc.defaultView.hcaptcha?.setResponse?.(token, id);
			}
		} catch {}
	} else if (type === "recaptcha2" || type === "recaptcha3") {
		const textarea = doc.querySelector("textarea#g-recaptcha-response") ||
			doc.querySelector("textarea[name='g-recaptcha-response']");
		if (textarea) {
			textarea.style.display = "block";
			textarea.value = token;
			textarea.style.display = "none";
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		}
		try {
			const cb = doc.querySelector(".g-recaptcha")?.dataset?.callback;
			if (cb && typeof doc.defaultView[cb] === "function") doc.defaultView[cb](token);
		} catch {}
	} else if (type === "turnstile") {
		const input = doc.querySelector("input[name='cf-turnstile-response']");
		if (input) {
			input.value = token;
			input.dispatchEvent(new Event("input", { bubbles: true }));
		}
	}
	const forms = doc.querySelectorAll("form");
	for (const form of forms) {
		form.dispatchEvent(new Event("change", { bubbles: true }));
	}
}

export class _CP extends ManagedPlugin {
	constructor() {
		super("_cp8", []);
		this._detected = new WeakSet();
	}

	install(frame) {
		super.install(frame);

		this.tap(frame.hooks.init.post, ({ window: win, client, isTopLevel }) => {
			if (!isTopLevel) return;

			const doc = win.document;
			const pageurl = client.url.href;
			const seen = new Set();

			const scan = () => {
				for (const [type, selectors] of Object.entries(CAPTCHA_SELECTORS)) {
					for (const sel of selectors) {
						try {
							const el = doc.querySelector(sel);
							if (!el || seen.has(type)) continue;
							seen.add(type);
							const sitekey = extractSitekey(doc, type);
							const overlay = createOverlay(win, doc, { type, sitekey, pageurl });
							doc.body.appendChild(overlay);
						} catch {}
					}
				}
			};

			const listen = (target, type, fn) => {
				try {
					target.addEventListener(type, fn);
				} catch {}
			};

			listen(win, "DOMContentLoaded", () => {
				scan();
				try {
					new win.MutationObserver(() => scan()).observe(doc.body || doc.documentElement, {
						childList: true,
						subtree: true,
					});
				} catch {}
			});

			listen(win, "load", scan);
		});
	}
}
