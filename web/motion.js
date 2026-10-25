/* Resize windows from their current size; keep their upper edge steady when space permits. */
(() => {
 const states=new WeakMap();
 const measure=element=>{const rect=element.getBoundingClientRect();return {height:element.offsetHeight,top:rect.top};};
 const enabled=()=>!document.body.classList.contains('gs-no-animations')&&!matchMedia('(prefers-reduced-motion: reduce)').matches;
 function ready(element){return element.tagName==='DIALOG'?element.open:!element.hidden&&element.getBoundingClientRect().height>0;}
 function resize(element){
  const state=states.get(element);if(!state||!ready(element)||state.animation||element.dataset.closing)return;
  const next=measure(element);if(!state.previous){state.previous=next;return;}
  const before=state.previous;state.previous=next;if(Math.abs(before.height-next.height)<1||!enabled())return;
  let top=next.top;const frames=[{height:before.height+'px'},{height:next.height+'px'}];
  if(element.tagName==='DIALOG'){
   top=Math.max(16,Math.min(before.top,innerHeight-next.height-16));element.style.marginBlock='0';element.style.top=top+'px';
   frames[0].top=before.top+'px';frames[1].top=top+'px';
  }
  element.classList.add('gs-resizing');const duration=typeof motionDuration==='function'?motionDuration(240):240;
  const animation=element.animate(frames,{duration,easing:'cubic-bezier(.2,.7,.2,1)'});state.animation=animation;animation.id='gs-window-resize';
  animation.finished.catch(()=>{}).then(()=>{if(state.animation!==animation)return;state.animation=null;element.classList.remove('gs-resizing');state.previous={height:next.height,top};resize(element);});
 }
 function track(element){
  if(states.has(element))return;const state={previous:null,animation:null};states.set(element,state);new ResizeObserver(()=>resize(element)).observe(element);
  if(element.tagName==='DIALOG')element.addEventListener('close',()=>{state.animation?.cancel();state.animation=null;element.classList.remove('gs-resizing');state.previous=null;element.style.removeProperty('top');element.style.removeProperty('margin-block');});
 }
 for(const element of document.querySelectorAll('dialog,#setup-form'))track(element);
 const observer=new MutationObserver(records=>{for(const record of records){if(record.target.tagName==='DIALOG'&&record.attributeName==='open'){const state=states.get(record.target);if(record.target.open){state.animation?.cancel();state.animation=null;record.target.classList.remove('gs-resizing');state.previous=measure(record.target);}else state.previous=null;}for(const child of record.addedNodes||[])if(child.nodeType===1){if(child.matches('dialog'))track(child);child.querySelectorAll('dialog').forEach(track);}}});
 observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['open']});
 window.GameShelfMotion={track};
})();
