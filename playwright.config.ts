import { defineConfig } from "@playwright/test";
process.loadEnvFile(".env");
export default defineConfig({
	testDir: "./tests/browser",
	workers: 1,
	use: {
		baseURL: "http://127.0.0.1:4310",
		channel: "chrome",
		viewport: { width: 1440, height: 1000 },
		trace: "retain-on-failure",
	},
	webServer: {
		command: "pnpm dev",
		url: "http://127.0.0.1:4310",
		reuseExistingServer: true,
		timeout: 60000,
		gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
	},
});
