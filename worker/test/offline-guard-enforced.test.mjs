import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

// Deliberately no guard import: the test command must supply it. These DNS
// rules also keep the negative control offline when the preload is omitted.
test('command preload protects a browser test without a handwritten guard import',async t=>{
 const browser=await chromium.launch({headless:true,
  executablePath:fileURLToPath(new URL('../../runtime/browsers/chromium-1248/chrome-win64/chrome.exe',import.meta.url)),
  args:['--no-proxy-server','--disable-background-networking','--disable-component-update','--no-first-run','--host-resolver-rules=MAP * ~NOTFOUND']});
 try{
  const page=await browser.newPage();let response,httpFailed=false;
  try{response=await page.goto('http://example.invalid/offline-guard-proof',{timeout:5000});}catch{httpFailed=true;}
  t.diagnostic(JSON.stringify({httpFailed,status:response?.status()??null,localBlock:response?.headers()['x-umh-test-offline']??null}));
  assert.equal(response?.status(),502);
  assert.equal(response.headers()['x-umh-test-offline'],'blocked');
  let httpsBlocked=false;
  try{
   const secure=await page.goto('https://example.invalid/',{timeout:5000});
   httpsBlocked=secure?.status()===502&&secure.headers()['x-umh-test-offline']==='blocked';
  }catch{httpsBlocked=true;}
  assert.equal(httpsBlocked,true);
 }finally{await browser.close();}
});
