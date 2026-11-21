import './fixtures/offline-network.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { scanPage } from '../src/shared/scanner.mjs';
import { tabSnapshot } from '../src/shared/browser.mjs';

// REFERENCE-CONTRACT FIXTURE, not observed live website traffic.
// Root verified F2 crawler.py:126-133 and model.py:111-114:
// https://raw.githubusercontent.com/Johnserf-Seed/f2/main/f2/apps/douyin/crawler.py
// https://raw.githubusercontent.com/Johnserf-Seed/f2/main/f2/apps/douyin/model.py
// F2 establishes POST with cursor/count, without a sec_user_id parameter.
// Form serialization here is a synthetic test choice, still pending live confirmation.
// All browser requests are locally fulfilled/aborted; no platform is contacted.
const endpoint = 'https://www.douyin.com/aweme/v1/web/aweme/listcollection/';
const source = {
  platform: 'douyin', kind: 'saved',
  url: 'https://www.douyin.com/user/fixture-owner', accountId: 'fixture-owner',
};
const payload = {
  status_code: 0, cursor: 18, has_more: 0,
  aweme_list: [{ aweme_id: '7312345678901234567', desc: 'Synthetic own collection work' }],
};
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
let browser;
before(async () => {
  browser = await chromium.launch({
    headless: true,
    executablePath: fileURLToPath(new URL('../../runtime/browsers/chromium-1248/chrome-win64/chrome.exe', import.meta.url)),
    args: ['--disable-background-networking', '--disable-component-update', '--no-first-run',
      '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND'],
  });
});
after(async () => { await browser?.close(); });

function html(selected) {
  const labels = { profile: '作品', saved: '收藏', liked: '喜欢' };
  return `<body><div id="primary" role="tablist">${Object.entries(labels).map(([kind, label]) =>
    `<button id="${kind}" role="tab" aria-selected="${kind === selected}">${label}</button>`).join('')}</div>
    <div role="tablist"><button role="tab" aria-selected="false">收藏夹</button><button role="tab" aria-selected="true">视频</button></div>
    <div role="tabpanel"></div><div role="tabpanel"></div></body>`;
}
async function fixture(t, kind = 'saved', request = {}, payloadFor) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const release = deferred(), requested = deferred();
  const calls = [], routeErrors = [];
  t.after(async () => { release.resolve(); await context.close(); });
  await context.route('**/*', async route => {
    const req = route.request();
    if (req.url() === (request.url ?? endpoint)) {
      calls.push({ method: req.method(), body: req.postData(), contentType: req.headers()['content-type'] });
      requested.resolve();
      await release.promise;
      // A cross-document navigation can cancel the old request before fulfillment.
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(payloadFor ? payloadFor(req) : payload) })
        .catch(error => routeErrors.push(error.name));
    } else if (req.isNavigationRequest() && new URL(req.url()).origin === 'https://www.douyin.com') {
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: html(kind) });
    } else await route.abort();
  });
  const page = await context.newPage();
  await page.goto(source.url);
  return { page, release, requested, calls, routeErrors, request };
}
async function beginRequest(f) {
  await f.page.evaluate(({ url, body, contentType }) => {
    window.collectionDone = fetch(url, {
      method: 'POST', headers: { 'Content-Type': contentType }, body,
    }).then(r => r.json()).then(() => true, () => false);
  }, { url: endpoint, body: 'cursor=0&count=18', contentType: 'application/x-www-form-urlencoded', ...f.request });
  await f.requested.promise;
  // A browser round trip lets the request-time source snapshot settle before a switch.
  await tabSnapshot(f.page, 'douyin', 'saved');
}
async function scan(f, overrides = {}, change, options = {}) {
  const items = [], progress = [];
  const result = await scanPage(f.page, {
    source: { ...source, ...overrides }, navigate: false, maxRounds: 4, waitMs: 25,
    emit: async (type, p) => { if (type === 'item') items.push(p.item); if (type === 'progress') progress.push(p); },
    prepare: async () => {
      await beginRequest(f);
      if (change) await change(f.page);
      f.release.resolve();
      await f.page.evaluate(() => window.collectionDone ?? false);
    },
    ...options,
  });
  // Fixture health: absence of emitted items must not be caused by a missing POST.
  assert.deepEqual(f.calls, [{ method: 'POST', body: f.request.body ?? 'cursor=0&count=18', contentType: f.request.contentType ?? 'application/x-www-form-urlencoded' }]);
  return { result, items, progress };
}

test('reference-contract: bound own saved POST emits one API-only work, never full history', async t => {
  const f = await fixture(t);
  assert.equal((await tabSnapshot(f.page, 'douyin', 'saved')).selected, true);
  assert.equal(await f.page.locator('[role="tabpanel"]').count(), 2);
  assert.equal(await f.page.locator('[role="tabpanel"] a').count(), 0);
  const { items, result } = await scan(f);
  assert.deepEqual(f.routeErrors, []);
  assert.equal(items.length, 1, 'reference-contract own-collection POST must discover the API-only work');
  assert.equal(items[0].contentId, '7312345678901234567');
  assert.equal(result.completeness, 'partial');
  assert.equal(result.reasonCode, 'history_unproven');
  const limited = await scan(await fixture(t), { maxItems: 1 });
  assert.equal(limited.items.length, 1);
  assert.equal(limited.result.completeness, 'partial');
  assert.equal(limited.result.reasonCode, 'item_limit');
});

for (const accountId of [undefined, 'different-account']) {
  test(`reference-contract: own saved POST rejects ${accountId ? 'mismatched' : 'unknown'} account binding`, async t => {
    const { items, result } = await scan(await fixture(t), { accountId });
    assert.equal(items.length, 0);
    assert.notEqual(result.completeness, 'complete');
  });
}
for (const kind of ['profile', 'liked']) {
  test(`reference-contract: selected ${kind} does not consume own saved POST`, async t => {
    const f = await fixture(t, kind);
    assert.equal((await tabSnapshot(f.page, 'douyin', kind)).selected, true);
    const { items, result } = await scan(f, { kind });
    assert.equal(items.length, 0);
    assert.notEqual(result.completeness, 'complete');
  });
}

test('reference-contract: old POST is retired across document replacement', async t => {
  const f = await fixture(t);
  const prior = await tabSnapshot(f.page, 'douyin', 'saved');
  const { items, result } = await scan(f, {}, page => page.reload({ waitUntil: 'domcontentloaded' }));
  assert.notEqual((await tabSnapshot(f.page, 'douyin', 'saved')).documentId, prior.documentId);
  assert.equal(items.length, 0);
  assert.notEqual(result.completeness, 'complete');
});

test('reference-contract: delayed POST cannot survive primary source switch-away and back', async t => {
  const f = await fixture(t);
  const prior = await tabSnapshot(f.page, 'douyin', 'saved');
  const { items, result } = await scan(f, {}, async page => {
    for (const selected of ['liked', 'saved']) {
      await page.evaluate(selected => {
        for (const tab of document.querySelectorAll('#primary [role="tab"]')) {
          tab.setAttribute('aria-selected', String(tab.id === selected));
        }
      }, selected);
    }
  });
  const current = await tabSnapshot(f.page, 'douyin', 'saved');
  assert.equal(current.selected, true);
  assert.ok(current.tabGeneration > prior.tabGeneration);
  assert.deepEqual(f.routeErrors, []);
  assert.equal(items.length, 0);
  assert.notEqual(result.completeness, 'complete');
});

test('reference-contract: JSON body and consistent query fields discover the same own work', async t => {
  const f = await fixture(t, 'saved', {
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({ cursor: 0, count: 18, sec_user_id: 'fixture-owner' }),
    url: endpoint + '?cursor=0&count=18&sec_user_id=fixture-owner',
  });
  const { items, result } = await scan(f);
  assert.equal(items.length, 1);
  assert.equal(result.completeness, 'partial');
  assert.equal(result.reasonCode, 'history_unproven');
});

test('reference-contract: own POST follows response cursor rather than profile max_cursor, still partial', async t => {
  const f = await fixture(t, 'saved', {}, req => {
    const first = new URLSearchParams(req.postData()).get('cursor') === '0';
    return { status_code: 0, cursor: first ? 18 : 36, max_cursor: 999, has_more: first ? 1 : 0,
      aweme_list: [{ aweme_id: first ? '7312345678901234567' : '7312345678901234568' }] };
  });
  f.release.resolve();
  const items = [], progress = [];
  const result = await scanPage(f.page, {
    source, navigate: false, maxRounds: 4, waitMs: 25,
    emit: async (type, p) => { if (type === 'item') items.push(p.item.contentId); if (type === 'progress') progress.push(p); },
    prepare: async () => {
      await beginRequest(f);
      await f.page.evaluate(async endpoint => {
        await window.collectionDone;
        await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'cursor=18&count=18' }).then(r => r.json());
      }, endpoint);
    },
  });
  assert.deepEqual(items, ['7312345678901234567', '7312345678901234568']);
  assert.ok(progress.length < 4, 'matching response cursor should recognize the observed chain end');
  assert.equal(result.completeness, 'partial');
  assert.equal(result.reasonCode, 'history_unproven');
});

test('reference-contract: missing, duplicate, conflicting and invalid cursors never terminate a chain', async t => {
  for (const request of [
    { body: 'count=18' },
    { body: 'cursor=0&cursor=0&count=18' },
    { url: endpoint + '?cursor=18' },
    { body: 'cursor=-1&count=18' },
    { contentType: 'application/json', body: '{"cursor":0,"cursor":0,"count":18}' },
  ]) {
    const { items, result, progress } = await scan(await fixture(t, 'saved', request));
    assert.equal(items.length, 1, 'uncertain pagination must not discard otherwise bound discoveries');
    assert.equal(progress.length, 4, 'ambiguous cursor cannot accept has_more=0 as a terminal chain');
    assert.equal(result.reasonCode, 'history_unproven');
  }
});

test('reference-contract: conflicting or repeated optional subject rejects the POST', async t => {
  for (const request of [
    { body: 'cursor=0&count=18&sec_user_id=someone-else' },
    { url: endpoint + '?sec_user_id=fixture-owner&sec_user_id=fixture-owner' },
  ]) assert.equal((await scan(await fixture(t, 'saved', request))).items.length, 0);
});

test('reference-contract: unsupported content type and oversized body cannot contribute items', async t => {
  for (const request of [
    { contentType: 'text/plain' },
    { body: 'cursor=0&count=18&padding=' + 'x'.repeat(65536) },
  ]) assert.equal((await scan(await fixture(t, 'saved', request))).items.length, 0);
});

test('reference-contract: owner-bound POST waits for initial selected-tab hydration and remains partial', async t => {
  const f = await fixture(t);
  await f.page.evaluate(() => { document.body.innerHTML = ''; });
  const { items, result } = await scan(f, {}, page => page.evaluate(markup => { document.body.innerHTML = markup; }, html('saved')));
  assert.equal(items.length, 1);
  assert.equal(items[0].contentId, '7312345678901234567');
  assert.equal(result.completeness, 'partial');
  assert.equal(result.reasonCode, 'history_unproven');
});

test('reference-contract: fresh identity gate can reject own POST before publication', async t => {
  let gates = 0;
  const { items, result } = await scan(await fixture(t), {}, undefined, {
    beforePublish: async () => { gates++; throw Object.assign(new Error('fixture account changed'), { code: 'auth_required' }); },
  });
  assert.equal(gates, 1);
  assert.equal(items.length, 0);
  assert.equal(result.reasonCode, 'auth_required');
});

test('reference-contract: source switch inside fresh identity gate retires own POST', async t => {
  const f = await fixture(t);
  let gates = 0;
  const { items } = await scan(f, {}, undefined, {
    beforePublish: async () => {
      gates++;
      await f.page.evaluate(() => history.replaceState({}, '', '/user/another-owner'));
    },
  });
  assert.equal(gates, 1);
  assert.equal(items.length, 0);
});
