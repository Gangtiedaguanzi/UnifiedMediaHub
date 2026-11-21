import './fixtures/offline-network.mjs';
import test from "node:test";
import assert from "node:assert/strict";
const mod = await import("../src/shared/normalizers.mjs").catch(() => ({}));
test("refresh preserves explicit gallery index mask but unresolved works discover every asset", async () => {
  const { applyMediaSelection } =
    await import("../src/shared/selection.mjs").catch(() => ({}));
  assert.equal(typeof applyMediaSelection, "function");
  const fresh = {
    contentId: "123",
    mediaResolved: true,
    media: [
      { index: 1, kind: "image" },
      { index: 2, kind: "video" },
      { index: 3, kind: "image" },
    ],
  };
  assert.deepEqual(
    applyMediaSelection(
      {
        contentId: "123",
        mediaResolved: true,
        media: [{ index: 2, kind: "video" }],
      },
      fresh,
    ).media.map((m) => m.index),
    [2],
  );
  assert.equal(
    applyMediaSelection(
      { contentId: "123", mediaResolved: false, media: [] },
      fresh,
    ).media.length,
    3,
  );
  assert.throws(
    () =>
      applyMediaSelection(
        {
          contentId: "123",
          mediaResolved: true,
          media: [{ index: 4, kind: "image" }],
        },
        fresh,
      ),
    /media_selection_changed/,
  );
});
test("unresolved gallery entry keeps stable numbering and prevents false media resolution", () => {
  const item = mod.normalizeDouyin({
    aweme_id: "123",
    images: [
      { url_list: ["https://cdn.example/1.jpg"] },
      { url_list: [] },
      { url_list: ["https://cdn.example/3.jpg"] },
    ],
  });
  assert.equal(item.mediaResolved, false);
  assert.deepEqual(
    item.media.map((m) => [m.index, m.url]),
    [
      [1, "https://cdn.example/1.jpg"],
      [2, null],
      [3, "https://cdn.example/3.jpg"],
    ],
  );
});
test("raw JSON unsafe integer IDs remain exact decimal strings", async () => {
  const json = await import("../src/shared/json.mjs").catch(() => ({}));
  assert.equal(typeof json.parseLossless, "function");
  const raw = json.parseLossless(
    '{"aweme_id":90071992547409931234,"has_more":0}',
  );
  assert.equal(raw.aweme_id, "90071992547409931234");
  assert.equal(raw.has_more, 0);
  assert.equal(mod.normalizeDouyin(raw).contentId, "90071992547409931234");
});
test("DY preserves huge IDs and image/dynamic-video ordering; rejects lossy numeric IDs", () => {
  assert.equal(typeof mod.normalizeDouyin, "function");
  const item = mod.normalizeDouyin({
    aweme_id: "90071992547409931234",
    desc: "../CON",
    images: [
      {
        url_list: ["https://cdn.example/1.jpg"],
        video: { play_addr: { url_list: ["https://cdn.example/1.mp4"] } },
      },
      { url_list: ["https://cdn.example/2.jpg"] },
    ],
  });
  assert.equal(item.contentId, "90071992547409931234");
  assert.deepEqual(
    item.media.map((x) => [x.index, x.kind]),
    [
      [1, "image"],
      [2, "video"],
      [3, "image"],
    ],
  );
  assert.equal(mod.normalizeDouyin({ aweme_id: 9007199254740993 }), null);
});
test("XHS card stays unresolved, selected detail keeps signed image order", () => {
  assert.equal(typeof mod.normalizeXhs, "function");
  const card = mod.normalizeXhs({
    note_id: "abc123",
    xsec_token: "privateToken",
    note_card: {
      display_title: "Card",
      cover: { urlDefault: "https://cdn.example/cover" },
    },
  });
  assert.equal(card.mediaResolved, false);
  assert.match(card.sourceUrl, /xsec_token=privateToken/);
  const full = mod.normalizeXhs(
    {
      note_id: "abc123",
      imageList: [
        { urlDefault: "https://cdn.example/first.jpg?signature=keep" },
        { urlDefault: "https://cdn.example/second.jpg" },
      ],
    },
    true,
  );
  assert.equal(full.media.length, 2);
  assert.match(full.media[0].url, /signature=keep/);
});
// Xiaohongshu video streams moved from stream.h264[].masterUrl to groups like EF4/EF5 whose
// entries may carry only backupUrls (observed 2026-11-18).
test('Xiaohongshu video notes resolve from the regrouped stream, preferring h264',async()=>{
 const {normalizeXhs}=await import('../src/shared/normalizers.mjs');
 const note=stream=>normalizeXhs({note_id:'abc123',xsec_token:'T',type:'video',video:{media:{stream}}},true);
 const regrouped=note({EF4:[{videoCodec:'h265',height:1080,masterUrl:'https://sns-video-hw.xhscdn.com/hevc.mp4'}],EF5:[{videoCodec:'h264',height:720,backupUrls:['https://sns-bak-v1.xhscdn.com/avc.mp4']}],EF6:[]});
 assert.equal(regrouped.mediaResolved,true);assert.equal(regrouped.media[0].url,'https://sns-bak-v1.xhscdn.com/avc.mp4');
 const onlyHevc=note({EF4:[{videoCodec:'h265',height:720,backupUrls:['https://a.xhscdn.com/1.mp4']},{videoCodec:'h265',height:1080,backupUrls:['https://a.xhscdn.com/2.mp4']}]});
 assert.equal(onlyHevc.media[0].url,'https://a.xhscdn.com/2.mp4');
 assert.equal(note({h264:[{masterUrl:'https://legacy.xhscdn.com/v.mp4'}]}).media[0].url,'https://legacy.xhscdn.com/v.mp4');
 assert.equal(note({EF4:[]}).mediaResolved,false);
});
