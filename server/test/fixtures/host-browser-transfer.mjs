import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {readFile,writeFile} from 'node:fs/promises';
import {hostUploadFiles,hostUploadManifest} from '../../src/task-host-browser-transfers.ts';
const [marker,source]=process.argv.slice(2),bytes=await readFile(source);
let revision=1;
const server=createServer(async(req,res)=>{
 try{
  if(req.headers.authorization!=='Bearer synthetic-file-fixture'){res.writeHead(401);res.end();return}
  const url=new URL(req.url,'http://127.0.0.1');
  const state=(tabId='tab',controller=null)=>({taskId:'task',tabId,generation:'generation',revision:revision++,url:'http://localhost:3000/',title:'Fixture',loading:false,back:false,forward:false,error:null,settings:{width:1280,height:800,mobile:false,zoom:1,appearance:'system'},controller,controlGeneration:1,dialog:null,popups:[],downloads:[],chooser:null});
  if(url.pathname==='/api/task-browser/host/open'){
   const input=await new Response(Readable.toWeb(req)).json();res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(state(input.tabId)));return
  }
  if(url.pathname==='/api/task-browser/host/events'){
   res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('event: state\ndata: '+JSON.stringify({type:'state',state:state(url.searchParams.get('tabId'),url.searchParams.get('viewer'))})+'\n\n');const ping=setInterval(()=>res.write(': heartbeat\n\n'),10000);res.on('close',()=>clearInterval(ping));return
  }
  if(url.pathname==='/api/task-browser/host/command'){
   const input=await new Response(Readable.toWeb(req)).json();const reply=state(input.tabId,input.viewer);reply.clipboardText=input.action?.type==='edit'&&input.action.command==='copy'?'explicit synthetic copy':'unsolicited text must be ignored';res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(reply));return
  }
  if(url.pathname==='/api/task-browser/host/upload'&&req.method==='POST'){
   const request=new Request(url,{method:'POST',headers:req.headers,body:Readable.toWeb(req),duplex:'half'});
   const files=await hostUploadFiles(request),digest=hostUploadManifest(files);
   if(digest!==url.searchParams.get('digest'))throw Error('Native upload manifest mismatch: '+JSON.stringify(files.map(f=>({name:f.name,mimeType:f.mimeType,bytes:f.buffer.length}))));
   res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({digest,files:files.map(f=>({name:f.name,mimeType:f.mimeType,base64:f.buffer.toString('base64')}))}));return
  }
  if(url.pathname==='/api/task-browser/host/download'&&url.searchParams.get('taskId')==='task'&&url.searchParams.get('tabId')==='tab'&&url.searchParams.get('generation')==='generation'&&url.searchParams.get('id')==='download'){
   res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':bytes.length});res.end(bytes);return
  }
  res.writeHead(404);res.end();
 }catch(error){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}))}
});
server.listen(0,'127.0.0.1',()=>writeFile(marker,JSON.stringify({port:server.address().port})));
process.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>process.exit(0))});
