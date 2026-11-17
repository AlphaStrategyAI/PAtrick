import { expect, test } from '@playwright/test';
import renderLock from '../../rendering.lock.json' with { type: 'json' };

test('loads the bilingual demo and preserves an independent consultation draft on reload', async ({ page, browser }) => {
  expect(browser.version()).toBe(renderLock.chromium.version);
  await page.goto('/decisions');
  await expect(page.getByRole('heading', { name: 'Needs decision' })).toBeVisible();
  await expect(page.getByText('Demo · sample data only')).toBeVisible();
  await page.getByRole('button', { name: 'Ask a question' }).click();
  await page.getByRole('textbox', { name: 'Consultation draft' }).fill('保留 / keep');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Ask a question' })).toBeFocused();
  await page.getByRole('combobox', { name: 'Interface language' }).selectOption('zh');
  await page.reload();
  await expect(page.getByRole('heading', { name: '需要决策' })).toBeVisible();
  await page.getByRole('button', { name: '问个问题' }).click();
  await expect(page.getByRole('textbox', { name: '咨询草稿' })).toHaveValue('保留 / keep');
});

test('mobile drawer restores focus and exposes protected navigation semantics', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile');
  await page.goto('/decisions');
  const trigger = page.getByRole('button', { name: 'Open navigation' });
  await trigger.click();
  const drawer = page.getByRole('dialog', { name: 'Main navigation' });
  await expect(drawer.getByRole('link', { name: 'Needs decision' })).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await drawer.getByRole('link', { name: 'Ongoing' }).click();
  await expect(page).toHaveURL(/\/work$/);
  await expect(page.getByRole('heading', { name: 'Ongoing' })).toBeVisible();
});
