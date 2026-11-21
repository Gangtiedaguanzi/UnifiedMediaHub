import { mkdir } from 'node:fs/promises';
import { reserveMediaStage } from './owned-temps.mjs';

// Full media belongs on the selected output volume. The data-root hash separates
// independent app instances sharing a download root. No credentials/manifests live here.
// Durable ownership permits next explicit operation recovery after a killed task.
export async function withMediaStage(ctx, operation) {
  ctx.signal?.throwIfAborted();
  const paths=ctx.paths ?? ctx.request.paths;
  const owned=await reserveMediaStage(paths.dataRoot,paths.downloadRoot);
  const stage=owned.target;let created=false;
  try {
    await mkdir(stage);created=true;await owned.claim();
    ctx.signal?.throwIfAborted();
    const result=await operation(stage);
    ctx.signal?.throwIfAborted();
    return result;
  } finally {
    // All children have settled before the callback exits. Never enumerate/remove
    // another namespace or another task, including crash remnants.
    if(created)await owned.clean();else await owned.abandon();
  }
}
