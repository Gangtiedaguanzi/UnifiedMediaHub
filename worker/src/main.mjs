import {diskFull} from './shared/storage-budget.mjs';
import {DiagnosticCollector} from './shared/diagnostics.mjs';
import { StringDecoder } from "node:string_decoder";
import {
  validateRequest,
  Controls,
  eventWriter,
  MAX_LINE,
} from "./shared/protocol.mjs";
const abort = new AbortController(),
  controls = new Controls();
const MAX_REQUEST = 16 * 1024 * 1024;
let protocolFailed = false;
let request,
  emit,
  started = false,
  finished = false,
  buffer = "";
const decoder = new StringDecoder("utf8");
const diagnostics=new DiagnosticCollector();let diagnosticsSent=false;
async function sendDiagnostics(){if(diagnosticsSent||!emit)return;diagnosticsSent=true;await diagnostics.settle();diagnostics.close();for(const diagnostic of diagnostics.snapshot())await emit('diagnostic',{diagnostic});}
async function finish(payload) {
  if (finished) return;
  finished = true;
  await sendDiagnostics();
  await emit?.("complete", payload);
  controls.close();
  process.stdin.pause();
}
async function start(input) {
  try {
    request = validateRequest(input);
    emit = eventWriter(process.stdout, request.requestId,{allowBridgeItems:request.operation==='importBridge'&&request.source.kind==='bridge'&&request.source.platform==='douyin'});
    diagnostics.add({operationStarted:true});
    // The host owns the data-root mutex and has settled the previous owned Job.
    // Recovery is explicit-operation-only; idle GUI launch never starts this worker.
    const { recoverOwnedTemps } = await import('./shared/owned-temps.mjs');
    await recoverOwnedTemps(request.paths.dataRoot);
    const { adapters } = await import("./adapters/index.mjs");
    abort.signal.throwIfAborted();
    const handler = adapters[request.source.platform]?.[request.operation];
    if (!handler) throw new Error("unsupported_operation");
    const result = await handler({
      request,
      paths: request.paths,
      signal: abort.signal,
      controls,
      emit,
      diagnostics,
    });
    await finish(result ?? { status: "completed", completeness: "unknown" });
  } catch (e) {
    if (!emit) emit = eventWriter(process.stdout, "invalid");
    // Internal error codes only (lowercase identifiers from code literals); free text is dropped.
    diagnostics.add({failure:e?.message,engineCode:e?.engineCode});
    await sendDiagnostics().catch(()=>{});
    if (!abort.signal.aborted || protocolFailed)
      await emit("error", {
        code: diskFull(e)?"disk_full":e.message==="storage_budget"?"storage_budget":protocolFailed
          ? "protocol_error"
          : [
                "event_too_large",
                "event_backpressure",
                "stdout_timeout",
                "invalid_request",
                "invalid_source",
                "invalid_host",
                "invalid_paths",
                "invalid_browser_path",
                "profile_busy",
                "private_acl_failed",
                "media_selection_changed",
                "owned_temp_unconfirmed",
                "owned_temp_limit",
              ].includes(e.message)
            ? e.message
            : "operation_failed",
        message:
          "The operation failed. No credentials or source tokens are included in diagnostics.",
      }).catch(() => {});
    await finish({
      status: abort.signal.aborted && !protocolFailed ? "paused" : "failed",
      completeness: "partial",
    }).catch(() => {});
  } finally {
    controls.close();
    process.stdin.pause();
  }
}
function line(text) {
  if (!text.trim()) return;
  try {
    const parsed = JSON.parse(text);
    if (!started) {
      started = true;
      void start(parsed);
    } else {
      if (parsed.command === "cancel") abort.abort();
      controls.push(parsed);
    }
  } catch {
    protocolFailed = true;
    abort.abort();
    if (!started) {
      started = true;
      void start(null);
    }
  }
}
process.stdin.on("data", (chunk) => {
  buffer += decoder.write(chunk);
  if (
    Buffer.byteLength(buffer, "utf8") > (started ? MAX_LINE : MAX_REQUEST) &&
    !buffer.includes("\n")
  ) {
    protocolFailed = true;
    abort.abort();
    buffer = "";
    if (!started) {
      started = true;
      void start(null);
    }
    return;
  }
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const next = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (Buffer.byteLength(next, "utf8") > (started ? MAX_LINE : MAX_REQUEST)) {
      protocolFailed = true;
      abort.abort();
      if (!started) {
        started = true;
        void start(null);
      }
      break;
    }
    line(next);
  }
  if (Buffer.byteLength(buffer, "utf8") > (started ? MAX_LINE : MAX_REQUEST)) {
    protocolFailed = true;
    abort.abort();
    buffer = "";
  }
});
process.stdin.on("end", () => {
  abort.abort();
  controls.close();
});
process.stdin.on("error", () => abort.abort());
process.stdout.on("error", () => abort.abort());
