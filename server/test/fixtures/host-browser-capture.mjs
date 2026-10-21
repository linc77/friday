import{createServer}from'node:http';import{Readable}from'node:stream';import{readFile,writeFile,appendFile}from'node:fs/promises';
const[marker,pngPath,delay='0']=process.argv.slice(2),png=await readFile(pngPath),document='00000000-0000-4000-8000-000000000001';let revision=1;
const state=(viewer=null)=>({taskId:'task',tabId:'tab',generation:'generation',documentId:document,revision:revision++,url:'http://localhost:3000/',title:'Capture fixture',loading:false,back:false,forward:false,error:null,settings:{width:1280,height:800,mobile:false,zoom:1,appearance:'system'},controller:viewer,controlGeneration:1,dialog:null,popups:[],downloads:[],chooser:null});
const annotation=id=>({nonce:id,pageUrl:'http://localhost:3000/',pageTitle:'Capture fixture',viewport:{width:640,height:480},tool:'select',elements:[{id:id+'-element-1',rect:{x:20,y:40,width:100,height:40},element:{pageUrl:'http://localhost:3000/',tagName:'button',selector:'#cta',htmlPreview:'<button>fixture</button>',styles:'color: red;'}}],regions:[],strokes:[],styleChanges:[],styleValues:{color:'rgb(255, 0, 0)'}});
const server=createServer(async(req,res)=>{try{
 if(req.headers.authorization!=='Bearer synthetic-capture-fixture'){res.writeHead(401);res.end();return}
 const url=new URL(req.url,'http://127.0.0.1'),path=url.pathname;
 if(path.endsWith('/events')){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('event: state\ndata: '+JSON.stringify({type:'state',state:state(url.searchParams.get('viewer'))})+'\n\n');const ping=setInterval(()=>res.write(': heartbeat\n\n'),10000);res.on('close',()=>clearInterval(ping));return}
 const body=req.method==='POST'?await new Response(Readable.toWeb(req)).json():{};
 if(path.endsWith('/open')){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(state()));return}
 if(path.endsWith('/capture')){res.writeHead(200,{'Content-Type':'image/png','X-Friday-Capture-Sequence':'10','X-Friday-Capture-Document':document});res.end(png);return}
 if(path.endsWith('/annotation')){
  if(body.document!==document||body.controlGeneration!==1){res.writeHead(409);res.end();return}
  await appendFile(marker+'.requests',JSON.stringify({action:body.action,id:body.id})+'\n');
  if(body.action==='start'&&Number(delay)>0)await new Promise(resolve=>setTimeout(resolve,Number(delay)));
  let value=body.action==='stop'||body.action==='read'?null:JSON.stringify(annotation(body.id));
  if(body.action==='elements')value=JSON.stringify(annotation(body.id).elements.map(e=>({...e.element,componentName:'FixtureButton',source:{fileName:'/src/Button.tsx',lineNumber:12,columnNumber:3}})));
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({value}));return
 }
 if(path.endsWith('/recording')){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,sequence:body.action==='start'?0:10}));return}
 res.writeHead(404);res.end();
}catch(error){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}))}});
server.listen(0,'127.0.0.1',()=>writeFile(marker,JSON.stringify({port:server.address().port})));process.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>process.exit(0))});
