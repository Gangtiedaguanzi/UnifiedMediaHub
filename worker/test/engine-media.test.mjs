import './fixtures/offline-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const n = await import('../src/shared/engine-media.mjs').catch(()=>({}));
const p = await import('../src/shared/protocol.mjs');

test('gallery manifest preserves 19 digit IDs, mixed media numbering and refuses conflicting keys',()=>{
  assert.equal(typeof n.galleryItems,'function');
  const text='[[3,"https://pbs.twimg.com/a?format=jpg&name=orig",{"tweet_id":1234567890123456789,"num":1,"extension":"jpg","author":{"name":"alice"}}],[3,"https://video.twimg.com/a.mp4",{"tweet_id":1234567890123456789,"num":2,"extension":"mp4"}]]';
  const {items}=n.galleryItems(text);
  assert.equal(items[0].key,'x:1234567890123456789');
  assert.deepEqual(items[0].media.map(x=>[x.index,x.kind]),[[1,'image'],[2,'video']]);
  assert.equal(items[0].sourceUrl,'https://x.com/i/status/1234567890123456789');
  assert.throws(()=>n.galleryItems(text.replace('"num":2','"num":1')),/conflicting_media/);
  assert.throws(()=>n.galleryItems(text.replace('https://video.twimg.com','https://evil.example')),/invalid_media_host/);
});
test('Telegram selected JSON retains typed Int64 peer and excludes unchecked messages',()=>{
  assert.equal(typeof n.telegramItems,'function');
  const root='{"id":9007199254740993,"peer_type":"channel","messages":[{"id":7,"type":"message","file":"a.jpg","raw":{"Media":{"Photo":{"Sizes":[{"Type":"x","Size":4096}]}}}},{"id":8,"type":"message","file":"b.mp4","raw":{"Media":{"Document":{"MimeType":"video/mp4","Size":20}}}}]}';
  const {items,mediaTypes}=n.telegramExport(root);
  assert.equal(items[0].chatId,'channel_9007199254740993');
  assert.equal(items[1].media[0].kind,'video');
  items[1].selected=false;
  const selected=n.telegramSelected(items,mediaTypes);
  assert.equal(selected.length,1);
  assert.match(selected[0].json,/"id":9007199254740993/);
  assert.deepEqual(JSON.parse(selected[0].json).messages,[{id:7,type:'message',photo:'selected'}]);
  assert.equal(n.telegramItems(root.replace('"channel"','"chat"'))[0].sourceUrl,'');
  assert.throws(()=>n.telegramItems(root.replace('9007199254740993','-1009007199254740993')),/invalid_peer/);
});
test('Telegram route retains exact single message and topic; rejects implicit Self and conflicting selectors',()=>{
  assert.equal(typeof n.telegramSource,'function');
  assert.deepEqual(n.telegramSource({url:'https://www.telegram.me/c/9007199254740993/23/45',kind:'single'}),{selector:'9007199254740993',peerType:'channel',messageId:'45',topicId:'23'});
  assert.equal(n.telegramSource({url:'https://t.me/name/77',kind:'single'}).messageId,'77');
  assert.equal(n.telegramSource({url:'https://t.me/',chatId:'user_7',kind:'chat'}).peerType,'user');
  assert.throws(()=>n.telegramSource({url:'https://t.me/',kind:'chat'}),/invalid_peer/);
  assert.throws(()=>n.telegramSource({url:'https://t.me/c/7/9',chatId:'chat_7',kind:'single'}),/peer_mismatch/);
  assert.throws(()=>n.telegramSource({url:'https://t.me/name/2147483648',kind:'single'}),/invalid_message/);
});
test('Telegram source-less item validation requires canonical typed peer and positive signed32 message',()=>{
  const r={version:1,requestId:'t',operation:'download',source:{platform:'telegram',kind:'chat',url:'https://t.me/',chatId:'user_7'},paths:{dataRoot:path.resolve('a'),downloadRoot:path.resolve('b'),browserExecutable:process.execPath,engineRoot:path.resolve('runtime/engines')},items:[{platform:'telegram',chatId:'user_7',messageId:'9',contentId:'9',sourceUrl:'',media:[]}]};
  assert.doesNotThrow(()=>p.validateRequest(r));
  for(const chatId of ['7','channel_0','user_9223372036854775808']) assert.throws(()=>p.validateRequest({...r,items:[{...r.items[0],chatId}]}));
  assert.throws(()=>p.validateRequest({...r,items:[{...r.items[0],messageId:'0'}]}));
});
test('X source routing rejects bookmark folder broadening and preserves photo suffix',()=>{
  assert.equal(typeof n.xSource,'function');
  assert.equal(n.xSource({url:'https://mobile.twitter.com/a/status/1234567890123456789/photo/2',kind:'single'}).mediaIndex,2);
  assert.equal(n.xSource({url:'https://x.com/i/history/likes',kind:'liked'},'9007199254740993').url,'https://x.com/id:9007199254740993/likes');
  // Verified screen name avoids X's rejected UserByRestId lookup; malformed names fall back to the id form.
  assert.equal(n.xSource({url:'https://x.com/i/likes',kind:'liked'},'9007199254740993','alice_1').url,'https://x.com/alice_1/likes');
  assert.equal(n.xSource({url:'https://x.com/id:9007199254740993/likes',kind:'liked'},'9007199254740993','alice_1').url,'https://x.com/alice_1/likes');
  assert.equal(n.xSource({url:'https://x.com/i/likes',kind:'liked'},'9007199254740993','../evil').url,'https://x.com/id:9007199254740993/likes');
  assert.equal(n.xSource({url:'https://x.com/i/likes',kind:'liked'},'9007199254740993','home').url,'https://x.com/id:9007199254740993/likes');
  assert.throws(()=>n.xSource({url:'https://x.com/i/bookmarks/123',kind:'saved'}),/unsupported_bookmark_folder/);
});
test('Telegram Bot API channel selector is canonicalized without forwarding negative peer IDs',()=>{
  assert.deepEqual(n.telegramSource({url:'https://t.me/',kind:'chat',chatId:'-1009007199254740993'}),{selector:'9007199254740993',peerType:'channel'});
});
test('Telegram typed identity validation also applies when a public SourceUrl is present',()=>{
 const r={version:1,requestId:'t',operation:'download',source:{platform:'telegram',kind:'chat',url:'https://t.me/example'},paths:{dataRoot:path.resolve('a'),downloadRoot:path.resolve('b'),browserExecutable:process.execPath,engineRoot:path.resolve('runtime/engines')},items:[{platform:'telegram',chatId:'7',messageId:'9',contentId:'9',sourceUrl:'https://t.me/example/9',media:[]}]};
 assert.throws(()=>p.validateRequest(r),/invalid_identity/);
});
test('lossless parser rejects unsafe exponent token rather than materializing a rounded ID',async()=>{
 const {parseLossless}=await import('../src/shared/json.mjs');
 assert.equal(parseLossless('{"x":-1009007199254740993}').x,'-1009007199254740993');
 assert.throws(()=>parseLossless('{"x":1e19}'),/unsafe_numeric_token/);
});
test('gallery ID normalization supports full unsigned64 without widening Telegram signed64 peers',()=>{
 const {items}=n.galleryItems('[[3,"https://pbs.twimg.com/a.jpg",{"tweet_id":18446744073709551615,"num":1,"extension":"jpg"}]]');assert.equal(items[0].contentId,'18446744073709551615');assert.throws(()=>n.typedPeer('channel_18446744073709551615'),/invalid_peer/);
});
test('X author profile comes only from extractor handle, never nickname or bound account',()=>{
 const manifest=author=>'[[3,"https://pbs.twimg.com/a.jpg",{"tweet_id":1234567890123456789,"num":1,"extension":"jpg","author":'+JSON.stringify(author)+'}]]';
 assert.equal(n.galleryItems(manifest({name:'real_handle',nick:'Display Name'})).items[0].authorUrl,'https://x.com/real_handle');
 assert.equal(n.galleryItems(manifest({nick:'Fake_Handle'})).items[0].authorUrl,undefined);
 assert.equal(n.galleryItems(manifest({name:'evil.example/path',nick:'Display'})).items[0].authorUrl,undefined);
});
test('obsolete type 4 rows are ignored',()=>{
 const r=n.galleryItems('[[4,"https://x.com/queue",{}],[3,"https://pbs.twimg.com/a.jpg",{"tweet_id":1234567890123456789,"num":1,"extension":"jpg"}]]');assert.equal(r.items[0].mediaResolved,true);assert.equal(r.queued,0);assert.deepEqual(r.errors,[]);
});
test('X preview requests a small image variant and leaves original transfer URL intact',()=>{
 const item=n.galleryItems('[[3,"https://pbs.twimg.com/media/fixture?format=jpg&name=orig",{"tweet_id":1234567890123456789,"num":1,"extension":"jpg"}]]').items[0];assert.equal(item.thumbnailUrl,'https://pbs.twimg.com/media/fixture?format=jpg&name=small');assert.equal(item.media[0].url,'https://pbs.twimg.com/media/fixture?format=jpg&name=orig');
});
test('gallery error rows are returned, not dropped',()=>{
 const r=n.galleryItems('[[-1,{"error":"AuthRequired","message":"NSFW Tweet"}]]');
 assert.deepEqual(r.items,[]);assert.deepEqual(r.errors,[{type:'AuthRequired',message:'NSFW Tweet'}]);assert.equal(r.queued,0);
});
test('gallery queue rows (type 6) are counted',()=>{
 const r=n.galleryItems('[[6,"https://x.com/i/cards/1",{}],[6,"https://example.invalid",{}]]');
 assert.equal(r.items.length,0);assert.equal(r.queued,2);assert.deepEqual(r.errors,[]);
});
test('media followed by an error keeps both',()=>{
 const r=n.galleryItems('[[3,"https://pbs.twimg.com/a.jpg",{"tweet_id":1234567890123456789,"num":1,"extension":"jpg"}],[-1,{"error":"AbortExtraction","message":"Rate limit exceeded"}]]');
 assert.equal(r.items.length,1);assert.equal(r.items[0].mediaResolved,true);assert.equal(r.errors[0].type,'AbortExtraction');
});
test('error type outside identifier pattern becomes Unknown and messages are bounded',()=>{
 for(const type of ['a.b<script>','a'.repeat(65),'',null,7]){
  const r=n.galleryItems(JSON.stringify([[-1,{error:type,message:'x'.repeat(400)}]]));
  assert.deepEqual(r.errors,[{type:'Unknown',message:'x'.repeat(300)}]);
 }
});
test('Telegram classifier username markers remain public selectors and URL thread agrees with explicit source',()=>{
 assert.deepEqual(n.telegramSource({kind:'single',url:'https://t.me/PublicName/45?thread=23',chatId:'publicname',messageId:'45',topicId:'23'}),{selector:'PublicName',messageId:'45',topicId:'23'});
 assert.throws(()=>n.telegramSource({kind:'single',url:'https://t.me/PublicName/45?thread=23',chatId:'publicname',topicId:'24'}),/peer_mismatch/);
 assert.throws(()=>n.telegramSource({kind:'single',url:'https://t.me/PublicName/45',chatId:'differentname'}),/invalid_peer/);
});
test('Telegram ordinary and progressive photo sizes match tdl final-entry choice exactly',()=>{
 const photo=sizes=>' {"id":7,"peer_type":"channel","messages":[{"id":9,"type":"message","file":"photo.jpg","raw":{"Media":{"Photo":{"Sizes":'+JSON.stringify(sizes)+'}}}}]}';
 const ordinary=n.telegramItems(photo([{Type:'x',Size:8192},{Type:'y',Size:4096}]))[0];assert.equal(ordinary.mediaResolved,true);assert.equal(ordinary.media[0].expectedBytes,4096);
 const progressive=n.telegramItems(photo([{Type:'x',Size:8192},{Type:'y',Sizes:[512,1024,4096]}]))[0];assert.equal(progressive.media[0].expectedBytes,4096);
 for(const sizes of [[],[{Type:'i',Bytes:'AQ4oAAAA'}],[{Type:'x',Size:0}],[{Type:'x',Size:-1}],[{Type:'x',Size:1.5}],[{Type:'x',Size:2147483648}],[{Type:'x',Sizes:[]}],[{Type:'x',Sizes:[4096,0]}],[{Type:'x',Sizes:[4096,1024]}]]){const item=n.telegramItems(photo(sizes))[0];assert.equal(item.mediaResolved,false);assert.deepEqual(item.media,[]);}
});
test('Telegram selected JSON keeps explicit photo versus image document despite equal byte sizes',()=>{
 assert.equal(typeof n.telegramExport,'function');
 const {items,mediaTypes}=n.telegramExport('{"id":7,"peer_type":"channel","messages":[{"id":9,"type":"message","raw":{"Media":{"Photo":{"Sizes":[{"Type":"x","Size":4096}]}}}},{"id":10,"type":"message","file":"document.jpg","raw":{"Media":{"Document":{"MimeType":"image/jpeg","Size":4096}}}}]}');
 assert.deepEqual(JSON.parse(n.telegramSelected(items,mediaTypes)[0].json).messages,[{id:9,type:'message',photo:'selected'},{id:10,type:'message',file:'selected'}]);
 assert.throws(()=>n.telegramSelected(items),/invalid_selection/);
});
test('Telegram messages with unsupported media are listed unchecked; photos stay checked',async()=>{
 const n=await import('../src/shared/engine-media.mjs');
 const text=JSON.stringify({id:7,peer_type:'user',messages:[
  {id:1,file:'a.pdf',raw:{Media:{Document:{MimeType:'application/pdf',Size:10}}}},
  {id:2,file:'b.ogg',raw:{Media:{Document:{MimeType:'audio/ogg',Size:10}}}},
  {id:3,file:'c.mp4',raw:{Media:{Document:{MimeType:'video/mp4',Size:10}}}}]});
 const items=n.telegramExport(text).items;
 assert.deepEqual(items.map(i=>[i.messageId,i.mediaResolved,i.selected]),[['1',false,false],['2',false,false],['3',true,true]]);
});
test('Telegram items carry the chat title as author so files land in a per-chat folder',async()=>{
 const n=await import('../src/shared/engine-media.mjs');
 const text=JSON.stringify({id:7,peer_type:'user',messages:[{id:3,file:'c.mp4',raw:{Media:{Document:{MimeType:'video/mp4',Size:10}}}}]});
 assert.equal(n.telegramExport(text,{chatTitle:'kestrel'}).items[0].author,'kestrel');
 assert.equal(n.telegramExport(text).items[0].author,'');
 assert.equal([...n.telegramExport(text,{chatTitle:'x'.repeat(300)}).items[0].author].length,200);
});
test('an X media row the program cannot save is skipped and counted instead of failing the list',()=>{
 const {items,skipped}=n.galleryItems('[[3,"https://video.twimg.com/live.m3u8",{"tweet_id":1,"num":1,"extension":"m3u8"}],[3,"https://pbs.twimg.com/a.jpg",{"tweet_id":2,"num":1,"extension":"jpg"}],[3,"https://pbs.twimg.com/b.jpg",{"tweet_id":3,"num":900,"extension":"jpg"}]]');
 assert.deepEqual(items.map(i=>i.contentId),['2']);assert.deepEqual(skipped,['m3u8','jpg']);
});
