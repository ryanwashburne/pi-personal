import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { varlockVitePlugin } from "@varlock/vite-integration";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
	server: {
		port: 3001,
	},
	resolve: {
		tsconfigPaths: true,
	},
	plugins: [
		varlockVitePlugin({ ssrInjectMode: "resolved-env" }),
		tailwindcss(),
		tanstackStart(),
		nitro(),
		viteReact(),
	],
	// The deployed server is the standalone build artifact. Dev keeps deps external
	// because the dev module runner cannot evaluate CommonJS packages like react.
	ssr: command === "build" ? { noExternal: true } : {},
}));
