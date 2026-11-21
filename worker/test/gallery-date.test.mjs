import './fixtures/offline-network.mjs';import test from 'node:test';import assert from 'node:assert/strict';import {galleryItems} from '../src/shared/engine-media.mjs';
const created=date=>galleryItems(JSON.stringify([[3,'https://pbs.twimg.com/media/synthetic.jpg',{tweet_id:'123',num:1,extension:'jpg',date}]])).items[0].createdAt;
test('gallery UTC date without zone is parsed explicitly as UTC',()=>assert.equal(created('2026-11-08 12:34:56'),'2026-11-08T12:34:56.000Z'));
test('existing explicit offset date remains absolute',()=>assert.equal(created('2026-11-08T12:34:56+02:00'),'2026-11-08T10:34:56.000Z'));
for(const invalid of ['2026-02-30 12:34:56','2026-11-08T12:34:56','unknown'])test(`ambiguous or impossible gallery date stays absent: ${invalid}`,()=>assert.equal(created(invalid),undefined));
