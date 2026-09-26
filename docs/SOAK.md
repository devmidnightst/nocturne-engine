# soak test results

2 hour run of `npm run test:soak` on 2026-09-26, in the claude cloud sandbox (4 cores), on the build in this branch:

```sh
SOAK_NAV_TRANSPORTS=libcurl,libcurl SOAK_FLIP=0 SOAK_MINUTES=120 SOAK_SAMPLE_SECONDS=60 npm run test:soak
```

both browsing shells ran libcurl (the default now) with no transport flips, since epoxy's keep alive bug (see the README) makes it fail on purpose. real sites were left out because libcurl can't trust the sandbox's re-signing ca. the two websocket shells ran one per transport the whole time.

summary: 20,588 navigations with 0 failures, 0 crashes, server memory, fds and wisp connections flat, and 14,401 websocket round trips plus 28,776 server pushes with nothing lost.

## known, not fixed here

every navigation keeps the old proxied window alive in the shell tab (about 0.7 windows and 0.8 MB of js heap per navigation, measured with heap snapshots). it happens on main with the original engine too, so it looks like scramjet or chromium, not nocturne's plugins. the soak reloads each shell every 60 navigations, which is why its heap stays flat above. a user who clicks through a few hundred pages in one tab without reloading will see the tab grow; single page apps like discord don't navigate, so they don't hit it.

## the report



- duration: 120 minutes, 20588 navigations, 121 samples
- server restarts (crashes): 0
- server log lines that look like errors: 0
- shell page crashes: 0
- uncaught page errors (shell or proxied sites, see shell-errors.jsonl): 0

### navigations

| page | ok | failed | p50 | p95 |
|---|---|---|---|---|
| redirect | 4118 | 0 | 149 ms | 213 ms |
| error | 4118 | 0 | 146 ms | 209 ms |
| fixture | 4118 | 0 | 753 ms | 989 ms |
| heavy | 4117 | 0 | 712 ms | 914 ms |
| child | 4117 | 0 | 299 ms | 428 ms |

### trends (steady state, first quarter vs last quarter, least squares slope)

| metric | start | end | slope |
|---|---|---|---|
| server rss | 145.3 MB | 146.8 MB | +0.95 MB/h |
| server heap after gc | 11.4 MB | 11.9 MB | +0.34 MB/h |
| server open fds | 45.8 fds | 46.2 fds | +0.22 fds/h |
| wisp connections | 7.3 conns | 7.4 conns | +0.09 conns/h |
| nav p50 | 305.9 ms | 295.4 ms | -5.67 ms/h |
| nav p95 | 890.3 ms | 831.7 ms | -42.44 ms/h |
| nav-a js heap | 21.6 MB | 20.6 MB | -0.70 MB/h |
| nav-a dom nodes | 598.8 nodes | 582.5 nodes | -10.80 nodes/h |
| nav-b js heap | 19.4 MB | 19.4 MB | -0.33 MB/h |
| nav-b dom nodes | 564.1 nodes | 565.4 nodes | -2.45 nodes/h |
| ws-epoxy js heap | 5.9 MB | 5.9 MB | +0.00 MB/h |
| ws-epoxy dom nodes | 426.0 nodes | 426.0 nodes | -0.00 nodes/h |
| ws-libcurl js heap | 5.8 MB | 5.7 MB | -0.06 MB/h |
| ws-libcurl dom nodes | 426.1 nodes | 426.1 nodes | -0.02 nodes/h |

### long lived websockets

- ws-epoxy: {"echoSent":7201,"echoRecv":7201,"echoLate":0,"echoOpens":1,"echoCloses":0,"pushRecv":14389,"pushGaps":0,"pushOpens":1,"pushCloses":0,"maxRttMs":120,"lastRttMs":4,"pendingEcho":0}
- ws-libcurl: {"echoSent":7200,"echoRecv":7200,"echoLate":0,"echoOpens":1,"echoCloses":0,"pushRecv":14387,"pushGaps":0,"pushOpens":1,"pushCloses":0,"maxRttMs":144,"lastRttMs":4,"pendingEcho":0}
