#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send=message=>process.stdout.write(JSON.stringify(message)+'\n');const threadId='approval-thread',turn={id:'approval-turn',status:'inProgress'};let step=0;
const request=()=>{
  if(step===5){send({method:'item/completed',params:{threadId,turnId:turn.id,item:{id:'final',type:'agentMessage',phase:'final_answer',text:'Approved sequence'}}});send({method:'turn/completed',params:{threadId,turn:{...turn,status:'completed'}}});return;}
  const method=[0,1,3].includes(step)?'item/commandExecution/requestApproval':'item/fileChange/requestApproval';send({id:100+step,method,params:{threadId,turnId:turn.id,itemId:'item-'+step,command:'echo step-'+step,reason:'fixture permission'}});
};
createInterface({input:process.stdin}).on('line',line=>{
  const message=JSON.parse(line);appendFileSync('approval-wire.jsonl',JSON.stringify(message)+'\n');
  if(message.method==='initialize')send({id:message.id,result:{}});
  if(['thread/start','thread/resume'].includes(message.method))send({id:message.id,result:{thread:{id:threadId},model:'fixture-model',reasoningEffort:'medium',sandbox:{type:'workspaceWrite'}}});
  if(message.method==='turn/start'){send({id:message.id,result:{turn}});send({method:'turn/started',params:{threadId,turn}});request();}
  if(message.id>=100&&!message.method){if(message.result?.decision==='cancel'){send({method:'turn/completed',params:{threadId,turn:{...turn,status:'interrupted'}}});return;}step++;request();}
  if(message.method==='turn/interrupt')send({id:message.id,result:{}});
});
