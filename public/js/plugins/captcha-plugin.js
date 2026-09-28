const { ManagedPlugin } = globalThis[atob("JHNjcmFtamV0Q29udHJvbGxlcg==")];
const { ScramjetHeaders } = globalThis[atob("JHNjcmFtamV0")];

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
	overlay.id = "__umbrella_captcha_overlay";

	const styles = doc.createElement("style");
	styles.textContent = [
		"#__umbrella_captcha_overlay{position:fixed;bottom:20px;right:20px;z-index:2147483647;font-family:-apple-system,system-ui,sans-serif;max-width:340px}",
		".__uc_card{background:#1a1a2e;color:#e0e0e0;border:1px solid #333;border-radius:12px;padding:16px;box-shadow:0 8px 32px rgba(0,0,0,.4)}",
		".__uc_title{font-size:14px;font-weight:600;margin:0 0 8px;color:#fff;display:flex;align-items:center;gap:8px}",
		".__uc_badge{background:#ff6b35;color:#fff;font-size:10px;padding:2px 6px;border-radius:4px;text-transform:uppercase;font-weight:700}",
		".__uc_text{font-size:12px;color:#aaa;margin:0 0 12px;line-height:1.5}",
		".__uc_actions{display:flex;gap:8px;flex-wrap:wrap}",
		".__uc_btn{border:none;border-radius:8px;padding:8px 14px;font-size:12px;font-weight:600;cursor:pointer;transition:opacity .15s}",
		".__uc_btn:hover{opacity:.85}",
		".__uc_btn--primary{background:#6c5ce7;color:#fff}",
		".__uc_btn--secondary{background:#2d2d44;color:#ccc;border:1px solid #444}",
		".__uc_btn--close{position:absolute;top:8px;right:10px;background:none;border:none;color:#666;font-size:18px;cursor:pointer;padding:4px}",
		".__uc_status{font-size:11px;color:#888;margin-top:8px;min-height:16px}",
	].join("\n");

	const card = doc.createElement("div");
	card.className = "__uc_card";
	card.style.position = "relative";

	const closeBtn = doc.createElement("button");
	closeBtn.className = "__uc_btn--close";
	closeBtn.textContent = "×";
	closeBtn.onclick = () => overlay.remove();

	const title = doc.createElement("div");
	title.className = "__uc_title";
	const badge = doc.createElement("span");
	badge.className = "__uc_badge";
	badge.textContent = info.type;
	title.textContent = "captcha detected ";
	title.appendChild(badge);

	const text = doc.createElement("p");
	text.className = "__uc_text";
	text.textContent = "this page uses a captcha that may not work through the proxy. you can try auto-solving or open the original page.";

	const actions = doc.createElement("div");
	actions.className = "__uc_actions";

	const status = doc.createElement("div");
	status.className = "__uc_status";

	const solveBtn = doc.createElement("button");
	solveBtn.className = "__uc_btn __uc_btn--primary";
	solveBtn.textContent = "try auto-solve";
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

	const openBtn = doc.createElement("button");
	openBtn.className = "__uc_btn __uc_btn--secondary";
	openBtn.textContent = "open original";
	openBtn.onclick = () => {
		win.open(info.pageurl, "_blank");
	};

	const dismissBtn = doc.createElement("button");
	dismissBtn.className = "__uc_btn __uc_btn--secondary";
	dismissBtn.textContent = "dismiss";
	dismissBtn.onclick = () => overlay.remove();

	actions.append(solveBtn, openBtn, dismissBtn);
	card.append(closeBtn, title, text, actions, status);
	overlay.append(styles, card);
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

export class CaptchaPlugin extends ManagedPlugin {
	constructor() {
		super("umbrella-captcha", []);
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
