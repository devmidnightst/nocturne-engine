const base = require("./ecosystem.config.cjs");
module.exports = {
	apps: base.apps.map((app) => ({
		...app,
		instances: 4,
		env: { ...app.env, PORT: 8090 },
	})),
};
