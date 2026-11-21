export function applyMediaSelection(original, resolved) {
  if (original.contentId !== resolved.contentId)
    throw new Error("media_selection_changed");
  if (!original.mediaResolved) return resolved;
  const allowed = new Map(
    original.media.map((asset) => [asset.index, asset.kind]),
  );
  const media = resolved.media.filter((asset) => allowed.has(asset.index));
  if (
    media.length !== allowed.size ||
    media.some((asset) => allowed.get(asset.index) !== asset.kind)
  ) {
    throw new Error("media_selection_changed");
  }
  return { ...resolved, media:media.map(asset=>{
    const old=original.media.find(x=>x.index===asset.index);
    return old?.reuseFrom?{...asset,reuseFrom:old.reuseFrom,reuseSha256:old.reuseSha256,reuseBytes:old.reuseBytes}:asset;
  }) };
}
