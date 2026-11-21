import './fixtures/offline-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
const p=await import('../src/shared/paths.mjs');
const item={platform:'douyin',contentId:'7300000000000000001',author:'作者A',title:'春天 的花',createdAt:'2026-03-01T02:00:00Z'};
test('readable layout includes category, author, date, title, id and media index',()=>{
 assert.equal(p.relativeMediaPath(item,{index:1,extension:'mp4'},{category:'风景'}),path.join('风景','douyin','作者A','2026-03-01_春天 的花_7300000000000000001','01.mp4'));
 assert.equal(p.relativeMediaPath({...item,createdAt:'not a date'},{index:104,extension:'..exe'},{category:''}),path.join('douyin','作者A','无日期_春天 的花_7300000000000000001','104.exe'));
});
test('degenerate titles produce valid stable paths',()=>{
 for(const title of ['<>:"/\\|?*','   ','CON','con.txt','😀'.repeat(60),'a'.repeat(500),'end...','COM9.txt','\u0085']){
  const a=p.relativeMediaPath({platform:'x',contentId:'1',title},{index:1,extension:'jpg'});
  assert.equal(a,p.relativeMediaPath({platform:'x',contentId:'1',title},{index:1,extension:'jpg'}));
  for(const seg of a.split(path.sep)){assert.doesNotMatch(seg,/[<>:"/\\|?*\x00-\x1f\x7f-\x9f]|[ .]$/);assert.doesNotMatch(seg,/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i);}
 }
 assert.equal(typeof p.safeSegment,'function');assert.equal(p.safeSegment('😀'.repeat(60),40,'fallback'),'😀'.repeat(40));
 assert.equal(p.safeSegment(' con.txt ',40,'fallback'),'_con.txt');assert.equal(p.safeSegment('<>:"/\\|?*',40,'fallback'),'fallback');
});
test('long root shortens title then author before failing',()=>{
 const root=path.join('G:\\','r'.repeat(175));
 const relative=p.relativeMediaPath({platform:'x',contentId:'1',author:'a'.repeat(40),title:'t'.repeat(40),createdAt:'2026-03-01T02:00:00Z'},{index:1,extension:'jpg'},{root});
 assert.ok(path.join(root,relative).length<=240);assert.equal(relative.split(path.sep)[1],'a'.repeat(10));assert.equal(relative.split(path.sep)[2],'2026-03-01_'+ 't'.repeat(10)+'_1');
 assert.throws(()=>p.relativeMediaPath(item,{index:1,extension:'mp4'},{root:path.join('G:\\','r'.repeat(235))}),/path_too_long/);
});
test('invalid category is rejected without silently renaming it',()=>{
 assert.equal(typeof p.validCategory,'function');
 for(const category of ['a\\b','a/b','..','CON','x:y','x.',' space','😀'.repeat(41),null,1])assert.throws(()=>p.validCategory(category),/invalid_category/);
 assert.equal(p.validCategory(''),'');assert.equal(p.validCategory(undefined),'');assert.equal(p.validCategory('风景😀'),'风景😀');assert.equal(p.validCategory('😀'.repeat(40)),'😀'.repeat(40));
});
// Like the standalone Telegram tool: one folder per chat, file names sort by send time (local clock).
test('telegram files go into one folder per chat, named by send time then message ID',()=>{
 const sent=new Date(2026,9,4,10,21,0).toISOString();
 assert.equal(p.relativeMediaPath({platform:'telegram',chatId:'channel_7',messageId:'9',author:'kestrel',createdAt:sent},{index:1,extension:'MOV'}),path.join('telegram','kestrel_channel_7','20261004_102100_9.mov'));
 assert.equal(p.relativeMediaPath({platform:'telegram',chatId:'channel_7',messageId:'9',createdAt:sent},{index:1,extension:'jpg'}),path.join('telegram','channel_7','20261004_102100_9.jpg'));
 assert.equal(p.relativeMediaPath({platform:'telegram',chatId:'user_8',messageId:'12',author:'a/b:c'},{index:1,extension:'jpg'}),path.join('telegram','a_b_c_user_8','无日期_12.jpg'));
 assert.equal(p.relativeMediaPath({platform:'telegram',chatId:'channel_7',messageId:'9',author:'kestrel',createdAt:sent},{index:2,extension:'jpg'}),path.join('telegram','kestrel_channel_7','20261004_102100_9_02.jpg'));
 const names=[[2026,9,4,10,21,0,'3'],[2026,9,4,9,0,0,'20'],[2026,9,10,0,0,0,'1']].map(([y,m,d,h,mi,s,id])=>path.basename(p.relativeMediaPath({platform:'telegram',chatId:'channel_7',messageId:id,createdAt:new Date(y,m,d,h,mi,s).toISOString()},{index:1,extension:'jpg'})));
 assert.deepEqual([...names].sort(),[names[1],names[0],names[2]]);
});
test('protocol validates the category before accepting a request',async()=>{
 const {validateRequest}=await import('../src/shared/protocol.mjs');
 const request={version:1,requestId:'category',operation:'scan',source:{platform:'x',kind:'single',url:'https://x.com/a/status/1'},paths:{dataRoot:path.resolve('data'),downloadRoot:path.resolve('media'),engineRoot:path.resolve('engines'),browserExecutable:process.execPath}};
 assert.doesNotThrow(()=>validateRequest({...request,paths:{...request.paths,category:'风景'}}));
 assert.throws(()=>validateRequest({...request,paths:{...request.paths,category:'../escape'}}),/invalid_category/);
});
// One folder per download task: every file of the task flat in it, names sort by publish time.
test('task folder layout puts all files of one download in one folder, sorted by publish time',()=>{
 const at=new Date(2026,2,1,10,5,9).toISOString();
 assert.equal(p.relativeMediaPath({...item,createdAt:at},{index:1,extension:'MP4'},{category:'风景',folder:'我的喜欢_小号_2026-11-19_2005'}),path.join('风景','douyin','我的喜欢_小号_2026-11-19_2005','2026-03-01_100509_作者A_春天 的花_7300000000000000001_01.mp4'));
 assert.equal(p.relativeMediaPath({...item,createdAt:'bad'},{index:2,extension:'jpg'},{folder:'f'}),path.join('douyin','f','无日期_作者A_春天 的花_7300000000000000001_02.jpg'));
 assert.equal(p.relativeMediaPath({platform:'telegram',chatId:'channel_7',messageId:'9',author:'kestrel',createdAt:at},{index:2,extension:'jpg'},{folder:'聊天_kestrel_2026-11-19_2005'}),path.join('telegram','聊天_kestrel_2026-11-19_2005','2026-03-01_100509_9_02.jpg'));
 const names=[[2026,2,1,10],[2025,11,31,23],[2026,2,1,9]].map(([y,m,d,h],i)=>path.basename(p.relativeMediaPath({platform:'x',contentId:String(i+1),author:'b'.repeat(3-i),title:'t',createdAt:new Date(y,m,d,h).toISOString()},{index:1,extension:'jpg'},{folder:'f'})));
 assert.deepEqual([...names].sort(),[names[1],names[2],names[0]]);
 assert.equal(p.relativeMediaPath(item,{index:1,extension:'mp4'},{folder:''}),path.join('douyin','作者A','2026-03-01_春天 的花_7300000000000000001','01.mp4'));
 for(const folder of ['a\\b','a/b','..','CON',' x','x.','😀'.repeat(81),1])assert.throws(()=>p.relativeMediaPath(item,{index:1,extension:'mp4'},{folder}),/invalid_folder/,String(folder));
 const root=path.join('G:\\','r'.repeat(120));
 const long=p.relativeMediaPath({platform:'x',contentId:'1',author:'a'.repeat(40),title:'t'.repeat(40),createdAt:at},{index:1,extension:'jpg'},{root,folder:'f'.repeat(40)});
 assert.ok(path.join(root,long).length<=240);assert.equal(path.basename(long),'2026-03-01_100509_'+'a'.repeat(10)+'_'+'t'.repeat(10)+'_1_01.jpg');
});
