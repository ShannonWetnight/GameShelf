/* Resize windows from their current size; keep their upper edge steady when space permits. */
(() => {
 const states=new WeakMap(),tracked=new Set();
 const measure=element=>{const rect=element.getBoundingClientRect();const scale=typeof uiScale==='number'?uiScale:1;return {height:element.offsetHeight,top:rect.top/scale};};
 const enabled=()=>!document.body.classList.contains('gs-no-animations')&&!matchMedia('(prefers-reduced-motion: reduce)').matches;
 function ready(element){return element.tagName==='DIALOG'?element.open:!element.hidden&&element.getBoundingClientRect().height>0;}
 function resize(element){
  const state=states.get(element);if(!state||!ready(element)||state.animation||element.dataset.closing)return;
  const next=measure(element);if(!state.previous){state.previous=next;return;}
  const before=state.previous;state.previous=next;if(Math.abs(before.height-next.height)<1||!enabled())return;
  let top=next.top;const frames=[{height:before.height+'px'},{height:next.height+'px'}];
  // A centered setup stage already follows the animated height. Translating
  // it again double-counts that movement, especially while collapsing.
  if(element.tagName!=='DIALOG'&&element.id!=='setup-form'){frames[0].transform='translateY('+(before.top-next.top)+'px)';frames[1].transform='translateY(0)';}
  if(element.tagName==='DIALOG'){
   top=Math.max(16,Math.min(before.top,innerHeight/(typeof uiScale==='number'?uiScale:1)-next.height-16));element.style.marginBlock='0';element.style.top=top+'px';
   frames[0].top=before.top+'px';frames[1].top=top+'px';
  }
  element.classList.add('gs-resizing');const duration=typeof motionDuration==='function'?motionDuration(240):240;
  const animation=element.animate(frames,{duration,easing:'cubic-bezier(.2,.7,.2,1)'});state.animation=animation;animation.id='gs-window-resize';
  animation.finished.catch(()=>{}).then(()=>{if(state.animation!==animation)return;state.animation=null;element.classList.remove('gs-resizing');state.previous={height:next.height,top};resize(element);});
 }
 function track(element){
  if(states.has(element))return;tracked.add(element);const state={previous:null,animation:null};states.set(element,state);new ResizeObserver(()=>resize(element)).observe(element);
  if(element.tagName==='DIALOG')element.addEventListener('close',()=>{state.animation?.cancel();state.animation=null;element.classList.remove('gs-resizing');state.previous=null;element.style.removeProperty('top');element.style.removeProperty('margin-block');});
 }
 for(const element of document.querySelectorAll('dialog,#setup-form'))track(element);
 const observer=new MutationObserver(records=>{for(const record of records){if(record.target.tagName==='DIALOG'&&record.attributeName==='open'){const state=states.get(record.target);if(record.target.open){state.animation?.cancel();state.animation=null;record.target.classList.remove('gs-resizing');state.previous=measure(record.target);}else state.previous=null;}for(const child of record.addedNodes||[])if(child.nodeType===1){if(child.matches('dialog'))track(child);child.querySelectorAll('dialog').forEach(track);}}});
 observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['open']});
 function reset(){for(const element of tracked){const state=states.get(element);state.animation?.cancel();state.animation=null;element.classList.remove('gs-resizing');element.style.removeProperty('top');element.style.removeProperty('margin-block');state.previous=ready(element)?measure(element):null;}}
 for(const type of ['pointerdown','keydown'])document.addEventListener(type,()=>{for(const element of tracked){const state=states.get(element);if(ready(element)&&!state.animation)state.previous=measure(element);}},true);
 window.GameShelfMotion={track,reset};
})();
