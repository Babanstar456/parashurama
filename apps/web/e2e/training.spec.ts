import { expect, test } from '@playwright/test';

test.describe('Recognition trainer, Hindi interface, all-drills review', () => {
  test('recognition trainer: 20 drones, an answer per drone, a result with accuracy and confusions', async ({ page }) => {
    await page.goto('/?reset');
    await page.click('#hcPlay'); await page.click('#hcRadarTrack'); await page.click('#hcRecog');
    await page.waitForSelector('#rcGo', { timeout: 60000 }); await page.click('#rcGo');
    for (let i = 0; i < 20; i++) {
      await expect(page.locator('#rcProg')).toHaveText(`Drone ${i + 1} of 20`);
      await page.keyboard.press('1');
      await page.waitForTimeout(i < 19 ? 2100 : 300);
    }
    await expect(page.locator('#rcAgain')).toBeVisible({ timeout: 15000 });
    const h = await page.evaluate(() => JSON.parse(localStorage.getItem('parashurama.recogH') || '[]'));
    expect(h.length).toBe(1); expect(h[0].n).toBe(20);
  });
  test('Hindi switch: the home screen and menus change language and the choice is kept', async ({ page }) => {
    await page.goto('/?reset');
    await page.click('#hcLang');
    await expect(page.locator('#hcPlay')).toContainText('खेलें');
    await expect(page.locator('html')).toHaveAttribute('lang', 'hi');
    await page.click('#hcPlay');
    await expect(page.locator('.homeMenu h2')).toHaveText('आप कहाँ प्रशिक्षण लेंगे?');
    await page.reload();
    await expect(page.locator('#hcLang')).toHaveText('English');
    await page.click('#hcLang');
    await expect(page.locator('#hcPlay')).toContainText('Play');
  });
  test('unit readiness shows the all-drills review with a progress chart and a CSV of every drill', async ({ page }) => {
    await page.goto('/?reset');
    await page.click('#hcPlay'); await page.click('#hcUnit');
    await expect(page.locator('#aarCard')).toContainText('All drills');
    await expect(page.locator('#aarCard .aarBoard tr')).toHaveCount(6); // header, you, four demo rows
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#aarCsv')]);
    expect(dl.suggestedFilename()).toBe('parashurama-all-drills.csv');
  });
});
