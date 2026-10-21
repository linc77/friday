/*
Adapted from T3 Code 8cd9641f apps/server/src/assets/GitHubMediaFetch.ts.
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/
import { taskFileMimeType } from './task-file-preview.js';
import { githubMediaFileName } from './vendor/t3-github-media.js';
import { getMimeType } from 'hono/utils/mime';

const credentialedHosts = new Set(['github.com','www.github.com','raw.githubusercontent.com','media.githubusercontent.com']);
const mediaType = /^(?:image|audio|video)\/[\w!#$&^.+-]+$/i;
const responseHeaders = ['content-length','content-range','accept-ranges','etag','last-modified'];
export type GitHubMediaRequest = { method: string; range?: string; ifRange?: string; signal?: AbortSignal };
/** Only GitHub's credentialed hosts receive the GitHub token. Redirected signed
 * stores authorize themselves; no incoming Friday credential or cookie is sent. */
export async function githubMediaResponse(url: string, token: string | null, request: GitHubMediaRequest,
  options: { fetch: typeof fetch; expires: number; headersReady: () => void; finished: () => void }): Promise<Response> {
  let target = url, upstream: Response | undefined;
  const headers = new Headers({'Cache-Control':`private, max-age=${Math.max(0,Math.floor((options.expires-Date.now())/1000))}`,'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
  try {
    for (let hop=0; ;hop++) {
      request.signal?.throwIfAborted();const address=new URL(target);
      if(address.protocol!=='https:'||address.username||address.password||address.port&&address.port!=='443') throw new Error('GitHub 媒体重定向无效');
      upstream=await options.fetch(address,{method:'GET',redirect:'manual',signal:request.signal,headers:{'Accept-Encoding':'identity',...(request.range?{Range:request.range}:{}),...(request.ifRange?{'If-Range':request.ifRange}:{}),...(token&&credentialedHosts.has(address.hostname.toLowerCase())?{Authorization:'Bearer '+token}:{})}});
      if(upstream.status<300||upstream.status>=400||upstream.status===304)break;
      const location=upstream.headers.get('location');await upstream.body?.cancel();
      if(!location||hop>=3)throw new Error('GitHub 媒体重定向无效');target=new URL(location,address).href;
    }
    options.headersReady();
    if(upstream.status>=400) {await upstream.body?.cancel();options.finished();return new Response(null,{status:upstream.status>=500?502:upstream.status,headers});}
    const supplied=upstream.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()??'';
    const name=githubMediaFileName(url), extension=name.toLowerCase().split('.').at(-1)??'';
    const fallback=({heic:'image/heic',heif:'image/heif'} as Record<string,string>)[extension]??getMimeType(name)??taskFileMimeType(name);
    const contentType=mediaType.test(supplied)?supplied:fallback;
    if(!mediaType.test(contentType)){await upstream.body?.cancel();options.finished();return new Response(null,{status:415,headers});}
    for(const name of responseHeaders){const value=upstream.headers.get(name);if(value!==null)headers.set(name,value);}
    headers.set('Content-Type',contentType);headers.set('Content-Disposition',"inline; filename*=UTF-8''"+encodeURIComponent(githubMediaFileName(url)).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase()));
    if(contentType==='image/svg+xml')headers.set('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; sandbox");
    if(request.method==='HEAD'||!upstream.body||[204,205,304].includes(upstream.status)){await upstream.body?.cancel();options.finished();return new Response(null,{status:upstream.status,headers});}
    const reader=upstream.body.getReader();let ended=false, finished=false, closing:Promise<void>|undefined, controller:ReadableStreamDefaultController<Uint8Array>|undefined;
    const finish=()=>{if(finished)return;ended=true;finished=true;request.signal?.removeEventListener('abort',abort);options.finished();};
    const cancel=()=>{ended=true;return closing??=Promise.resolve().then(()=>reader.cancel()).finally(finish);};
    const abort=()=>{if(ended)return;try{controller?.error(request.signal?.reason??new Error('媒体读取已中断'));}catch{}void cancel().catch(()=>{});};
    const body=new ReadableStream<Uint8Array>({start(value){controller=value;request.signal?.addEventListener('abort',abort,{once:true});if(request.signal?.aborted)abort();},
      async pull(value){if(ended)return;try{const chunk=await reader.read();if(ended)return;if(chunk.done){value.close();finish();}else value.enqueue(chunk.value);}catch(error){if(!ended){value.error(error);finish();}}},
      cancel,
    });
    return new Response(body,{status:upstream.status,headers});
  }catch{await upstream?.body?.cancel().catch(()=>{});options.finished();request.signal?.throwIfAborted();return new Response(null,{status:502,headers});}
}
