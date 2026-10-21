/* Native-controlled DOM selection. Runs only in a private WKContentWorld / CDP world. */
globalThis.FridayBrowserPicker = (() => {
  'use strict';
  const marker = 'data-friday-picked', overlay = 'data-friday-annotation-ui';
  const properties = new Set(['font-family','font-size','font-weight','line-height','color','background-color','opacity','border-radius','border-width','border-color','border-style','width','height','margin','padding','margin-top','margin-right','margin-bottom','margin-left','padding-top','padding-right','padding-bottom','padding-left','gap','display','flex-direction','align-items','justify-content']);
  let state = null;
  const rect = r => ({x:r.left,y:r.top,width:r.width,height:r.height});
  const normalizeRect = (x,y,endX,endY) => ({x:Math.min(x,endX),y:Math.min(y,endY),width:Math.abs(endX-x),height:Math.abs(endY-y)});
  const strokeBounds = (points,width) => {const padding=width+3,x=Math.min(...points.map(p=>p.x))-padding,y=Math.min(...points.map(p=>p.y))-padding;return {x,y,width:Math.max(...points.map(p=>p.x))-x+padding,height:Math.max(...points.map(p=>p.y))-y+padding};};
  const escape = value => globalThis.CSS?.escape ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g,c=>'\\'+c);
  function roots(root=document) {const values=[root];for(const node of root.querySelectorAll('*'))if(node.shadowRoot)values.push(...roots(node.shadowRoot));return values;}
  function find(id) {for(const root of roots()){const node=root.querySelector(`[${marker}="${escape(id)}"]`);if(node)return node;}return null;}
  function selector(element) {
    const root=element.getRootNode();
    if(element.id){const value='#'+escape(element.id);if(root.querySelectorAll(value).length===1)return value;}
    const test=element.getAttribute('data-testid');if(test){const value='[data-testid='+JSON.stringify(test)+']';try{if(root.querySelectorAll(value).length===1)return value;}catch{}}
    const parts=[];let current=element;
    while(current && current!==document.body && current!==document.documentElement){let part=current.tagName.toLowerCase();const parent=current.parentElement;if(parent){const siblings=[...parent.children].filter(node=>node.tagName===current.tagName);if(siblings.length>1)part+=':nth-of-type('+(siblings.indexOf(current)+1)+')';}parts.unshift(part);const value=parts.join(' > ');try{if(root.querySelectorAll(value).length===1)return value;}catch{}current=parent;}
    return parts.join(' > ') || element.tagName.toLowerCase();
  }
  function baseElement(element) {
    const copy=element.cloneNode(true);copy.removeAttribute(marker);for(const node of copy.querySelectorAll('['+marker+']'))node.removeAttribute(marker);
    const computed=getComputedStyle(element),styles=[...properties].map(property=>property+': '+computed.getPropertyValue(property).trim()+';').join('\n');
    return {pageUrl:location.href,pageTitle:document.title.trim()||null,tagName:element.tagName.toLowerCase(),selector:selector(element),htmlPreview:copy.outerHTML.slice(0,500),componentName:null,source:null,styles};
  }
  function snapshot() {
    if(!state)return null;
    const elements=[...state.selected.values()].map(target=>({id:target.id,element:baseElement(target.element),rect:rect(target.element.getBoundingClientRect())}));
    const styleValues={};const first=state.selected.values().next().value;if(first){const css=getComputedStyle(first.element);for(const property of properties)styleValues[property]=css.getPropertyValue(property).trim();}
    return {nonce:state.nonce,pageUrl:location.href,pageTitle:document.title.trim()||null,viewport:{width:innerWidth,height:innerHeight},tool:state.tool,elements,regions:state.regions.map(v=>({...v,rect:{...v.rect}})),strokes:state.strokes.map(v=>({...v,points:v.points.map(p=>({...p})),bounds:{...v.bounds}})),styleChanges:[...state.changes.values()],styleValues};
  }
  function post(kind='state') {const value=snapshot();if(value){const message={kind,...value};if(state.deliver)state.deliver(message);else globalThis.webkit?.messageHandlers?.fridayBrowserAnnotation?.postMessage(message);}}
  function ui(node) {return node?.closest?.('['+overlay+']') || node===state?.host;}
  function fromPoint(x,y) {
    let candidates=document.elementsFromPoint(x,y);
    for(let depth=0;depth<8;depth++){const host=candidates.find(node=>!ui(node)&&node.shadowRoot);if(!host?.shadowRoot?.elementsFromPoint)break;const nested=host.shadowRoot.elementsFromPoint(x,y);if(!nested.length)break;candidates=[...nested,...candidates.filter(node=>node!==host)];}
    return candidates.find(node=>node instanceof Element && !ui(node) && node!==document.body && node!==document.documentElement) ?? null;
  }
  function box(r,color,fill) {const node=document.createElement('div');Object.assign(node.style,{position:'absolute',left:r.x+'px',top:r.y+'px',width:Math.max(0,r.width)+'px',height:Math.max(0,r.height)+'px',boxSizing:'border-box',border:'2px solid '+color,background:fill||'transparent',borderRadius:'3px',pointerEvents:'none'});return node;}
  function repaint() {
    if(!state)return;state.layer.replaceChildren();let index=0;
    for(const target of state.selected.values()){const node=box(rect(target.element.getBoundingClientRect()),state.color,state.color+'15'),label=document.createElement('span');label.textContent=String(++index);Object.assign(label.style,{position:'absolute',left:'-2px',top:'-20px',font:'600 11px -apple-system,sans-serif',color:'#fff',background:state.color,padding:'2px 5px',borderRadius:'3px'});node.append(label);state.layer.append(node);}
    for(const region of state.regions)state.layer.append(box(region.rect,state.color,state.color+'10'));
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('width',String(innerWidth));svg.setAttribute('height',String(innerHeight));Object.assign(svg.style,{position:'absolute',inset:'0',overflow:'visible',pointerEvents:'none'});
    for(const stroke of [...state.strokes,...(state.drawing?[state.drawing]:[])]){const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',stroke.points.map((p,i)=>(i?'L':'M')+p.x+' '+p.y).join(' '));path.setAttribute('fill','none');path.setAttribute('stroke',stroke.color);path.setAttribute('stroke-width',String(stroke.width));path.setAttribute('stroke-linecap','round');path.setAttribute('stroke-linejoin','round');svg.append(path);}state.layer.append(svg);
    if(state.marquee)state.layer.append(box(state.marquee,state.color,state.color+'10'));
    if(state.hover && state.tool==='select' && !state.start)state.layer.append(box(rect(state.hover.getBoundingClientRect()),state.color));
  }
  function restore(target) {if(target.baseline.size){if(target.originalStyle===null)target.element.removeAttribute('style');else target.element.setAttribute('style',target.originalStyle);}}
  function remove(target) {restore(target);target.element.removeAttribute(marker);state.selected.delete(target.element);for(const [key,value]of state.changes)if(value.targetId===target.id)state.changes.delete(key);}
  function add(element) {if(!element||state.selected.has(element)||state.selected.size>=50)return;const id=state.nonce+'-element-'+(++state.sequence);element.setAttribute(marker,id);state.selected.set(element,{id,element,originalStyle:element.getAttribute('style'),baseline:new Map()});}
  function erase(x,y) {
    for(const target of [...state.selected.values()].reverse()){const r=target.element.getBoundingClientRect();if(x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom){remove(target);return;}}
    for(const list of [state.regions,state.strokes]){const index=list.findIndex(target=>{const r=target.rect||target.bounds;return x>=r.x&&x<=r.x+r.width&&y>=r.y&&y<=r.y+r.height;});if(index>=0){list.splice(index,1);return;}}
  }
  function marquee(r) {
    const candidates=roots().flatMap(root=>[...root.querySelectorAll(root===document?'body *':'*')]).filter(element=>!ui(element)).map(element=>({element,r:element.getBoundingClientRect()})).filter(({element,r:c})=>c.width>=2&&c.height>=2&&c.left+c.width/2>=r.x&&c.left+c.width/2<=r.x+r.width&&c.top+c.height/2>=r.y&&c.top+c.height/2<=r.y+r.height&&(!element.children.length||['BUTTON','A'].includes(element.tagName)||element.getAttribute('role')==='button')).sort((a,b)=>a.r.width*a.r.height-b.r.width*b.r.height).slice(0,20);
    for(const candidate of candidates)add(candidate.element);if(!candidates.length&&state.regions.length<200)state.regions.push({id:state.nonce+'-region-'+(++state.sequence),rect:r});
  }
  function pointer(event,phase) {
    if(!state||state.frozen||!event.isTrusted||ui(event.target))return;
    const x=event.clientX,y=event.clientY;
    if(phase==='down'){
      if(event.button!==0)return;event.preventDefault();event.stopImmediatePropagation();state.start={x,y};
      if(state.tool==='select'){const element=fromPoint(x,y);if(state.selected.has(element))remove(state.selected.get(element));else if(element){if(!event.shiftKey)for(const target of [...state.selected.values()])remove(target);add(element);}}
      else if(state.tool==='erase')erase(x,y);
      else if(state.tool==='draw'&&state.strokes.length<200)state.drawing={id:state.nonce+'-stroke-'+(++state.sequence),color:state.color,width:4,points:[{x,y}],bounds:{x,y,width:1,height:1}};
    }else if(phase==='move'){
      if(state.tool==='select'&&!state.start)state.hover=fromPoint(x,y);
      if(state.start){event.preventDefault();event.stopImmediatePropagation();if(state.tool==='marquee')state.marquee=normalizeRect(state.start.x,state.start.y,x,y);if(state.tool==='draw'&&state.drawing&&state.drawing.points.length<5000&&state.strokes.reduce((n,s)=>n+s.points.length,0)+state.drawing.points.length<20000){state.drawing.points.push({x,y});state.drawing.bounds=strokeBounds(state.drawing.points,state.drawing.width);}}
    }else if(phase==='up'&&state.start){
      event.preventDefault();event.stopImmediatePropagation();if(state.tool==='marquee'){const r=normalizeRect(state.start.x,state.start.y,x,y);if(r.width>=3&&r.height>=3)marquee(r);}
      if(state.tool==='draw'&&state.drawing?.points.length>1)state.strokes.push(state.drawing);state.drawing=null;state.start=null;state.marquee=null;
    }
    repaint();if(phase!=='move')post();
  }
  function style(nonce,property,value) {
    if(!state||state.nonce!==nonce||state.frozen||!properties.has(property)||typeof value!=='string'||value.length>2048)return false;
    if(!state.selected.size || globalThis.CSS?.supports && !CSS.supports(property,value))return false;
    const additions=[...state.selected.values()].filter(target=>!state.changes.has(target.id+':'+property)).length;if(state.changes.size+additions>200)return false;
    for(const target of state.selected.values()){
      if(!(target.element instanceof HTMLElement||target.element instanceof SVGElement))continue;
      if(!target.baseline.has(property))target.baseline.set(property,{value:target.element.style.getPropertyValue(property),priority:target.element.style.getPropertyPriority(property)});
      const key=target.id+':'+property,previousValue=state.changes.get(key)?.previousValue ?? getComputedStyle(target.element).getPropertyValue(property).trim();
      target.element.style.setProperty(property,value,'important');state.changes.set(key,{targetId:target.id,selector:selector(target.element),property,previousValue:previousValue.slice(0,8000),value});
    }repaint();post();return true;
  }
  function tool(nonce,value) {if(!state||state.nonce!==nonce||!['select','marquee','draw','erase'].includes(value)||state.frozen)return false;state.tool=value;state.hover=null;repaint();post();return true;}
  function stop(nonce) {
    if(!state||state.nonce!==nonce)return false;const old=state;for(const target of old.selected.values()){restore(target);target.element.removeAttribute(marker);}for(const [name,handler]of old.listeners)window.removeEventListener(name,handler,true);old.host.remove();state=null;return true;
  }
  function start(nonce,color='#5689f5',deliver=null) {
    if(state)stop(state.nonce);const host=document.createElement('div');host.setAttribute(overlay,'');Object.assign(host.style,{position:'fixed',inset:'0',zIndex:'2147483646',pointerEvents:'none'});const root=host.attachShadow({mode:'closed'}),layer=document.createElement('div');Object.assign(layer.style,{position:'absolute',inset:'0',pointerEvents:'none'});root.append(layer);document.documentElement.append(host);
    state={nonce,color,deliver,host,root,layer,tool:'select',selected:new Map(),regions:[],strokes:[],changes:new Map(),sequence:0,start:null,hover:null,drawing:null,marquee:null,listeners:[],frozen:false};
    const listen=(name,handler)=>{window.addEventListener(name,handler,{capture:true,passive:false});state.listeners.push([name,handler]);};
    listen('pointerdown',event=>pointer(event,'down'));listen('pointermove',event=>pointer(event,'move'));listen('pointerup',event=>pointer(event,'up'));
    listen('pointercancel',()=>{if(state){state.start=null;state.drawing=null;state.marquee=null;repaint();post();}});
    for(const name of ['touchstart','touchmove'])listen(name,event=>{if(state&&event.isTrusted&&!ui(event.target)){event.preventDefault();event.stopImmediatePropagation();}});
    listen('click',event=>{if(state&&event.isTrusted&&!ui(event.target)){event.preventDefault();event.stopImmediatePropagation();}});
    listen('keydown',event=>{if(!state||!event.isTrusted||event.isComposing)return;if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();post('cancel');return;}if(event.metaKey||event.ctrlKey||event.altKey)return;const tools={v:'select',r:'marquee',d:'draw',e:'erase'};if(tools[event.key]){event.preventDefault();event.stopImmediatePropagation();tool(nonce,tools[event.key]);}});
    listen('scroll',()=>{repaint();post();});listen('resize',()=>{repaint();post();});listen('blur',()=>{if(state){state.hover=null;repaint();}});post();return snapshot();
  }
  function freeze(nonce,value) {if(!state||state.nonce!==nonce)return null;state.frozen=value;state.hover=null;repaint();return snapshot();}
  return {start,stop,tool,style,snapshot,freeze,find,selector,normalizeRect,strokeBounds};
})();
