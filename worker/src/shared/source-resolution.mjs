import { barrier } from "./browser.mjs";
import { sourceIdentity } from "./scanner.mjs";

export class ActionRequired extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const shortHosts = {
  douyin: ["v.douyin.com"],
  xiaohongshu: ["xhslink.com", "www.xhslink.com"],
};
const allowedHosts = {
  douyin: ["douyin.com", "www.douyin.com", "www.iesdouyin.com", "iesdouyin.com", "v.douyin.com"],
  xiaohongshu: [
    "xiaohongshu.com",
    "www.xiaohongshu.com",
    "xhslink.com",
    "www.xhslink.com",
  ],
};

export async function resolveSource(
  page,
  source,
  { signal, timeoutMs = 15000 } = {},
) {
  const start = new URL(source.url);
  const slide=/^\/share\/slides\/(\d+)\/?$/.exec(start.pathname);
  if(source.platform==='douyin'&&['iesdouyin.com','www.iesdouyin.com'].includes(start.hostname)&&slide)return {...source,url:`https://www.douyin.com/note/${slide[1]}`};
  if (!shortHosts[source.platform]?.includes(start.hostname)) return source;
  let rejected = false,
    navigations = 0;
  // Chromium's Fetch domain reports each redirect hop separately. Playwright's
  // route API only handles the first URL in some redirected navigation chains.
  const guard = await page.context().newCDPSession(page);
  const { frameTree } = await guard.send("Page.getFrameTree");
  const paused = async (event) => {
    let target;
    try {
      target = new URL(event.request.url);
    } catch {}
    if (
      event.frameId === frameTree.frame.id &&
      (++navigations > 5 ||
        !target ||
        !["http:", "https:"].includes(target.protocol) ||
        target.username ||
        target.password ||
        target.port ||
        !allowedHosts[source.platform].includes(target.hostname))
    ) {
      rejected = true;
      await guard
        .send("Fetch.failRequest", {
          requestId: event.requestId,
          errorReason: "BlockedByClient",
        })
        .catch(() => {});
    } else
      await guard
        .send("Fetch.continueRequest", { requestId: event.requestId })
        .catch(() => {});
  };
  guard.on("Fetch.requestPaused", paused);
  await guard.send("Fetch.enable", {
    patterns: [
      { urlPattern: "*", resourceType: "Document", requestStage: "Request" },
    ],
  });
  try {
    signal?.throwIfAborted();
    const deadline = Date.now() + timeoutMs;
    await page.goto(source.url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const current = new URL(page.url());
      if (rejected || !allowedHosts[source.platform].includes(current.hostname))
        throw new ActionRequired(
          "input_required",
          "The short link left its allowed platform; no content was accepted.",
        );
      const blocked = await barrier(page);
      if (blocked)
        throw new ActionRequired(
          ["auth_required", "challenge", "rate_limited"].includes(blocked)
            ? blocked
            : "input_required",
          "Short-link resolution requires manual attention.",
        );
      if (!shortHosts[source.platform].includes(current.hostname)) {
        const final = { ...source, url: current.href };
        const identity = sourceIdentity(final);
        const dy = source.platform === "douyin";
        const profilePath = dy
          ? /^\/user\/[A-Za-z0-9_-]+\/?$/
          : /^\/user\/profile\/[A-Za-z0-9_-]+\/?$/;
        const detailPath = dy
          ? /^\/(?:share\/)?(?:video|note|slides)\/\d+\/?$/
          : /^\/(?:explore|discovery\/item|search_result)\/[A-Za-z0-9_-]+\/?$|^\/user\/profile\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/?$/;
        const validDetail =
          detailPath.test(current.pathname) ||
          (dy &&
            profilePath.test(current.pathname) &&
            /^\d+$/.test(current.searchParams.get("modal_id") ?? ""));
        if (
          (source.kind === "single" && (!identity.work || !validDetail)) ||
          (source.kind === "profile" &&
            (!identity.subject ||
              identity.work ||
              !profilePath.test(current.pathname))) ||
          !["single", "profile"].includes(source.kind)
        )
          throw new ActionRequired(
            "input_required",
            "The short link did not resolve to the requested source type.",
          );
        if(dy&&/^\/share\/slides\/\d+\/?$/.test(current.pathname))return {...final,url:`https://www.douyin.com/note/${identity.work}`};
        return final;
      }
      await page.waitForTimeout(100);
    }
    throw new ActionRequired(
      "input_required",
      "The short link did not resolve within its bounded navigation window.",
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof ActionRequired) throw error;
    throw new ActionRequired(
      "input_required",
      "The short link could not be resolved safely.",
    );
  } finally {
    guard.off("Fetch.requestPaused", paused);
    await guard.send("Fetch.disable").catch(() => {});
    await guard.detach().catch(() => {});
  }
}
