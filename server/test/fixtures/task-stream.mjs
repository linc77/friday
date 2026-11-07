import {createServer} from 'node:http';
import {spawn} from 'node:child_process';

const task = {id:'a',title:'a',prompt:'',projectId:null,cwd:'/project',agent:'codex',mode:'code',status:'completed',createdAt:'',updatedAt:'',durableId:null,threadId:null,turnId:null,result:'body',events:[],approvals:[],artifact:null,contentVersion:'v1'};
const snapshot = {revision:1,ideas:[],projects:[],memories:[],tasks:[{...task,contentOmitted:true}],taskStreamSession:'service',taskStreamSerial:1};
const output = {taskId:'a',eventId:'command',epoch:'epoch',text:'你好 🚀\n',truncated:false,running:true};
const data = {
  overview:[['snapshot',snapshot],['taskSummaries',{sessionId:'service',sequence:2,serial:2,tasks:[],removed:[]}]],
  task:[['taskSnapshot',{taskId:'a',sessionId:'service',sequence:1,serial:1,version:'v1',task}],['taskRemoved',{taskId:'a',sessionId:'service',sequence:2,serial:2}]],
  output:[['output',output],['output',{...output,running:false}]],
  terminal:[['terminal',{type:'output',generation:1,sequence:1,data:Buffer.from('你好').toString('base64')}],['terminal',{type:'closed',generation:1,sequence:2}]],
};
const liveTask = {...task,status:'running',turnId:'live-turn',events:[
  {id:'reasoning',kind:'reasoning',turnId:'live-turn',text:'正在分析项目 🚀',at:'2026-10-18T00:00:00Z',status:'running'},
  {id:'commentary',kind:'message',phase:'commentary',turnId:'live-turn',text:'先检查执行链路。',at:'2026-10-18T00:00:01Z',status:'running'},
]};
const frame = (value,sequence) => ['taskSnapshot',{taskId:'a',sessionId:'service',sequence,serial:sequence,version:'v'+sequence,task:{...value,contentVersion:'v'+sequence}}];
let releaseLive;
const write = (response,records) => new Promise(resolve => {
  const wire=Buffer.from(records.map(([event,body])=>'event: '+event+'\ndata: '+JSON.stringify(body)+'\n\n').join(''));
  let position=0;
  const chunk=()=>{if(position>=wire.length){resolve();return;}response.write(wire.subarray(position,position+17));position+=17;setImmediate(chunk);};
  chunk();
});
const server=createServer((request,response)=>{
  if(request.url==='/live/release' && request.method==='POST'){
    if(!releaseLive){response.writeHead(409);response.end();return;}
    const release=releaseLive;releaseLive=undefined;release();response.writeHead(204);response.end();return;
  }
  if(request.url==='/live'){
    response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});
    // Keep the SSE connection open until native AsyncBytes.lines has decoded
    // and projected the running frame. EOF cannot conceal delayed dispatch.
    const first=write(response,[frame(liveTask,1)]);
    releaseLive=async()=>{await first;await write(response,[frame({...liveTask,status:'completed'},2)]);response.end();};
    return;
  }
  const records=data[request.url.slice(1)]; if(!records){response.writeHead(404);response.end();return;}
  response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});
  void write(response,records).then(()=>response.end());
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try{
  const child=spawn(process.argv[2],['http://127.0.0.1:'+server.address().port],{stdio:'inherit'});
  const watchdog=setTimeout(()=>child.kill('SIGTERM'),30000);
  try { await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('Native task stream check failed')));}); }
  finally { clearTimeout(watchdog); }
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
