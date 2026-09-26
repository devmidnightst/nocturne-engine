# nocturne engine

a scramjet 2.x web proxy with a patched rewriter, a glass ui and a node server that's ready for pm2 cluster mode behind caddy.

it's built on the pinned 2.x packages (scramjet `2.0.67-alpha.2`, scramjet-controller `0.0.14`, scramjet-utils `0.0.3`), with epoxy and libcurl both selectable in settings, and wisp-js serving the tunnel from the same express process.

what makes it better than the stock scramjet demos:

- **nine patches to the 2.x bundles** fix real bugs, and the e2e suite fails on stock scramjet for every one of them it covers. two are aimed right at discord: websockets where the server talks first (the gateway), and set-cookie getting dropped by the http cache. details are in [docs/PATCHES.md](docs/PATCHES.md).
- **error pages that say what actually broke**. stock scramjet shows "Internal Service Worker Error" for everything. nocturne tells you whether the domain doesn't exist, the server blocked it, the site refused, it timed out or tls failed. it asks the server to redo the dns and tcp step when the transport's own error is too vague.
- **recovery**. when a page throws rewriter errors or loads blank, a banner offers a reload, compat mode for that site, or switching transport.
- **optional ad and tracker blocking**, answered locally inside the proxied page, plus discord's telemetry endpoints.
- **custom domains** with caddy on_demand_tls and an allowlist endpoint, so nobody can make your box request certs for random hostnames.

## layout

```
nocturne-engine/
  package.json              exact version pins
  ecosystem.config.cjs      pm2 cluster config
  .env.example              every setting, documented
  deploy/
    Caddyfile               on_demand_tls + ask endpoint + reverse proxy
    domains.txt.example     optional custom domain list
  src/                      node server
    server.js               express app, wisp upgrade handler, asset routes, graceful shutdown
    scramjet-patches.js     the bundle patches (exact string edits, version locked)
    config.js               env + .env loading
    domains.js              tls allowlist (exact names and *.wildcards, file hot reload)
    diagnose.js             /api/diagnose, redoes dns + tcp with the same rules as wisp
    packages.js             finds package dirs even when exports maps hide package.json
    check.js                `npm run check`: versions + patch sanity
  public/                   the shell ui
    index.html              omnibox, frame, settings / history / bookmarks panel
    sw.js                   service worker, hands /~/sj/ requests to the controller
    css/nocturne.css        glass theme, mobile bottom sheet under 640px
    js/engine.js            scramjet controller wiring, transports, plugins, compat flags
    js/app.js               ui logic
    js/store.js             settings, bookmarks, history (localStorage)
    js/omnibox.js           url vs search detection
    js/error-page.js        error classification + branded error pages
    js/plugins/             nocturne frame plugins + blocklist
  test/                     unit tests + a fixture site that exercises the rewriter
  scripts/e2e.mjs           real chromium end to end suite
  docs/
    PATCHES.md              every patch, why it exists, how it was proven
    DISCORD.md              discord notes and known limits
```

## setup

needs node 20.11 or newer (22 lts is what it was tested on).

```sh
git clone https://github.com/devmidnightst/nocturne-engine.git
cd nocturne-engine
npm ci
cp .env.example .env      # optional, defaults are fine for local dev
npm run check             # verifies versions and that every patch applies
npm start                 # http://127.0.0.1:8080
```

`npm run dev` restarts on file changes.

service workers only run on https or `localhost`/`127.0.0.1`. if you open the dev server by lan ip it won't work. use a tunnel or the real domain for that.

## deploy (pm2 + caddy)

```sh
# on the vps
git clone https://github.com/devmidnightst/nocturne-engine.git /opt/nocturne-engine
cd /opt/nocturne-engine
npm ci --omit=dev
cp .env.example .env && $EDITOR .env
npm run check

npm i -g pm2
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

updates:

```sh
git pull && npm ci --omit=dev && npm run check && pm2 reload ecosystem.config.cjs
```

`pm2 reload` is zero downtime. every worker calls `process.send("ready")` once it's listening (`wait_ready`), so pm2 only kills the old worker after the new one is up. on shutdown a worker stops taking connections and gives open wisp tunnels a few seconds before exiting.

cluster mode is safe. a wisp websocket stays on whichever worker accepted it, and all proxy state (cookies, cache, rewriting) lives in the browser, so there's nothing to share between workers. `NOCTURNE_INSTANCES` sets the worker count (default `max`). on the 12 core gcore box, something like 8 leaves room for caddy.

### caddy

copy `deploy/Caddyfile` to `/etc/caddy/Caddyfile`, swap in your domains, then `sudo systemctl reload caddy`.

- `nocturne.lol, www.nocturne.lol` get normal automatic https.
- `https://` with `tls { on_demand }` catches every other hostname pointed at the box. before caddy requests a cert for a new name it calls `GET /api/tls-ask?domain=<name>`, and node answers 200 only if the name is in `TLS_ALLOWED_DOMAINS` or `TLS_DOMAINS_FILE`. without that check anyone could point junk domains at your ip and burn your acme rate limits.
- `TLS_ALLOWED_DOMAINS` takes exact names and `*.example.com` wildcards (one label deep, like tls wildcards). the domains file is re-read when it changes, so adding a custom domain needs no restart.
- websockets (the `/wisp/` tunnel) pass through `reverse_proxy` automatically. `flush_interval -1` stops caddy from buffering streamed responses.

the caddyfile hasn't been run through `caddy validate` yet (caddy wasn't available where this was built), so run `caddy validate --config /etc/caddy/Caddyfile` before reloading.

### settings that matter on a public box

all in `.env.example` with comments. the important ones:

| env | default | what it does |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `8080` | keep it on loopback behind caddy |
| `TRUST_PROXY` | `loopback` | trusts x-forwarded-for from caddy only |
| `WISP_ALLOW_PRIVATE_IPS` | `false` | leave off. stops the proxy reaching your vps, homelab or cloud metadata |
| `WISP_ALLOW_LOOPBACK_IPS` | `false` | same, for 127.0.0.0/8 and ::1 |
| `WISP_PORT_BLACKLIST` | `25,465,587` | stops people sending spam from your ip |
| `WISP_ALLOWED_ORIGINS` | empty | set to your own origins so other sites can't hotlink your wisp bandwidth |
| `TLS_ALLOWED_DOMAINS` | empty | who caddy may get certs for |
| `NOCTURNE_DISABLE_PATCHES` | empty | `all` or a list of patch ids, for debugging |

## how it fits together

```
browser tab (nocturne shell, /)
  |-- iframe /~/sj/<encoded url>         the proxied site
  |      every request from it goes to...
  |-- service worker (sw.js)             only routes /~/sj/ requests...
  |      over a MessageChannel back to...
  |-- scramjet Controller (engine.js)    rewrites html / css / js, runs plugins
         |-- transport (epoxy or libcurl, runs in the page)
                |-- wss://your.domain/wisp/  (wisp-js inside server.js)
                       |-- the real site
```

in scramjet 2.x the rewriter and the transport live in the shell page, not the service worker. the service worker just forwards. that's why there's no bare-mux in this stack: the 2.x controller takes a `ProxyTransport` (from `@mercuryworkshop/proxy-transports`) directly, and epoxy 3.x and libcurl 2.x both implement it.

the node server:

- serves the patched `scramjet.js`, `controller.inject.js` and `scramjet-utils.js` from memory with etags. patches are applied once at boot, and `/api/health` lists which ones applied.
- serves the rest of `@mercuryworkshop/scramjet/dist` and the controller dist as static files, `scramjet.wasm` as `application/wasm`, and the transports at `/transports/epoxy.mjs` and `/transports/libcurl.mjs`.
- serves `/sw.js` with `Service-Worker-Allowed: /` and no caching, so updates reach users on the next load.
- sets `X-Content-Type-Options` and `Referrer-Policy` everywhere, and cors plus `Cross-Origin-Resource-Policy` on the engine assets. it deliberately sets no `X-Frame-Options` or coep on the shell. the proxied pages come from the service worker, and scramjet handles site csp itself.
- handles websocket upgrades itself: `/wisp/` goes to wisp-js, anything else gets a 404, and a disallowed origin gets a 403 when `WISP_ALLOWED_ORIGINS` is set.

### rewriter config

`engine.js` builds the scramjet config from scramjet's own defaults plus:

- `allowInvalidJs: true`: if the rewriter can't parse a script, it runs the original instead of throwing. youtube's eval'd code hits this ([scramjet #206](https://github.com/MercuryWorkshop/scramjet/issues/206)).
- `allowFailedIntercepts: true`: a broken api hook logs instead of killing the page.
- `sourcemaps: true`: `Function.prototype.toString` returns the original source, which a lot of feature detection and anti tamper code checks.
- `rewriterLogs`: toggled in settings, under developer.

**compat mode** (per site, from the recovery banner or settings) turns off `destructureRewrites` and `encapsulateWorkers` for that origin through scramjet's `siteFlags`. those are the two most involved rewrites, so they're the first suspects when a site breaks.

### plugins

scramjet-utils plugins in use: `HttpCachePlugin` (patched, see below), `UrlWatcherPlugin` (keeps the omnibox in sync) and `CatchEscapedLinksPlugin` (a link that escapes the proxy gets routed back through `/?go=`).

nocturne's own, in `public/js/plugins/nocturne-plugins.js`:

- **ErrorPagePlugin**: replaces a failed navigation with a branded page. transports report most failures as "the connection closed", so for vague errors it calls `/api/diagnose`, which redoes the dns lookup and a tcp connect with the same ip rules as wisp and reports `dns`, `blocked`, `refused`, `timeout` or `reachable`. the page has retry, switch transport and home buttons.
- **ContentBlockerPlugin**: when "block ads & trackers" is on, requests to ad and analytics hosts (plus discord's `/api/v*/science` and `/metrics`, and youtube's ad pings) are answered locally with an empty response of the right type, so ad loaders don't retry in a loop. it never blocks top level navigations. it only runs inside proxied pages, so ads on the nocturne shell itself aren't touched.
- **RecoveryPlugin**: counts uncaught errors, rejections and rewriter failures in each proxied window. 3.5s after load it reports whether the page looks blank, and the shell shows the recovery banner.
- **ShellBridgePlugin**: title, loading bar and url updates for the ui.

## ui

- omnibox that takes a url, a bare host (`discord.com`) or a search. the search engine is picked in settings.
- back, forward, reload, loading bar, open current page in a new tab, bookmark star.
- bookmarks and history panels. everything is stored in localStorage and never leaves the browser.
- settings: transport (epoxy or libcurl, switched live), search engine, ad blocking, custom wisp url, compat sites, developer toggles, clear data.
- `ctrl+l` focuses the omnibox, `esc` closes panels.
- mobile: the panel becomes a bottom sheet and less important buttons hide under 640px.
- links like `/?go=https://example.com` open straight into the proxy.

## testing

```sh
npm test            # unit tests: patches, domain allowlist, server routes + headers
npm run test:e2e    # real chromium, both transports
```

the e2e suite starts the server and a local fixture site, then loads the fixture through the proxy in headless chromium, once over epoxy and once over libcurl. the fixture checks:

- location, origin, relative fetch, referer, redirects, xhr
- a websocket where the server speaks first (the discord gateway pattern) and cookie round trips
- classic, module and blob workers, dynamic `import()`, a static es module graph
- `eval` and `new Function` scope
- `history.pushState`, `toString` source
- keyword glue, `setAttribute` coercion, a same origin child iframe

it also checks the error page and the ad blocker. `NOCTURNE_E2E_URLS=https://a.com,https://b.com` adds real site smoke tests with screenshots. `CHROME_PATH` points it at a chromium binary if playwright can't find one.

`NOCTURNE_DISABLE_PATCHES=all npm run test:e2e` shows what stock scramjet fails.

## version notes

checked on npm when this was built:

- `@mercuryworkshop/scramjet@2.0.67-alpha.2` is the `alpha` tag. `latest` is still `1.1.0`, so a plain `npm i @mercuryworkshop/scramjet` gets you 1.x. the pin has to stay exact.
- `scramjet-controller@0.0.14` is `latest` and hard codes that it wants scramjet `2.0.67-alpha.2`. mismatch them and it throws on boot. `npm run check` catches this.
- `scramjet-utils@0.0.3` was built against scramjet `2.0.67-alpha.1` and controller `0.0.13`. its plugins work fine with alpha.2, but its `getScramjet()` and `getVersionInfo()` helpers throw a version mismatch, so nocturne doesn't call them.
- `epoxy-transport@3.0.1` and `libcurl-transport@2.0.5` are both `latest` and implement the 2.x `ProxyTransport` interface. heads up: epoxy's readme says `import { EpoxyClient }`, but the actual build only has a default export (`EpoxyTransport`). libcurl exports `LibcurlClient`.
- `wisp-js@0.5.0` is `latest`.
- no bare-mux. scramjet 2.x doesn't use it (see above).

if you bump scramjet, the patches are locked to the exact alpha.2 build and switch themselves off on any other version. `npm run check` tells you which ones stopped applying.

## discord and other big sites

see [docs/DISCORD.md](docs/DISCORD.md). short version: the patches fix the proxy bugs discord was hitting (gateway websocket, cookies, workers, glue), but discord couldn't be tested live where this was built (outbound access to discord.com was blocked). voice and video won't go through the proxy, and discord may challenge logins from a datacenter ip.

## known limitations

- **webrtc** (discord voice and video, google meet, and so on) isn't proxied. scramjet 2.x doesn't tunnel it, so those connections either fail or go direct from the user's ip.
- **youtube**: the rewriter's parser can panic on some of youtube's eval'd code ([scramjet #206](https://github.com/MercuryWorkshop/scramjet/issues/206)). `allowInvalidJs` keeps that code running unrewritten, which usually works, but it's inside the compiled wasm so nocturne can't truly fix it. compat mode or switching transport helps when it doesn't.
- **spotify**: not tested. the web player needs widevine drm, which the iframe allows, but whether spotify's drm and license checks accept a proxied origin is unverified.
- **microsoft logins** are a known open scramjet issue ([#207](https://github.com/MercuryWorkshop/scramjet/issues/207)).
- **captchas** (hcaptcha, recaptcha, turnstile) often work but score proxied traffic from datacenter ips harshly.
- **alpha software**: scramjet 2.x is an alpha. the patches are exact string edits on the published build, locked to alpha.2 and verified at boot.

## license

scramjet, the controller, scramjet-utils and both transports are AGPL-3.0, so nocturne engine is AGPL-3.0 too. if you run a modified version for other people, you have to offer them the source. a link to your repo in the about panel (`public/index.html`) covers it.
