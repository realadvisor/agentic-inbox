import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests/browser",
	testMatch: "email-rendering.spec.ts",
	use: { baseURL: "http://127.0.0.1:4397", channel: process.env.CI ? "chromium" : "chrome", trace: "retain-on-failure" },
	webServer: {
		command: "pnpm exec vite --config tests/browser/email-rendering.vite.ts --host 127.0.0.1 --port 4397 --strictPort",
		url: "http://127.0.0.1:4397/@vite/client",
	},
});
