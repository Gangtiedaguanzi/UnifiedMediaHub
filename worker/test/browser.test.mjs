import './fixtures/offline-network.mjs';
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
const b = await import("../src/shared/browser.mjs").catch(() => ({}));
const a = await import("../src/adapters/douyin.mjs").catch(() => ({}));
const executable = fileURLToPath(
  new URL(
    "../../runtime/browsers/chromium-1248/chrome-win64/chrome.exe",
    import.meta.url,
  ),
);
test("owned shortlink navigation preserves exact work and signed XHS source; rejects external or profile destinations", async (t) => {
  const { browserAdapter } = await import("../src/shared/browser-adapter.mjs");
  for (const [platform, start, final, ok, cid] of [
    [
      "douyin",
      "https://v.douyin.com/fixture/",
      "https://www.douyin.com/video/123",
      true,
      "123",
    ],
    [
      "xiaohongshu",
      "https://xhslink.com/fixture",
      "https://www.xiaohongshu.com/explore/abc123?xsec_token=signedFixture",
      true,
      "abc123",
    ],
    [
      "douyin",
      "https://v.douyin.com/external/",
      "https://evil.example/video/123",
      false,
      "123",
    ],
    [
      "douyin",
      "https://v.douyin.com/profile/",
      "https://www.douyin.com/user/author",
      false,
      "123",
    ],
    [
      "douyin",
      "https://v.douyin.com/loop/",
      "https://v.douyin.com/loop/",
      false,
      "123",
    ],
    [
      "xiaohongshu",
      "https://xhslink.com/invalid-path",
      "https://www.xiaohongshu.com/explore/abc123/extra",
      false,
      "abc123",
    ],
  ]) {
    const html = `<body><script>window._ROUTER_DATA={aweme_id:'123',images:[{url_list:['https://cdn.example/a.jpg']}]};window.__INITIAL_STATE__={note:{noteDetailMap:{abc123:{note:{noteId:'abc123',imageList:[{urlDefault:'https://cdn.example/a.jpg'}]}}}}};</script>`;
    const context = await fixture(t, html);
    await context.unroute("**/*");
    const page = context.pages()[0] ?? (await context.newPage());
    const wire = await context.newCDPSession(page);
    wire.on("Fetch.requestPaused", async (event) => {
      const redirect = event.request.url === start;
      await wire
        .send("Fetch.fulfillRequest", {
          requestId: event.requestId,
          responseCode: redirect ? 302 : 200,
          responseHeaders: redirect
            ? [{ name: "Location", value: final }]
            : [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
          body: Buffer.from(redirect ? "" : html).toString("base64"),
        })
        .catch(() => {});
    });
    await wire.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });
    const events = [];
    const result = await browserAdapter(platform, {
      open: async () => context,
    }).scan({
      request: { source: { platform, kind: "single", url: start } },
      signal: new AbortController().signal,
      emit: async (type, payload) => events.push({ type, ...payload }),
    });
    assert.equal(
      result.status,
      ok ? "completed" : "needs_action",
      platform + " " + result.message,
    );
    const items = events.filter((e) => e.type === "item");
    assert.equal(items.length, ok ? 1 : 0);
    if (ok) {
      assert.equal(items[0].item.contentId, cid);
      assert.equal(items[0].item.sourceUrl, final);
    }
  }
});
test("Douyin fresh identity uses ordinary root traffic when user/self emits no self request", async t => {
  const selfPath='/aweme/v1/web/user/profile/self/';
  const context=await fixture(t,
    `<body><script>window._ROUTER_DATA={user:{sec_uid:'visited-author'}};if(location.pathname==='/')fetch('${selfPath}');</script>`,
    {[selfPath]:[0,{status_code:0,user:{sec_uid:'fresh-viewer',nickname:'Synthetic viewer'}}]},
  );
  const identityPage=await context.newPage();let selfRequests=0;
  identityPage.on('request',request=>{if(new URL(request.url()).pathname===selfPath)selfRequests++;});
  // The former entry loads successfully but cannot supply identity evidence.
  await identityPage.goto('https://www.douyin.com/user/self');
  assert.equal(selfRequests,0);
  const account=await b.currentIdentity(identityPage,'douyin',{timeoutMs:250});
  assert.deepEqual(account,{accountId:'fresh-viewer',displayName:'Synthetic viewer'});
  assert.equal(identityPage.url(),'https://www.douyin.com/');
  assert.equal(selfRequests,1);
});

for(const mode of ['no endpoint','author endpoint','invalid self schema'])test(`Douyin root identity rejects ${mode} despite stored viewer-looking state`,async t=>{
  const selfPath='/aweme/v1/web/user/profile/self/',otherPath='/aweme/v1/web/user/profile/other/';
  const requestPath=mode==='no endpoint'?null:mode==='author endpoint'?otherPath:selfPath;
  const context=await fixture(t,
    `<body><script>window._ROUTER_DATA={user:{sec_uid:'stored-viewer'}};if(location.pathname==='/'&&${JSON.stringify(requestPath)})fetch(${JSON.stringify(requestPath)});</script>`,
    {[selfPath]:[0,{status_code:0,user:{sec_uid:12345}}],[otherPath]:[0,{status_code:0,user:{sec_uid:'untrusted-author'}}]},
  );
  const page=await context.newPage();
  assert.equal(await b.currentIdentity(page,'douyin',{timeoutMs:150}),null);
});

test("private list binding rejects changed account and emits verified matching account before items", async (t) => {
  const { browserAdapter } = await import("../src/shared/browser-adapter.mjs");
  for (const bound of ["accountA", "accountB", undefined]) {
    const context = await fixture(
      t,
      `<body><button role="tab" aria-selected="true">收藏</button><div role="tabpanel"><a href="/video/123">card</a><p>暂时没有更多了</p></div><script>window._ROUTER_DATA={loaderData:{'user-layout':{user:{sec_uid:'accountB',nickname:'Fixture'}}}};if(location.pathname==='/')fetch('/aweme/v1/web/user/profile/self/');</script>`,
      {'/aweme/v1/web/user/profile/self/':[0,{status_code:0,user:{sec_uid:'accountB'}}]},
    );
    const events = [];
    const result = await browserAdapter("douyin", {
      open: async () => context,
    }).scan({
      request: {
        source: {
          platform: "douyin",
          kind: "saved",
          url: "https://www.douyin.com/user/accountB",
          accountId: bound,
        },
      },
      signal: new AbortController().signal,
      emit: async (type, payload) => events.push({ type, ...payload }),
    });
    if (bound === "accountA") {
      assert.equal(result.status, "needs_action");
      assert.equal(
        events.some((e) => e.type === "item"),
        false,
      );
      assert.equal(
        events.some((e) => e.type === "account" && e.accountId === "accountB"),
        false,
      );
    } else {
      const account = events.find((e) => e.type === "account");
      assert.equal(account?.accountId, "accountB");
      assert.equal(account.authenticated, true);
      assert.ok(
        events.indexOf(account) < events.findIndex((e) => e.type === "item"),
      );
    }
  }
});

test('fresh identity tolerates delayed DOMContentLoaded followed by a delayed self request without retry', {timeout:45000}, async t=>{
  const selfPath='/aweme/v1/web/user/profile/self/';
  const context=await fixture(t,`<body><script src="/fixture-delayed-script.js"></script>`,
    {[selfPath]:[0,{status_code:0,user:{sec_uid:'delayed-viewer'}}]});
  await context.route('**/fixture-delayed-script.js',async route=>{
    await new Promise(resolve=>setTimeout(resolve,16000));
    await route.fulfill({contentType:'application/javascript',body:`setTimeout(()=>fetch('${selfPath}'),6500);`}).catch(()=>{});
  });
  const page=await context.newPage();let navigations=0;
  page.on('request',request=>{if(request.isNavigationRequest()&&request.frame()===page.mainFrame())navigations++;});
  assert.equal((await b.currentIdentity(page,'douyin'))?.accountId,'delayed-viewer');
  assert.equal(navigations,1);
});

for(const mode of ['null','timeout','abort','unrelated error'])test(`identity uncertainty classification: ${mode}`,async t=>{
  const {browserAdapter}=await import('../src/shared/browser-adapter.mjs');
  const {errors}=await import('playwright');
  const context=await fixture(t,`<body><script>if(location.pathname==='/')fetch('/aweme/v1/web/user/profile/self/');</script>`,
    {'/aweme/v1/web/user/profile/self/':[0,{status_code:8}]});
  const controller=new AbortController(),cancelReason=new Error('fixture cancellation'),unrelated=new TypeError('fixture coding failure');
  const newPage=context.newPage.bind(context);let identityPage;
  context.newPage=async(...args)=>{
    identityPage=await newPage(...args);
    if(mode!=='null')identityPage.goto=async()=>{
      await new Promise(resolve=>setTimeout(resolve,10));
      if(mode==='abort')controller.abort(cancelReason);
      if(mode==='unrelated error')throw unrelated;
      throw new errors.TimeoutError('fixture navigation did not reach DOMContentLoaded');
    };
    return identityPage;
  };
  const events=[];
  const running=browserAdapter('douyin',{open:async()=>context}).scan({
    request:{source:{platform:'douyin',kind:'profile',url:'https://www.douyin.com/user/bound-viewer',accountId:'bound-viewer'}},
    signal:controller.signal,emit:async(type,p)=>events.push({type,...p}),
  });
  if(mode==='abort')await assert.rejects(running,error=>error===cancelReason);
  else if(mode==='unrelated error')await assert.rejects(running,error=>error===unrelated);
  else {
    const result=await running;
    assert.equal(result.status,'needs_action');assert.equal(result.reasonCode,'identity_unverified');
    assert.equal(events.find(e=>e.type==='needs_action')?.code,'identity_unverified');
  }
  assert.equal(events.some(e=>e.type==='account'||e.type==='item'),false);
  assert.equal(identityPage.isClosed(),true);
});
test("private cached media requires account recheck before any transfer", async (t) => {
  const http = await import("node:http");
  const { browserAdapter } = await import("../src/shared/browser-adapter.mjs");
  const { readFile } = await import("node:fs/promises");
  const png = await readFile(
    new URL("./fixtures/synthetic-blue.png", import.meta.url),
  );
  let hits = 0;
  const server = http.createServer((_q, r) => {
    hits++;
    r.writeHead(200, { "content-type": "image/png" });
    r.end(png);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  for (const account of ["accountB", null, "unbound", "accountA"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "umh-bound-download-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const context = await fixture(
      t,
      `<body><script>window._ROUTER_DATA=${JSON.stringify(account ? { loaderData: { "user-layout": { user: { sec_uid: account } } } } : {})};if(location.pathname==="/")fetch("/aweme/v1/web/user/profile/self/");</script>`,
      {"/aweme/v1/web/user/profile/self/":[0,account?{status_code:0,user:{sec_uid:account}}:{status_code:8}]},
    );
    const events = [];
    const result = await browserAdapter("douyin", {
      open: async () => context,
    }).download({
      request: {
        source: {
          platform: "douyin",
          kind: "saved",
          url: "https://www.douyin.com/user/accountA",
          accountId: account === "unbound" ? undefined : "accountA",
        },
        items: [
          {
            platform: "douyin",
            contentId: "123",
            sourceUrl: "https://www.douyin.com/video/123",
            mediaResolved: true,
            media: [
              {
                index: 1,
                kind: "image",
                extension: "png",
                url: `http://127.0.0.1:${server.address().port}/image`,
              },
            ],
          },
        ],
        paths: { downloadRoot: root },
      },
      signal: new AbortController().signal,
      emit: async (type, payload) => events.push({ type, ...payload }),
    });
    if (account === "accountA") {
      assert.equal(result.status, "completed");
      assert.equal(events[0]?.type, "account");
      assert.equal(events[0].accountId, "accountA");
      assert.equal(events.filter((e) => e.type === "receipt").length, 1);
      assert.equal(hits, 1);
    } else {
      assert.equal(result.status, "needs_action");
      assert.equal(
        events.some((e) => e.type === "item" || e.type === "receipt"),
        false,
      );
      assert.equal(hits, 0);
    }
  }
});
test("expired selected media refreshes detail once, retains signed source and excludes completed indices", async (t) => {
  const http = await import("node:http");
  const { browserAdapter } = await import("../src/shared/browser-adapter.mjs");
  const { readFile } = await import("node:fs/promises");
  const png = await readFile(
    new URL("./fixtures/synthetic-blue.png", import.meta.url),
  );
  const hits = [];
  const server = http.createServer((q, r) => {
    hits.push(q.url);
    r.writeHead(q.url === "/expired" ? 403 : 200, {
      "content-type": "image/png",
    });
    r.end(q.url === "/expired" ? "expired" : png);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const root = await mkdtemp(path.join(os.tmpdir(), "umh-refresh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const context = await fixture(
    t,
    `<body><script>window.__INITIAL_STATE__={note:{noteDetailMap:{abc123:{note:{noteId:'abc123',imageList:[{urlDefault:'${base}/excluded'},{urlDefault:'${base}/fresh'}]}}}}};</script>`,
  );
  const events = [];
  const sourceUrl =
    "https://www.xiaohongshu.com/explore/abc123?xsec_token=keptFixture";
  const result = await browserAdapter("xiaohongshu", {
    open: async () => context,
  }).download({
    request: {
      source: { platform: "xiaohongshu", kind: "single", url: sourceUrl },
      items: [
        {
          platform: "xiaohongshu",
          contentId: "abc123",
          sourceUrl,
          mediaResolved: true,
          media: [
            {
              index: 2,
              kind: "image",
              extension: "png",
              url: base + "/expired",
            },
          ],
        },
      ],
      paths: { downloadRoot: root },
    },
    signal: new AbortController().signal,
    emit: async (type, payload) => events.push({ type, ...payload }),
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(hits, ["/expired", "/fresh"]);
  const item = events.find((e) => e.type === "item")?.item;
  assert.equal(item?.sourceUrl, sourceUrl);
  assert.deepEqual(
    item.media.map((m) => m.index),
    [2],
  );
  assert.equal(events.filter((e) => e.type === "receipt").length, 1);
});
test("refresh keeps challenge/token boundaries; HTTP500 retries once without detail refresh", async (t) => {
  const http = await import("node:http");
  const { browserAdapter } = await import("../src/shared/browser-adapter.mjs");
  for (const mode of ["repeat403", "challenge", "missingToken", "server500"]) {
    const hits = [];
    const server = http.createServer((q, r) => {
      hits.push(q.url);
      r.writeHead(mode === "server500" ? 500 : 403);
      r.end("blocked");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    });
    const root = await mkdtemp(path.join(os.tmpdir(), "umh-refresh-boundary-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const base = `http://127.0.0.1:${server.address().port}`;
    const context = await fixture(
      t,
      mode === "challenge"
        ? "<body>请完成安全验证</body>"
        : `<body><script>window.__INITIAL_STATE__={note:{noteDetailMap:{abc123:{note:{noteId:'abc123',imageList:[{urlDefault:'${base}/refreshed'}]}}}}};</script>`,
    );
    let opens = 0;
    const events = [];
    const sourceUrl =
      "https://www.xiaohongshu.com/explore/abc123" +
      (mode === "missingToken" ? "" : "?xsec_token=fixture");
    const result = await browserAdapter("xiaohongshu", {
      open: async () => {
        opens++;
        return context;
      },
    }).download({
      request: {
        source: { platform: "xiaohongshu", kind: "single", url: sourceUrl },
        items: [
          {
            platform: "xiaohongshu",
            contentId: "abc123",
            sourceUrl,
            mediaResolved: true,
            media: [
              {
                index: 1,
                kind: "image",
                extension: "png",
                url: base + "/original",
              },
            ],
          },
        ],
        paths: { downloadRoot: root },
      },
      signal: new AbortController().signal,
      emit: async (type, payload) => events.push({ type, ...payload }),
    });
    assert.equal(
      result.status,
      mode === "server500" ? "failed" : "needs_action",
      mode,
    );
    assert.deepEqual(
      hits,
      mode === "repeat403" ? ["/original", "/refreshed"] : mode === "server500" ? ["/original", "/original"] : ["/original"],
    );
    // Each actual media operation reads its dedicated browser UA once, even
    // when a later media response cannot be refreshed.
    assert.equal(opens, 1);
    if (mode === "challenge")
      assert.equal(
        events.find((e) => e.type === "needs_action")?.code,
        "challenge",
      );
    assert.equal(
      events.some(
        (e) => e.type === "receipt" && e.receipt.status === "completed",
      ),
      false,
    );
  }
});
test("joining an already-open collection at a later cursor cannot prove whole-source completion", async (t) => {
  const context = await fixture(
    t,
    `<body><button role="tab" aria-selected="true">作品</button>`,
    {
      "/aweme/v1/web/aweme/post/": [
        0,
        { status_code: 0, aweme_list: [{ aweme_id: "123" }], has_more: 0 },
      ],
    },
  );
  const page = await context.newPage();
  await page.goto("https://www.douyin.com/user/author");
  const result = await a.scanPage(page, {
    source: { platform: "douyin", kind: "profile", url: page.url() },
    signal: new AbortController().signal,
    emit: async () => {},
    navigate: false,
    prepare: () =>
      page.evaluate(() =>
        fetch("/aweme/v1/web/aweme/post/?sec_user_id=author&max_cursor=999"),
      ),
    maxRounds: 3,
    waitMs: 100,
  });
  assert.equal(result.completeness, "partial");
});
test("adapter resolves selected detail before transfer and retains resume index mask", async (t) => {
  const { readFile } = await import("node:fs/promises");
  const http = await import("node:http");
  const { browserAdapter } = await import("../src/shared/browser-adapter.mjs");
  const png = await readFile(
    new URL("./fixtures/synthetic-blue.png", import.meta.url),
  );
  let requested = [];
  const server = http.createServer((req, res) => {
    requested.push(req.url);
    res.writeHead(200, { "content-type": "image/png" });
    res.end(png);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const root = await mkdtemp(path.join(os.tmpdir(), "umh-selected-detail-"));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const context = await fixture(
    t,
    `<body><script>window._ROUTER_DATA={aweme_id:'123',images:[{url_list:['${base}/1.png']},{url_list:['${base}/2.png']}]}</script>`,
  );
  const adapter = browserAdapter("douyin", { open: async () => context });
  const events = [];
  const result = await adapter.download({
    request: {
      items: [
        {
          platform: "douyin",
          contentId: "123",
          sourceUrl: "https://www.douyin.com/video/123",
          mediaResolved: true,
          media: [{ index: 2, kind: "image", url: null }],
        },
        {
          platform: "douyin",
          contentId: "999",
          selected: false,
          mediaResolved: false,
          media: [],
        },
      ],
      paths: {
        dataRoot: root,
        downloadRoot: path.join(root, "downloads"),
        browserExecutable: executable,
      },
    },
    signal: new AbortController().signal,
    emit: async (type, payload) => events.push({ type, ...payload }),
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(requested, ["/2.png"]);
  assert.deepEqual(
    events.find((e) => e.type === "item").item.media.map((m) => m.index),
    [2],
  );
  assert.equal(events.filter((e) => e.type === "receipt").length, 1);
  assert.ok(
    events.findIndex((e) => e.type === "item") <
      events.findIndex((e) => e.type === "receipt"),
  );
});
test("browser rejects executables outside its package before touching profile root", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "umh-path-browser-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    b.openBrowser(
      { dataRoot: root, browserExecutable: process.execPath },
      "douyin",
      { headless: true },
    ),
    /invalid_browser_path/,
  );
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(await readdir(root), []);
});
test("requested limit and malformed list entry cannot turn full-source status complete", async (t) => {
  for (const [maxItems, entries] of [
    [1, [{ aweme_id: "123" }, { aweme_id: "456" }]],
    [0, [{ unexpected_id: "unparseable" }]],
  ]) {
    const context = await fixture(
      t,
      `<body><button role="tab" aria-selected="true">作品</button><script>fetch('/aweme/v1/web/aweme/post/?sec_user_id=author')</script>`,
      {
        "/aweme/v1/web/aweme/post/": [50, { status_code: 0, aweme_list: entries, has_more: 0 }],
      },
    );
    const result = await a.scanPage(await context.newPage(), {
      source: {
        platform: "douyin",
        kind: "profile",
        url: "https://www.douyin.com/user/author",
        maxItems,
      },
      signal: new AbortController().signal,
      emit: async () => {},
      maxRounds: 3,
      waitMs: 100,
    });
    assert.equal(result.completeness, "partial");
  }
});
test("cancellation closes owned browser and releases profile without persistent lock", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "umh-cancel-browser-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const c = new AbortController();
  const context = await b.openBrowser(
    { dataRoot: root, browserExecutable: executable },
    "douyin",
    { headless: true, signal: c.signal },
  );
  t.after(() => context.close());
  await assert.rejects(
    b.openBrowser({ dataRoot: root, browserExecutable: executable }, "douyin", {
      headless: true,
    }),
  );
  const closed = new Promise((r) => context.once("close", r));
  c.abort();
  await closed;
  await context.close();
  const reopened = await b.openBrowser(
    { dataRoot: root, browserExecutable: executable },
    "douyin",
    { headless: true },
  );
  await reopened.close();
  const { readdir } = await import("node:fs/promises");
  assert.equal(
    (await readdir(path.join(root, "private"))).filter((x) =>
      x.endsWith(".lock"),
    ).length,
    0,
  );
});
test("selected collection first response observed before tab click; raw large ID exact", async (t) => {
  const context = await fixture(
    t,
    `<body><button role="tab" aria-selected="true" id="creator">作品</button><button role="tab" aria-selected="false" id="liked" onclick="creator.setAttribute('aria-selected','false');liked.setAttribute('aria-selected','true');fetch('/aweme/v1/web/aweme/favorite/?sec_user_id=author&max_cursor=0')">喜欢</button>`,
  );
  await context.route("**/aweme/v1/web/aweme/favorite/**", (r) =>
    r.fulfill({
      contentType: "application/json",
      body: '{"status_code":0,"aweme_list":[{"aweme_id":90071992547409931234}],"has_more":0}',
    }),
  );
  const page = await context.newPage();
  await page.goto("https://www.douyin.com/user/author");
  const events = [];
  const result = await a.scanPage(page, {
    source: { platform: "douyin", kind: "liked", url: page.url() },
    signal: new AbortController().signal,
    emit: async (type, payload) => events.push({ type, ...payload }),
    navigate: false,
    prepare: () => page.getByRole("tab", { name: "喜欢", exact: true }).click(),
    maxRounds: 4,
    waitMs: 100,
  });
  assert.equal(result.completeness, "complete");
  assert.deepEqual(
    events.filter((e) => e.type === "item").map((e) => e.item.contentId),
    ["90071992547409931234"],
  );
});
test("tab switch away and back invalidates in-flight terminal response", async (t) => {
  const context = await fixture(
    t,
    `<body><button role="tab" aria-selected="true" id="creator">作品</button><button role="tab" aria-selected="false" id="liked">喜欢</button><script>fetch('/aweme/v1/web/aweme/post/?sec_user_id=author');setTimeout(()=>{creator.setAttribute('aria-selected','false');liked.setAttribute('aria-selected','true')},80);setTimeout(()=>{creator.setAttribute('aria-selected','true');liked.setAttribute('aria-selected','false')},140)</script>`,
    {
      "/aweme/v1/web/aweme/post/": [
        350,
        { status_code: 0, aweme_list: [{ aweme_id: "999" }], has_more: 0 },
      ],
    },
  );
  const events = [];
  const result = await a.scanPage(await context.newPage(), {
    source: {
      platform: "douyin",
      kind: "profile",
      url: "https://www.douyin.com/user/author",
    },
    signal: new AbortController().signal,
    emit: async (type, payload) => events.push({ type, ...payload }),
    maxRounds: 8,
    waitMs: 100,
  });
  assert.equal(result.completeness, "partial");
  assert.equal(events.filter((e) => e.type === "item").length, 0);
});
test("visible scoped DOM cards preserve membership and scoped end evidence", async (t) => {
  const context = await fixture(
    t,
    `<body><button role="tab" aria-selected="true">作品</button><div role="tabpanel"><a href="/video/123">owned card</a><p>暂时没有更多了</p></div><aside><a href="/video/999">recommendation</a></aside>`,
  );
  const events = [];
  const result = await a.scanPage(await context.newPage(), {
    source: {
      platform: "douyin",
      kind: "profile",
      url: "https://www.douyin.com/user/author",
    },
    signal: new AbortController().signal,
    emit: async (type, payload) => events.push({ type, ...payload }),
    maxRounds: 2,
    waitMs: 100,
  });
  assert.equal(result.completeness, "partial");
  assert.deepEqual(
    events.filter((e) => e.type === "item").map((e) => e.item.contentId),
    ["123"],
  );
  assert.equal(events.find((e) => e.type === "item").item.mediaResolved, false);
});
test("XHS late expected detail excludes other notes and preserves token source", async (t) => {
  const context = await fixture(
    t,
    `<body><script>setTimeout(()=>{window.__INITIAL_STATE__={note:{noteDetailMap:{abc123:{note:{noteId:'abc123',imageList:[{urlDefault:'https://cdn.example/a.jpg?sig=keep'},{urlDefault:'https://cdn.example/b.jpg'}]}},other:{note:{noteId:'other',imageList:[{urlDefault:'https://cdn.example/wrong.jpg'}]}}}}}},120)</script>`,
  );
  const events = [];
  const result = await a.scanPage(await context.newPage(), {
    source: {
      platform: "xiaohongshu",
      kind: "single",
      url: "https://www.xiaohongshu.com/user/profile/author/abc123?xsec_token=fixtureToken",
    },
    signal: new AbortController().signal,
    emit: async (type, payload) => events.push({ type, ...payload }),
    maxRounds: 5,
    waitMs: 100,
  });
  assert.equal(result.completeness, "complete");
  const items = events.filter((e) => e.type === "item").map((e) => e.item);
  assert.equal(items.length, 1);
  assert.equal(items[0].contentId, "abc123");
  assert.match(items[0].sourceUrl, /xsec_token=fixtureToken/);
  assert.equal(items[0].media.length, 2);
});
async function fixture(t, html, responses = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "umh-browser-"));
  let context;
  t.after(async () => {
    await context?.close();
    await rm(root, { recursive: true, force: true });
  });
  context = await b.openBrowser(
    { dataRoot: root, browserExecutable: executable },
    "douyin",
    { headless: true },
  );
  await context.addCookies([{name:'sessionid',value:'SYNTHETIC_SESSION',domain:'.douyin.com',path:'/',secure:true},{name:'web_session',value:'SYNTHETIC_SESSION',domain:'.xiaohongshu.com',path:'/',secure:true}]);
  await context.route("**/*", async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith("/aweme/")) {
      const [delay, payload] = responses[u.pathname] ?? [0, {}];
      await new Promise((r) => setTimeout(r, delay));
      await route
        .fulfill({
          contentType: "application/json",
          body: JSON.stringify(payload),
        })
        .catch(() => {});
    } else
      await route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: html,
      });
  });
  return context;
}
test("DOM anchor bound cannot certify a truncated collection complete", async (t) => {
  const links = Array.from(
    { length: 1001 },
    (_, i) => `<a href="/video/${i + 1}">work</a>`,
  ).join("");
  const context = await fixture(
    t,
    `<body><button role="tab" aria-selected="true">作品</button><div role="tabpanel">${links}<p>没有更多了</p></div>`,
  );
  const items = [];
  const result = await a.scanPage(await context.newPage(), {
    source: {
      platform: "douyin",
      kind: "profile",
      url: "https://www.douyin.com/user/author",
    },
    emit: async (type, payload) => {
      if (type === "item") items.push(payload.item);
    },
    maxRounds: 1,
    waitMs: 10,
  });
  assert.equal(items.length, 1000);
  assert.equal(result.completeness, "partial");
});

for (const outcome of ["resolve", "reject", "cancel"]) {
  test(`pending observed item delivery must settle before scan completion: ${outcome}`, async (t) => {
    const context = await fixture(
      t,
      `<body><script>fetch('/aweme/v1/web/aweme/detail/?aweme_id=123')</script>`,
      {
        "/aweme/v1/web/aweme/detail/": [
          0,
          {
            aweme_detail: {
              aweme_id: "123",
              images: [{ url_list: ["https://cdn.example/one.jpg"] }],
            },
          },
        ],
      },
    );
    const gate = Promise.withResolvers(),
      entered = Promise.withResolvers();
    t.after(() => gate.resolve());
    const controller = new AbortController();
    let settled = false,
      delivered = false;
    const scanning = a.scanPage(await context.newPage(), {
      source: {
        platform: "douyin",
        kind: "single",
        url: "https://www.douyin.com/video/123",
      },
      signal: controller.signal,
      emit: async (type) => {
        if (type !== "item") return;
        entered.resolve();
        await gate.promise;
        delivered = true;
      },
      maxRounds: 2,
      waitMs: 100,
    });
    // Observe both resolutions and rejections immediately, avoiding unhandled promises.
    const observed = scanning.then(
      (value) => {
        settled = true;
        return { value };
      },
      (error) => {
        settled = true;
        return { error };
      },
    );
    await entered.promise;
    await new Promise((resolve) => setTimeout(resolve, 400));
    const completedWhileBlocked = settled;
    if (outcome === "cancel") controller.abort(new Error("test cancellation"));
    else if (outcome === "reject")
      gate.reject(new Error("test delivery failure"));
    else gate.resolve();
    const final = await Promise.race([
      observed,
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("scan did not settle promptly")),
          2000,
        );
        observed.finally(() => clearTimeout(timer));
      }),
    ]);
    assert.equal(
      completedWhileBlocked,
      false,
      "scan returned before item delivery settled",
    );
    if (outcome === "resolve") {
      assert.equal(delivered, true);
      assert.equal(final.value.completeness, "complete");
    } else if (outcome === "cancel") {
      assert.match(final.error?.message ?? "", /test cancellation/);
    } else {
      assert.notEqual(final.value?.status, "completed");
      assert.equal(delivered, false);
    }
  });
}

test('explicit larger browser scan reads beyond the default DOM prefix',async t=>{
  const links=Array.from({length:1001},(_,i)=>`<a href="/video/${i+1}">work</a>`).join('');
  const context=await fixture(t,`<button role="tab" aria-selected="true">作品</button><div role="tabpanel">${links}<p>没有更多了</p></div>`);
  const items=[];const result=await a.scanPage(await context.newPage(),{
    source:{platform:'douyin',kind:'profile',url:'https://www.douyin.com/user/author',maxItems:1500},
    emit:async(type,p)=>{if(type==='item')items.push(p.item);},waitMs:1,
  });
  assert.equal(items.length,1001);assert.equal(items.at(-1).contentId,'1001');assert.equal(result.completeness,'partial');
});
test('explicit larger scan advances beyond default finite round budget',async t=>{
  const html=`<button role="tab" aria-selected="true">作品</button><div role="tabpanel"></div><script>let rounds=0;window.scrollBy=()=>{if(++rounds===37)document.querySelector('[role=tabpanel]').innerHTML='<a href="/video/123">late</a><p>没有更多了</p>';};</script>`;
  const context=await fixture(t,html);const page=await context.newPage();const items=[];
  const result=await a.scanPage(page,{source:{platform:'douyin',kind:'profile',url:'https://www.douyin.com/user/author',maxItems:1000},emit:async(type,p)=>{if(type==='item')items.push(p.item);},waitMs:1});
  assert.equal(items.length,1);assert.equal(result.completeness,'partial');
});
test("real browser late hydration resolves only requested work", async (t) => {
  assert.equal(typeof b.openBrowser, "function");
  assert.equal(typeof a.scanPage, "function");
  const context = await fixture(
    t,
    `<body><script>setTimeout(()=>{window._ROUTER_DATA={wrong:{aweme_id:'999',video:{play_addr:{url_list:['https://cdn.example/wrong.mp4']}}},actual:{aweme_id:'123',images:[{url_list:['https://cdn.example/one.jpg']},{url_list:['https://cdn.example/two.jpg']}]}}},250)</script>`,
  );
  const events = [];
  const result = await a.scanPage(await context.newPage(), {
    source: {
      platform: "douyin",
      kind: "single",
      url: "https://www.douyin.com/user/author?modal_id=123",
    },
    signal: new AbortController().signal,
    emit: async (type, payload) => events.push({ type, ...payload }),
    maxRounds: 8,
    waitMs: 100,
  });
  assert.equal(result.completeness, "complete");
  assert.deepEqual(
    events.filter((e) => e.type === "item").map((e) => e.item.contentId),
    ["123"],
  );
  assert.equal(events.find((e) => e.type === "item").item.media.length, 2);
});
test("wrong-list terminal response excluded and stalled list is partial", async (t) => {
  assert.equal(typeof b.openBrowser, "function");
  const context = await fixture(
    t,
    `<body><button role="tab" aria-selected="true">作品</button><script>fetch('/aweme/v1/web/aweme/favorite/?sec_user_id=author&max_cursor=0')</script>`,
    {
      "/aweme/v1/web/aweme/favorite/": [
        0,
        { status_code: 0, aweme_list: [{ aweme_id: "999" }], has_more: 0 },
      ],
    },
  );
  const events = [];
  const r = await a.scanPage(await context.newPage(), {
    source: {
      platform: "douyin",
      kind: "profile",
      url: "https://www.douyin.com/user/author",
    },
    signal: new AbortController().signal,
    emit: async (type, payload) => events.push({ type, ...payload }),
    maxRounds: 3,
    waitMs: 100,
  });
  assert.equal(r.completeness, "partial");
  assert.equal(events.filter((e) => e.type === "item").length, 0);
});
test("matching current list explicit end is complete and challenge needs action", async (t) => {
  assert.equal(typeof b.openBrowser, "function");
  const context = await fixture(
    t,
    `<body><button role="tab" aria-selected="true">作品</button><script>fetch('/aweme/v1/web/aweme/post/?sec_user_id=author&max_cursor=0')</script>`,
    {
      "/aweme/v1/web/aweme/post/": [
        100,
        { status_code: 0, aweme_list: [{ aweme_id: "123", desc: "card" }], has_more: 0 },
      ],
    },
  );
  const r = await a.scanPage(await context.newPage(), {
    source: {
      platform: "douyin",
      kind: "profile",
      url: "https://www.douyin.com/user/author",
    },
    signal: new AbortController().signal,
    emit: async () => {},
    maxRounds: 5,
    waitMs: 100,
  });
  assert.equal(r.completeness, "complete");
  const page = await context.newPage();
  await page.route("**/*", (r) =>
    r.fulfill({
      contentType: "text/html; charset=utf-8",
      body: "<body>请完成安全验证</body>",
    }),
  );
  const barrier = await a.scanPage(page, {
    source: {
      platform: "douyin",
      kind: "profile",
      url: "https://www.douyin.com/user/author",
    },
    signal: new AbortController().signal,
    emit: async () => {},
    maxRounds: 2,
    waitMs: 100,
  });
  assert.equal(barrier.status, "needs_action");
});
test("platform 'no more' stops scrolling at once even when the page chain is unproven, and stays partial", async (t) => {
  const context = await fixture(
    t,
    `<body><button role="tab" aria-selected="true">作品</button><script>fetch('/aweme/v1/web/aweme/post/?sec_user_id=author&max_cursor=5')</script>`,
    { "/aweme/v1/web/aweme/post/": [50, { status_code: 0, aweme_list: [{ aweme_id: "123" }], has_more: 0 }] },
  );
  const items = [], started = Date.now();
  const result = await a.scanPage(await context.newPage(), {
    source: { platform: "douyin", kind: "profile", url: "https://www.douyin.com/user/author" },
    signal: new AbortController().signal,
    emit: async (type, payload) => { if (type === "item") items.push(payload.item); },
    maxRounds: 200, waitMs: 100,
  });
  assert.equal(items.length, 1);
  assert.equal(result.completeness, "partial");
  assert.ok(Date.now() - started < 10000, "must not scroll through all 200 rounds after the list ended");
});
test("scan limit 0 (no limit) gets the full scroll budget but keeps the 1000-anchor DOM bound", async () => {
  const { scanBudget } = await import("../src/shared/scanner.mjs");
  assert.deepEqual(scanBudget({ maxItems: 0 }), { maxRounds: 500, maxAnchors: 1000 });
  assert.deepEqual(scanBudget({ maxItems: 2000 }), { maxRounds: 200, maxAnchors: 2000 });
  assert.deepEqual(scanBudget({ maxItems: 5 }), { maxRounds: 35, maxAnchors: 1000 });
});
