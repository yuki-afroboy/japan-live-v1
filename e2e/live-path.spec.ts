import { expect, test, type Page } from "@playwright/test";
import { blockPlateau } from "./helpers.js";

/**
 * The LIVE data path, end to end, against a stubbed gateway.
 *
 * Everything else in the suite exercises DEMO mode. This is the only test that puts
 * realtime-shaped data through the whole app — provider parse, freshness, render,
 * Inspector — and it is where the product's central promise is checked: that
 * REALTIME_TRIP is never presented as a realtime position, and that stale data stops
 * being called live.
 */

const GATEWAY = "https://stub-gateway.test";

function train(overrides: Record<string, unknown> = {}) {
  return {
    "@id": "urn:test:1",
    "dc:date": new Date().toISOString(),
    "odpt:operator": "odpt.Operator:Toei",
    "odpt:railway": "odpt.Railway:Toei.Oedo",
    "odpt:trainNumber": "0712A",
    "odpt:fromStation": "odpt.Station:Toei.Oedo.Roppongi",
    "odpt:toStation": "odpt.Station:Toei.Oedo.AzabuJuban",
    "odpt:delay": 60,
    "odpt:carComposition": 8,
    ...overrides,
  };
}

async function stubGateway(
  page: Page,
  options: { trains?: unknown[]; fail?: boolean; ageMs?: number } = {},
) {
  await page.route(`${GATEWAY}/**`, async (route) => {
    const url = route.request().url();
    if (options.fail) {
      await route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          endpoint: url,
          fetchedAt: Date.now(),
          error: { code: "UPSTREAM_502", message: "upstream request failed" },
        }),
      });
      return;
    }
    const isTrains = url.includes("/trains");
    const age = options.ageMs ?? 0;
    const stamp = new Date(Date.now() - age).toISOString();
    const data = isTrains
      ? (options.trains ?? [train({ "dc:date": stamp })])
      : [];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        endpoint: url,
        fetchedAt: Date.now(),
        sourceTimestamp: Date.now() - age,
        data,
      }),
    });
  });
}

async function boot(page: Page) {
  // This file is about the realtime data path. See e2e/helpers.ts.
  await blockPlateau(page);
  await page.goto(`/?gateway=${encodeURIComponent(GATEWAY)}`);
  await page.waitForSelector(".cesium-widget canvas", { timeout: 45_000 });
  await expect(page.locator(".boot")).toHaveCount(0, { timeout: 45_000 });
  await page.waitForTimeout(5_000);
}

test("with a gateway configured the app leaves DEMO mode and reports LIVE", async ({ page }) => {
  await stubGateway(page);
  await boot(page);

  await expect(page.locator(".mode-badge.demo")).toHaveCount(0);
  await expect(page.locator(".mode-badge.live")).toContainText("LIVE");

  const data = page.locator('section[aria-label="データ状態"]');
  await expect(data).toContainText("東京都交通局");
  await expect(data.locator(".status-chip.LIVE")).toHaveCount(1);
});

test("Toei data is labelled REALTIME TRIP, never REALTIME POSITION", async ({ page }) => {
  await stubGateway(page);
  await boot(page);

  const data = page.locator('section[aria-label="データ状態"]');
  // The whole product's central claim: this feed publishes no coordinates.
  await expect(data).toContainText("REALTIME TRIP");
  await expect(data).not.toContainText("REALTIME POSITION");
  await expect(page.locator("body")).not.toContainText("REALTIME POSITION");
});

test("stale realtime data stops being called live", async ({ page }) => {
  // Older than the 5 minute degrade threshold in ToeiProvider's freshness policy.
  await stubGateway(page, { ageMs: 400_000 });
  await boot(page);

  const data = page.locator('section[aria-label="データ状態"]');
  await expect(data.locator(".status-chip.LIVE")).toHaveCount(0);
  await expect(data).not.toContainText("REALTIME TRIP");
  // It degrades to schedule rather than silently continuing to claim realtime.
  await expect(data).toContainText("SCHEDULE");
});

test("an unreachable feed reports the failure and never fakes data", async ({ page }) => {
  await stubGateway(page, { fail: true });
  await boot(page);

  const data = page.locator('section[aria-label="データ状態"]');
  // Exactly one ERROR: the failing feed. Unavailable map layers carry OFF instead,
  // because a basemap that would not load is a different failure from a dead feed.
  await expect(data.locator(".status-chip.ERROR")).toHaveCount(1);
  await expect(data).toContainText("取得できません");

  // The map is still usable — a dead feed must not white-screen the app.
  await expect(page.locator(".cesium-widget canvas")).toBeVisible();
  await expect(page.locator(".timeline")).toBeVisible();
});

test("a realtime record with no timestamp is dropped, not trusted", async ({ page }) => {
  await stubGateway(page, {
    trains: [train({ "dc:date": undefined }), train({ "@id": "urn:test:2", "odpt:trainNumber": "0713A" })],
  });
  await boot(page);

  // One of the two records has no timestamp and must not be counted.
  const data = page.locator('section[aria-label="データ状態"]');
  await expect(data).toContainText("1本");
});

test("switching to SIMULATION stops claiming live data", async ({ page }) => {
  await stubGateway(page);
  await boot(page);
  await expect(page.locator(".mode-badge.live")).toBeVisible();

  await page.getByRole("button", { name: "×60", exact: true }).click();
  await expect(page.locator(".mode-badge.live")).toHaveCount(0);
  await expect(page.locator(".mode-badge.sim")).toContainText("SIMULATION ×60");
});
