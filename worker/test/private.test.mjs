import './fixtures/offline-network.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {securePrivateRoot} from '../src/shared/private.mjs';
const run=promisify(execFile);
async function ps(script,target){return run('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env:{...process.env,UMH_ACL_FIXTURE:target},windowsHide:true,maxBuffer:4096});}
test('existing current-user-owned private directory without WRITE_OWNER receives restricted verified DACL',async t=>{
  if(process.platform!=='win32')return t.skip('Windows DACL regression');
  const root=await mkdtemp(path.join(os.tmpdir(),'umh-private-'));const target=path.join(root,'private');await mkdir(target);
  t.after(()=>rm(root,{recursive:true,force:true}));
  await ps('$ErrorActionPreference="Stop"; $p=$env:UMH_ACL_FIXTURE; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=[IO.Directory]::GetAccessControl($p); if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw "fixture owner"}; $new=New-Object Security.AccessControl.DirectorySecurity; $new.SetAccessRuleProtection($true,$false); $r=New-Object Security.AccessControl.FileSystemAccessRule($sid,"Modify","ContainerInherit,ObjectInherit","None","Allow"); $new.AddAccessRule($r); [IO.Directory]::SetAccessControl($p,$new)',target);
  assert.equal(await securePrivateRoot(root),target);
  const result=await ps('$ErrorActionPreference="Stop"; $a=[IO.Directory]::GetAccessControl($env:UMH_ACL_FIXTURE); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; [pscustomobject]@{owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;current=$sid.Value;protect=$a.AreAccessRulesProtected;rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object { [pscustomobject]@{id=$_.IdentityReference.Value;rights=[int]$_.FileSystemRights;inherited=$_.IsInherited;type=[string]$_.AccessControlType} })} | ConvertTo-Json -Compress -Depth 4',target);
  const a=JSON.parse(result.stdout);assert.equal(a.owner,a.current);assert.equal(a.protect,true);assert.deepEqual(a.rules.map(x=>x.id).sort(),[a.current,'S-1-5-18','S-1-5-32-544'].sort());assert.equal(a.rules.every(x=>x.rights===2032127&&!x.inherited&&x.type==='Allow'),true);
});
