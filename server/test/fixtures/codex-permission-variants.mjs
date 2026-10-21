#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send=message=>process.stdout.write(JSON.stringify(message)+'\n'),threadId='permission-thread',turn={id:'permission-turn',status:'inProgress'};let step=0;
const permissions={fileSystem:{read:['/only-read'],write:['/only-write']},network:{enabled:true}};
const request=()=>{
  const base={threadId,turnId:turn.id,itemId:'item-'+step};let method,params;
  if(step<=1){method='item/permissions/requestApproval';params={...base,permissions,reason:'Review the requested scope'};}
  if(step===2){method='execCommandApproval';params={conversationId:threadId,callId:'legacy-command',command:['echo','legacy'],reason:'Legacy command'};}
  if(step===3){method='item/commandExecution/requestApproval';params={...base,command:'echo another command'};}
  if(step===4){method='applyPatchApproval';params={conversationId:threadId,callId:'legacy-patch',changes:{'file.txt':{type:'add',content:'fixture'}}};}
  if(step>=5&&step<=8){method='mcpServer/elicitation/request';params={...base,mode:step===6?'url':'form',serverName:'computer-use',message:'Allow ChatGPT to use Safari?',_meta:{app_name:'Safari',persist:['session','always']},requestedSchema:{type:'object',properties:{approval:{type:'string',enum:['once','session','always']}},required:['approval']},...(step===6?{elicitationId:'url-request',url:'https://example.invalid/consent'}:{})};if(step===7)params.requestedSchema={type:'object',properties:{secret:{type:'string'}},required:['secret']};if(step===8)params.turnId=null;}
  if(step===9){send({method:'item/completed',params:{...base,item:{id:'final',type:'agentMessage',phase:'final_answer',text:'Permission variants complete'}}});send({method:'turn/completed',params:{threadId,turn:{...turn,status:'completed'}}});return;}
  send({id:100+step,method,params});
};
createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);appendFileSync('permission-wire.jsonl',JSON.stringify(message)+'\n');
  if(message.method==='initialize')send({id:message.id,result:{}});
  if(['thread/start','thread/resume'].includes(message.method))send({id:message.id,result:{thread:{id:threadId},model:'fixture-model',sandbox:{type:'workspaceWrite'}}});
  if(message.method==='turn/start'){send({id:message.id,result:{turn}});send({method:'turn/started',params:{threadId,turn}});request();}
  if(message.id>=100&&!message.method){step++;request();}
});
