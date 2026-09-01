import { defineConfig, devices } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";

/**
 * Use the Chromium already in the image rather than downloading one: the build number
 * Playwright expects and the one installed do not always match. Falls back to
 * Playwright's own resolution when nothing is preinstalled.
 */
function preinstalledChromium(): string | undefined {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  if (!existsSync(root)) return undefined;
  const dir = readdirSync(root).find((d) => /^chromium-\d+$/.test(d));
  if (!dir) return undefined;
  const exe = `${root}/${dir}/chrome-linux/chrome`;
  return existsSync(exe) ? exe : undefined;
}

const chromiumPath = preinstalledChromium();

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // The container has no GPU; SwiftShader software WebGL is what Cesium falls back to.
    launchOptions: {
      ...(chromiumPath ? { executablePath: chromiumPath } : {}),
      args: [
        "--use-gl=swiftshader",
        "--enable-unsafe-swiftshader",
        "--disable-dev-shm-usage",
        "--no-sandbox",
      ],
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run preview -w @japan-live/web -- --port 4173 --host 127.0.0.1",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
