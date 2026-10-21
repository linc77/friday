#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const notify = (method, params) => send({ method, params });
const saved = () => existsSync('goal.json') ? JSON.parse(readFileSync('goal.json','utf8')) : null;
let goal = saved(), current = '', history = existsSync('native-turns.json') ? JSON.parse(readFileSync('native-turns.json','utf8')) : [], count = history.length;
const begin = () => { current = 'goal-turn-' + (++count); history.push(current); writeFileSync('native-turns.json',JSON.stringify(history)); return current; };
const save = () => { writeFileSync('goal.json', JSON.stringify(goal)); notify(goal ? 'thread/goal/updated' : 'thread/goal/cleared', { threadId: 'goal-thread', ...(goal ? { goal } : {}) }); };
const complete = id => { notify('item/completed', { threadId:'goal-thread', turnId:id, item:{id:'answer-'+id,type:'agentMessage',phase:'final_answer',text:'Result '+id} }); notify('turn/completed',{threadId:'goal-thread',turn:{id,status:'completed'}}); };
createInterface({ input:process.stdin }).on('line', line => {
  const message = JSON.parse(line); appendFileSync('wire.jsonl', JSON.stringify(message)+'\n'); const {id,method,params:p={}}=message;
  if(method==='initialize') send({id,result:{}});
  if(method==='feedback/upload') {writeFileSync('feedback-uploaded','');if(existsSync('drop-feedback'))process.exit(0);send({id,result:{threadId:'feedback-fixture-id'}});}
  if(method==='thread/start'||method==='thread/resume') send({id,result:{thread:{id:'goal-thread'},model:'fixture-model',reasoningEffort:'medium',sandbox:{type:'workspaceWrite'}}});
  if(method==='thread/read')send({id,result:{thread:{id:'goal-thread',historyMode:'paginated',status:{type:'notLoaded'}}}});
  if(method==='thread/turns/list')send({id,result:{data:history.map(id=>({id,status:'completed'})),nextCursor:null}});
  if(method==='thread/revert'){history=history.slice(0,history.indexOf(p.beforeTurnId));writeFileSync('native-turns.json',JSON.stringify(history));send({id,result:{thread:{id:'goal-thread'}}});}
  if(method==='thread/goal/get') send({id,result:{goal}});
  if(method==='thread/goal/clear') {const cleared=!!goal;goal=null;save();send({id,result:{cleared}});}
  if(method==='thread/goal/set') {
    goal={...(goal??{tokensUsed:0,timeUsedSeconds:0}),...p};delete goal.threadId;save();
    if(p.status==='active'&&existsSync('hold-activation')) {writeFileSync('activation-entered','');const timer=setInterval(()=>{if(!existsSync('release-activation'))return;clearInterval(timer);send({id,result:{goal:{...goal,status:'active'}}});},5);return;}
    send({id,result:{goal}});
    if(p.status==='active'&&!existsSync('no-continuation')) setTimeout(()=>{
      begin();notify('turn/started',{threadId:'goal-thread',turn:{id:current,status:'inProgress'}});
      if(existsSync('hold-continuation'))return;
      complete(current);goal={...goal,status:'complete',tokensUsed:1250,timeUsedSeconds:65};save();
    },15);
  }
  if(method==='turn/start') {begin();send({id,result:{turn:{id:current,status:'inProgress'}}});notify('turn/started',{threadId:'goal-thread',turn:{id:current,status:'inProgress'}});complete(current);}
  if(method==='turn/interrupt') {send({id,result:{}});notify('turn/completed',{threadId:'goal-thread',turn:{id:p.turnId,status:'interrupted'}});}
});
