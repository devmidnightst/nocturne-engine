# scramjet patches

nocturne serves patched copies of three published bundles. the patches live in `src/scramjet-patches.js`. they're applied once when the server boots, and the result is served from memory.

how the patches stay safe:

- every edit is an exact string swap against the published alpha.2 build, and it has to match **exactly once** or it's skipped. a patch can't half apply or land in the wrong place.
- if the installed scramjet isn't `2.0.67-alpha.2`, every scramjet patch is skipped and the stock bundle is served.
- `npm run check`, the server log at boot and `/api/health` all list which patches applied and which were skipped, with the reason.
- `NOCTURNE_DISABLE_PATCHES=all` (or a comma list of ids) serves stock code, so you can check whether a broken site is a patch problem or an upstream one.
- the source map comment is stripped from patched bundles, because the map no longer lines up with the patched file.

the e2e suite (`npm run test:e2e`) was run with `NOCTURNE_DISABLE_PATCHES=all` to confirm that each bug fix below fails on stock scramjet.

## scramjet.js

### `wasm-module-cache`

`getRewriter()` compiled a fresh `WebAssembly.Module` from the 586kb rewriter wasm on every js rewrite, even though `initSync` only ever uses the first one. nocturne caches the compiled module. in a local benchmark each rewrite call got about 3x faster, and that adds up on js heavy sites like discord and youtube that ship hundreds of chunks.

### `keyword-glue` ([scramjet #185](https://github.com/MercuryWorkshop/scramjet/issues/185))

the rewriter wraps member accesses like `.postMessage` and `.location` in helper calls. when the object sits right after a keyword with no space (`typeof(x).postMessage`, `return(x).location`, common in minified code), the output glues them together as `typeof$scramjet$wrap...(x)`. that's a ReferenceError, and it kills the whole script.

the fix runs on the rewriter's output bytes before they're decoded. `kw$scramjet$name(` becomes `kw $scramjet$nam(`, so the keyword and helper are separate tokens again. the byte length doesn't change, which keeps scramjet's own source maps valid (they drive `Function.prototype.toString` and error stacks). an epilogue then defines each shortened helper name as a getter for the real one.

covered keywords: `typeof return await void delete throw case in of new yield else do instanceof extends`.

tested by `test/patches.test.js`, which runs the real rewriter, and by the "keyword glue" e2e check.

### `rewrite-error-report`

when a script fails to rewrite, stock scramjet `console.warn`s the entire script source. on a 2mb bundle that freezes devtools. nocturne cuts the dump to 400 characters and passes the failure to the recovery plugin, which is what drives the "this page had rewriter errors" banner. `self.__nocturneDiag` keeps counts and the last few errors for the diagnostics panel.

### `module-worker-imports`

with `encapsulateWorkers` on (the default), a rewritten worker is moved into a `data:` url. the rewriter emits root relative import specifiers like `/~/sj/...`, and a `data:` url has no base to resolve them against, so `new Worker(url, { type: "module" })` died on load for any module worker with an import. module workers now skip the `data:` wrapper. modules are always strict mode, so the wrapper isn't needed there. classic workers still get it.

tested by the "module worker" e2e check.

### `setattribute-coerce` ([scramjet #184](https://github.com/MercuryWorkshop/scramjet/issues/184))

`element.setAttribute(name, value)` with a non string `name` threw `r.toLowerCase is not a function`. the real dom converts the name to a string first. the patch does the same conversion.

tested by the "setAttribute with a non string name" e2e check.

### `getresponseheader-coerce`

same bug as #184, in `XMLHttpRequest.prototype.getResponseHeader`.

## controller.inject.js

### `websocket-open-order`

this is the big one for discord.

a proxied page's websocket gets its data over one MessagePort and its `open` event over another (the rpc reply). if the server talks first, a message can arrive before `open` fires. discord's gateway sends HELLO the moment you connect, so this happens every time. the page then answers with `ws.send()` while `readyState` is still `CONNECTING`, which throws, and the gateway never gets identified.

the patch queues incoming data until `open` has fired, then flushes the queue in order. it also removes the `console.warn("connecting")` and `console.log` the stock build prints for every socket.

tested by the "websocket, server speaks first (discord gateway pattern)" e2e check, on both transports.

### `websocket-close-reason`

`ws.close(code, reason)` dropped the reason on the way to the real socket.

## scramjet-utils.js

### `http-cache-keeps-set-cookie`

`HttpCachePlugin` rebuilt every cacheable response with `new Response()`, and the Response constructor silently drops `Set-Cookie`. so any cacheable GET that set a cookie (login pages, session refreshes) lost it, and the site never saw that cookie again. that's a classic "logs in, then gets logged straight back out" bug.

the patch keeps the original raw headers on the response the page gets. the cached copy still has no cookies, which is what you want in a shared cache.

tested by the "cookies round trip" e2e check.

## adding a patch

1. find the minified code in `node_modules/@mercuryworkshop/<pkg>/dist/`.
2. add `{ id, why, find, replace }` to the right list in `src/scramjet-patches.js`. make `find` long enough to match only once.
3. add a fixture check in `test/fixture/site/checks.js` that fails without it.
4. run `npm run check && npm test && npm run test:e2e`.
