import test from 'node:test';
import assert from 'node:assert/strict';
import {SourceControlConnections} from '../src/source-control-connections.js';
import {githubMediaFetchUrl,githubMediaFileName} from '../src/vendor/t3-github-media.js';
const source='https://github.com/user-attachments/assets/fixture-id',expires=()=>Date.now()+3600000;
function fixture(handler:(url:URL,init:RequestInit)=>Response|Promise<Response>,authenticated=true){
 const calls:{url:URL;headers:Headers}[]=[];
 const connections=new SourceControlConnections(undefined,{environment:authenticated?{GH_TOKEN:'synthetic-github-token'}:{},command:()=>null,request:async(url,init)=>{calls.push({url:new URL(String(url)),headers:new Headers(init?.headers)});return handler(new URL(String(url)),init??{});}});
 return {connections,calls,read:async(url=source,method='GET',range?:string,ifRange?:string)=>connections.githubMedia('/synthetic',url,(await connections.githubMediaIdentity('/synthetic')).fingerprint,expires(),{method,range,ifRange})};
}
test('T3 media URLs preserve fixed refs and Unicode, strip attachment query/fragment and refuse foreign origins',()=>{
 assert.equal(githubMediaFetchUrl('https://www.github.com/user-attachments/assets/abc-def?token=discard#t=1'), 'https://github.com/user-attachments/assets/abc-def');
 assert.equal(githubMediaFetchUrl('https://github.com/owner/repo/blob/abc123/path/clip.mp4?raw=1#t=2'),'https://raw.githubusercontent.com/owner/repo/abc123/path/clip.mp4');
 assert.equal(githubMediaFetchUrl('https://raw.githubusercontent.com/owner/repo/commit/clip.mp4?x=1#t=2'),'https://raw.githubusercontent.com/owner/repo/commit/clip.mp4?x=1');
 for(const url of ['http://github.com/a/b/raw/main/x.png','https://evil.test/a.png','https://github.com/a/b/issues/1','https://objects.githubusercontent.com/signed'])assert.equal(githubMediaFetchUrl(url),null);
 assert.equal(githubMediaFileName('https://raw.githubusercontent.com/a/b/main/%E4%B8%AD%2Fpic.png'),'中pic.png');
});
test('Private video ranges use GitHub authentication then a credential-free signed store, forwarding only media headers',async t=>{
 const f=fixture(url=>url.hostname==='github.com'?new Response(null,{status:302,headers:{location:'https://objects.githubusercontent.com/signed?signature=synthetic'}}):new Response('123',{status:206,headers:{'content-type':'video/mp4','content-length':'3','content-range':'bytes 1-3/10','accept-ranges':'bytes',etag:'"fixture"','last-modified':'Tue, 20 Oct 2026 00:00:00 GMT','set-cookie':'must-not-forward'}}));t.after(()=>f.connections.close());
 const response=await f.read(source,'GET','bytes=1-3','"older"');assert.equal(response.status,206);assert.equal(await response.text(),'123');
 assert.equal(f.calls[0].headers.get('authorization'),'Bearer synthetic-github-token');assert.equal(f.calls[1].headers.get('authorization'),null);
 for(const call of f.calls){assert.equal(call.headers.get('range'),'bytes=1-3');assert.equal(call.headers.get('if-range'),'"older"');assert.equal(call.headers.get('cookie'),null);assert.equal(call.headers.get('accept-encoding'),'identity');}
 assert.equal(response.headers.get('content-range'),'bytes 1-3/10');assert.equal(response.headers.get('etag'),'"fixture"');assert.equal(response.headers.get('set-cookie'),null);
});
test('Large media streams bypass JSON limits; public fallback, HEAD and SVG use the same bounded resource lifecycle',async t=>{
 const bytes=Buffer.alloc(9*1024*1024,7),f=fixture(()=>new Response(bytes,{headers:{'content-type':'video/mp4','content-length':String(bytes.length)}}),false);t.after(()=>f.connections.close());
 const response=await f.read();assert.equal((await response.arrayBuffer()).byteLength,bytes.length);assert.equal(f.calls[0].headers.get('authorization'),null);
 const head=await f.read(source,'HEAD');assert.equal(head.body,null);assert.equal(head.headers.get('content-length'),String(bytes.length));
 const svg=fixture(()=>new Response('<svg/>',{headers:{'content-type':'image/svg+xml'}}));t.after(()=>svg.connections.close());assert.match((await svg.read()).headers.get('content-security-policy')!,/sandbox/);
 for(const [extension,type] of [['bmp','image/bmp'],['tiff','image/tiff'],['heic','image/heic'],['heif','image/heif']]){
  const fallback=fixture(()=>new Response('opaque',{headers:{'content-type':'application/octet-stream'}}));t.after(()=>fallback.connections.close());
  const media=await fallback.read('https://raw.githubusercontent.com/fixture/repo/commit/image.'+extension);assert.equal(media.headers.get('content-type'),type);assert.equal(await media.text(),'opaque');
 }
});
test('HTML/login pages and upstream failures never leak a body, entity length, redirect token or cookie',async t=>{
 for(const status of [200,401,404,500]){
  const f=fixture(()=>new Response('private upstream diagnostic',{status,headers:{'content-type':'text/html','content-length':'9999','set-cookie':'secret'}}));t.after(()=>f.connections.close());
  const result=await f.read();assert.equal(result.status,status===200?415:status===500?502:status);assert.equal(await result.text(),'');assert.equal(result.headers.get('content-length'),null);assert.equal(result.headers.get('set-cookie'),null);
 }
 const f=fixture(()=>new Response(null,{status:302,headers:{location:'http://foreign.test/asset'}}));t.after(()=>f.connections.close());assert.equal((await f.read()).status,502);assert.equal(f.calls.length,1);
 const loop=fixture(()=>new Response(null,{status:302,headers:{location:source}}));t.after(()=>loop.connections.close());assert.equal((await loop.read()).status,502);assert.equal(loop.calls.length,4);
});
test('Service close aborts a live media body and client cancellation releases its stream',async()=>{
 let cancelled=0;const f=fixture(()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1]));},cancel(){cancelled++;}}),{headers:{'content-type':'audio/mpeg'}}));
 const response=await f.read(),reader=response.body!.getReader();assert.deepEqual((await reader.read()).value,new Uint8Array([1]));const pending=reader.read();await f.connections.close();await assert.rejects(pending);assert.equal(cancelled,1);
 const other=fixture(()=>new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:{'content-type':'video/mp4'}}));const second=await other.read();await second.body!.cancel();await other.connections.close();assert.equal(cancelled,2);
});
test('Service shutdown waits for the upstream reader cancellation to settle',async()=>{
 let release!:()=>void,cancelled=false,closed=false;const stopped=new Promise<void>(resolve=>{release=resolve;});
 const f=fixture(()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1]));},async cancel(){cancelled=true;await stopped;}}),{headers:{'content-type':'video/mp4'}}));
 const response=await f.read(),reader=response.body!.getReader();await reader.read();const close=f.connections.close().then(()=>{closed=true;});
 try{for(let i=0;i<50&&!cancelled;i++)await new Promise(r=>setTimeout(r,5));assert.equal(cancelled,true);assert.equal(closed,false);}finally{release();}
 await close;assert.equal(closed,true);
});
