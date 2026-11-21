import './fixtures/offline-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {fileURLToPath} from 'node:url';
test('unhandled non-loopback browser request is answered by the local deny proxy',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:fileURLToPath(new URL('../../runtime/browsers/chromium-1248/chrome-win64/chrome.exe',import.meta.url))});
 try{
  const page=await browser.newPage();
  const response=await page.goto('http://203.0.113.1/synthetic-test-only');
  assert.equal(response.status(),502);assert.equal(response.headers()['x-umh-test-offline'],'blocked');
 }finally{await browser.close();}
});
