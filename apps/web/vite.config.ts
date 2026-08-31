import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cesiumRoot = fileURLToPath(new URL("./node_modules/cesium/Build/Cesium", import.meta.url));
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * `base` must match the GitHub Pages sub-path. Set VITE_BASE at build time
 * (the Pages workflow does), and it defaults to "/" for local dev.
 */
export default defineConfig(({ mode }) => ({
  base: process.env.VITE_BASE ?? "/",
  plugins: [
    react(),
    // Cesium ships its workers, assets and widget CSS as static files that must sit
    // beside the bundle; CESIUM_BASE_URL below points the runtime at them.
    viteStaticCopy({
      targets: [
        { src: `${cesiumRoot}/Workers`, dest: "cesium" },
        { src: `${cesiumRoot}/Assets`, dest: "cesium" },
        { src: `${cesiumRoot}/ThirdParty`, dest: "cesium" },
        { src: `${cesiumRoot}/Widgets`, dest: "cesium" },
      ],
    }),
  ],
  define: {
    CESIUM_BASE_URL: JSON.stringify(`${process.env.VITE_BASE ?? "/"}cesium`.replace(/\/+/g, "/")),
  },
  resolve: {
    alias: {
      "@japan-live/shared": r("../../packages/shared/src/index.ts"),
      "@japan-live/core": r("../../packages/core/src/index.ts"),
      "@japan-live/transit": r("../../packages/transit/src/index.ts"),
      "@japan-live/providers": r("../../packages/providers/src/index.ts"),
      "@japan-live/simulation": r("../../packages/simulation/src/index.ts"),
    },
  },
  build: {
    outDir: "dist",
    sourcemap: mode !== "production",
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      output: {
        manualChunks: {
          // Cesium is by far the largest dependency; keeping it in its own chunk lets
          // the browser cache it across app deploys.
          cesium: ["cesium"],
          react: ["react", "react-dom"],
        },
      },
    },
  },
  server: { port: 5173, host: true },
}));
