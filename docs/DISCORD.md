# discord on nocturne engine

## honest status

discord **was not tested live** while this was built. the build machine's outbound network blocked discord.com, so no real discord session was ever loaded through it. what was tested is a local fixture that copies the behaviour discord depended on, in real chromium, over both transports. the first thing to do on the vps:

```sh
NOCTURNE_E2E_URLS=https://discord.com/login,https://discord.com/app npm run test:e2e
```

that loads each url through the proxy, waits 15s, and saves a screenshot (`e2e-discord.com.png`). it needs the dev dependencies (plain `npm ci`) and a chromium binary. set `CHROME_PATH` if playwright can't find one.

## what was fixed for it

| problem on stock scramjet 2.x | fix |
| --- | --- |
| the gateway sends HELLO the instant the websocket connects. on stock scramjet (seen with epoxy in the fixture) that message can reach the page before `open`, so the page answers with `ws.send()` while still CONNECTING and it throws. for discord that would mean the client never identifies and sits on "connecting". | `websocket-open-order` queues data until `open` fires |
| cacheable GETs that set cookies lost the `Set-Cookie` header inside HttpCachePlugin | `http-cache-keeps-set-cookie` |
| every js chunk recompiled the 586kb rewriter wasm. discord ships a lot of chunks. | `wasm-module-cache`, about 3x faster per rewrite |
| minified `typeof(x).y` style code became a ReferenceError after rewriting | `keyword-glue` |
| module workers with imports died on load | `module-worker-imports` |
| `ws.close(code, reason)` lost the reason | `websocket-close-reason` |
| libcurl dropped websocket close codes (the page saw code 0) and never fired `close` on a socket that died or was refused. discord's qr login gateway closes with 1000 once the phone approves, and the client reads that code to decide whether to finish the login or show a new qr, so a code of 0 most likely explains "the qr resets and never logs in". a dropped gateway connection left the client sitting on a dead socket. | `ws-close-code`, `ws-close-frame`, `ws-dead-socket-closes` in `src/libcurl-patches.js`. the e2e suite replays the qr handshake against a local copy of the gateway. |
| epoxy 3.0.1 kept every websocket frame the page sent until the next one went out. discord's IDENTIFY would sit in the browser until the first heartbeat, and each heartbeat only left with the one after it, so the gateway would treat the session as dead and the client would reconnect forever. found by the soak test (echo round trips were exactly one ping interval on epoxy, 4ms on libcurl). | with epoxy selected, websockets go through libcurl (`engine.js`). the e2e suite checks a lone message's round trip on both transports. |

with "block ads & trackers" on, discord's telemetry (`/api/v*/science` and `/api/v*/metrics`) is answered locally with an empty 200. that's less traffic through wisp and one less thing to go wrong.

see [PATCHES.md](PATCHES.md) for the details.

## known limits

- **voice, video and screen share don't go through the proxy.** they use webrtc (udp to discord's media servers), and scramjet 2.x doesn't tunnel webrtc. they'll either fail or connect straight from the user's own ip. text, dms, servers, images and embeds all go over http and the gateway websocket, so those go through the proxy.
- **login checks.** discord sees your vps ip, not the user's. a login from a datacenter ip often gets an hcaptcha, and sometimes a "new login location" email or a phone check. hcaptcha runs through the proxy like any other page, but it scores datacenter traffic harshly, so expect more challenges than on a home connection.
- **bandwidth.** avatars, attachments and emoji from `cdn.discordapp.com` and `media.discordapp.net` all go through your server. a busy discord tab can be a steady stream of traffic.
- **one account per browser profile.** proxied cookies live in the user's browser under the nocturne origin, so two tabs share one discord session, same as normal.

## when something breaks

1. switch transport (settings, or the button on the error page or banner). epoxy and libcurl have different tls and http stacks, and a site that breaks on one often works on the other.
2. turn on compat mode for discord.com from the recovery banner. it disables the two most involved rewrites for that origin only.
3. turn on "rewriter logs" under developer settings and check the browser console. `__nocturneDiag` in the console shows rewriter error counts and the last few errors.
4. `NOCTURNE_DISABLE_PATCHES=all npm start` serves stock scramjet. if the bug is still there, it's upstream. [open an issue with scramjet](https://github.com/MercuryWorkshop/scramjet/issues).
