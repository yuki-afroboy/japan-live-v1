import { expect, test, type Page } from "@playwright/test";
import { blockPlateau } from "./helpers.js";

/**
 * Can someone actually READ the building diagnostics on an iPhone?
 *
 * V1.1 shipped a diagnostics panel that was unreachable on a phone: the drawer
 * scrolled, and each panel body scrolled inside it, so a finger drag in LAYERS moved
 * only LAYERS and never reached PLATEAU BUILDINGS or DATA STATUS behind it. The panel
 * existed in the DOM the whole time, which is exactly why "it renders" is not the same
 * as "a user can use it".
 *
 * So these assert visibility and actionability at an iPhone viewport, never presence.
 */

// iPhone 14 / 15 logical resolution. 375px (SE, mini) is checked separately below.
// hasTouch so a scroll can be driven the way a finger drives it, not only by script.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test.beforeEach(async ({ page }) => blockPlateau(page));

// `query` is only ever used to add ?debug=1, which exposes window.__viewer. It changes
// no layout, so the UI assertions below still describe what a normal visitor gets.
async function boot(page: Page, query = "") {
  await page.goto(`/${query}`);
  await page.waitForSelector(".cesium-widget canvas", { timeout: 45_000 });
  await page.waitForTimeout(5_000);
}

async function openDrawer(page: Page) {
  await page.locator(".panels-toggle").click();
  await expect(page.locator(".right-stack")).toBeVisible();
}

test("A. the layers/data drawer opens", async ({ page }) => {
  await boot(page);
  await expect(page.locator(".right-stack")).toBeHidden();
  await openDrawer(page);
  await expect(page.locator('section[aria-label="レイヤー"]')).toBeVisible();
});

test("B. PLATEAU BUILDINGS can be scrolled to and read", async ({ page }) => {
  await boot(page);
  await openDrawer(page);

  const buildings = page.locator('section[aria-label="3D建物"]');
  // scrollIntoViewIfNeeded fails if an ancestor cannot actually bring it into view.
  await buildings.scrollIntoViewIfNeeded();
  await expect(buildings).toBeInViewport();
  await expect(buildings.getByText("PLATEAU BUILDINGS")).toBeVisible();
});

test("C. every diagnostic field is legible, and the log opens", async ({ page }) => {
  await boot(page);
  await openDrawer(page);

  const buildings = page.locator('section[aria-label="3D建物"]');
  await buildings.scrollIntoViewIfNeeded();

  // The fields someone needs to diagnose missing buildings.
  for (const label of ["状態", "取得元", "読込済", "表示", "カメラ高度", "LOD"]) {
    await expect(buildings.getByText(label, { exact: true })).toBeVisible();
  }

  // STATUS chip, and the expandable developer log with failed URLs behind it.
  await expect(buildings.locator(".status-chip")).toBeVisible();
  const log = buildings.getByRole("button", { name: /詳細ログ/ });
  if (await log.count()) {
    await log.scrollIntoViewIfNeeded();
    await expect(log).toBeVisible();
    await log.click();
    await expect(buildings.locator(".diag-log")).toBeVisible();
  }
});

test("D. DATA STATUS can be scrolled to, below the diagnostics", async ({ page }) => {
  await boot(page);
  await openDrawer(page);

  const data = page.locator('section[aria-label="データ状態"]');
  await data.scrollIntoViewIfNeeded();
  await expect(data).toBeInViewport();
  await expect(data.getByText("DEMO (模擬データ)")).toBeVisible();
});

test("the drawer is a single scroll container, not nested scrollers", async ({ page }) => {
  await boot(page);
  await openDrawer(page);

  const nested = await page.locator(".right-stack .panel-body").evaluateAll((els) =>
    els
      .filter((el) => {
        const style = getComputedStyle(el);
        const scrolls = style.overflowY === "auto" || style.overflowY === "scroll";
        return scrolls && el.scrollHeight > el.clientHeight + 1;
      })
      .map((el) => el.closest("section")?.getAttribute("aria-label") ?? "?"),
  );
  // An inner scroller here swallows the touch gesture on iOS and strands the panels
  // behind it — the exact bug this file exists for.
  expect(nested, `panel bodies still scroll independently: ${nested.join(", ")}`).toEqual([]);
});

test("a scroll gesture started inside LAYERS moves the drawer, not just LAYERS", async ({
  page,
}) => {
  await boot(page);
  await openDrawer(page);

  const before = await page.locator(".right-stack").evaluate((el) => el.scrollTop);

  // Put the pointer over the LAYERS body and scroll from there. This is the gesture
  // that failed on the device: with an inner scroller, the panel consumes the drag and
  // the drawer never moves, so PLATEAU BUILDINGS behind it stays out of reach.
  const layersBody = page.locator('section[aria-label="レイヤー"] .panel-body');
  const box = (await layersBody.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 500);
  await page.waitForTimeout(700);

  const after = await page.locator(".right-stack").evaluate((el) => el.scrollTop);
  expect(
    after,
    "a scroll starting inside LAYERS did not move the drawer; the panel trapped it",
  ).toBeGreaterThan(before);
});

test("scrolling the drawer to the bottom reaches DATA STATUS", async ({ page }) => {
  await boot(page);
  await openDrawer(page);

  await page.locator(".right-stack").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(500);
  await expect(page.locator('section[aria-label="データ状態"]')).toBeInViewport();
});

test("E. CITY VIEW is visible and tappable without any horizontal scrolling", async ({ page }) => {
  await boot(page, "?debug=1");

  const city = page.getByRole("button", { name: "CITY VIEW" });
  await expect(city).toBeVisible();
  await expect(city).toBeInViewport();

  // It must not be parked inside the horizontally scrolling preset list.
  const pinned = await city.evaluate((el) => Boolean(el.closest(".preset-pinned")));
  expect(pinned, "CITY VIEW is inside the horizontal scroller and can be swiped away").toBe(true);

  // And it does what it says: a low oblique camera over west Shinjuku. Read the real
  // camera, not a label — the point of the button is the viewpoint it lands on.
  await city.click();
  await page.waitForTimeout(9_000);
  const cam = await page.evaluate(() => {
    const camera = (window as any).__viewer?.camera;
    if (!camera) return null;
    const c = camera.positionCartographic;
    return {
      lon: (c.longitude * 180) / Math.PI,
      lat: (c.latitude * 180) / Math.PI,
      height: c.height,
      pitchDeg: (camera.pitch * 180) / Math.PI,
    };
  });
  expect(cam, "no Cesium camera to read").not.toBeNull();
  // West Shinjuku, roughly. Generous box: the assertion is "it flew to the city", not
  // a re-statement of the preset's constants.
  expect(cam!.lon).toBeGreaterThan(139.6);
  expect(cam!.lon).toBeLessThan(139.78);
  expect(cam!.lat).toBeGreaterThan(35.62);
  expect(cam!.lat).toBeLessThan(35.73);
  // Low and oblique: buildings are only legible from below ~2 km at a downward tilt
  // shallow enough to see their sides.
  expect(cam!.height).toBeLessThan(2_000);
  expect(cam!.pitchDeg).toBeLessThan(-5);
  expect(cam!.pitchDeg).toBeGreaterThan(-60);
});

test("the future-layer list is collapsed so diagnostics are not pushed off screen", async ({
  page,
}) => {
  await boot(page);
  await openDrawer(page);

  const layers = page.locator('section[aria-label="レイヤー"]');
  // Six V1-inoperable controls used to occupy roughly half the panel.
  await expect(layers.getByRole("button", { name: /V2以降で追加予定/ })).toBeVisible();
  await expect(layers.getByRole("button", { name: "バス Bus" })).toHaveCount(0);

  await layers.getByRole("button", { name: /V2以降で追加予定/ }).click();
  await expect(layers.getByRole("button", { name: "バス Bus" })).toBeVisible();
});

test.describe("on a 375px phone (iPhone SE / mini)", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("CITY VIEW is still reachable in one tap", async ({ page }) => {
    await boot(page);
    const city = page.getByRole("button", { name: "CITY VIEW" });
    await expect(city).toBeVisible();
    await expect(city).toBeInViewport();
    await city.click();
  });

  test("the diagnostics are still reachable", async ({ page }) => {
    await boot(page);
    await openDrawer(page);
    const buildings = page.locator('section[aria-label="3D建物"]');
    await buildings.scrollIntoViewIfNeeded();
    await expect(buildings).toBeInViewport();
  });
});
