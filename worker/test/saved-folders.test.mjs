import './fixtures/offline-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {validateRequest} from '../src/shared/protocol.mjs';
import {browserAdapter} from '../src/shared/browser-adapter.mjs';
const folders=await import('../src/shared/saved-folders.mjs').catch(()=>({}));
const source={platform:'douyin',kind:'saved_folders',url:'https://www.douyin.com/user/fixture-owner',accountId:'fixture-owner',maxItems:50};
const request=()=>({version:1,requestId:'folders-test',operation:'listFolders',source:{...source},paths:Object.fromEntries(['dataRoot','downloadRoot','browserExecutable','engineRoot'].map(k=>[k,path.resolve('synthetic',k)]))});

test('directory metadata uses string IDs, keeps equal titles separate and item count zero distinct from unknown',()=>{
 assert.equal(typeof folders.parseFolderDirectory,'function');
 const value=folders.parseFolderDirectory('{"status_code":0,"cursor":10,"has_more":0,"total_number":999,"collects_list":[{"collects_id_str":"7312345678901234567","collects_id":7312345678901234567,"collects_name":"Same","total_number":0},{"collects_id":7312345678901234568,"collects_name":"Same"}]}');
 assert.deepEqual(value,{folders:[{id:'7312345678901234567',title:'Same',itemCount:0},{id:'7312345678901234568',title:'Same',itemCount:null}],cursor:'10',hasMore:false});
});
test('directory parser refuses malformed entries and does not guess unknown pagination',()=>{
 assert.equal(typeof folders.parseFolderDirectory,'function');
 const body={status_code:0,collects_list:[],has_more:'0'};
 assert.equal(folders.parseFolderDirectory(JSON.stringify(body)).hasMore,null);
 assert.equal(folders.parseFolderDirectory(JSON.stringify(body)).cursor,null);
 for(const entry of [{collects_id_str:'1',collects_name:'a'.repeat(257)},{collects_id_str:'1',collects_id:'2',collects_name:'Mismatch'},{collects_id:1.2,collects_name:'invalid'}])assert.throws(()=>folders.parseFolderDirectory(JSON.stringify({...body,collects_list:[entry]})),/folder_schema/);
 assert.throws(()=>folders.parseFolderDirectory(JSON.stringify({...body,status_code:1})),/folder_schema/);
 assert.throws(()=>folders.parseFolderDirectory(JSON.stringify({...body,collects_list:Array(1001).fill({})})),/folder_schema/);
});
test('directory request is bound and capped; saved_folder is explicit without fallback',()=>{
 assert.equal(validateRequest(request()).operation,'listFolders');
 for(const maxItems of [0,2,51])assert.equal(validateRequest({...request(),source:{...source,maxItems}}).source.maxItems,maxItems);
 for(const patch of [{maxItems:-1},{maxItems:1.5},{accountId:null},{kind:'saved'},{kind:'profile'},{folderId:'123'},{platform:'x',url:'https://x.com/'}])assert.throws(()=>validateRequest({...request(),source:{...source,...patch}}));
 const member={...request(),operation:'scan',source:{...source,kind:'saved_folder',folderId:'7312345678901234567'}};
 assert.equal(validateRequest(member).source.folderId,'7312345678901234567');
 assert.equal(validateRequest({...member,source:{...member.source,folderId:'a'.repeat(128)}}).source.folderId.length,128);
 assert.throws(()=>validateRequest({...member,source:{...member.source,folderId:'a'.repeat(129)}}));
 for(const patch of [{folderId:''},{accountId:null},{platform:'x',url:'https://x.com/'}])assert.throws(()=>validateRequest({...member,source:{...member.source,...patch}}));
});
test('unsupported saved_folder members and directory-as-scan stop before browser launch',async()=>{
 let opened=0;const events=[];
 for(const [platform,operation,kind] of [['douyin','scan','saved_folder'],['douyin','download','saved_folder'],['douyin','scan','saved_folders']]){
  const adapter=browserAdapter(platform,{open:async()=>{opened++;throw Error('must not open');}});
  assert.equal(typeof adapter[operation],'function');
  const result=await adapter[operation]({request:{source:{...source,platform,kind,folderId:'123'}},signal:new AbortController().signal,emit:async(type,p)=>events.push({type,...p})});
  assert.equal(result.status,'needs_action');assert.equal(result.reasonCode,'folder_members_unavailable');
 }
 assert.equal(opened,0);assert.equal(events.some(e=>e.type==='item'||e.type==='folder'),false);
});
test('nonmember source cannot carry a folder ID into whole-saved or other scanners',()=>{
 for(const kind of ['saved','liked','profile','single','saved_folders']){
  const r={...request(),operation:kind==='saved_folders'?'listFolders':'scan',source:{...source,kind,folderId:'123'}};
  assert.throws(()=>validateRequest(r),/invalid_source/);
 }
});
