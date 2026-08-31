import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@japan-live/shared": r("./packages/shared/src/index.ts"),
      "@japan-live/core": r("./packages/core/src/index.ts"),
      "@japan-live/transit": r("./packages/transit/src/index.ts"),
      "@japan-live/providers": r("./packages/providers/src/index.ts"),
      "@japan-live/simulation": r("./packages/simulation/src/index.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["packages/*/test/**/*.test.ts", "apps/gateway/test/**/*.test.ts"],
  },
});
