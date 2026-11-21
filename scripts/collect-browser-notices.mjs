// Saves the bundled browser's own license pages (chrome://credits and chrome://terms)
// so a release can ship them in notices/browser. All web requests are blocked.
// Usage: runtime\node\node.exe scripts\collect-browser-notices.mjs [--out <folder>]
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const outFlag = process.argv.indexOf('--out');
const out = outFlag > 0 ? path.resolve(process.argv[outFlag + 1]) : path.join(root, 'artifacts', 'third-party', 'browser-notices');
const executablePath = path.join(root, 'runtime', 'browsers', 'chromium-1248', 'chrome-win64', 'chrome.exe');
const { chromium } = createRequire(path.join(root, 'worker', 'package.json'))('playwright');

const profile = path.join(root, '.cache', `browser-notices-${crypto.randomUUID()}`);
await fs.mkdir(profile, { recursive: true });
await fs.mkdir(out, { recursive: true });
const context = await chromium.launchPersistentContext(profile, { executablePath, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
try {
  await context.route('**/*', route => (route.request().url().startsWith('chrome://') ? route.continue() : route.abort()));
  const page = context.pages()[0] ?? await context.newPage();
  for (const name of ['credits', 'terms']) {
    await page.goto(`chrome://${name}`, { waitUntil: 'load', timeout: 30000 });
    const html = await page.content();
    // textContent keeps the collapsed license bodies that innerText leaves out.
    const text = await page.evaluate(() => document.body?.textContent ?? '');
    if (text.trim().length < 200) throw new Error(`chrome://${name} returned too little text`);
    await fs.writeFile(path.join(out, `chrome-${name}.html`), html, 'utf8');
    await fs.writeFile(path.join(out, `chrome-${name}.txt`), text, 'utf8');
    console.log(`saved chrome-${name} (${text.length} chars)`);
  }
} finally {
  await context.close();
  await fs.rm(profile, { recursive: true, force: true });
}
