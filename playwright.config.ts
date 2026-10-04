import { defineConfig } from "@playwright/test";
import { browserDatabase } from "./scripts/browser-environment";

// Deliberately never load a developer .env or reuse an existing application.
process.env.DATABASE_URL = browserDatabase(process.env.DATABASE_URL);
process.env.CLASSIFIER_PREVIEW = "0";
process.env.CLASSIFIERS_ENABLED = "1";
process.env.TYPESAFE_API_KEY = "";
process.env.AI_GATEWAY_API_KEY = "";
process.env.WEBHOOK_SECRET_KEY = "11".repeat(32);
const port = Number(process.env.BROWSER_PORT ?? 4432);
const baseURL = `http://127.0.0.1:${port}`;
process.env.PORT = String(port);
process.env.PUBLIC_ORIGIN = baseURL;
export default defineConfig({
	testDir: "./tests/browser",
	testIgnore: "email-rendering.spec.ts",
	workers: 1,
	forbidOnly: !!process.env.CI,
	outputDir: "test-results/application",
	reporter: [
		["list"],
		["html", { outputFolder: "playwright-report/application", open: "never" }],
	],
	use: {
		baseURL,
		browserName: "chromium",
		viewport: { width: 1440, height: 1000 },
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	webServer: {
		command: "node --import tsx scripts/browser-server.ts",
		url: baseURL,
		reuseExistingServer: false,
		timeout: 60000,
		gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
	},
});
