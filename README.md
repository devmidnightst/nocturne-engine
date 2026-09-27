# umbrella

a scramjet 2.x web proxy with a patched rewriter, a plain ui and a node server that's ready for pm2 cluster mode behind caddy.

it's built on the pinned 2.x packages (scramjet `2.0.67-alpha.2`, scramjet-controller `0.0.14`, scramjet-utils `0.0.3`), with epoxy and libcurl both selectable in settings, and wisp-js serving the tunnel from the same express process.

what makes it better than the stock scramjet demos:

- **twelve patches to the 2.x bundles** fix real bugs, and the e2e suite fails on stock scramjet for every one of them it covers. two are aimed right at discord: websockets where the server talks first (the gateway), and set-cookie getting dropped by the http cache. details are in [docs/PATCHES.md](docs/PATCHES.md).
- **error pages that say what actually broke**. stock scramjet shows "Internal Service Worker Error" for everything. umbrella tells you whether the domain doesn't exist, the server blocked it, the site refused, it timed out or tls failed. it asks the server to redo the dns and tcp step when the transport's own error is too vague.
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
    server.js               express app, websocket upgrade routing, asset routes, graceful shutdown
    wisp.js                 the wisp endpoint: wisp-js with its crash, leak and ssrf holes closed
    ip-policy.js            the one ssrf rule set, shared by wisp and /api/diagnose
    scramjet-patches.js     the bundle patches (exact string edits, version locked)
    config.js               env + .env loading
    domains.js              tls allowlist (exact names and *.wildcards, file hot reload)
    diagnose.js             /api/diagnose, redoes dns + tcp with the same rules as wisp
    packages.js             finds package dirs even when exports maps hide package.json
    check.js                `npm run check`: versions + patch sanity
  public/                   the shell ui
    index.html              sidebar (omnibox, bookmarks, tabs), tab frames, settings / history / bookmarks panel
    sw.js                   service worker, hands /~/sj/ requests to the controller
    css/umbrella.css        plain light/dark theme, sidebar becomes a drawer under 640px
    js/engine.js            scramjet controller wiring, transports, plugins, compat flags
    js/app.js               ui logic
    js/store.js             settings, bookmarks, history, open tabs, site icons (localStorage)
    js/omnibox.js           url vs search detection
    js/error-page.js        error classification + branded error pages
    js/plugins/             umbrella frame plugins + blocklist
  test/                     unit tests + a fixture site that exercises the rewriter
  scripts/e2e.mjs           real chromium end to end suite
  scripts/soak.mjs          long running stability test (npm run test:soak)
  docs/
    PATCHES.md              every patch, why it exists, how it was proven
    DISCORD.md              discord notes and known limits
    SOAK.md                 results of the 2 hour soak run
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

cluster mode is safe. a wisp websocket stays on whichever worker accepted it, and all proxy state (cookies, cache, rewriting) lives in the browser, so there's nothing to share between workers. `UMBRELLA_INSTANCES` sets the worker count (default `max`). on the 12 core gcore box, something like 8 leaves room for caddy.

### coming from nocturne engine

this project used to be called nocturne engine. the pm2 app is now called `umbrella`, so the first deploy after the rename has to swap the process once instead of a plain reload (a few seconds of downtime):

```sh
git pull && npm ci --omit=dev && npm run check
pm2 delete nocturne-engine
pm2 start ecosystem.config.cjs
pm2 save
```

after that, normal `pm2 reload ecosystem.config.cjs` updates work again. old `NOCTURNE_*` env vars are still read as a fallback, and settings, bookmarks and history saved in browsers under the old `nocturne:` keys move to `umbrella:` on the next visit.

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
| `WISP_STREAM_LIMIT_PER_HOST` | `-1` | caps streams per destination host on one wisp connection. used to crash the server, safe now |
| `WISP_MAX_FRAME_BYTES` | `4194304` | biggest websocket frame a client may send to `/wisp/` |
| `TLS_ALLOWED_DOMAINS` | empty | who caddy may get certs for |
| `UMBRELLA_DISABLE_PATCHES` | empty | `all` or a list of patch ids, for debugging |

## how it fits together

```
browser tab (umbrella shell, /)
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
- handles websocket upgrades itself: exactly `/wisp/` goes to the wisp endpoint in `wisp.js`, anything else gets a 404 (wisp-js would otherwise open a raw tcp tunnel for paths like `/wisp/host:22`), and a disallowed origin gets a 403 when `WISP_ALLOWED_ORIGINS` is set.
- `wisp.js` runs wisp-js 0.5.0's connection class with fixes on top: every stream resolves once, gets checked by `ip-policy.js` and connects to that exact address (so `::ffff:127.0.0.1` and friends can't sneak past, and dns rebinding can't swap the target), bad websocket frames can't crash the process, reused stream ids can't leak sockets, the per host stream limit works instead of crashing, and frames are capped at `WISP_MAX_FRAME_BYTES`.

### transports

libcurl is the default. epoxy 3.0.1 (the newest release) has two bugs the soak test and e2e suite caught:

- **stale keep alive hang**: when a site closes an idle keep alive connection (node does it after 5s, nginx after 75s, most servers somewhere in between), epoxy's next request to that site reuses the dead connection and hangs forever. so a page you read for a minute stops loading anything when you click. `npm run test:e2e` shows it as a "known" line.
- **held websocket frames**: every frame a page sends sits in the browser until the next frame is sent. a chat app that sends one message and waits for the reply hangs, and discord's gateway never gets a timely heartbeat.

epoxy is still in settings. when it's picked, its websockets go through libcurl (loaded when the first socket opens, or when the browser is idle), which fixes the second bug but not the first.

scramjet 2.x also never cancels a request when a page is left (the controller passes the transport no abort signal), so long polls and requests to dead hosts piled up until libcurl's 6 connections per host were all stuck and the site froze. `engine.js` tracks every request until its body finishes and aborts them all when the top level page unloads, and gives libcurl 16 connections per host.

### rewriter config

`engine.js` builds the scramjet config from scramjet's own defaults plus:

- `allowInvalidJs: true`: if the rewriter can't parse a script, it runs the original instead of throwing. youtube's eval'd code hits this ([scramjet #206](https://github.com/MercuryWorkshop/scramjet/issues/206)).
- `allowFailedIntercepts: true`: a broken api hook logs instead of killing the page.
- `sourcemaps: true`: `Function.prototype.toString` returns the original source, which a lot of feature detection and anti tamper code checks.
- `rewriterLogs`: toggled in settings, under developer.

**compat mode** (per site, from the recovery banner or settings) turns off `destructureRewrites` and `encapsulateWorkers` for that origin through scramjet's `siteFlags`. those are the two most involved rewrites, so they're the first suspects when a site breaks.

### plugins

scramjet-utils plugins in use: `HttpCachePlugin` (patched, see below), `UrlWatcherPlugin` (keeps the omnibox in sync) and `CatchEscapedLinksPlugin` (a link that escapes the proxy gets routed back through `/?go=`).

umbrella's own, in `public/js/plugins/umbrella-plugins.js`:

- **ErrorPagePlugin**: replaces a failed navigation with a branded page. transports report most failures as "the connection closed", so for vague errors it calls `/api/diagnose`, which redoes the dns lookup and a tcp connect with the same ip rules as wisp and reports `dns`, `blocked`, `refused`, `timeout` or `reachable`. the page has retry, switch transport and home buttons.
- **ContentBlockerPlugin**: when "block ads & trackers" is on, requests to ad and analytics hosts (plus discord's `/api/v*/science` and `/metrics`, and youtube's ad pings) are answered locally with an empty response of the right type, so ad loaders don't retry in a loop. it never blocks top level navigations. it only runs inside proxied pages, so ads on the umbrella shell itself aren't touched.
- **RecoveryPlugin**: counts uncaught errors, rejections and rewriter failures in each proxied window. 3.5s after load it reports whether the page looks blank, and the shell shows the recovery banner.
- **ShellBridgePlugin**: title, icon, loading bar and url updates for the ui. it also sends `target=_blank` links, middle clicks and ctrl clicks to the sidebar as new tabs instead of new browser tabs.

## ui

- zen style vertical tabs in a left sidebar. every tab keeps its own live frame, so switching tabs never reloads a page and audio keeps playing in the background. tabs can be dragged to reorder, middle clicked to close, and the sidebar can be hidden (hover the left edge to peek at it).
- bookmarks sit above the tabs as a grid of site icons. clicking one switches to its open tab or opens it.
- open tabs are saved in localStorage, so a reload or a new visit brings them back. only the active tab loads right away, the rest load when you click them.
- site icons are fetched once through the proxy, shrunk to 32px and cached per host.
- omnibox that takes a url, a bare host (`discord.com`) or a search. the search engine is picked in settings.
- back, forward, reload, loading bar, open current page in a real browser tab, bookmark star.
- bookmarks and history panels. everything is stored in localStorage and never leaves the browser.
- settings: transport (libcurl or epoxy, switched live), search engine, ad blocking, custom wisp url, compat sites, developer toggles, clear data.
- `ctrl+l` focuses the omnibox, `alt+t` opens a tab, `alt+w` closes one, `esc` closes panels.
- mobile: under 640px the sidebar becomes a drawer behind the tab count button and the panel becomes a bottom sheet.
- links like `/?go=https://example.com` open straight into the proxy as a new tab. the browser's address bar always stays on the bare site (`/`).
- `public/sw.js` waits for the shell to re-register when chrome restarts an idle service worker, instead of letting the navigation fall through to the server's 404 page. when a deploy ships a new `sw.js`, the open shell follows the new worker, since scramjet's controller would otherwise keep talking to the old dead one and every proxied page would hit that 404.

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
- audio playback (test/fixture/site/media.html): `<audio>` with range requests and seeking, media source extensions fed from fetch, xhr, a streamed body and a binary POST (how youtube music streams), range requests after a cached full download (how spotify fetches audio), live streams, web audio, eme clearkey and the media element `src`/`currentSrc` getters

it also checks the error page, the ad blocker and the tabs (icons, `target=_blank` and middle click landing in the sidebar, switching without a reload, restoring after a reload). `UMBRELLA_E2E_URLS=https://a.com,https://b.com` adds real site smoke tests with screenshots. `CHROME_PATH` points it at a chromium binary if playwright can't find one.

`UMBRELLA_DISABLE_PATCHES=all npm run test:e2e` shows what stock scramjet fails.

### soak test

```sh
npm run test:soak                   # 30 minutes
SOAK_MINUTES=120 npm run test:soak  # longer
```

runs the server as its own process and keeps a real chromium on it the whole time: two shells navigating in a loop (fixture, a heavy page with 31 parallel requests and 5 MB of bodies checked byte for byte, redirects, error pages, and any `SOAK_URLS`), flipping transport and reloading every so often, plus one shell per transport holding websockets open for the entire run. every minute it records server rss, heap after gc, open fds, wisp connections, each shell's js heap and dom size and navigation latency, and at the end writes `soak-results/<time>/report.md` comparing the start of the run with the end. the last 2 hour run is in [docs/SOAK.md](docs/SOAK.md).

## version notes

checked on npm when this was built:

- `@mercuryworkshop/scramjet@2.0.67-alpha.2` is the `alpha` tag. `latest` is still `1.1.0`, so a plain `npm i @mercuryworkshop/scramjet` gets you 1.x. the pin has to stay exact.
- `scramjet-controller@0.0.14` is `latest` and hard codes that it wants scramjet `2.0.67-alpha.2`. mismatch them and it throws on boot. `npm run check` catches this.
- `scramjet-utils@0.0.3` was built against scramjet `2.0.67-alpha.1` and controller `0.0.13`. its plugins work fine with alpha.2, but its `getScramjet()` and `getVersionInfo()` helpers throw a version mismatch, so umbrella doesn't call them.
- `epoxy-transport@3.0.1` and `libcurl-transport@2.0.5` are both `latest` and implement the 2.x `ProxyTransport` interface. heads up: epoxy's readme says `import { EpoxyClient }`, but the actual build only has a default export (`EpoxyTransport`). libcurl exports `LibcurlClient`.
- `wisp-js@0.5.0` is `latest`.
- no bare-mux. scramjet 2.x doesn't use it (see above).

if you bump scramjet, the patches are locked to the exact alpha.2 build and switch themselves off on any other version. `npm run check` tells you which ones stopped applying.

## discord and other big sites

see [docs/DISCORD.md](docs/DISCORD.md). short version: the patches fix the proxy bugs discord was hitting (gateway websocket, cookies, workers, glue), but discord couldn't be tested live where this was built (outbound access to discord.com was blocked). voice and video won't go through the proxy, and discord may challenge logins from a datacenter ip.

## known limitations

- **webrtc** (discord voice and video, google meet, and so on) isn't proxied. scramjet 2.x doesn't tunnel it, so those connections either fail or go direct from the user's ip.
- **youtube**: the rewriter's parser can panic on some of youtube's eval'd code ([scramjet #206](https://github.com/MercuryWorkshop/scramjet/issues/206)). `allowInvalidJs` keeps that code running unrewritten, which usually works, but it's inside the compiled wasm so umbrella can't truly fix it. compat mode or switching transport helps when it doesn't.
- **spotify**: not tested. the web player needs widevine drm, which the iframe allows, but whether spotify's drm and license checks accept a proxied origin is unverified.
- **microsoft logins** are a known open scramjet issue ([#207](https://github.com/MercuryWorkshop/scramjet/issues/207)).
- **captchas** (hcaptcha, recaptcha, turnstile) often work but score proxied traffic from datacenter ips harshly.
- **alpha software**: scramjet 2.x is an alpha. the patches are exact string edits on the published build, locked to alpha.2 and verified at boot.

## license

umbrella is AGPL-3.0 (`LICENSE`) with extra terms in `NOTICE`, added under section 7 of the license. in short, if you fork it, host it or rebrand it:

- keep the "Umbrella by midnight" credit box on the home page, linked to this repo, readable and visible without scrolling. a renamed fork says "based on Umbrella by midnight".
- keep the same credit in the about panel and keep `NOTICE` with the source.
- don't pass a modified version off as the original.
- like any AGPL program, if you run a modified version for other people, you have to offer them its source.

scramjet, the controller, scramjet-utils and both transports are AGPL-3.0 by Mercury Workshop and keep their own licenses. the extra terms only cover umbrella's own code.


## credits

made by:

me (midnight)
claude (worlds sexiest AI)
chatgpt (ideas)
gemini (fuck this ai)
grok (currently helping to port to S3)
zinko (emotional support)
faiz + david (big pickle)
