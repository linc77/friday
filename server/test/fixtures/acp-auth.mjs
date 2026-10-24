#!/usr/bin/env node
import { appendFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
const wire = process.env.AUTH_FLOW_TRACE, marker = process.env.AUTH_FLOW_MARKER;
const trace = value => appendFileSync(wire, JSON.stringify({pid:process.pid,...value}) + '\n');
if (process.argv.includes('--sign-in')) {
  trace({terminal:true,envApplied:process.env.AUTH_METHOD_ENV === 'native-value',isTTY:process.stdin.isTTY === true});
  process.stdout.write('Native terminal sign-in 🙂\r\n');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8'); let input = '';
  process.on('SIGWINCH',()=>trace({cols:process.stdout.columns,rows:process.stdout.rows}));
  process.stdin.on('data',chunk=>{input += chunk; if (/[\r\n]/.test(input)) { writeFileSync(marker,'authenticated'); process.exit(0); }});
} else {
  const modern = process.env.AUTH_FLOW_GENERATION === '2', kind = process.env.AUTH_FLOW_KIND ?? 'agent';
  const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
  const reply = (request,result) => send({id:request.id,result});
  let pendingAuth;
  const authenticated = request => { if (process.env.AUTH_FLOW_FALSE_SUCCESS !== '1') writeFileSync(marker,'authenticated'); reply(request,{}); };
  const methods = [{[modern?'methodId':'id']:'native-auth',name:'Native auth',type:kind,
    ...(kind==='terminal'?{args:['--sign-in'],env:{AUTH_METHOD_ENV:'native-value'}}:{}),
    ...(kind==='env_var'?{vars:[{name:'AUTH_TEST_TOKEN'}],link:'https://example.test/account'}:{})}];
  function handle(request) {
    if (request.id==='auth-browser' && request.result) { trace({browserAnswer:request.result}); if(request.result.action==='accept')authenticated(pendingAuth); else send({id:pendingAuth.id,error:{code:-32000,message:'Consent declined'}}); return; }
    trace({method:request.method,params:request.params});
    if(request.method==='initialize') return reply(request,modern?
      {protocolVersion:2,info:{name:'ACP auth fixture',version:'2'},capabilities:{session:{}},authMethods:methods}:
      {protocolVersion:1,agentInfo:{name:'ACP auth fixture'},agentCapabilities:{loadSession:true},authMethods:methods});
    if(request.method===(modern?'auth/login':'authenticate')) {
      if(process.env.AUTH_FLOW_BROWSER==='1') {pendingAuth=request;send({id:'auth-browser',method:'elicitation/create',params:{mode:'url',elicitationId:'native-browser',url:process.env.AUTH_FLOW_BROWSER_URL??'https://example.test/login'}});return;}
      return authenticated(request);
    }
    if(request.method===(modern?'auth/logout':'logout')) {rmSync(marker,{force:true});return reply(request,{});}
    if(request.method==='session/new') {
      if(!existsSync(marker) && !(kind==='env_var' && process.env.AUTH_TEST_TOKEN==='configured-fixture-key'))return send({id:request.id,error:{code:-32000,message:'Not authenticated'}});
      return reply(request,{sessionId:'verified-session',models:{currentModelId:'native-model',availableModels:[{modelId:'native-model',name:'Native'}]}});
    }
    send({id:request.id,error:{code:-32601,message:'Unknown ACP method'}});
  }
  let buffer='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(line)handle(JSON.parse(line));}});
}
