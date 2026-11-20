import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('./');
});

test('пустая страница подсказывает, что делать', async ({ page }) => {
  await expect(page.locator('#result')).toContainText('Заполните все три поля');
  await expect(page.locator('#error')).toBeHidden();
});

test('пример: два потребителя ломаются, один не затронут', async ({ page }) => {
  await page.getByRole('button', { name: /Загрузить пример/ }).click();
  const tiles = page.locator('.tile');
  await expect(tiles.nth(0)).toContainText('2');
  await expect(tiles.nth(0)).toContainText('потребителей сломается');
  await expect(tiles.nth(3)).toContainText('1');
  const cards = page.locator('.card');
  await expect(cards).toHaveCount(3);
  await expect(cards.filter({ hasText: 'mobile-app' })).toContainText('Сломается');
  await expect(cards.filter({ hasText: 'billing-service' })).toContainText('Сломается');
  await expect(cards.filter({ hasText: 'analytics-job' })).toContainText('Не затронут');
  await expect(cards.filter({ hasText: 'mobile-app' })).toContainText('npm run test:contract -- users');
  await expect(page.locator('#result')).toContainText('GET /legacy/ping');
});

test('сломанный YAML показывает понятную ошибку и исчезает после исправления', async ({ page }) => {
  await page.getByRole('button', { name: /Загрузить пример/ }).click();
  await page.locator('#new').fill('openapi: 3.0.0\ninfo: [unclosed');
  await expect(page.locator('#error')).toBeVisible();
  await expect(page.locator('#error')).toContainText('новая схема: не удалось разобрать');
  await page.getByRole('button', { name: /Загрузить пример/ }).click();
  await expect(page.locator('#error')).toBeHidden();
  await page.locator('#old').fill('swagger: "2.0"\npaths: {}');
  await expect(page.locator('#error')).toContainText('только OpenAPI 3');
});

test('фильтр уровней меняет таблицу изменений', async ({ page }) => {
  await page.getByRole('button', { name: /Загрузить пример/ }).click();
  const caption = page.locator('caption');
  await expect(caption).toHaveText(/Показано 11 из 12/);
  await page.getByLabel(/Безопасно/).check();
  await expect(caption).toHaveText('Показано 12 из 12');
  await page.getByLabel(/Ломает/).uncheck();
  await page.getByLabel(/Возможно/).uncheck();
  await expect(caption).toHaveText('Показано 1 из 12');
});

test('текст из схемы и карты выводится как текст, а не разметка', async ({ page }) => {
  await page.getByRole('button', { name: /Загрузить пример/ }).click();
  await page.locator('#map').fill('consumers:\n  "<img src=x onerror=window.__xss=1>":\n    owner: "<b>x</b>"\n    uses:\n      - operation: GET /users/{id}\n        response: [email]\n        check: "<script>window.__xss=2</script>"\n');
  await expect(page.locator('.card')).toHaveCount(1);
  await expect(page.locator('.card')).toContainText('<img src=x onerror=window.__xss=1>');
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  expect(await page.locator('.card img, .card b, .card script').count()).toBe(0);
});

test('загрузка файла подставляет его в поле', async ({ page }) => {
  await page.locator('#old-file').setInputFiles({ name: 'a.yaml', mimeType: 'text/yaml', buffer: Buffer.from('openapi: 3.0.0\ninfo: {}\npaths: {}\n') });
  await expect(page.locator('#old')).toHaveValue(/openapi: 3.0.0/);
});

test('копирование отчёта в Markdown', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'буфер обмена проверяем в chromium');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: /Загрузить пример/ }).click();
  await page.getByRole('button', { name: /Скопировать отчёт/ }).click();
  await expect(page.getByRole('button', { name: /Скопировано/ })).toBeVisible();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain('# Влияние изменений API на потребителей');
  expect(text).toContain('## mobile-app (@team-mobile)');
});

test('страница не прокручивается вбок', async ({ page }) => {
  await page.getByRole('button', { name: /Загрузить пример/ }).click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

for (const scheme of ['light', 'dark'] as const) {
  for (const state of ['с результатом', 'с ошибкой'] as const) {
    test(`доступность axe: ${scheme} тема, ${state}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.getByRole('button', { name: /Загрузить пример/ }).click();
      if (state === 'с ошибкой') await page.locator('#map').fill('consumers: [unclosed');
      await expect(state === 'с ошибкой' ? page.locator('#error') : page.locator('.card').first()).toBeVisible();
      const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
    });
  }
}

test('version.json содержит версию', async ({ request, baseURL }) => {
  const r = await request.get(new URL('version.json', baseURL).toString());
  expect(r.ok()).toBeTruthy();
  const v = await r.json();
  expect(v.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(v.commit).toMatch(/^[0-9a-f]{40}$/);
});
