import {ActionRequired} from './source-resolution.mjs';

// Own only this attempt's listeners/waiters. A closed page never restarts itself.
export async function withLoginPage(ctx,page,browser,operation){
 const local=new AbortController();let closed=false;
 const closing=()=>{closed=true;local.abort(new ActionRequired('browser_closed','登录窗口已关闭，请手动重新发起登录。'));};
 const signal=ctx.signal?AbortSignal.any([ctx.signal,local.signal]):local.signal;
 page.on('close',closing);page.on('crash',closing);browser.on('close',closing);
 let abort;
 try{
  if(page.isClosed?.())closing();signal.throwIfAborted();
  const stopped=new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});});
  return await Promise.race([operation({...ctx,signal}),stopped]);
 }catch(error){if(ctx.signal?.aborted)throw ctx.signal.reason;if(closed)throw new ActionRequired('browser_closed','登录窗口已关闭，请手动重新发起登录。');throw error;}
 finally{page.off('close',closing);page.off('crash',closing);browser.off('close',closing);signal.removeEventListener('abort',abort);local.abort(new Error('attempt_finished'));}
}
