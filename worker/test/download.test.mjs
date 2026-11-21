import './fixtures/offline-network.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  mkdir,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
const mod = await import("../src/shared/download.mjs").catch(() => ({}));
const paths = await import("../src/shared/paths.mjs").catch(() => ({}));
test("private roots receive protected ACL and reject junction traversal", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "umh-private-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { securePrivateRoot } = await import("../src/shared/private.mjs");
  const secured = await securePrivateRoot(path.join(root, "data"));
  if (process.platform === "win32") {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const script =
      '$a=[System.IO.Directory]::GetAccessControl($env:UMH_ACL_TEST); $allowed=@([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,"S-1-5-18","S-1-5-32-544"); $rules=$a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]); $bad=@($rules | Where-Object { $_.IdentityReference.Value -notin $allowed }); if(-not $a.AreAccessRulesProtected -or $bad.Count -gt 0 -or $rules.Count -ne 3){exit 9}; "protected"';
    const out = await promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, env: { ...process.env, UMH_ACL_TEST: secured } },
    );
    assert.match(out.stdout, /protected/);
  }
  await mkdir(path.join(root, "outside"));
  await mkdir(path.join(root, "linked"));
  await symlink(
    path.join(root, "outside"),
    path.join(root, "linked", "private"),
    "junction",
  );
  await assert.rejects(
    securePrivateRoot(path.join(root, "linked")),
    /unsafe_link/,
  );
});
const png = Buffer.from("89504e470d0a1a0a0000000049454e44ae426082", "hex");
test("existing target is reused only if bytes match; different file remains intact", async (t) => {
  const f = await fixture(t);
  const item = { platform: "douyin", contentId: "123" },
    asset = {
      index: 1,
      kind: "image",
      extension: "png",
      url: f.url + "/image",
    };
  const target = path.join(f.root, paths.relativeMediaPath(item, asset));
  await mkdir(path.dirname(target), { recursive: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(target, "existing-user-file");
  await assert.rejects(
    mod.downloadAsset({
      root: f.root,
      item,
      asset,
      signal: new AbortController().signal,
    }),
    /file_conflict/,
  );
  assert.equal(await readFile(target, "utf8"), "existing-user-file");
  await writeFile(target, png);
  const receipt = await mod.downloadAsset({
    root: f.root,
    item,
    asset,
    signal: new AbortController().signal,
  });
  assert.equal(receipt.status, "skipped");
  assert.equal(receipt.bytes, png.length);
});
async function fixture(t) {
  let cookies = [];
  const server = http.createServer((req, res) => {
    cookies.push([req.url, req.headers.cookie]);
    if (req.url === "/redirect") {
      res.writeHead(302, {
        location: `http://localhost:${server.address().port}/image`,
      });
      res.end();
      return;
    }
    if (req.url === "/bad") {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    if (req.url === "/html") {
      res.setHeader("Content-Type", "text/html");
      res.end("<html>login</html>");
      return;
    }
    res.setHeader("Content-Type", "image/png");
    if (req.url === "/slow") {
      res.write(png.subarray(0, 8));
      const timer = setTimeout(() => res.end(png.subarray(8)), 1500);
      res.on("close", () => clearTimeout(timer));
    } else res.end(png);
  });
  await new Promise((r) => server.listen(0, "0.0.0.0", r));
  const root = await mkdtemp(path.join(os.tmpdir(), "umh-download-"));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  return { root, cookies, url: `http://127.0.0.1:${server.address().port}` };
}
test("worker readable layout retains identity and rejects traversal", () => {
  assert.equal(typeof paths.relativeMediaPath, "function");
  assert.equal(
    paths
      .relativeMediaPath(
        { platform: "x", contentId: "123" },
        { index: 1, extension: "JPG" },
      )
      .replaceAll("\\", "/"),
    "x/未知作者/无日期_无标题_123/01.jpg",
  );
  assert.throws(() =>
    paths.relativeMediaPath(
      { platform: "x", contentId: "../bad" },
      { index: 1, extension: "jpg" },
    ),
  );
});
test("stream verifies bytes/hash and redirect recomputes cookie domain", async (t) => {
  assert.equal(typeof mod.downloadAsset, "function");
  const f = await fixture(t);
  const receipt = await mod.downloadAsset({
    root: f.root,
    item: { platform: "douyin", contentId: "123" },
    asset: {
      index: 1,
      kind: "image",
      extension: "png",
      url: f.url + "/redirect",
      expectedBytes: png.length,
    },
    cookies: [
      {
        name: "session",
        value: "secret",
        domain: "127.0.0.1",
        path: "/",
        secure: false,
      },
    ],
    signal: new AbortController().signal,
  });
  assert.equal(receipt.bytes, png.length);
  assert.equal(receipt.sha256, createHash("sha256").update(png).digest("hex"));
  assert.deepEqual(await readFile(receipt.filePath), png);
  assert.equal(f.cookies.find((x) => x[0] === "/image")[1], undefined);
});
test("HTTP error, HTML, mismatch and cancellation never publish file or leave part", async (t) => {
  assert.equal(typeof mod.downloadAsset, "function");
  const f = await fixture(t);
  for (const [route, size] of [
    ["/bad", null],
    ["/html", null],
    ["/image", 99],
    ["/slow", null],
  ]) {
    const c = new AbortController();
    if (route === "/slow") setTimeout(() => c.abort(), 80);
    await assert.rejects(
      mod.downloadAsset({
        root: f.root,
        item: { platform: "x", contentId: route.slice(1) },
        asset: {
          index: 1,
          kind: "image",
          extension: "png",
          url: f.url + route,
          expectedBytes: size,
        },
        signal: c.signal,
      }),
    );
  }
  const files = await readdir(f.root, { recursive: true });
  assert.equal(
    files.filter((x) => x.endsWith(".part") || x.endsWith(".png")).length,
    0,
  );
});
