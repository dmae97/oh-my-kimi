import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Dev-only Vite config for the harbor-manager dashboard.
 *
 * Serves `src/web` with React Fast Refresh and proxies the API — including the
 * SSE run stream at `/api/events` — to the Bun server that `scripts/dev.ts`
 * starts alongside it (`HARBOR_API_PORT`, default 4700). Production is served by
 * the Bun server itself (`src/server.ts` bundles `app.tsx` on demand); Vite is
 * not part of the production path.
 */
const apiTarget = `http://localhost:${process.env.HARBOR_API_PORT ?? "4700"}`;

export default defineConfig({
	root: "src/web",
	server: {
		port: Number(process.env.HARBOR_WEB_PORT ?? "5173"),
		proxy: {
			"/api": { target: apiTarget, changeOrigin: true },
		},
	},
	plugins: [react()],
});
