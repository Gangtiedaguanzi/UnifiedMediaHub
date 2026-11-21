import http from 'node:http';
import {chromium} from 'playwright';

// Test-only fail-closed network boundary. Playwright route.fulfill(302) does not
// intercept the follow-up request. Deny all non-loopback traffic even if a
// fixture forgets to route a request or Chromium issues background requests.
let proxy;
async function options(input={}){
 proxy??=new Promise((resolve,reject)=>{
  const server=http.createServer((_req,res)=>{res.writeHead(502,{'x-umh-test-offline':'blocked'});res.end('Offline fixture: outbound request blocked');});
  server.on('connect',(_req,socket)=>{socket.on('error',()=>{});socket.end('HTTP/1.1 502 Offline fixture\r\nConnection: close\r\n\r\n');});
  server.on('error',reject);server.listen(0,'127.0.0.1',()=>{server.unref();resolve(`http://127.0.0.1:${server.address().port}`);});
 });
 return {...input,proxy:{server:await proxy,bypass:'localhost,127.0.0.1,[::1]'},args:[...(input.args??[]).filter(a=>!a.startsWith('--no-proxy-server')&&!a.startsWith('--proxy-')&&!a.startsWith('--host-resolver-rules=')), '--disable-background-networking','--disable-component-update','--no-first-run','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]']};
}
const launch=chromium.launch.bind(chromium),persistent=chromium.launchPersistentContext.bind(chromium);
chromium.launch=async input=>launch(await options(input));
chromium.launchPersistentContext=async(directory,input)=>persistent(directory,await options(input));
