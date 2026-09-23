import { readFileSync } from "node:fs";

const config = readFileSync("wrangler.jsonc", "utf8");
if (config.includes("00000000000000000000000000000000")) {
	throw new Error(
		"Provision the Postgres database and Hyperdrive binding before deployment; wrangler.jsonc still contains the placeholder binding.",
	);
}
console.log(
	"Deployment binding configured. Live mode requires a valid Cloudflare Access JWT and configured audience.",
);
