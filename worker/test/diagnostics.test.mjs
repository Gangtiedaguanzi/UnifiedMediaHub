import './fixtures/offline-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const diagnostic=await import('../src/shared/diagnostics.mjs').catch(()=>({}));
test('diagnostic entries strip queries, dynamic identities, bodies and unknown fields',()=>{
 assert.equal(typeof diagnostic.DiagnosticCollector,'function');
 const c=new diagnostic.DiagnosticCollector();
 c.add({path:'https://www.douyin.com/aweme/v1/web/aweme/detail/?account=SECRET_ACCOUNT',status:200,topFields:['aweme_detail','cookie','SECRET_TITLE'],hasAwemeDetail:true,awemeType:68,imageCount:2,hasLiveVideo:true,accountId:'SECRET_ACCOUNT',title:'SECRET_TITLE',url:'https://secret.invalid/?token=SECRET_TOKEN'});
 c.add({finalPath:'https://www.douyin.com/user/SECRET_ACCOUNT?cookie=SECRET_TOKEN',unresolved:true});
 const entries=c.snapshot(),text=JSON.stringify(entries);
 for(const secret of ['?','cookie','SECRET_ACCOUNT','SECRET_TITLE','SECRET_TOKEN','secret.invalid'])assert.equal(text.includes(secret),false);
 assert.equal(entries[0].path,'/aweme/v1/web/aweme/detail/');assert.equal(entries[0].awemeType,68);assert.equal(entries[1].finalPath,'/user/:id');
});
test('diagnostic collection is bounded to 200 entries and 300 UTF8 bytes each',()=>{
 assert.equal(typeof diagnostic.DiagnosticCollector,'function');const c=new diagnostic.DiagnosticCollector();
 for(let i=0;i<1000;i++)c.add({path:'/aweme/v1/web/aweme/detail/',status:200,attempt:1,topFields:Array(1000).fill('aweme_detail'),hasAwemeDetail:true,awemeType:150,imageCount:200,hasLiveVideo:true,unresolved:true,unknown:'x'.repeat(100000)});
 const entries=c.snapshot();assert.equal(entries.length,200);for(const entry of entries)assert.ok(Buffer.byteLength(JSON.stringify(entry))<=300);
});
