import { expect, test } from '@playwright/test';

test.describe('Igla (MANPADS) drill on foot', () => {
  test('the home menu and the gun lobby both open the Igla drill', async ({ page }) => {
    await page.goto('/?reset');
    await page.click('#hcPlay'); await page.click('#hcGround');
    await expect(page.locator('#hcIgla')).toContainText('Igla on foot');
    await page.click('#hcGun');
    await expect(page.locator('#gnIgla')).toContainText('Igla (MANPADS)');
  });

  test('a drill runs: the gunner, the launcher state, the net calls, then the expert plays it to a debrief', async ({ page }) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto('/?gun=igla&reset');
    await page.waitForFunction(() => (window as any).PARA_IGLA?.state()?.tick > 3, null, { timeout: 120_000 });
    await expect(page.locator('#igObj')).toContainText('Tube on the gripstock: live round');
    await expect(page.locator('#igObj')).toContainText('BCU: fitted, off');
    // The trigger does nothing without a lock (launch interlock).
    await page.evaluate(() => { const P = (window as any).PARA_IGLA; P.look(P.engine().sol.az, 30, true); P.skip(1.5); });
    await page.evaluate(() => { const P = (window as any).PARA_IGLA; P.trig(); P.skip(0.3); });
    expect(await page.evaluate(() => (window as any).PARA_IGLA.state().launches)).toBe(0);
    await expect(page.locator('#igRadio')).toContainText('Switch on the BCU first');
    // The air defence net calls the first contact within the first half minute.
    await page.evaluate(() => (window as any).PARA_IGLA.skip(25));
    await expect(page.locator('#igRadio')).toContainText('AD NET');
    // The expert gunner plays the rest; the drill ends in a debrief and is kept in the history.
    await page.evaluate(() => { const P = (window as any).PARA_IGLA; P.ai(true); P.skip(400); });
    await expect(page.locator('.gnDebrief h2')).toHaveText(/Igla on foot/, { timeout: 30_000 });
    await expect(page.locator('.gnLead b')).toHaveText(/^\d{1,3}$/);
    const h = await page.evaluate(() => JSON.parse(localStorage.getItem('parashurama.iglaH') || '[]'));
    expect(h.length).toBe(1); expect(typeof h[0].total).toBe('number');
    expect(errors).toEqual([]);
  });
});
