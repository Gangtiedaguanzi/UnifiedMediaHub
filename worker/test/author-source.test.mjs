import './fixtures/offline-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDouyin,normalizeXhs} from '../src/shared/normalizers.mjs';
test('author source derives from actual author identity, never nickname or viewer',()=>{
 const dy=normalizeDouyin({aweme_id:'123',author:{sec_uid:'MS4wLjAB_author',nickname:'Display'},accountId:'viewer'});
 assert.equal(dy.authorUrl,'https://www.douyin.com/user/MS4wLjAB_author');
 assert.equal(dy.author,'Display');
 const xhs=normalizeXhs({id:'note',note_card:{user:{user_id:'realAuthor',nickname:'Display'}}});
 assert.equal(xhs.authorUrl,'https://www.xiaohongshu.com/user/profile/realAuthor');
 assert.equal(normalizeXhs({id:'note',user:{userId:'camelAuthor'}}).authorUrl,'https://www.xiaohongshu.com/user/profile/camelAuthor');
});
test('missing or malicious author IDs never fabricate a profile',()=>{
 for(const bad of [undefined,'../other','https://evil.test','a/b','name with spaces']) {
  assert.equal(normalizeDouyin({aweme_id:'123',author:{sec_uid:bad,nickname:'Use me'}}).authorUrl,undefined);
  assert.equal(normalizeXhs({id:'note',user:{user_id:bad,nickname:'Use me'}}).authorUrl,undefined);
 }
});
