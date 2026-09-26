// pm2 config for nocturne engine.
//
//   pm2 start ecosystem.config.cjs      first start
//   pm2 reload ecosystem.config.cjs     zero downtime restart after a git pull
//   pm2 save && pm2 startup             survive reboots
//
// cluster mode is safe here: every wisp websocket stays on the worker that
// accepted it, and all proxy state (cookies, rewriting) lives in the browser.

module.exports = {
	apps: [
		{
			name: "nocturne-engine",
			script: "src/server.js",
			cwd: __dirname,
			exec_mode: "cluster",
			// one worker per core. on the 12 core gcore box you may want to leave
			// a few cores for caddy and anything else running there, e.g. 8
			instances: process.env.NOCTURNE_INSTANCES || "max",
			// server.js calls process.send("ready") once it is listening
			wait_ready: true,
			listen_timeout: 10000,
			kill_timeout: 9000,
			max_memory_restart: "700M",
			env: {
				NODE_ENV: "production",
				HOST: "127.0.0.1",
				PORT: 8080,
				TRUST_PROXY: "loopback",
			},
			time: true,
			merge_logs: true,
		},
	],
};
