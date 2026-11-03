import { expect, test } from '@playwright/test';

test.describe('Mission Hub and 3D view', () => {
  test('the hub opens first and every path works', async ({ page }) => {
    await page.goto('/?reset');
    await expect(page.locator('#home')).toHaveClass(/on/);
    await expect(page.locator('#tour')).not.toHaveClass(/on/); // the tour waits until a path is chosen
    await expect(page.locator('.homeTitle')).toHaveText('PARASHURAMA');
    // Only Play at first; the choices come after it, and the rest waits behind More options.
    await expect(page.locator('#hcL70')).toHaveCount(0);
    await page.click('#hcPlay');
    await expect(page.locator('#hcL70')).toBeVisible();
    await expect(page.locator('#hcDrill')).toBeHidden();
    await page.click('#hcMore');
    await expect(page.locator('[data-hm]')).toHaveCount(4);

    // Quick drill: brief + first-visit tour
    await page.click('#hcDrill');
    await expect(page.locator('#brief')).toHaveClass(/on/);
    await expect(page.locator('#tour')).toHaveClass(/on/);
    await page.click('#tourEnd');

    // Home button reopens the hub; commander path opens the readiness board
    await page.click('#homeBtn');
    await page.click('#hcUnit');
    await expect(page.locator('#tabUnit')).toBeVisible();
    await expect(page.locator('#board')).toContainText('Bad weather');

    // A real-world mission starts a scored drill with its weather
    await page.click('#homeBtn');
    await page.click('[data-hm="1"]');
    await expect(page.locator('#fight')).toHaveClass(/on/);
    await expect(page.locator('#homeBtn')).toBeHidden(); // no accidental exit mid-drill
    expect(await page.evaluate(() => (window as any).PARA.live.cfg.weather)).toBe('fog');
  });

  test('keyboard: Enter on Play shows the choices (easy L-70 first); nothing starts by itself', async ({ page }) => {
    await page.goto('/?reset');
    await expect(page.locator('#hcPlay')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#hcL70')).toBeFocused();
    await expect(page.locator('#fight')).not.toHaveClass(/on/);
    await page.keyboard.press('Escape');
    await expect(page.locator('#hcPlay')).toBeVisible();
  });

  test('the easy L-70 opens a day, clear-sky field drill at level 1 with working sensors', async ({ page }) => {
    await page.goto('/?reset');
    await page.click('#hcPlay');
    await page.click('#hcL70');
    await expect(page.locator('.gnDrill.field')).toBeVisible();
    const cfg = await page.evaluate(() => (window as any).PARA_GUN.engine().cfg);
    expect([cfg.gun, cfg.time, cfg.weather, cfg.difficulty, !!cfg.radarFault]).toEqual(['l70', 'day', 'clear', 1, false]);
  });

  test('3D view: present in scored drills, expands with V, minimises', async ({ page }) => {
    await page.goto('/?reset&nohome');
    await page.click('#tourEnd');
    await page.click('#beginBtn');
    const has3d = await page.locator('#view3d canvas').count();
    test.skip(!has3d, 'no WebGL in this browser: the 2D radar still works');
    await page.evaluate(() => localStorage.removeItem('parashurama.3dmin'));
    await page.keyboard.press('v');
    await expect(page.locator('#view3d')).toHaveClass(/big/);
    await page.keyboard.press('v');
    await expect(page.locator('#view3d')).not.toHaveClass(/big/);
    await page.click('#v3min');
    await expect(page.locator('#view3d')).toHaveClass(/min/);
  });

  test('lite mode: with ?lite the 3D view stays closed on drill start', async ({ page }) => {
    await page.goto('/?reset&nohome&lite');
    await page.click('#tourEnd');
    await page.click('#beginBtn');
    const has3d = await page.locator('#view3d canvas').count();
    test.skip(!has3d, 'no WebGL in this browser: the 2D radar still works');
    await expect(page.locator('#view3d')).toHaveClass(/min/);
    await expect(page.locator('#liteBtn')).toContainText('Lite on');
  });
});
