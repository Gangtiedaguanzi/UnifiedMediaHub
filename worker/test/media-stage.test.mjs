import './fixtures/offline-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,rm,writeFile,readdir,access,mkdir,symlink} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const s=await import('../src/shared/media-stage.mjs').catch(()=>({}));
const run=promisify(execFile);
async function setup(t){const root=await mkdtemp(path.join(os.tmpdir(),'umh-stage-'));t.after(()=>rm(root,{recursive:true,force:true}));return {root,ctx:{paths:{dataRoot:path.join(root,'data-a'),downloadRoot:path.join(root,'downloads')},signal:new AbortController().signal}};}
test('media stage is secured on output root with data-root namespace isolation',async t=>{
 assert.equal(typeof s.withMediaStage,'function');const {root,ctx}=await setup(t);let first,second;
 await s.withMediaStage(ctx,async stage=>{first=stage;assert.equal(path.relative(ctx.paths.downloadRoot,stage).startsWith('..'),false);await writeFile(path.join(stage,'9'),'synthetic media');
  const other={...ctx,paths:{...ctx.paths,dataRoot:path.join(root,'data-b')}};
  await s.withMediaStage(other,async stage2=>{second=stage2;assert.notEqual(path.dirname(first),path.dirname(second));await access(path.join(first,'9'));});
  await access(path.join(first,'9'));assert.deepEqual(await readdir(path.dirname(second)),[]);
  if(process.platform==='win32'){
   const script='$a=[IO.Directory]::GetAccessControl($env:UMH_STAGE_TEST); [pscustomobject]@{owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;protected=$a.AreAccessRulesProtected;rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object{[pscustomobject]@{sid=$_.IdentityReference.Value;rights=[int]$_.FileSystemRights;allow=[string]$_.AccessControlType}})}|ConvertTo-Json -Compress -Depth 4';
   const result=await run('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,env:{...process.env,UMH_STAGE_TEST:path.dirname(stage)},maxBuffer:4096});
   const acl=JSON.parse(result.stdout);assert.equal(acl.owner,acl.sid);assert.equal(acl.protected,true);assert.deepEqual(acl.rules.map(x=>x.sid).sort(),[acl.sid,'S-1-5-18','S-1-5-32-544'].sort());assert.equal(acl.rules.every(x=>x.rights===2032127&&x.allow==='Allow'),true);
  }
 });
 await assert.rejects(access(first),{code:'ENOENT'});await assert.rejects(access(second),{code:'ENOENT'});
});
test('media stage cleans only its own task on failure and graceful cancellation',async t=>{
 assert.equal(typeof s.withMediaStage,'function');const {ctx}=await setup(t);let failed,cancelled;
 await assert.rejects(s.withMediaStage(ctx,async stage=>{failed=stage;await writeFile(path.join(stage,'9'),'synthetic');throw new Error('fixture_failure');}),/fixture_failure/);
 await assert.rejects(access(failed),{code:'ENOENT'});
 const abort=new AbortController();ctx.signal=abort.signal;
 await assert.rejects(s.withMediaStage(ctx,async stage=>{cancelled=stage;await writeFile(path.join(stage,'9'),'synthetic');abort.abort();}),/abort/i);
 await assert.rejects(access(cancelled),{code:'ENOENT'});
});
test('media stage refuses junction output paths before any staging write',async t=>{
 assert.equal(typeof s.withMediaStage,'function');const {root,ctx}=await setup(t);const target=path.join(root,'elsewhere');await mkdir(target);await symlink(target,ctx.paths.downloadRoot,process.platform==='win32'?'junction':'dir');
 await assert.rejects(s.withMediaStage(ctx,async()=>{throw new Error('must_not_run');}),/unsafe_link/);assert.deepEqual(await readdir(target),[]);
});
