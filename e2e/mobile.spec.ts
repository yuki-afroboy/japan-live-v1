import { expect, test } from "@playwright/test";

/**
 * Map-first on a phone (spec §19).
 *
 * The desktop layout puts panels at the edges; on a 414px screen the same panels
 * cover the map entirely, which turns the product into a settings screen. These
 * assert the map keeps the screen.
 */

test.use({ viewport: { width: 414, height: 896 } });

test("the map, not the panels, owns a phone screen", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(".cesium-widget canvas", { timeout: 45_000 });
  await page.waitForTimeout(5_000);

  // Panels start closed.
  await expect(page.locator(".right-stack")).toBeHidden();

  const canvas = await page.locator(".cesium-widget canvas").boundingBox();
  const viewport = page.viewportSize()!;
  const canvasArea = canvas!.width * canvas!.height;

  // Everything visible that is not the map.
  let covered = 0;
  for (const sel of [".brand", ".panels-toggle", ".top-center", ".timeline-wrap"]) {
    const box = await page.locator(sel).boundingBox();
    if (box) covered += box.width * box.height;
  }
  const visibleMap = 1 - covered / canvasArea;
  expect(visibleMap).toBeGreaterThan(0.45);
  expect(canvasArea).toBeGreaterThan(viewport.width * viewport.height * 0.9);
});

test("the panels open and close on demand", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(".cesium-widget canvas", { timeout: 45_000 });
  await page.waitForTimeout(5_000);

  const toggle = page.locator(".panels-toggle");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  await toggle.click();
  await expect(page.locator(".right-stack")).toBeVisible();
  await expect(page.locator('section[aria-label="データ状態"]')).toBeVisible();

  await toggle.click();
  await expect(page.locator(".right-stack")).toBeHidden();
});

test("the honesty badge and timeline stay visible without opening anything", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(".cesium-widget canvas", { timeout: 45_000 });
  await page.waitForTimeout(5_000);

  // Whatever else is hidden, the user must always be able to see that this is demo
  // data and what time is being shown.
  await expect(page.locator(".mode-badge.demo")).toBeVisible();
  await expect(page.locator(".clock")).toBeVisible();
  await expect(page.locator(".timeline")).toBeVisible();
  await expect(page.locator(".attribution")).toBeVisible();
});
