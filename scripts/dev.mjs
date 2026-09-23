import { spawn } from "node:child_process";

const commands = [
	[
		"node_modules/tsx/dist/cli.mjs",
		"watch",
		"--env-file=.env",
		"server/index.ts",
	],
	[
		"node_modules/@react-router/dev/bin.js",
		"dev",
		"--host",
		"127.0.0.1",
		"--port",
		"4310",
	],
];
const children = commands.map((args) =>
	spawn(process.execPath, args, { stdio: "inherit" }),
);
let stopping = false;
function stop(code = 0) {
	if (stopping) return;
	stopping = true;
	for (const child of children) {
		try {
			child.kill("SIGTERM");
		} catch {
			/* Child already exited. */
		}
	}
	process.exitCode = code;
}
for (const child of children) {
	child.on("exit", (code) => stop(code ?? 1));
	child.on("error", (error) => {
		console.error(error.message);
		stop(1);
	});
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
