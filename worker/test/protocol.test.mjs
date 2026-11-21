import './fixtures/offline-network.mjs';
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const p = await import("../src/shared/protocol.mjs").catch(() => ({}));
test("resolved empty media selection does no browser or transfer work", async () => {
  const { download } = await import("../src/adapters/douyin.mjs");
  const events = [];
  const result = await download({
    request: {
      items: [
        {
          platform: "douyin",
          contentId: "123",
          sourceUrl: "https://www.douyin.com/video/123",
          mediaResolved: true,
          media: [],
        },
      ],
      paths: { browserExecutable: process.execPath },
    },
    signal: new AbortController().signal,
    emit: async (...args) => events.push(args),
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(events, []);
});
test("bounded large first request is accepted; malformed control fails instead of claiming pause", async () => {
  for (const malformed of [false, true]) {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../src/main.mjs", import.meta.url))],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const exited = once(child, "exit");
    let out = "";
    child.stdout.on("data", (x) => (out += x));
    const request = {
      version: 1,
      requestId: "large",
      operation: "login",
      source: {
        platform: "douyin",
        kind: "profile",
        url: "https://www.douyin.com/user/fixture",
        label: "fixture".repeat(15000),
      },
      paths: {
        dataRoot: path.resolve("not-created"),
        downloadRoot: path.resolve("downloads"),
        browserExecutable: process.execPath,
        engineRoot: fileURLToPath(new URL("../../runtime", import.meta.url)),
      },
    };
    child.stdin.write(
      JSON.stringify(request) + "\n" + (malformed ? "not-json\n" : ""),
    );
    await exited;
    const events = out.trim().split("\n").map(JSON.parse);
    assert.equal(events.at(-1).status, "failed");
    assert.equal(
      events.find((e) => e.type === "error")?.code,
      malformed ? "protocol_error" : "invalid_browser_path",
    );
  }
});
test("production worker cancellation during streamed write removes part and reports paused", async (t) => {
  const http = await import("node:http");
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "video/mp4" });
    res.write(Buffer.from("000000186674797069736f6d", "hex"));
    const timer = setTimeout(() => res.end("tail"), 3000);
    res.on("close", () => clearTimeout(timer));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const root = await mkdtemp(path.join(os.tmpdir(), "umh-cancel-e2e-"));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../src/main.mjs", import.meta.url))],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const exited = once(child, "exit");
  const timer = setTimeout(() => child.kill(), 10000);
  t.after(() => clearTimeout(timer));
  let out = "",
    sent = false;
  child.stdout.on("data", (x) => {
    out += x;
    if (out.includes('"phase":"download"') && !sent) {
      sent = true;
      child.stdin.write('{"command":"cancel"}\n');
    }
  });
  child.stdin.write(
    JSON.stringify({
      version: 1,
      requestId: "cancel-e2e",
      operation: "download",
      source: {
        platform: "douyin",
        kind: "single",
        url: "https://www.douyin.com/video/123",
      },
      items: [
        {
          platform: "douyin",
          contentId: "123",
          sourceUrl: "https://www.douyin.com/video/123",
          mediaResolved: true,
          selected: true,
          media: [
            {
              index: 1,
              kind: "video",
              extension: "mp4",
              url: `http://127.0.0.1:${server.address().port}/media`,
            },
          ],
        },
      ],
      paths: {
        dataRoot: root,
        downloadRoot: path.join(root, "downloads"),
        browserExecutable: fileURLToPath(
          new URL(
            "../../runtime/browsers/chromium-1248/chrome-win64/chrome.exe",
            import.meta.url,
          ),
        ),
        engineRoot: fileURLToPath(new URL("../../runtime", import.meta.url)),
      },
    }) + "\n",
  );
  const [code] = await exited;
  assert.equal(code, 0);
  assert.equal(sent, true);
  const events = out.trim().split("\n").map(JSON.parse);
  assert.equal(events.at(-1).status, "paused");
  assert.equal(
    events.some((e) => e.type === "receipt"),
    false,
  );
  const files = await readdir(root, { recursive: true });
  assert.equal(
    files.some((f) => f.endsWith(".part") || f.endsWith(".mp4")),
    false,
  );
});
test("writer blocks on real backpressure and rejects queue overflow without dropping accepted events", async () => {
  const { Writable } = await import("node:stream");
  const callbacks = [];
  const got = [];
  const stream = new Writable({
    highWaterMark: 1,
    write(chunk, enc, cb) {
      got.push(JSON.parse(chunk));
      callbacks.push(cb);
    },
  });
  const emit = p.eventWriter(stream, "pressure");
  const first = emit("status", { message: "first" });
  await new Promise((r) => setImmediate(r));
  assert.equal(got.length, 1);
  let finished = false;
  first.then(() => (finished = true));
  await new Promise((r) => setImmediate(r));
  assert.equal(finished, false);
  const pending = Array.from({ length: 255 }, (_, i) =>
    emit("status", { message: String(i) }),
  );
  await assert.rejects(
    emit("status", { message: "overflow" }),
    /event_backpressure/,
  );
  for (let i = 0; i < 256; i++) {
    while (!callbacks.length) await new Promise((r) => setImmediate(r));
    callbacks.shift()();
    await new Promise((r) => setImmediate(r));
  }
  await Promise.all([first, ...pending]);
  assert.equal(got.length, 256);
});
test("writer rejects oversize events and applies finite backpressure", async () => {
  const { Writable } = await import("node:stream");
  const events = [];
  const stream = new Writable({
    write(chunk, enc, cb) {
      events.push(JSON.parse(chunk));
      cb();
    },
  });
  const emit = p.eventWriter(stream, "bound");
  await assert.rejects(emit("item", { item: { title: "a".repeat(65536) } }));
  await emit("status", { message: "ok" });
  assert.equal(events.length, 1);
  assert.equal(events[0].requestId, "bound");
});
test("production worker downloads selected synthetic media and exits, with hash evidence", async (t) => {
  const http = await import("node:http");
  const { readFile } = await import("node:fs/promises");
  const data = await readFile(
    new URL("./fixtures/synthetic-grid.mp4", import.meta.url),
  );
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    res.writeHead(200, {
      "content-type": "video/mp4",
      "content-length": data.length,
    });
    res.end(data);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const root = await mkdtemp(path.join(os.tmpdir(), "umh-e2e-"));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../src/main.mjs", import.meta.url))],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const exited = once(child, "exit");
  const timer = setTimeout(() => child.kill(), 10000);
  t.after(() => clearTimeout(timer));
  let out = "",
    err = "";
  child.stdout.on("data", (x) => (out += x));
  child.stderr.on("data", (x) => (err += x));
  const make = (cid, selected) => ({
    platform: "douyin",
    contentId: cid,
    key: "douyin:" + cid,
    sourceUrl: "https://www.douyin.com/video/" + cid,
    mediaResolved: true,
    selected,
    media: [
      {
        index: 1,
        kind: "video",
        extension: "mp4",
        url: `http://127.0.0.1:${server.address().port}/media`,
        expectedBytes: 11009,
      },
    ],
  });
  child.stdin.write(
    JSON.stringify({
      version: 1,
      requestId: "fixture-e2e",
      operation: "download",
      source: {
        platform: "douyin",
        kind: "single",
        url: "https://www.douyin.com/video/123",
      },
      items: [make("123", true), make("999", false)],
      paths: {
        dataRoot: root,
        downloadRoot: path.join(root, "downloads"),
        browserExecutable: fileURLToPath(
          new URL(
            "../../runtime/browsers/chromium-1248/chrome-win64/chrome.exe",
            import.meta.url,
          ),
        ),
        engineRoot: fileURLToPath(new URL("../../runtime", import.meta.url)),
      },
    }) + "\n",
  );
  const [code] = await exited;
  assert.equal(code, 0);
  assert.equal(err, "");
  const events = out.trim().split("\n").map(JSON.parse);
  assert.equal(events.at(-1).status, "completed");
  const receipts = events.filter((e) => e.type === "receipt");
  assert.equal(receipts.length, 1);
  assert.equal(
    receipts[0].receipt.sha256,
    "aacde4542a5061a8767142d766f4581b14ebf51a03c9647055d8e0c7f2a174c3",
  );
  assert.deepEqual(await readFile(receipts[0].receipt.filePath), data);
  assert.equal(requests, 1);
});
test("validation rejects lookalike URLs, missing paths, invalid controls", () => {
  assert.equal(typeof p.validateRequest, "function");
  const good = {
    version: 1,
    requestId: "r1",
    operation: "scan",
    source: {
      platform: "douyin",
      kind: "single",
      url: "https://www.douyin.com/video/123",
    },
    paths: {
      dataRoot: path.resolve("data"),
      downloadRoot: path.resolve("downloads"),
      browserExecutable: fileURLToPath(
        new URL(
          "../../runtime/browsers/chromium-1248/chrome-win64/chrome.exe",
          import.meta.url,
        ),
      ),
      engineRoot: fileURLToPath(new URL("../../runtime", import.meta.url)),
    },
  };
  assert.equal(p.validateRequest(good).requestId, "r1");
  assert.throws(() =>
    p.validateRequest({
      ...good,
      source: {
        ...good.source,
        url: "https://douyin.com.evil.example/video/123",
      },
    }),
  );
  assert.throws(() => p.validateRequest({ ...good, paths: {} }));
  assert.equal(p.validateRequest({ ...good, paths: { ...good.paths, folder: "我的喜欢_小号_2026-11-19_2005" } }).requestId, "r1");
  for (const folder of ["a/b", "..", "CON", " x"]) assert.throws(() => p.validateRequest({ ...good, paths: { ...good.paths, folder } }), /invalid_folder/);
});
test("production worker performs no startup filesystem effects and EOF exits", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "umh-transport-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../src/main.mjs", import.meta.url))],
    {
      cwd: root,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (x) => (output += x));
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(await readdir(root), []);
  assert.equal(output, "");
  const exited = once(child, "exit");
  child.stdin.end();
  const [code] = await exited;
  assert.equal(code, 0);
});
