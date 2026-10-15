const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const url = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
const solution = Array.from('534678912672195348198342567859761423426853791713924856961537284287419635345286179', Number);
const puzzle = Array.from('530070000600195000098000060800060003400803001700020006060000280000419005000080079', Number);
function state() {
  return { diff: 'easy', puzzle: puzzle.slice(), solution: solution.slice(), values: puzzle.slice(),
    notes: Array(81).fill(0), seconds: 0, mistakes: 0, hints: 0, complete: false };
}
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
async function open(t, saved = state(), preferences = {}) {
  const context = await browser.newContext({ colorScheme: 'light', reducedMotion: 'reduce' });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, [], 'no uncaught page errors'));
  await page.addInitScript(({ saved, preferences }) => {
    // Only seed the first load, so reload tests exercise real persistence.
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('yidoku:state', JSON.stringify(saved));
    for (const [key, value] of Object.entries(preferences)) {
      localStorage.setItem('yidoku:' + key, JSON.stringify(value));
    }
  }, { saved, preferences });
  await page.goto(url);
  await page.waitForSelector('.cell');
  return page;
}
const savedState = page => page.evaluate(() => JSON.parse(localStorage.getItem('yidoku:state')));
const selected = page => page.locator('.cell[aria-selected="true"]').getAttribute('data-i');
const dark = page => page.evaluate(() => document.documentElement.style.colorScheme);

for (const popup of ['Menu', 'Palette']) {
  test(`${popup}: shortcuts cannot edit the board behind an open popup`, async t => {
    const page = await open(t);
    await page.locator('.cell[data-i="2"]').click();
    await page.locator('#btn' + popup).click();
    await page.keyboard.press('h');
    assert.equal((await savedState(page)).hints, 0);
    await page.keyboard.press('4');
    assert.equal((await savedState(page)).values[2], 0);
    await page.keyboard.press('ArrowRight');
    assert.equal(await selected(page), '2');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#btn' + popup).getAttribute('aria-expanded'), 'false');
    assert.equal(await selected(page), '2', 'closing a popup preserves board selection');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'btn' + popup);
    await page.keyboard.press('4');
    assert.equal((await savedState(page)).values[2], 4);
  });
}

test('system theme follows OS changes until the user explicitly chooses', async t => {
  const page = await open(t);
  assert.equal(await dark(page), 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.style.colorScheme === 'dark', null, { timeout: 2000 });
  await page.locator('#btnTheme').click();
  assert.equal(await dark(page), 'light');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await dark(page), 'light');
  await page.reload();
  assert.equal(await dark(page), 'light', 'explicit choice persists');
  await page.locator('#btnMenu').click();
  await page.locator('[data-act="reset"]').click();
  await page.locator('#dlgActions .primary').click();
  await page.waitForFunction(() => document.querySelector('#board').getAttribute('aria-busy') === 'false');
  assert.equal(await dark(page), 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.style.colorScheme === 'light', null, { timeout: 2000 });
});

test('invalid preferences fall back to system theme and a selected palette', async t => {
  const page = await open(t, state(), { mode: 'invalid', palette: {} });
  assert.equal(await page.locator('.sw.sel').getAttribute('data-id'), 'purple');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.style.colorScheme === 'dark', null, { timeout: 2000 });
});

test('completed digit can still be tapped again to erase it', async t => {
  const s = state();
  s.values = solution.map((v, i) => v === 4 ? v : puzzle[i]);
  const page = await open(t, s);
  await page.locator('.cell[data-i="2"]').click();
  const four = page.locator('#pad button').nth(3);
  assert.equal(await four.isEnabled(), true);
  await four.click();
  assert.equal((await savedState(page)).values[2], 0);
});

test('completed digit notes remain removable through the on-screen keypad', async t => {
  const s = state();
  s.values = solution.map((v, i) => v === 4 ? v : puzzle[i]);
  s.notes[3] = (1 << 4) | (1 << 6);
  const page = await open(t, s);
  await page.locator('.cell[data-i="3"]').click();
  await page.locator('#btnNotes').click();
  const four = page.locator('#pad button').nth(3);
  assert.equal(await four.isEnabled(), true);
  await four.click();
  assert.equal((await savedState(page)).notes[3], 1 << 6);
  assert.equal(await four.isDisabled(), true);
});

test('notes, peer cleanup, undo, hints and reload preserve game invariants', async t => {
  const page = await open(t);
  await page.locator('.cell[data-i="3"]').click();
  await page.keyboard.press('n');
  await page.keyboard.press('4');
  await page.keyboard.press('n');
  await page.locator('.cell[data-i="2"]').click();
  await page.keyboard.press('4');
  assert.equal((await savedState(page)).notes[3], 0);
  await page.keyboard.press('z');
  let s = await savedState(page);
  assert.equal(s.values[2], 0);
  assert.equal(s.notes[3], 1 << 4);
  await page.keyboard.press('1');
  await page.keyboard.press('h');
  s = await savedState(page);
  assert.equal(s.values[2], 4);
  assert.equal(s.mistakes, 1);
  assert.equal(s.hints, 1);
  await page.reload();
  assert.equal(await page.locator('.cell[data-i="2"]').textContent(), '4');
  assert.equal(await page.locator('#mistakes').textContent(), '1');
  assert.equal(await page.locator('#hintTag').textContent(), '1');
});

test('a win is counted only once across reloads', async t => {
  const s = state();
  s.values = solution.slice(); s.values[2] = 0;
  const page = await open(t, s);
  await page.locator('.cell[data-i="2"]').click();
  await page.keyboard.press('4');
  assert.equal((await savedState(page)).complete, true);
  const wins = () => page.evaluate(() => JSON.parse(localStorage.getItem('yidoku:stats')).easy.won);
  assert.equal(await wins(), 1);
  await page.reload();
  assert.equal(await wins(), 1);
  assert.equal(await page.locator('#btnHint').isDisabled(), true);
});

test('corrupt saved games recover to a playable puzzle', async t => {
  const s = state(); s.solution[0] = 0;
  const page = await open(t, s);
  const restored = await savedState(page);
  assert.equal(restored.solution.includes(0), false);
  assert.equal(await page.locator('.cell').count(), 81);
  assert.equal(await page.locator('#btnHint').isEnabled(), true);
});

test('storage denial does not prevent playing offline', async t => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [], requests = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (/^https?:/.test(r.url())) requests.push(r.url()); });
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Denied', 'SecurityError'); } });
  });
  await page.goto(url);
  await page.locator('#btnHint').click();
  assert.equal(await page.locator('#hintTag').textContent(), '1');
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
});

test('timer excludes hidden time and keeps fractional foreground seconds', async t => {
  const page = await open(t);
  await page.clock.install();
  // Reset after installing the fake monotonic clock.
  await page.locator('#btnNew').click();
  await page.clock.runFor(30);
  await page.clock.runFor(600);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const seconds = (await savedState(page)).seconds;
  await page.clock.runFor(60000);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal((await savedState(page)).seconds, seconds);
  await page.clock.runFor(500);
  await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')));
  assert.equal((await savedState(page)).seconds, seconds + 1);
});

test('narrow viewport scaling is stable and does not overflow', async t => {
  const page = await open(t);
  for (const width of [320, 375, 400, 900, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(() => dispatchEvent(new Event('resize')));
    const metrics = await page.evaluate(() => ({ zoom: document.documentElement.style.zoom,
      right: document.querySelector('#board').getBoundingClientRect().right }));
    assert.equal(metrics.zoom, width < 400 ? String(width / 400) : '');
    assert.ok(metrics.right <= width + 1);
  }
});

test('Tab can leave popups and Escape restores focus from a popup item', async t => {
  const page = await open(t);
  await page.locator('.cell[data-i="2"]').click();
  await page.locator('#btnMenu').click();
  await page.locator('#popMenu .item').first().waitFor({ state: 'visible' });
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.act), 'new');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'btnMenu');
  assert.equal(await selected(page), '2');
  await page.locator('#btnMenu').click();
  for (let i = 0; i < 5; i++) await page.keyboard.press('Tab');
  assert.equal(await page.locator('#btnMenu').getAttribute('aria-expanded'), 'false');
  // Navigation/typing work again without an extra click or Escape.
  await page.locator('.cell[data-i="2"]').focus();
  await page.keyboard.press('4');
  assert.equal((await savedState(page)).values[2], 4);
});

test('menu mutations are disabled while a new puzzle is pending', async t => {
  const page = await open(t);
  await page.clock.install();
  await page.evaluate(() => document.querySelectorAll('#chips button')[2].click());
  assert.equal(await page.locator('#board').getAttribute('aria-busy'), 'true');
  assert.equal(await page.locator('[data-act="reset"]').isDisabled(), true);
  assert.equal(await page.locator('[data-act="new"]').isDisabled(), true);
  await page.clock.runFor(30);
  assert.equal((await savedState(page)).diff, 'hard');
  assert.equal(await page.locator('[data-act="reset"]').isEnabled(), true);
  await page.locator('#btnMenu').click();
  await page.locator('[data-act="reset"]').click();
  await page.locator('#dlgActions .primary').click();
  await page.clock.runFor(30);
  assert.equal((await savedState(page)).diff, 'easy');
});
