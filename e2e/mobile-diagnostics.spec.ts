import { expect, test, type Locator, type Page } from "@playwright/test";
import { blockPlateau } from "./helpers.js";

/**
 * Can someone actually REACH the diagnostics on an iPhone?
 *
 * Two attempts failed before this one, and the second failure is the interesting one.
 *
 * V1.1 stacked LAYERS, PLATEAU BUILDINGS and DATA STATUS in a drawer where every panel
 * body was its own scroller. PR #4 removed the inner scrollers so the drawer was the
 * single scroll container, added a test that drove a scroll with `page.mouse.wheel`
 * from inside the LAYERS body, showed that test failing on the old code and passing on
 * the new — and on a real iPhone the diagnostics were still unreachable.
 *
 * WHY THE TEST LIED. `.hud > *` sets `pointer-events: none` on every grid cell, with
 * only .panel/button/input getting it back, so the drawer itself did not accept
 * pointer events. iOS Safari picks a pan's scroll container by hit-testing, found a
 * .panel that no longer scrolled, and handed the gesture to the map. Chromium's
 * synthetic wheel event takes a different path: it walks the containing-block chain
 * from the element under the cursor and does not care that an ancestor opted out of
 * hit-testing. A wheel event is not a finger.
 *
 * The lesson kept here: DO NOT prove a touch-scrolling fix with a wheel event. The
 * structure is what these tests assert now — a tab strip, one panel at a time, every
 * panel two taps from the map with no scrolling required at all — plus the specific
 * CSS property whose absence caused the second failure.
 */

const PHONES = [
  { name: "iPhone 14/15 (390x844)", width: 390, height: 844 },
  { name: "iPhone SE/mini (375x667)", width: 375, height: 667 },
];

async function boot(page: Page): Promise<void> {
  await blockPlateau(page);
  await page.goto("/");
  await page.waitForSelector(".cesium-widget canvas", { timeout: 45_000 });
  await page.waitForTimeout(5_000);
}

/** Open the drawer the way a finger does, not with a synthetic click. */
async function tap(page: Page, target: Locator): Promise<void> {
  await expect(target).toBeVisible();
  await expect(target).toBeInViewport();
  const box = await target.boundingBox();
  if (!box) throw new Error("no box to tap");
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

async function openDrawer(page: Page): Promise<void> {
  await tap(page, page.locator(".panels-toggle"));
  await expect(page.locator(".right-stack")).toBeVisible();
}

function tabButton(page: Page, name: string): Locator {
  return page.getByRole("tab", { name });
}

for (const phone of PHONES) {
  test.describe(phone.name, () => {
    test.use({ viewport: { width: phone.width, height: phone.height }, hasTouch: true });

    test("1-2. the drawer opens and every panel has a visible, tappable tab", async ({ page }) => {
      await boot(page);
      await expect(page.locator(".right-stack")).toBeHidden();
      await openDrawer(page);

      // All four tabs, on screen at once, at the narrowest phone we support.
      for (const name of ["レイヤー", "3D建物", "データ", "性能"]) {
        const tab = tabButton(page, name);
        await expect(tab, `tab ${name} is missing`).toBeVisible();
        await expect(tab, `tab ${name} is off screen`).toBeInViewport();
        const box = await tab.boundingBox();
        // A tap target under ~30px high is a coin toss with a thumb.
        expect(box!.height, `tab ${name} is only ${box!.height}px tall`).toBeGreaterThan(30);
      }

      await expect(tabButton(page, "レイヤー")).toHaveAttribute("aria-selected", "true");
    });

    test("3-5. the 3D建物 tab reaches the diagnostics in one tap", async ({ page }) => {
      await boot(page);
      await openDrawer(page); // tap 1

      await tap(page, tabButton(page, "3D建物")); // tap 2 — and that is the whole journey
      await expect(tabButton(page, "3D建物")).toHaveAttribute("aria-selected", "true");

      const panel = page.locator('section[aria-label="3D建物"]');
      await expect(panel).toBeVisible();
      await expect(panel).toBeInViewport();
      await expect(panel.getByText("PLATEAU BUILDINGS")).toBeVisible();
      await expect(panel.locator(".status-chip")).toBeVisible();

      // 4. The fields that answer "why are there no buildings?".
      for (const label of [
        "状態",
        "取得元",
        "読込済",
        "読込済区",
        "タイルセット",
        "表示",
        "カメラ高度",
        "LOD",
        "データ年度",
      ]) {
        await expect(
          panel.getByText(label, { exact: true }),
          `diagnostic field ${label} is not readable`,
        ).toBeVisible();
      }

      // The other panels are gone, not merely pushed below the fold.
      await expect(page.locator('section[aria-label="レイヤー"]')).toBeHidden();
      await expect(page.locator('section[aria-label="データ状態"]')).toBeHidden();

      // 5. The developer log, with the failed URLs behind it.
      const log = panel.getByRole("button", { name: /詳細ログ/ });
      if (await log.count()) {
        await tap(page, log);
        await expect(panel.locator(".diag-log")).toBeVisible();
      }
    });

    test("6-7. データ and back to レイヤー, one tap each", async ({ page }) => {
      await boot(page);
      await openDrawer(page);

      await tap(page, tabButton(page, "データ"));
      const data = page.locator('section[aria-label="データ状態"]');
      await expect(data).toBeVisible();
      await expect(data).toBeInViewport();
      await expect(data.getByText("DEMO (模擬データ)")).toBeVisible();

      await tap(page, tabButton(page, "レイヤー"));
      const layers = page.locator('section[aria-label="レイヤー"]');
      await expect(layers).toBeVisible();
      await expect(layers).toBeInViewport();
      await expect(page.locator('section[aria-label="データ状態"]')).toBeHidden();
    });

    test("the PERFORMANCE tab reports real frame timings", async ({ page }) => {
      await boot(page);
      await openDrawer(page);
      await tap(page, tabButton(page, "性能"));

      const panel = page.locator('section[aria-label="パフォーマンス"]');
      await expect(panel).toBeVisible();
      await expect(panel).toBeInViewport();

      // It must produce numbers, not just a heading. Frames accumulate as the scene
      // runs, so give the rolling window a moment to fill.
      await expect(panel.getByText("FPS", { exact: true })).toBeVisible({ timeout: 20_000 });
      for (const label of ["平均フレーム", "中央値", "p95", "解像度倍率", "品質プロファイル"]) {
        await expect(panel.getByText(label, { exact: true })).toBeVisible();
      }

      const fps = await panel.locator("dd").first().innerText();
      expect(Number.parseFloat(fps), `FPS read back as "${fps}"`).toBeGreaterThan(0);
    });

    test("no panel needs scrolling to be reached", async ({ page }) => {
      await boot(page);
      await openDrawer(page);

      // The bug this file exists for was a panel that could only be reached by a
      // gesture. With a tab per panel, the drawer's own scroll position must never be
      // what decides whether a panel is on screen.
      for (const [tabName, label] of [
        ["3D建物", "3D建物"],
        ["データ", "データ状態"],
        ["レイヤー", "レイヤー"],
      ] as const) {
        await tap(page, tabButton(page, tabName));
        await page.locator(".right-stack").evaluate((el) => {
          el.scrollTop = 0;
        });
        await expect(
          page.locator(`section[aria-label="${label}"]`),
          `${tabName} needed scrolling to come into view`,
        ).toBeInViewport();
      }
    });

    test("the open drawer accepts pointer events itself", async ({ page }) => {
      await boot(page);
      await openDrawer(page);

      // The exact regression that made PR #4 fail on a real device: the scroll
      // container inherited `pointer-events: none` from `.hud > *`, so iOS Safari
      // never treated it as the pan target. A synthetic wheel event does not notice.
      const pe = await page
        .locator(".right-stack")
        .evaluate((el) => getComputedStyle(el).pointerEvents);
      expect(pe, "the drawer opts out of hit-testing; iOS will give pans to the map").toBe(
        "auto",
      );
    });
  });
}

test.describe("desktop keeps its stacked panels", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("all three panels are visible at once and there is no tab strip", async ({ page }) => {
    await boot(page);
    await expect(page.locator(".drawer-tabs")).toHaveCount(0);
    await expect(page.locator('section[aria-label="レイヤー"]')).toBeVisible();
    await expect(page.locator('section[aria-label="3D建物"]')).toBeVisible();
    await expect(page.locator('section[aria-label="データ状態"]')).toBeVisible();

    // PERFORMANCE is present but collapsed, so nothing subscribes to a 2 Hz feed
    // until someone asks for it.
    const perf = page.locator('section[aria-label="パフォーマンス"]');
    await expect(perf).toBeVisible();
    await expect(perf.locator(".panel-body")).toHaveCount(0);
    await perf.getByRole("button", { name: "パフォーマンス計測" }).click();
    await expect(perf.getByText("FPS", { exact: true })).toBeVisible({ timeout: 20_000 });
  });
});
