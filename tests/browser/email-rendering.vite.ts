import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
	resolve: { alias: { "~": fileURLToPath(new URL("../../app", import.meta.url)) } },
	esbuild: { jsx: "automatic" },
	optimizeDeps: { include: ["react", "react-dom/client"] },
});
