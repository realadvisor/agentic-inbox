import { Hono } from "hono";
import { Scalar } from "@scalar/hono-api-reference";
import spec from "../openapi.json";

export function documentation() {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.header("Cache-Control", "no-store");
		await next();
	});
	app.get("/api/openapi.json", (c) => c.json(spec));
	app.get(
		"/api/docs",
		Scalar({
			url: "/api/openapi.json",
			cdn: "/vendor/scalar.js",
			pageTitle: "RealAdvisor Inbox API",
			withDefaultFonts: false,
			persistAuth: false,
			proxyUrl: "",
			telemetry: false,
		}),
	);
	return app;
}
