const { ManagedPlugin } = globalThis[atob("JHNjcmFtamV0Q29udHJvbGxlcg==")];

const HIDDEN_PREFIXES = [atob("JHNjcmFtamV0"), "__nc_", "_p8q2"];
const HIDDEN_IDB_NAMES = [atob("c2NyYW1qZXQtaHR0cC1jYWNoZQ=="), atob("c2NyYW1qZXQtaHR0cC1jYWNoZS12Mg==")];

function shouldHide(name) {
	if (typeof name !== "string") return false;
	for (let i = 0; i < HIDDEN_PREFIXES.length; i++) {
		if (name.startsWith(HIDDEN_PREFIXES[i])) return true;
	}
	return false;
}

export class _CK extends ManagedPlugin {
	constructor() {
		super("_ck7", []);
	}

	install(frame) {
		super.install(frame);

		this.tap(frame.hooks.init.post, ({ window: win, client, isTopLevel }) => {
			try { this._cloakGlobals(win); } catch {}
			try { this._cloakIDB(win); } catch {}
			try { this._cloakNavigator(win); } catch {}
			try { this._cloakPerformance(win); } catch {}
		});
	}

	_cloakGlobals(win) {
		const descriptors = Object.getOwnPropertyDescriptors(win);
		for (const key of Object.keys(descriptors)) {
			if (shouldHide(key)) {
				try {
					Object.defineProperty(win, key, {
						...descriptors[key],
						enumerable: false,
					});
				} catch {}
			}
		}

		const nativeKeys = Object.keys;
		Object.defineProperty(Object, "keys", {
			value: function keys(obj) {
				const result = nativeKeys.call(this, obj);
				if (obj === win || obj === win.self) {
					return result.filter((k) => !shouldHide(k));
				}
				return result;
			},
			writable: true,
			configurable: true,
		});

		const nativeGetOwnNames = Object.getOwnPropertyNames;
		Object.defineProperty(Object, "getOwnPropertyNames", {
			value: function getOwnPropertyNames(obj) {
				const result = nativeGetOwnNames.call(this, obj);
				if (obj === win || obj === win.self) {
					return result.filter((k) => !shouldHide(k));
				}
				return result;
			},
			writable: true,
			configurable: true,
		});

		const nativeGetOwnDesc = Object.getOwnPropertyDescriptor;
		Object.defineProperty(Object, "getOwnPropertyDescriptor", {
			value: function getOwnPropertyDescriptor(obj, prop) {
				if ((obj === win || obj === win.self) && shouldHide(prop)) {
					return undefined;
				}
				return nativeGetOwnDesc.call(this, obj, prop);
			},
			writable: true,
			configurable: true,
		});

		const nativeHasOwn = Object.prototype.hasOwnProperty;
		const hasOwnProxy = function hasOwnProperty(prop) {
			if ((this === win || this === win.self) && shouldHide(prop)) {
				return false;
			}
			return nativeHasOwn.call(this, prop);
		};
		try {
			Object.defineProperty(win, "hasOwnProperty", {
				value: hasOwnProxy,
				writable: true,
				configurable: true,
			});
		} catch {}

		const nativeIn = win.Reflect?.has;
		if (nativeIn) {
			try {
				win.Reflect.has = function has(target, prop) {
					if ((target === win || target === win.self) && shouldHide(prop)) {
						return false;
					}
					return nativeIn.call(this, target, prop);
				};
			} catch {}
		}
	}

	_cloakIDB(win) {
		const nativeOpen = win.indexedDB?.open;
		if (!nativeOpen) return;

		const nativeDatabases = win.indexedDB.databases;
		if (nativeDatabases) {
			try {
				win.indexedDB.databases = async function databases() {
					const dbs = await nativeDatabases.call(win.indexedDB);
					return dbs.filter((db) => {
						const n = db.name || "";
						return !HIDDEN_IDB_NAMES.some((h) => n.includes(h));
					});
				};
			} catch {}
		}
	}

	_cloakNavigator(win) {
		try {
			const sw = Object.getOwnPropertyDescriptor(win.Navigator.prototype, "serviceWorker");
			if (sw) {
				const nativeGet = sw.get;
				Object.defineProperty(win.Navigator.prototype, "serviceWorker", {
					get() {
						const real = nativeGet.call(this);
						if (!real) return real;
						const handler = {
							get(target, prop) {
								if (prop === "controller") return null;
								if (prop === "getRegistrations") {
									return async () => [];
								}
								if (prop === "getRegistration") {
									return async () => undefined;
								}
								const val = Reflect.get(target, prop);
								return typeof val === "function" ? val.bind(target) : val;
							}
						};
						return new Proxy(real, handler);
					},
					configurable: true,
				});
			}
		} catch {}
	}

	_cloakPerformance(win) {
		const nativeGetEntries = win.Performance?.prototype?.getEntriesByType;
		if (!nativeGetEntries) return;
		try {
			win.Performance.prototype.getEntriesByType = function getEntriesByType(type) {
				const entries = nativeGetEntries.call(this, type);
				if (type === "resource") {
					return entries.filter((e) => {
						const n = e.name || "";
						return !n.includes("/~/xf/") && !n.includes(atob("c2NyYW1qZXQ=")) && !n.includes("__nc_");
					});
				}
				return entries;
			};
		} catch {}

		const nativeGetAll = win.Performance?.prototype?.getEntries;
		if (nativeGetAll) {
			try {
				win.Performance.prototype.getEntries = function getEntries() {
					return nativeGetAll.call(this).filter((e) => {
						const n = e.name || "";
						return !n.includes("/~/xf/") && !n.includes(atob("c2NyYW1qZXQ=")) && !n.includes("__nc_");
					});
				};
			} catch {}
		}
	}
}
