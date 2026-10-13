import { test, expect, Page } from '@playwright/test';

// Interactive state/emirate selection: click (or tap) a state polygon must
// select it, fit the viewport to its bounds, and replace the listing results
// with the state's filtered population. Hover must show the state name and its
// lazy listing count. Runs against a production server (BASE_URL, default
// :3000) with the tenant admin-1 asset served from /geo/.
const DEFAULT_CENTER: [number, number] = [77.0266, 28.4595]; // tenant map.center
const DEFAULT_ZOOM = 4; // tenant map.zoom
const MUMBAI: [number, number] = [72.877, 19.076]; // well inside Maharashtra

// Slippy-map projection (MapLibre world size = 512 * 2^zoom) to turn a
// lng/lat into a canvas pixel delta from the map center.
function projectDelta(lng: number, lat: number, center: [number, number], zoom: number) {
  const size = 512 * Math.pow(2, zoom);
  const worldX = (v: number) => ((v + 180) / 360) * size;
  const worldY = (v: number) => {
    const rad = (v * Math.PI) / 180;
    return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * size;
  };
  return {
    dx: worldX(lng) - worldX(center[0]),
    dy: worldY(lat) - worldY(center[1]),
  };
}

async function openBrowse(page: Page) {
  // The admin layer is served gzipped via /api/admin-geo (the raw public file
  // would be a 3.4 MB uncompressed download per visitor).
  const geoLoaded = page.waitForResponse(
    (r) => r.url().includes('/api/admin-geo') && r.status() === 200,
    { timeout: 30_000 }
  );
  await page.goto('/browse');
  await geoLoaded;
  const canvas = page.locator('.maplibregl-canvas');
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  // Headless style/WebGL startup is slower than a warm browser: give MapTiler
  // tiles + admin layers time to attach before computing the click point.
  await page.waitForTimeout(6000);
  const box = await canvas.boundingBox();
  if (!box) throw new Error('map canvas has no bounding box');
  const { dx, dy } = projectDelta(MUMBAI[0], MUMBAI[1], DEFAULT_CENTER, DEFAULT_ZOOM);
  return { x: box.x + box.width / 2 + dx, y: box.y + box.height / 2 + dy };
}

// Hovering can race layer attachment; retry with tiny pointer jiggles until the
// state tooltip appears (returns the hovered point).
async function hoverMaharashtra(page: Page, point: { x: number; y: number }) {
  const tooltip = page.locator('.map-state-tooltip');
  for (let attempt = 0; attempt < 8; attempt++) {
    await page.mouse.move(point.x + (attempt % 2), point.y + (attempt % 2));
    if (await tooltip.isVisible().catch(() => false)) return tooltip;
    await page.waitForTimeout(750);
  }
  return tooltip;
}

// The UI defaults to the Buy intent, which sends listingPurpose=Sell — the
// expected hover/listing count must be derived from the same query, not from
// the all-purpose total (which includes Rent).
async function expectedStateCount(stateId: string) {
  const url = `${process.env.BASE_URL || 'http://localhost:3000'}/api/state-counts?state=${stateId}&scope=both&listingPurpose=Sell`;
  // A freshly started server can answer the first count from a cold ES/cache
  // path; retry briefly so the test measures behavior, not warmup.
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url);
    if (res.ok) {
      const j = await res.json();
      if (typeof j.total === 'number' && j.total > 0) return j.total as number;
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error('state-counts did not return a positive total after retries');
}

test.describe('state selection on /browse', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('clicking a state selects it, zooms to it, and shows its listings', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const mapDataUrls: string[] = [];
    const mapDetailUrls: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/map-data')) mapDataUrls.push(r.url());
      if (r.url().includes('/api/admin-geo')) mapDetailUrls.push(r.url());
    });

    const expected = await expectedStateCount('IN-MH');
    expect(expected).toBeGreaterThan(0);

    const point = await openBrowse(page);

    // Hover first: tooltip carries the state name and its count.
    const tooltip = await hoverMaharashtra(page, point);
    await expect(tooltip).toBeVisible({ timeout: 10_000 });
    await expect(tooltip).toContainText('Maharashtra');
    await expect(tooltip).toContainText(`${expected} listings`, { timeout: 15_000 });

    // Canonical geometry for Maharashtra is fetched for hover/prefetch — the
    // sha cache-bust proves the client reuses the manifest identity, and the
    // outline drawn is exactly the shape the server filters by.
    await expect
      .poll(
        () => mapDetailUrls.filter((u) => u.includes('state=IN-MH') && u.includes('&v=')).length,
        { timeout: 15_000 }
      )
      .toBeGreaterThan(0);

    // Click selects the state.
    await page.mouse.click(point.x, point.y);

    // Chip proves the selection landed in the filter UI.
    const chip = page.locator('button[aria-label="Clear Maharashtra selection"]');
    await expect(chip).toBeVisible({ timeout: 10_000 });

    // The full-detail outline is fetched for the selected state only.
    const detail = mapDetailUrls.filter((u) => u.includes('state=IN-MH'));
    await expect.poll(() => detail.length, { timeout: 15_000 }).toBeGreaterThan(0);

    // The request flow must be: state-filtered fetch, then a post-zoom refetch
    // at the state's zoom with markers enabled (overview skips markers). Wait
    // for it explicitly — fitBounds animation + debounce is timing-dependent.
    await expect
      .poll(() => mapDataUrls.some((u) => u.includes('state=IN-MH')), { timeout: 10_000 })
      .toBe(true);
    const zoomed = await page.waitForRequest((r) => {
      if (!r.url().includes('/api/map-data') || !r.url().includes('state=IN-MH')) return false;
      const p = new URL(r.url()).searchParams;
      return p.get('markers') !== 'false' && Number(p.get('zoom')) >= 5;
    }, { timeout: 20_000 }).catch(() => null);
    expect(zoomed, `expected a post-zoom marker-enabled request; got ${mapDataUrls.join(' | ')}`).toBeTruthy();

    // Listings for the state render in the sidebar with the same total the API
    // reported for the default (Buy) intent.
    await expect(page.locator('a[href*="/property/"]').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(String(expected), { exact: false }).first()).toBeVisible({ timeout: 10_000 });

    // Clearing the chip drops the state filter and refetches without it.
    const before = mapDataUrls.length;
    await chip.click();
    await page.waitForTimeout(1500);
    const after = mapDataUrls.slice(before).filter((u) => u.includes('state=IN-MH'));
    expect(after.length).toBe(0);
    expect(errors, `page errors: ${errors.join('; ')}`).toEqual([]);
  });

  test('hovering a state shows its lazy listing count', async ({ page }) => {
    const expected = await expectedStateCount('IN-MH');
    const point = await openBrowse(page);
    const tooltip = await hoverMaharashtra(page, point);
    await expect(tooltip).toBeVisible({ timeout: 10_000 });
    await expect(tooltip).toContainText('Maharashtra');
    await expect(tooltip).toContainText(`${expected} listings`, { timeout: 15_000 });
    // Moving away from every region hides it. The canvas center is the tenant
    // center, so an Arabian Sea point (65E, 15N) is guaranteed to be over no
    // state polygon (moving a fixed few hundred px would still be Maharashtra).
    const ocean = projectDelta(65, 15, DEFAULT_CENTER, DEFAULT_ZOOM);
    const box = await page.locator('.maplibregl-canvas').boundingBox();
    await page.mouse.move(box!.x + box!.width / 2 + ocean.dx, box!.y + box!.height / 2 + ocean.dy);
    await expect(tooltip).toBeHidden({ timeout: 5_000 });
  });
});
