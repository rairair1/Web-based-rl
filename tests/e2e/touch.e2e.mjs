// End-to-end check of the touch layer against a running stack.
//
// Start the stack with tests/fixtures/InputProbe.java as RUNELITE_CMD and its
// stdout in PROBE_LOG (see tests/README.md), then:
//   RLWEB_URL=http://127.0.0.1:8080 RLWEB_PASSWORD=... PROBE_LOG=... node tests/e2e/touch.e2e.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { chromium } from 'playwright';

const URL_BASE = process.env.RLWEB_URL || 'http://127.0.0.1:8080';
const PASSWORD = process.env.RLWEB_PASSWORD;
const PROBE_LOG = process.env.PROBE_LOG;
const SCREENSHOT = process.env.SCREENSHOT;
assert.ok(PASSWORD && PROBE_LOG, 'Set RLWEB_PASSWORD and PROBE_LOG');

let logOffset = readFileSync(PROBE_LOG, 'utf8').length;
async function probeLines() {
  await sleep(400);
  const text = readFileSync(PROBE_LOG, 'utf8');
  const lines = text
    .slice(logOffset)
    .split('\n')
    .filter((l) => /^(press|release|drag|wheel|key|typed) /.test(l));
  logOffset = text.length;
  return lines;
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
});
// iPhone-sized landscape screen with touch.
const context = await browser.newContext({
  viewport: { width: 844, height: 390 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
page.on('pageerror', (err) => console.error('page error:', err));

// Unauthenticated users are sent to the login page; the API refuses them.
await page.goto(URL_BASE);
assert.match(page.url(), /\/login$/);
const api = await page.request.get(`${URL_BASE}/api/profiles`);
assert.equal(api.status(), 401);

await page.fill('input[name=password]', 'wrong');
await page.click('button[type=submit]');
await page.waitForURL(/error=1/);

await page.fill('input[name=password]', PASSWORD);
await page.click('button[type=submit]');
await page.waitForURL(`${URL_BASE}/`);
await page.waitForFunction(() => document.querySelector('#screen canvas')?.width > 0, null, { timeout: 15000 });
await page.waitForSelector('#status', { state: 'hidden' });
// Wait for the remote desktop to resize to 1.5x the viewport (1266x585).
await page.waitForFunction(() => document.querySelector('#screen canvas').width === 1266, null, { timeout: 15000 });
await sleep(1500); // let the window manager resize the probe window
await probeLines();

const cdp = await context.newCDPSession(page);
const touch = (type, points) =>
  cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map(([x, y], id) => ({ x, y, id })),
  });

// Tap -> left-click at 1.5x the touch point.
await page.touchscreen.tap(400, 200);
let lines = await probeLines();
assert.deepEqual(lines, ['press 1 600 300', 'release 1 600 300'], 'tap');

// Long-press -> right-click.
await touch('touchStart', [[300, 150]]);
await sleep(700);
await touch('touchEnd', []);
lines = await probeLines();
assert.deepEqual(lines, ['press 3 450 225', 'release 3 450 225'], 'long-press');

// Quick drag -> middle-button drag.
await touch('touchStart', [[300, 200]]);
for (let x = 310; x <= 400; x += 10) await touch('touchMove', [[x, 200]]);
await touch('touchEnd', []);
lines = await probeLines();
assert.equal(lines[0], 'press 2 450 300', 'drag press');
assert.ok(
  lines.some((l) => l.startsWith('drag 0 ')),
  'drag moves',
);
assert.equal(lines.at(-1), 'release 2 600 300', 'drag release');

// Long-press then drag -> left-button drag (inventory items).
await touch('touchStart', [[200, 200]]);
await sleep(700);
for (let y = 210; y <= 260; y += 10) await touch('touchMove', [[200, y]]);
await touch('touchEnd', []);
lines = await probeLines();
assert.equal(lines[0], 'press 1 300 300', 'item drag press');
assert.equal(lines.at(-1), 'release 1 300 390', 'item drag release');

// Pinch out -> wheel up (zoom in) at the pinch centre.
await touch('touchStart', [
  [380, 200],
  [460, 200],
]);
for (let d = 50; d <= 140; d += 10)
  await touch('touchMove', [
    [420 - d, 200],
    [420 + d, 200],
  ]);
await touch('touchEnd', []);
lines = await probeLines();
assert.ok(lines.length >= 3 && lines.every((l) => l === 'wheel -1 630 300'), `pinch: ${lines}`);

// Menu mode button -> next tap is a right-click.
await page.touchscreen.tap(...(await center('#btn-menu')));
await page.touchscreen.tap(400, 100);
lines = await probeLines();
assert.deepEqual(lines, ['press 3 600 150', 'release 3 600 150'], 'menu mode tap');

// Shift toggle + tap -> shift-click (tap-to-drop).
await page.touchscreen.tap(...(await center('#btn-shift')));
await page.touchscreen.tap(400, 100);
await page.touchscreen.tap(...(await center('#btn-shift')));
lines = await probeLines();
assert.ok(lines.includes('press 1 600 150 shift'), `shift-click: ${lines}`);

// On-screen keyboard: typed text, Backspace and Enter.
await page.touchscreen.tap(...(await center('#btn-kbd')));
await page.keyboard.type('Hi!');
await page.keyboard.press('Backspace');
await page.keyboard.press('Enter');
lines = await probeLines();
const typed = lines.filter((l) => l.startsWith('typed ')).map((l) => l.slice(6));
assert.deepEqual(typed.slice(0, 3), ['H', 'i', '!'], `keyboard: ${lines}`);
assert.ok(lines.includes('key Backspace'), `backspace: ${lines}`);
assert.ok(lines.includes('key Enter'), `enter: ${lines}`);

// Profiles round-trip through the host.
const saved = await page.evaluate(async () => {
  const doc = { version: 1, profiles: { Default: { longPressMs: 500 }, Bossing: { dragSensitivity: 2 } } };
  const put = await fetch('api/profiles', { method: 'PUT', body: JSON.stringify(doc) });
  return put.ok && (await (await fetch('api/profiles')).json());
});
assert.deepEqual(Object.keys(saved.profiles).sort(), ['Bossing', 'Default']);

if (SCREENSHOT) {
  await page.keyboard.press('Escape');
  await page.screenshot({ path: SCREENSHOT });
}
await browser.close();
console.log('All touch end-to-end checks passed.');

async function center(selector) {
  const box = await page.locator(selector).boundingBox();
  return [box.x + box.width / 2, box.y + box.height / 2];
}
