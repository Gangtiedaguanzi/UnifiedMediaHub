import {diskFull} from './storage-budget.mjs';
import {errors as browserErrors} from 'playwright';
import {withLoginPage} from './login-lifecycle.mjs';
import { openBrowser, currentIdentity, barrier, prepareSourceTab, tabSnapshot } from "./browser.mjs";
import { bounded } from './source-observation.mjs';
import { scanPage, sourceIdentity } from "./scanner.mjs";
import { downloadAsset } from "./download.mjs";
import { applyMediaSelection } from "./selection.mjs";
import { resolveSource, ActionRequired } from "./source-resolution.mjs";
import {listDouyinFolders} from './saved-folders.mjs';
import {listXhsFolders} from './xhs-saved-folders.mjs';
import {scanXhsFolderMembers} from './xhs-folder-members.mjs';
import {sessionFingerprint} from './session-fingerprint.mjs';
import {safeBridgeMedia} from './bridge-import.mjs';
import {ordinaryLogin} from './ordinary-login.mjs';

const privateList = (source) => ["saved", "liked"].includes(source?.kind);
const needsIdentity = (source) => !!source?.accountId || privateList(source);

export function browserAdapter(platform, { open = openBrowser, download: transferAsset = downloadAsset, identity = currentIdentity, ordinary = ordinaryLogin } = {}) {
  const identityPages=new WeakMap();
  async function closeIdentity(context){
    const page=context&&identityPages.get(context);
    if(page){identityPages.delete(context);await page.close().catch(()=>{});}
  }
  async function passiveCheck(page,expectedFingerprint,signal){
    signal?.throwIfAborted();
    const observed=await sessionFingerprint(page.context(),platform);
    signal?.throwIfAborted();
    if(!expectedFingerprint||!observed||observed!==expectedFingerprint)throw new ActionRequired('auth_required','The bound session changed. Stop and reconfirm the account manually.');
    let url;try{url=new URL(page.url());}catch{}
    const hosts=platform==='douyin'?['www.douyin.com','douyin.com','www.iesdouyin.com']:['www.xiaohongshu.com','xiaohongshu.com'];
    if(!url||url.protocol!=='https:'||url.username||url.password||url.port||!hosts.includes(url.hostname))throw new ActionRequired('source_changed','The dedicated page left its platform.');
    const blocked=await barrier(page);signal?.throwIfAborted();
    if(blocked)throw new ActionRequired(['auth_required','challenge','rate_limited'].includes(blocked)?blocked:'input_required','The bound page requires manual attention.');
  }
  async function action(ctx, error) {
    await ctx.emit("needs_action", {
      code: error.code,
      reasonCode: error.code,
      message: error.message,
    });
    return {
      status: "needs_action",
      completeness: "partial",
      reasonCode: error.code,
      message: error.message,
    };
  }
  async function verifyAccount(page, source, expected = source.accountId,signal) {
    signal?.throwIfAborted();
    const blocked = await barrier(page);
    if (blocked)
      throw new ActionRequired(
        ["auth_required", "challenge", "rate_limited"].includes(blocked)
          ? blocked
          : "input_required",
        "The bound account page requires manual attention.",
      );
    const context=page.context();
    let identityPage=identityPages.get(context);
    if(!identityPage||identityPage.isClosed()){identityPage=await context.newPage();identityPages.set(context,identityPage);}
    let account;
    const close=()=>{void identityPage.close().catch(()=>{});};
    signal?.addEventListener('abort',close,{once:true});
    try{
      signal?.throwIfAborted();
      account=await bounded(child=>identity(identityPage,platform,{signal:child}),signal,45000,'identity_timeout');
      signal?.throwIfAborted();
    }catch(error){
      signal?.throwIfAborted();
      if(error instanceof browserErrors.TimeoutError||error.message==='identity_timeout')
        throw new ActionRequired('identity_unverified','The current account identity could not be verified within this attempt.');
      throw error;
    }finally{
      signal?.removeEventListener('abort',close);
      if(!identityPage.isClosed())await identityPage.goto('about:blank',{timeout:5000}).catch(()=>{});
    }
    if (!account)
      throw new ActionRequired(
        "identity_unverified",
        "The current account identity could not be verified within this attempt.",
      );
    if (expected && account.accountId !== expected)
      throw new ActionRequired(
        "auth_required",
        "The current account differs from the account bound to this source. The source was not rebound.",
      );
    return account;
  }
  const emitAccount = (ctx, account) =>
    ctx.emit("account", { platform, authenticated: true, ...account });
  async function withBrowser(ctx, fn, profileLease) {
    const browser = await open(ctx.paths ?? ctx.request.paths, platform, {
      signal: ctx.signal,
      ...(profileLease ? { profileLease } : {}),
    });
    try {
      return await fn(browser, browser.pages()[0] ?? (await browser.newPage()));
    } catch (error) {
      if(diskFull(error))return action(ctx,new ActionRequired("disk_full","磁盘空间不足，已停止任务。"));
      if(error.message==="storage_budget")return action(ctx,new ActionRequired("storage_budget","媒体超过有限空间预算。"));
      if (error instanceof ActionRequired) return action(ctx, error);
      throw error;
    } finally {
      try{await closeIdentity(browser);}finally{await browser.close();}
    }
  }
  async function login(ctx) {
    // A QR login in the automation-controlled browser did not persist (still guest), as with X.
    // Sign in in an ordinary window first, then verify with the same profile lease.
    if (platform === "xiaohongshu")
      return ordinary(ctx, (lease) => withBrowser(ctx, async (_browser, page) => {
        const account = await verifyAccount(page, ctx.request.source ?? {}, undefined, ctx.signal);
        ctx.signal.throwIfAborted(); await emitAccount(ctx, account);
        return { status: "completed", completeness: "unknown", message: "Login identity observed." };
      }, lease), { platform, url: "https://www.xiaohongshu.com/" });
    return withBrowser(ctx, async (_browser, page) => withLoginPage(ctx,page,_browser,async ctx=>{
      await page.goto(
        platform === "douyin"
          ? "https://www.douyin.com/"
          : "https://www.xiaohongshu.com/",
        { waitUntil: "domcontentloaded" },
      );
      const waiting=ctx.controls.waitFor("finish-login",ctx.signal);void waiting.catch(()=>{});
      await ctx.emit("needs_action", {
        code: "auth_required",awaitingInput:true,
        message:
          "Sign in manually in this new dedicated browser, then choose Finish login.",
      });
      await waiting;ctx.signal.throwIfAborted();
      const account = await verifyAccount(page, ctx.request.source ?? {},undefined,ctx.signal);
      ctx.signal.throwIfAborted();await emitAccount(ctx, account);
      return {
        status: "completed",
        completeness: "unknown",
        message: "Login identity observed.",
      };
    }));
  }
  async function scan(ctx) {
    if(ctx.request.source?.kind==='saved_folder'&&platform==='xiaohongshu')return withBrowser(ctx,async(_browser,page)=>scanXhsFolderMembers(page,{source:ctx.request.source,signal:ctx.signal,emit:ctx.emit,verifyAccount:({signal})=>verifyAccount(page,ctx.request.source,ctx.request.source.accountId,signal)}));
    if(['saved_folder','saved_folders'].includes(ctx.request.source?.kind))return action(ctx,new ActionRequired('folder_members_unavailable','This saved-folder operation is not supported by the member scanner.'));
    return withBrowser(ctx, async (_browser, page) => {
      let source = await resolveSource(page, ctx.request.source, {
        signal: ctx.signal,
      });
      if (!needsIdentity(source))
        return scanPage(page, { source, signal: ctx.signal, emit: ctx.emit,diagnostics:ctx.diagnostics });
      const account = await verifyAccount(page, source,undefined,ctx.signal);
      const expectedFingerprint=await sessionFingerprint(_browser,platform);
      if(!expectedFingerprint)throw new ActionRequired('auth_required','The bound session cookie is missing.');
      if(privateList(source) && sourceIdentity(source).subject!==account.accountId)
        throw new ActionRequired('input_required','The requested private profile does not match the verified account.');
      await emitAccount(ctx,account);
      source={...source,accountId:account.accountId};
      const result=await scanPage(page,{
        source,signal:ctx.signal,emit:ctx.emit,diagnostics:ctx.diagnostics,
        beforePublish:({signal})=>passiveCheck(page,expectedFingerprint,signal),
        beforeFinish:async({signal})=>{await passiveCheck(page,expectedFingerprint,signal);return verifyAccount(page,source,account.accountId,signal);},
        prepare:async({signal,waitForManual})=>{
          if(privateList(source) && sourceIdentity({...source,url:page.url()}).subject!==account.accountId)
            throw new ActionRequired('input_required','The requested private profile does not match the verified account.');
          if(!privateList(source) || await prepareSourceTab(page,platform,source.kind,{signal}))return;
          // Auto-discovery is finite; one explicit manual continuation keeps the
          // dedicated page open under its own finite manual/cancel lifetime.
          const local=new AbortController();
          const waitingSignal=AbortSignal.any([signal,local.signal]);
          const closed=()=>local.abort(new ActionRequired('browser_closed','The dedicated browser was closed. Start a new scan manually.'));
          page.on('close',closed);page.on('crash',closed);_browser.on('close',closed);
          try {
            if(page.isClosed())closed();
            waitingSignal.throwIfAborted();
            await waitForManual(async manualSignal=>{
              const signal=AbortSignal.any([manualSignal,local.signal]);
              const waiting=ctx.controls.waitFor('continue',signal);
              void waiting.catch(()=>{});
              await bounded(()=>ctx.emit('needs_action',{
                code:'source_tab_required',awaitingInput:true,
                message:'Select the requested saved/liked tab in the dedicated browser, then Continue.',
              }),signal,5000,'item_delivery_failed');
              await waiting;signal.throwIfAborted();
            });
            waitingSignal.throwIfAborted();
            await verifyAccount(page,source,account.accountId,waitingSignal);
            const state=await bounded(()=>tabSnapshot(page,platform,source.kind),waitingSignal,3000);
            waitingSignal.throwIfAborted();
            if(sourceIdentity({...source,url:state.url}).subject!==account.accountId || !state.selected)
              throw new ActionRequired('source_tab_required','The requested account and tab are still unverified after Continue. Automatic scanning stopped.');
          } finally {
            page.off('close',closed);page.off('crash',closed);_browser.off('close',closed);
            local.abort(new Error('manual_preparation_retired'));
          }
        },
      });
      return result;
    });
  }
  async function download(ctx) {
    const folderDownload=platform==='xiaohongshu'&&ctx.request.source?.kind==='saved_folder';
    if(!folderDownload&&['saved_folder','saved_folders'].includes(ctx.request.source?.kind))return action(ctx,new ActionRequired('folder_members_unavailable','Saved-folder member operations are not yet supported.'));
    const source = ctx.request.source ?? { platform, kind: "single" };
    const bridge=platform==='douyin'&&source.kind==='bridge';
    const selected = (ctx.request.items ?? []).filter(
      (item) =>
        item.selected !== false &&
        (bridge || !(item.mediaResolved && item.media?.length === 0)),
    );
    if (!selected.length)
      return { status: "completed", completeness: "unknown" };
    const unresolved=bridge?new Set(selected.filter(item=>!item.mediaResolved||!item.media?.length)):new Set();
    let browser,
      page,
      failed = false,
      boundAccount,expectedFingerprint,requestHeaders=bridge?{referer:'https://www.douyin.com/','user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'}:undefined;
    const members=new Map();
    const ensureBrowser = async () => {
      browser ??= await open(ctx.paths ?? ctx.request.paths, platform, {
        signal: ctx.signal,
      });
      page ??= browser.pages()[0] ?? (await browser.newPage());
    };
    const checkBound = async () => {
      if (boundAccount) await passiveCheck(page,expectedFingerprint,ctx.signal);
    };
    const initialOrPassive=async({signal})=>{
      if(expectedFingerprint!==undefined){await passiveCheck(page,expectedFingerprint,signal);return {accountId:boundAccount};}
      const account=await verifyAccount(page,source,source.accountId,signal);
      expectedFingerprint=await sessionFingerprint(browser,platform);signal?.throwIfAborted();
      if(!expectedFingerprint)throw new ActionRequired('auth_required','The bound session cookie is missing.');
      boundAccount=account.accountId;return account;
    };
    async function resolveItem(item) {
      // Missing signed sources are never replaced by a guessed URL.
      if (
        platform === "xiaohongshu" &&
        !new URL(item.sourceUrl).searchParams.get("xsec_token") &&
        !["xhslink.com", "www.xhslink.com"].includes(
          new URL(item.sourceUrl).hostname,
        )
      )
        throw new ActionRequired(
          "input_required",
          "The selected note needs a fresh signed source. Rescan its original collection.",
        );
      await ensureBrowser();
      const detailSource = await resolveSource(
        page,
        { platform, kind: "single", url: item.sourceUrl },
        { signal: ctx.signal },
      );
      if (sourceIdentity(detailSource).work !== item.contentId)
        throw new ActionRequired(
          "input_required",
          "The selected source no longer resolves to the selected work.",
        );
      let resolved;
      const result = await scanPage(page, {
        diagnostics:ctx.diagnostics,
        source: detailSource,
        signal: ctx.signal,
        emit: async (type, payload) => {
          if (type === "item" && payload.item.contentId === item.contentId)
            resolved = payload.item;
          else if (type === "needs_action")
            throw new ActionRequired(payload.code, payload.message);
          else await ctx.emit(type, payload);
        },
      });
      if (!resolved?.mediaResolved || result.status !== "completed")
        throw new ActionRequired(
          "input_required",
          "Selected detail could not be verified after normal navigation. Manual source refresh is required.",
        );
      await checkBound();
      const resultItem = applyMediaSelection(item, resolved);
      await ctx.emit("item", { item: resultItem });
      return resultItem;
    }
    async function transfer(item, asset,attempt=1) {
      if(!requestHeaders){
        await ensureBrowser();
        // BrowserContext owns this dedicated page. Version is read from its
        // Browser when available; the actual navigator UA is sent unchanged.
        browser.browser?.()?.version();
        const userAgent=await page.evaluate(()=>navigator.userAgent);ctx.signal.throwIfAborted();
        requestHeaders={referer:platform==='douyin'?'https://www.douyin.com/':'https://www.xiaohongshu.com/','user-agent':userAgent};
      }
      await checkBound();
      return transferAsset({
        root: ctx.request.paths.downloadRoot,
        category: ctx.request.paths.category,
        folder: ctx.request.paths.folder,
        dataRoot: ctx.request.paths.dataRoot,
        item,
        asset,
        signal: ctx.signal,
        cookies: browser ? await browser.cookies() : [],
        ...(bridge?{allowedUrl:safeBridgeMedia}:{}),
        requestHeaders,diagnostics:ctx.diagnostics,attempt,
        onProgress: (bytes) => {
          ctx.signal.throwIfAborted();
          return ctx.emit("progress", { phase: "download", bytes });
        },
      });
    }
    try {
      // Check the entire explicit selection before the first transfer.
      if(bridge)for(const item of selected)if(item.platform!==platform)throw new Error('wrong_platform');
      if(folderDownload){
        for(const item of selected)if(item.platform!==platform)throw new Error('wrong_platform');
        await ensureBrowser();
        // This is a bounded membership snapshot at download start. The complete
        // selected set must pass before any detail navigation or transfer.
        const result=await scanXhsFolderMembers(page,{
          source:{...source,maxItems:50},signal:ctx.signal,
          verifyAccount:initialOrPassive,
          emit:async(type,payload)=>{
            ctx.signal.throwIfAborted();
            if(type==='item')members.set(payload.item.contentId,payload.item);
            else if(type==='account'||type==='needs_action')await ctx.emit(type,payload);
          },
        });
        ctx.signal.throwIfAborted();
        if(result.status!=='completed')return result;
        if(selected.some(item=>!members.has(item.contentId)))
          throw new ActionRequired('folder_unverified','Not every selected note could be verified in the finite current board snapshot. Rescan the selected board.');
        boundAccount=source.accountId;
      }else if (!bridge&&needsIdentity(source)) {
        if (!source.accountId)
          throw new ActionRequired(
            "auth_required",
            "This private download has no verified account binding. Rescan its source before downloading.",
          );
        await ensureBrowser();
        const identitySource = await resolveSource(page, source, {
          signal: ctx.signal,
        });
        await page.goto(identitySource.url, { waitUntil: "domcontentloaded" });
        const account = await initialOrPassive({signal:ctx.signal});
        if (
          privateList(source) &&
          sourceIdentity({ ...source, url: page.url() }).subject !==
            account.accountId
        )
          throw new ActionRequired(
            "input_required",
            "The private download source does not match the bound account.",
          );
        boundAccount = account.accountId;
        await emitAccount(ctx, account);
      }
      for (let item of selected) {
        ctx.signal.throwIfAborted();
        if (item.platform !== platform) throw new Error("wrong_platform");
        if(unresolved.has(item))continue;
        if(bridge&&(!item.mediaResolved||!item.media?.length||item.media.some(a=>!safeBridgeMedia(a.url))))throw new ActionRequired('bridge_refresh_required','请在 Edge 打开原页面，用桥接脚本重新发送这些作品。');
        if(folderDownload)item={...item,sourceUrl:members.get(item.contentId).sourceUrl};
        if (
          folderDownload ||
          !item.mediaResolved ||
          !item.media?.length ||
          item.media.some((asset) => !asset.url)
        )
          item = await resolveItem(item);
        const allowedIndices = item.media.map((asset) => asset.index);
        let refreshed = false;
        for (const index of allowedIndices) {
          let asset = item.media.find((asset) => asset.index === index);
          try {
            let receipt;
            try {
              receipt = await transfer(item, asset);
            } catch (error) {
              if (ctx.signal.aborted) throw error;
              if (error.httpStatus === 429)
                throw new ActionRequired(
                  "rate_limited",
                  "The media server is rate limiting requests. Automatic transfers have stopped.",
                );
              if (error.httpStatus === 401)
                throw new ActionRequired(
                  "auth_required",
                  "The selected media requires renewed authentication.",
                );
              if (![403, 410].includes(error.httpStatus)) throw error;
              if(bridge)throw new ActionRequired('bridge_refresh_required','请在 Edge 打开原页面，用桥接脚本重新发送这些作品。');
              if (refreshed)
                throw new ActionRequired(
                  "media_forbidden",
                  "The refreshed media remains unavailable. Check account permissions manually.",
                );
              refreshed = true;
              // Exactly one detail refresh per selected work. applyMediaSelection
              // retains only the explicit pending mask, including resumed galleries.
              item = await resolveItem(item);
              asset = item.media.find((asset) => asset.index === index);
              try {
                receipt = await transfer(item, asset,2);
              } catch (retryError) {
                if ([403, 410].includes(retryError.httpStatus))
                  throw new ActionRequired(
                    "media_forbidden",
                    "The refreshed media remains unavailable. Check account permissions manually.",
                  );
                if(retryError.httpStatus===401)throw new ActionRequired('auth_required','The selected media requires renewed authentication.');
                if (retryError.httpStatus === 429)
                  throw new ActionRequired(
                    "rate_limited",
                    "The media server is rate limiting requests.",
                  );
                throw retryError;
              }
            }
            ctx.signal.throwIfAborted();
            await ctx.emit("receipt", { receipt });
          } catch (error) {
            if(diskFull(error))throw new ActionRequired("disk_full", "磁盘空间不足，已停止任务。");
            if(error.message==="storage_budget")throw new ActionRequired("storage_budget","媒体超过有限空间预算。");
            if (ctx.signal.aborted || error instanceof ActionRequired)
              throw error;
            failed = true;
            await ctx.emit("receipt", {
              receipt: {
                contentKey: item.key ?? `${platform}:${item.contentId}`,
                mediaIndex: index,
                filePath: "",
                bytes: 0,
                sha256: "",
                status: "failed",
                errorCode:
                  error.message === "file_conflict"
                    ? "file_conflict"
                    : "transfer_failed",
                message:
                  error.message === "file_conflict"
                    ? "A different file exists at the destination and was preserved."
                    : "The selected media failed transfer verification.",
              },
            });
          }
        }
      }
      if(boundAccount){await checkBound();await verifyAccount(page,source,boundAccount,ctx.signal);ctx.signal.throwIfAborted();}
      if(unresolved.size)return {...await action(ctx,new ActionRequired('bridge_refresh_required',`已跳过 ${unresolved.size} 个未解析作品；其余勾选项已处理。请在 Edge 重新发送跳过的作品，已完成文件保留。`)),skippedCount:unresolved.size};
      return {
        status: failed ? "failed" : "completed",
        completeness: "unknown",
      };
    } catch (error) {
      ctx.signal.throwIfAborted();
      if (error instanceof ActionRequired) return action(ctx, error);
      throw error;
    } finally {
      try{await closeIdentity(browser);}finally{await browser?.close();}
    }
  }
  async function listFolders(ctx){
    if(!['douyin','xiaohongshu'].includes(platform))return action(ctx,new ActionRequired('folder_unverified','Saved-folder directory discovery is not supported on this platform.'));
    const source=ctx.request.source;
    if(source?.kind!=='saved_folders'||!source.accountId||source.folderId!=null)return action(ctx,new ActionRequired('input_required','Choose an account-bound folder directory source.'));
    return withBrowser(ctx,async(_browser,page)=>{
      const list=platform==='douyin'?listDouyinFolders:listXhsFolders;
      return list(page,{source,signal:ctx.signal,emit:ctx.emit,verifyAccount:({signal})=>verifyAccount(page,source,source.accountId,signal)});
    });
  }
  return { login, scan, download, listFolders };
}
