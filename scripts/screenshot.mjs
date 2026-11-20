// Снимок доски с загруженным примером для README: npm run site, затем node scripts/serve.mjs и node scripts/screenshot.mjs
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
await page.goto('http://127.0.0.1:4182/');
await page.getByRole('button', { name: /Загрузить пример/ }).click();
await page.locator('.card').first().waitFor();
await page.screenshot({ path: 'docs/screenshot.png', fullPage: true });
await browser.close();
