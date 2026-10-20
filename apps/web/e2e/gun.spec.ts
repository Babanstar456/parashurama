import { expect, test } from '@playwright/test';

test.describe('Air defence gun drills', () => {
  test('the Hub card opens the gun drills with both games', async ({ page }) => {
    await page.goto('/?reset');
    await page.click('#hcGun');
    await expect(page.locator('#gunApp')).toHaveClass(/on/);
    await expect(page.locator('[data-game=control]')).toBeVisible();
    await expect(page.locator('[data-game=ground]')).toBeVisible();
  });

  test('On Ground: a drill plays to a verified debrief and does not touch the radar history', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto('/?gun=ground&reset');
    await expect(page.locator('.gnDrill.ground')).toBeVisible();
    const before = await page.evaluate(() => (window as any).PARA.DB.H.length);
    await page.keyboard.press('k');
    await page.evaluate(() => (window as any).PARA_GUN.autoplay());
    await expect(page.locator('.gnScore b')).toHaveText(/^\d{1,3}$/);
    await expect(page.locator('.gnScore')).toContainText('Verified');
    await expect(page.locator('.gnParts')).toContainText('G6');
    expect(await page.evaluate(() => (window as any).PARA.DB.H.length)).toBe(before);
    expect(await page.evaluate(() => (window as any).PARA_GUN.history().length)).toBe(1);
    expect(errors).toEqual([]);
  });

  test('Control Room: orders go out on the radio net; firing order needs a selected track', async ({ page }) => {
    await page.goto('/?gun=control&reset');
    await expect(page.locator('.gnDrill.control')).toBeVisible();
    await expect(page.locator('[data-o=engage]')).toBeDisabled();
    await page.keyboard.press('r');
    await expect(page.locator('#gnRadio')).toContainText('RANGE CLEAR');
    await page.evaluate(() => (window as any).PARA_GUN.autoplay());
    await expect(page.locator('.gnScore')).toContainText('Verified');
    await expect(page.locator('.gnParts')).toContainText('F2');
  });
});

test.describe('UAV ground-control-station strike drill', () => {
  test('pre-flight checks tick off; the expert mission ends in a verified debrief', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto('/?gun=uav&reset');
    await expect(page.locator('.gnDrill.gcs')).toBeVisible();
    await page.click('#ucProc [data-check=link]');
    await expect(page.locator('#ucProc li.ok')).toHaveCount(1);
    await page.keyboard.press(' '); // release on the ground: nothing happens (not airborne, not armed)
    await page.evaluate(() => (window as any).PARA_UAV.autoplay());
    await expect(page.locator('.gnScore')).toContainText('Verified');
    await expect(page.locator('.gnParts')).toContainText('U5');
    expect(errors).toEqual([]);
  });
});
