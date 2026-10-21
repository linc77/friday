import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { CDPSession } from 'playwright-core';
import { HostBrowserCaptures, hostBrowserLayout } from '../src/task-host-browser-capture.js';
import { hostRecordingInputSource } from '../src/task-host-browser-recording-input.js';

class CaptureProtocol {
  calls:{ method:string; params:any }[]=[];
  png=Buffer.from([137,80,78,71,13,10,26,10,0]);
  input:unknown[]=[];
  hold?:Promise<void>;
  scripts=0;
  async send(method:string,params?:any):Promise<any> {
    this.calls.push({method,params});
    if(method==='Page.addScriptToEvaluateOnNewDocument')return{identifier:'script-'+(++this.scripts)};
    if(method==='Page.getFrameTree')return{frameTree:{frame:{id:'frame'}}};
    if(method==='Page.createIsolatedWorld')return{executionContextId:1};
    if(method==='Runtime.evaluate'){const input=this.input;this.input=[];return{result:{value:input}}}
    if(method==='Page.captureScreenshot'){await this.hold;return{data:this.png.toString('base64')}};
    return{};
  }
  session(){return this as unknown as CDPSession}
}
test('Remote CSS viewport layout matches execution of the pinned T3 function for every zoom and viewport fixture',async()=>{
  const fixture=JSON.parse(await readFile(new URL('./fixtures/t3-host-browser-layout.json',import.meta.url),'utf8'));assert.ok(fixture.cases.length>=200);
  for(const value of fixture.cases)assert.deepEqual(hostBrowserLayout({...value,mobile:true,appearance:'dark'}),value.expected);
});
test('Recording input in the service exactly matches the packaged native source',async()=>{
  assert.equal(hostRecordingInputSource,await readFile(new URL('../../apps/apple/Sources/FridayKit/Resources/BrowserRecordingInput.js',import.meta.url),'utf8'));
});
test('Capture pauses and restores streams and refuses a document that changed before the PNG read completed',async()=>{
  const protocol=new CaptureProtocol();let doc='doc',owner:HostBrowserCaptures;const phases:boolean[]=[];owner=new HostBrowserCaptures(protocol.session(),async()=>{phases.push(owner.paused)},()=>doc);
  let release!:()=>void;protocol.hold=new Promise<void>(resolve=>{release=resolve});const pending=owner.screenshot('doc');await new Promise(resolve=>setImmediate(resolve));doc='other';release();await assert.rejects(pending,/已变化/);assert.deepEqual(phases,[true,false]);assert.equal(owner.paused,false);
  protocol.hold=undefined;assert.deepEqual(await owner.screenshot('other'),protocol.png);await owner.close();
});
test('Recording leases prepare once, preserve their original frame baseline and cannot be stopped or restarted by a different viewer',async()=>{
  const protocol=new CaptureProtocol();let sequence=8;const owner=new HostBrowserCaptures(protocol.session(),async()=>{sequence++},()=> 'doc',()=>sequence);
  assert.equal(await owner.start('capture','viewer','device',true),8);assert.equal(owner.recording,true);sequence=100;assert.equal(await owner.start('capture','viewer','device',true),8);assert.equal(protocol.scripts,1);
  await assert.rejects(owner.stop('capture','other','device'),/不属于/);await assert.rejects(owner.start('capture','viewer','device',false),/其他内容/);
  await owner.stop('capture','viewer','device');await owner.stop('capture','viewer','device');assert.equal(owner.recording,false);assert.equal(protocol.calls.filter(value=>value.method==='Page.removeScriptToEvaluateOnNewDocument').length,1);await assert.rejects(owner.start('capture','viewer','device',true),/已结束/);await owner.close();
});
test('Private recording input is scoped to viewer and current document, bounded, and keys remain opt-in',async()=>{
  const protocol=new CaptureProtocol(),owner=new HostBrowserCaptures(protocol.session(),async()=>{},()=> 'doc');await owner.start('capture','viewer','device',false);
  const point={nonce:'capture',document:'page',type:'pointer',width:400,height:800,x:10,y:20,phase:'down'};
  protocol.input=[point,{...point,nonce:'foreign'}, {...point,x:NaN},{...point,type:'key',label:'A',held:true},{nonce:'capture',type:'clear',width:0,height:0}];
  assert.deepEqual(await owner.inputs('foreign','device'),[]);const values=await owner.inputs('viewer','device');assert.equal(values.length,2);assert.equal(values[0].document,'doc');assert.equal(values[1].type,'clear');await owner.detach('viewer','device');assert.equal(owner.recording,false);await owner.close();
});
test('A cancelled pending recording still removes the installed script after its startup reply arrives',async()=>{
  const protocol=new CaptureProtocol();let release!:()=>void,started=0;const hold=new Promise<void>(resolve=>{release=resolve});const owner=new HostBrowserCaptures(protocol.session(),async()=>{if(started++===0)await hold},()=> 'doc');const starting=owner.start('capture','viewer','device',true);await new Promise(resolve=>setImmediate(resolve));const stopping=owner.stop('capture','viewer','device');release();await starting;await stopping;assert.equal(owner.recording,false);assert.equal(protocol.calls.filter(value=>value.method==='Page.removeScriptToEvaluateOnNewDocument').length,1);await owner.close();
});
