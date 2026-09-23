import { copyFile, mkdir } from "node:fs/promises";
const target = new URL("../public/vendor/", import.meta.url);
await mkdir(target, { recursive: true });
await copyFile(
	new URL(
		"../node_modules/@scalar/api-reference/dist/browser/standalone.js",
		import.meta.url,
	),
	new URL("scalar.js", target),
);
