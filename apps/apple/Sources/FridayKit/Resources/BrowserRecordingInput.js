/* Private WKContentWorld input for explicitly started browser recordings. */
globalThis.FridayBrowserRecordingInput = (() => {
  let state=null;
  function sensitive() {let element=document.activeElement;while(element?.shadowRoot?.activeElement)element=element.shadowRoot.activeElement;return element?.tagName==='IFRAME'||element?.tagName.includes('-')===true||element?.getAttribute('type')?.toLowerCase()==='password';}
  function keyLabel(input,mac=true) {
    if(['Dead','Process','Unidentified',''].includes(input.key))return null;
    const labels={Enter:'↵',Tab:'⇥',Backspace:'⌫',Delete:'⌦',Escape:'Esc',ArrowUp:'↑',ArrowDown:'↓',ArrowLeft:'←',ArrowRight:'→',' ':'Space',Space:'Space'};
    const values=[input.ctrlKey||input.key==='Control'?(mac?'⌃':'Ctrl'):null,input.altKey||input.key==='Alt'?(mac?'⌥':'Alt'):null,input.shiftKey||input.key==='Shift'?(mac?'⇧':'Shift'):null,input.metaKey||input.key==='Meta'?(mac?'⌘':'Win'):null].filter(v=>v!==null);
    if(!['Control','Alt','Shift','Meta'].includes(input.key))values.push(labels[input.key]??(input.key.length===1?input.key.toUpperCase():input.key));return values.join(mac?'':' + ');
  }
  function post(input) {if(state){const body={nonce:state.nonce,document:state.document,width:innerWidth,height:innerHeight,...input};if(state.deliver)state.deliver(body);else globalThis.webkit?.messageHandlers?.fridayBrowserRecording?.postMessage(body);}}
  function stop(nonce) {if(!state||state.nonce!==nonce)return false;for(const [name,fn]of state.listeners)window.removeEventListener(name,fn,true);if(state.frame)cancelAnimationFrame(state.frame);state=null;return true;}
  function start(nonce,documentID,showKeys,deliver) {
    if(state)stop(state.nonce);state={nonce,document:documentID,showKeys,deliver:typeof deliver==='function'?deliver:null,listeners:[],frame:null,pending:null,lastKey:null};
    const listen=(name,fn)=>{window.addEventListener(name,fn,true);state.listeners.push([name,fn]);};
    listen('pointermove',event=>{if(!state||!event.isTrusted||event.pointerType==='touch')return;state.pending={type:'pointer',phase:'move',x:event.clientX,y:event.clientY};state.frame??=requestAnimationFrame(()=>{if(!state)return;state.frame=null;if(state.pending)post(state.pending);state.pending=null;});});
    const cancelPointer=()=>{if(state?.frame)cancelAnimationFrame(state.frame);if(state){state.frame=null;state.pending=null;}};
    for(const [name,phase]of [['pointerdown','down'],['pointerup','up'],['pointercancel','up']])listen(name,event=>{if(state&&event.isTrusted&&event.pointerType!=='touch'){cancelPointer();post({type:'pointer',phase,x:event.clientX,y:event.clientY});}});
    listen('keydown',event=>{if(!state||!state.showKeys||!event.isTrusted||event.isComposing||event.repeat)return;state.lastKey=sensitive()?null:keyLabel(event,true);post({type:'key',label:state.lastKey,held:true});});
    listen('keyup',event=>{if(state?.showKeys&&event.isTrusted&&!event.isComposing)post({type:'key',label:sensitive()?null:state.lastKey,held:false});});
    const clear=()=>{if(state){cancelPointer();state.lastKey=null;post({type:'clear'});}};
    listen('compositionstart',clear);listen('blur',clear);listen('pointerout',event=>{if(event.isTrusted&&event.relatedTarget===null)clear();});return true;
  }
  return {start,stop,keyLabel,sensitive};
})();
