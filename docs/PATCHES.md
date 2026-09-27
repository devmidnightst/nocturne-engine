# scramjet patches

umbrella serves patched copies of four published bundles. the scramjet patches live in `src/scramjet-patches.js`, the libcurl transport patches in `src/libcurl-patches.js`. they're applied once when the server boots, and the result is served from memory.

how the patches stay safe:

- every edit is an exact string swap against the published alpha.2 build, and it has to match **exactly once** or it's skipped. a patch can't half apply or land in the wrong place.
- if the installed scramjet isn't `2.0.67-alpha.2`, every scramjet patch is skipped and the stock bundle is served. same for libcurl-transport and `2.0.5`.
- `npm run check`, the server log at boot and `/api/health` all list which patches applied and which were skipped, with the reason.
- `UMBRELLA_DISABLE_PATCHES=all` (or a comma list of ids) serves stock code, so you can check whether a broken site is a patch problem or an upstream one.
- the source map comment is stripped from patched bundles, because the map no longer lines up with the patched file.

the e2e suite (`npm run test:e2e`) was run with `UMBRELLA_DISABLE_PATCHES=all` to confirm that each bug fix below fails on stock scramjet.

## scramjet.js

### `wasm-module-cache`

`getRewriter()` compiled a fresh `WebAssembly.Module` from the 586kb rewriter wasm on every js rewrite, even though `initSync` only ever uses the first one. umbrella caches the compiled module. in a local benchmark each rewrite call got about 3x faster, and that adds up on js heavy sites like discord and youtube that ship hundreds of chunks.

### `keyword-glue` ([scramjet #185](https://github.com/MercuryWorkshop/scramjet/issues/185))

the rewriter wraps member accesses like `.postMessage` and `.location` in helper calls. when the object sits right after a keyword with no space (`typeof(x).postMessage`, `return(x).location`, common in minified code), the output glues them together as `typeof$scramjet$wrap...(x)`. that's a ReferenceError, and it kills the whole script.

the fix runs on the rewriter's output bytes before they're decoded. `kw$scramjet$name(` becomes `kw $scramjet$nam(`, so the keyword and helper are separate tokens again. the byte length doesn't change, which keeps scramjet's own source maps valid (they drive `Function.prototype.toString` and error stacks). an epilogue then defines each shortened helper name as a getter for the real one.

covered keywords: `typeof return await void delete throw case in of new yield else do instanceof extends`.

tested by `test/patches.test.js`, which runs the real rewriter, and by the "keyword glue" e2e check.

### `rewrite-error-report`

when a script fails to rewrite, stock scramjet `console.warn`s the entire script source. on a 2mb bundle that freezes devtools. umbrella cuts the dump to 400 characters and passes the failure to the recovery plugin, which is what drives the "this page had rewriter errors" banner. `self.__umbrellaDiag` keeps counts and the last few errors for the diagnostics panel.

### `module-worker-imports`

with `encapsulateWorkers` on (the default), a rewritten worker is moved into a `data:` url. the rewriter emits root relative import specifiers like `/~/sj/...`, and a `data:` url has no base to resolve them against, so `new Worker(url, { type: "module" })` died on load for any module worker with an import. module workers now skip the `data:` wrapper. modules are always strict mode, so the wrapper isn't needed there. classic workers still get it.

tested by the "module worker" e2e check.

### `setattribute-coerce` ([scramjet #184](https://github.com/MercuryWorkshop/scramjet/issues/184))

`element.setAttribute(name, value)` with a non string `name` threw `r.toLowerCase is not a function`. the real dom converts the name to a string first. the patch does the same conversion.

tested by the "setAttribute with a non string name" e2e check.

### `getresponseheader-coerce`

same bug as #184, in `XMLHttpRequest.prototype.getResponseHeader`.

### `media-src-readback`

players attach media source extensions with `audio.src = URL.createObjectURL(mediaSource)`. scramjet hooks `createObjectURL` to hand back a blob url on the site's origin, but reading `audio.src` back returned the real blob url on umbrella's origin, so `audio.src === url` was false. `audio.currentSrc` wasn't hooked at all and returned the `/~/sj/` proxy url. players compare these to tell whether the element is still theirs. both getters now return what the site set.

tested by the "media element src reads back what was set" and "currentSrc is the real url" e2e checks.

### `history-state-no-url`

`history.pushState(state, title)` and `history.replaceState(state, title, undefined)` mean "keep the current url". scramjet's hook turned the missing url into the string `"undefined"` (or `"null"`) and moved the page to `/undefined`. duckduckgo does this after every search, so the address bar and any reload landed on `duckduckgo.com/undefined`.

tested by the "history state without a url keeps the page url" e2e check.

## controller.inject.js

### `websocket-open-order`

this is the big one for discord.

a proxied page's websocket gets its data over one MessagePort and its `open` event over another (the rpc reply). if the server talks first, a message can arrive before `open` fires. discord's gateway sends HELLO the moment you connect, so this happens every time. the page then answers with `ws.send()` while `readyState` is still `CONNECTING`, which throws, and the gateway never gets identified.

the patch queues incoming data until `open` has fired, then flushes the queue in order. a socket that fails to connect now also gets its `close` event (1006) after `error`, like in a browser, so pages that reconnect from `onclose` actually try again. it also removes the `console.warn("connecting")` and `console.log` the stock build prints for every socket.

tested by the "websocket, server speaks first (discord gateway pattern)" e2e check, on both transports.

### `websocket-close-reason`

`ws.close(code, reason)` dropped the reason on the way to the real socket.

## scramjet-utils.js

### `http-cache-keeps-set-cookie`

`HttpCachePlugin` rebuilt every cacheable response with `new Response()`, and the Response constructor silently drops `Set-Cookie`. so any cacheable GET that set a cookie (login pages, session refreshes) lost it, and the site never saw that cookie again. that's a classic "logs in, then gets logged straight back out" bug.

the patch keeps the original raw headers on the response the page gets. the cached copy still has no cookies, which is what you want in a shared cache.

tested by the "cookies round trip" e2e check.

### `http-cache-skips-media`

two bugs in `HttpCachePlugin` that break audio:

- it matched cached responses by url only. once a full copy of an audio file was cached, a `Range: bytes=100-199` request got the whole file back as a 200. music players (spotify's web player among them) fetch audio from their cdn in byte ranges, and a wrong range means undecodable audio.
- it read every cacheable 200 to the end before handing it to the page. a response that never finishes (internet radio, live streams) never started playing, and every audio segment was copied into cache storage.

range requests, audio/video requests and audio, video, youtube ump and event stream responses now skip the cache.

tested by the "range request after a full download of the same file" and "live stream starts before it ends" e2e checks.

## libcurl.mjs (libcurl-transport 2.0.5)

every proxied websocket goes through libcurl, even with epoxy picked (see DISCORD.md), so these decide how every socket closes. discord's qr login depends on all three.

### `ws-close-code`

a close frame from the server reached the page as code `0` with no reason, and `ws.close(4000, "x")` came back to the page as code `0` too. libcurl.js never looked inside the close frame. the patch reads the code and reason out of it.

discord's qr login gateway ends every session with a close code: 1000 when the phone approved, 4003 when the qr expired. the web client reads that code to decide whether to finish the login or put up a fresh qr, so with code 0 the most likely result is what users saw: the phone approves and the browser starts over with a new qr. (discord.com was blocked from the build machine, so this was checked against a local copy of the gateway, not the real one.)

### `ws-close-frame`

`ws.close()` cut the connection without sending a close frame, so servers saw an abnormal 1006. it sends one now. libcurl.js 0.7 can only send an empty close frame, so the server sees 1005 (no code) rather than the page's code.

### `ws-dead-socket-closes`

when a socket died without a close frame (server restart, network drop), the page got an `error` and never a `close`. when the handshake was refused, it got nothing at all. either way the page sat on a dead socket forever instead of reconnecting, and chat apps reconnect from `onclose`. both now fire `error` then `close` with 1006, like a browser.

tested by the four websocket close checks and the "discord qr login handshake" e2e check, which replays the remote auth gateway's protocol (rsa-oaep key exchange, nonce proof, pending login, close 1000, ticket POST) against a local copy.

## adding a patch

1. find the minified code in `node_modules/@mercuryworkshop/<pkg>/dist/`.
2. add `{ id, why, find, replace }` to the right list in `src/scramjet-patches.js` (or `src/libcurl-patches.js`). make `find` long enough to match only once.
3. add a fixture check in `test/fixture/site/checks.js` that fails without it.
4. run `npm run check && npm test && npm run test:e2e`.
