import { expect, test } from '@playwright/test';

test.describe('Mission Hub and 3D view', () => {
  test('the hub opens first and every path works', async ({ page }) => {
    await page.goto('/?reset');
    await expect(page.locator('#home')).toHaveClass(/on/);
    await expect(page.locator('#tour')).not.toHaveClass(/on/); // the tour waits until a path is chosen
    await expect(page.locator('.homeTitle')).toHaveText('PARASHURAMA');
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

  test('keyboard: Enter on the hub starts the Academy, not a scored drill', async ({ page }) => {
    await page.goto('/?reset');
    await expect(page.locator('#hcAcademy')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#fight')).toHaveClass(/on/);
    expect(await page.evaluate(() => document.body.dataset.mode)).toBe('academy');
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
