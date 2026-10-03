const { ManagedPlugin } = globalThis[atob("JHNjcmFtamV0Q29udHJvbGxlcg==")];

const MEDIA_EVENTS = ["play", "playing", "pause", "ended", "emptied", "volumechange", "durationchange", "seeked"];

const isMedia = (el) => !!el && (el.tagName === "VIDEO" || el.tagName === "AUDIO");

export class _MW extends ManagedPlugin {
	constructor(onChange) {
		super("_mw2", []);
		this.onChange = onChange;
		this.els = new Set();
		this.ours = new WeakSet();
		this.heard = new WeakSet();
		this.listen = new WeakMap();
		this.handlers = new WeakMap();
		this.muted = false;
		this.last = null;
		this.pending = false;
	}

	install(frame) {
		super.install(frame);
		this.tap(frame.hooks.init.post, ({ window: win, client }) => {
			try {
				this.listen.set(win, (target, type, fn, capture) => {
					try {
						client.natives.call("EventTarget.prototype.addEventListener", target, type, fn, capture);
					} catch {
						target.addEventListener(type, fn, capture);
					}
				});
				this.watch(win);
			} catch {
			}
		});
	}

	watch(win) {
		const self = this;
		const proto = win.HTMLMediaElement?.prototype;
		if (proto) {
			proto.play = new win.Proxy(proto.play, {
				apply(target, el, args) {
					self.add(el);
					return Reflect.apply(target, el, args);
				},
			});
		}
		const ms = win.MediaSession?.prototype;
		if (ms) {
			ms.setActionHandler = new win.Proxy(ms.setActionHandler, {
				apply(target, session, args) {
					try {
						let map = self.handlers.get(session);
						if (!map) self.handlers.set(session, (map = new Map()));
						if (typeof args[1] === "function") map.set(args[0], args[1]);
						else map.delete(args[0]);
					} catch {
					}
					return Reflect.apply(target, session, args);
				},
			});
		}
		this.listen.get(win)(win.document, "play", (e) => isMedia(e.target) && this.add(e.target, true), true);
	}

	add(el, started = false) {
		if (!isMedia(el)) return;
		if (!this.els.has(el)) {
			this.els.add(el);
			const listen = this.listen.get(el.ownerDocument?.defaultView) ?? ((t, type, fn) => t.addEventListener(type, fn));
			for (const type of MEDIA_EVENTS) listen(el, type, (e) => this.event(el, e.type));
		}
		if (started) this.event(el, "play");
	}

	event(el, type) {
		if (type === "play" || type === "playing") {
			this.last = el;
			if (this.muted && !el.muted) {
				el.muted = true;
				this.ours.add(el);
			}
		}
		if (!el.paused && el.volume > 0 && (!el.muted || this.ours.has(el))) this.heard.add(el);
		if (type === "volumechange" && !el.muted && this.ours.has(el)) {
			this.ours.delete(el);
			if (![...this.els].some((e) => this.ours.has(e))) this.muted = false;
			if (!el.paused && el.volume > 0) this.heard.add(el);
		}
		this.changed();
	}

	changed() {
		if (this.pending) return;
		this.pending = true;
		setTimeout(() => {
			this.pending = false;
			this.onChange?.();
		}, 50);
	}

	prune() {
		for (const el of this.els) {
			let alive = false;
			try {
				alive = !!el.ownerDocument?.defaultView && (el.isConnected || !el.paused);
			} catch {
			}
			if (!alive || (el.ended && !el.isConnected)) {
				this.els.delete(el);
				if (this.last === el) this.last = null;
			}
		}
	}

	main() {
		this.prune();
		const list = [...this.els].filter((e) => this.heard.has(e));
		const playing = list.filter((e) => !e.paused && !e.ended);
		if (this.last && this.heard.has(this.last) && this.els.has(this.last) && !this.last.ended) return this.last;
		return playing[0] ?? list.find((e) => !e.ended && e.currentTime > 0) ?? null;
	}

	session(el) {
		const win = el.ownerDocument?.defaultView;
		const ms = win?.navigator?.mediaSession;
		return { win, ms, actions: (ms && this.handlers.get(ms)) || new Map() };
	}

	state() {
		const el = this.main();
		if (!el) return null;
		const playing = [...this.els].filter((e) => this.heard.has(e) && !e.paused && !e.ended);
		const { win, ms, actions } = this.session(el);
		let title = "";
		let artist = "";
		try {
			title = ms?.metadata?.title || "";
			artist = ms?.metadata?.artist || "";
			if (!title) title = win?.document?.title || "";
		} catch {
		}
		const duration = Number.isFinite(el.duration) ? el.duration : 0;
		return {
			playing: !el.paused && !el.ended,
			audible: playing.some((e) => !e.muted && e.volume > 0),
			muted: this.muted && playing.length > 0,
			title,
			artist,
			time: el.currentTime || 0,
			duration,
			live: el.duration === Infinity,
			canPrev: actions.has("previoustrack"),
			canNext: actions.has("nexttrack"),
			canPip: el.tagName === "VIDEO" && el.videoWidth > 0 && !!win?.document?.pictureInPictureEnabled && !el.disablePictureInPicture,
			pip: !!win?.document?.pictureInPictureElement,
		};
	}

	toggle() {
		const el = this.main();
		if (!el) return;
		if (el.paused || el.ended) el.play()?.catch?.(() => {});
		else el.pause();
	}

	seek(time) {
		const el = this.main();
		if (el && Number.isFinite(el.duration)) el.currentTime = Math.max(0, Math.min(time, el.duration));
	}

	action(name) {
		const el = this.main();
		if (!el) return;
		const fn = this.session(el).actions.get(name);
		try {
			fn?.({ action: name });
		} catch {
		}
	}

	setMuted(on) {
		this.muted = on;
		for (const el of this.els) {
			if (on && !el.muted) {
				el.muted = true;
				this.ours.add(el);
			} else if (!on && this.ours.has(el)) {
				this.ours.delete(el);
				el.muted = false;
			}
		}
		this.changed();
	}

	async pip() {
		const el = this.main();
		if (!el) return;
		const doc = el.ownerDocument;
		try {
			if (doc.pictureInPictureElement) await doc.exitPictureInPicture();
			else if (el.tagName === "VIDEO") await el.requestPictureInPicture();
		} catch {
		}
		this.changed();
	}
}
