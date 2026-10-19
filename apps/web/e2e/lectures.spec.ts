import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';

const clip = resolve(import.meta.dirname, 'fixtures/lecture.webm'); // 2 s, 160×90 test pattern

test.describe('Lecture library (offline: stored in this browser)', () => {
  test('add a lecture from the hub, play it, keep it after reload, delete it', async ({ page }) => {
    await page.goto('/?reset');
    await page.click('#hcLectures');
    await expect(page.locator('#lectures')).toBeVisible();
    await expect(page.locator('.lecEmpty')).toContainText('No lectures yet');
    await page.setInputFiles('#lecFile', clip);
    await page.fill('#lecTitle', 'Reading the <RF> clue');
    await page.selectOption('#lecTopic', 'Sensors');
    await page.fill('#lecDesc', 'Two-second test clip');
    await page.click('#lecSave');
    await expect(page.locator('#lecMsg')).toContainText('Lecture added');
    const item = page.locator('.lecItem').first();
    await expect(item).toContainText('Reading the <RF> clue'); // escaped, shown as text
    await expect(item).toContainText('Sensors · 2 s');
    await item.locator('.lecPlay').click();
    const video = page.locator('#lecPlayer video');
    await expect(video).toBeVisible();
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThan(0);
    expect(Math.round(await video.evaluate((v: HTMLVideoElement) => v.duration))).toBe(2);
    await page.reload();
    await page.click('#hcLectures');
    await expect(page.locator('.lecItem')).toHaveCount(1);
    page.once('dialog', (d) => d.accept());
    await page.click('.lecDel');
    await expect(page.locator('.lecEmpty')).toBeVisible();
  });

  test('typing in the library does not trigger drill shortcuts', async ({ page }) => {
    await page.goto('/?reset');
    await page.click('#hcLectures'); // the brief is underneath: Enter there would begin a drill
    await page.fill('#lecTitle', 'x');
    await page.press('#lecTitle', 'Enter');
    await expect(page.locator('#fight')).not.toHaveClass(/on/);
  });
});
