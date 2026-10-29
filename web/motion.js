/* Resize windows from their current size; keep their upper edge steady when space permits. */
(() => {
 const states=new WeakMap(),tracked=new Set();
 const measure=element=>{const rect=element.getBoundingClientRect();const scale=typeof uiScale==='number'?uiScale:1;return {height:element.offsetHeight,top:rect.top/scale};};
 const enabled=()=>!document.body.classList.contains('gs-no-animations')&&!matchMedia('(prefers-reduced-motion: reduce)').matches;
 function ready(element){return element.tagName==='DIALOG'?element.open:!element.hidden&&element.getBoundingClientRect().height>0;}
 function resize(element){
  const state=states.get(element);if(!state||!ready(element)||state.animation||element.dataset.closing)return;
  const next=measure(element);if(element.querySelector('[data-details-animating]')){state.previous=next;return;}if(!state.previous){state.previous=next;return;}
  const before=state.previous;state.previous=next;if(Math.abs(before.height-next.height)<1||!enabled())return;
  let top=next.top;const limit=Math.max(80,innerHeight/(typeof uiScale==='number'?uiScale:1)-24);const frames=[{height:Math.min(before.height,limit)+'px'},{height:Math.min(next.height,limit)+'px'}];
  // A centered setup stage already follows the animated height. Translating
  // it again double-counts that movement, especially while collapsing.
  if(element.tagName!=='DIALOG'&&element.id!=='setup-form'){frames[0].transform='translateY('+(before.top-next.top)+'px)';frames[1].transform='translateY(0)';}
  if(element.tagName==='DIALOG'){
   const viewport=innerHeight/(typeof uiScale==='number'?uiScale:1);
   top=element.id==='profile-picker'?Math.max(12,(viewport-next.height)/2):Math.max(16,Math.min(before.top,viewport-next.height-16));element.style.marginBlock='0';element.style.bottom='auto';element.style.top=top+'px';
   frames[0].top=Math.max(12,Math.min(before.top,innerHeight/(typeof uiScale==='number'?uiScale:1)-Math.min(before.height,limit)-12))+'px';frames[1].top=top+'px';
  }
  element.classList.add('gs-resizing');const duration=typeof motionDuration==='function'?motionDuration(240):240;
  const animation=element.animate(frames,{duration,easing:'cubic-bezier(.2,.7,.2,1)'});state.animation=animation;animation.id='gs-window-resize';
  animation.finished.catch(()=>{}).then(()=>{if(state.animation!==animation)return;state.animation=null;element.classList.remove('gs-resizing');state.previous={height:next.height,top};resize(element);});
 }
 function track(element){
  if(states.has(element))return;tracked.add(element);const state={previous:null,animation:null};states.set(element,state);new ResizeObserver(()=>resize(element)).observe(element);
  if(element.tagName==='DIALOG')element.addEventListener('close',()=>{state.animation?.cancel();state.animation=null;element.classList.remove('gs-resizing');state.previous=null;element.style.removeProperty('top');element.style.removeProperty('margin-block');element.style.removeProperty('bottom');});
 }
 for(const element of document.querySelectorAll('dialog,#setup-form'))track(element);
 const observer=new MutationObserver(records=>{for(const record of records){if(record.target.tagName==='DIALOG'&&record.attributeName==='open'){const state=states.get(record.target);if(record.target.open){state.animation?.cancel();state.animation=null;record.target.classList.remove('gs-resizing');state.previous=measure(record.target);}else state.previous=null;}for(const child of record.addedNodes||[])if(child.nodeType===1){if(child.matches('dialog'))track(child);child.querySelectorAll('dialog').forEach(track);}}});
 observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['open']});
 function reset(){for(const element of tracked){const state=states.get(element);state.animation?.cancel();state.animation=null;element.classList.remove('gs-resizing');element.style.removeProperty('top');element.style.removeProperty('margin-block');element.style.removeProperty('bottom');state.previous=ready(element)?measure(element):null;}}
 for(const type of ['pointerdown','keydown'])document.addEventListener(type,()=>{for(const element of tracked){const state=states.get(element);if(ready(element)&&!state.animation)state.previous=measure(element);}},true);

 const detailsState=new WeakMap();for(const details of document.querySelectorAll('details'))details.classList.toggle('gs-details-expanded',details.open);
 document.addEventListener('click',event=>{
  const summary=event.target.closest?.('summary');if(!summary||summary.parentElement?.tagName!=='DETAILS')return;event.preventDefault();
  const details=summary.parentElement,old=detailsState.get(details);let body=[...details.children].find(node=>node.classList.contains('gs-details-body'));
  if(!body){body=document.createElement('div');body.className='gs-details-body';for(const node of [...details.childNodes])if(node!==summary)body.append(node);details.append(body);}
  const opening=old?.motion?!old.opening:!details.open,current=details.open?body.getBoundingClientRect().height/(typeof uiScale==='number'?uiScale:1):0,opacity=old?.motion?getComputedStyle(body).opacity:details.open?1:0;
  old?.motion?.cancel();for(const element of tracked){if(element.contains(details)){const state=states.get(element);state.animation?.cancel();state.animation=null;element.classList.remove('gs-resizing');}}details.dataset.detailsAnimating='true';details.classList.toggle('gs-details-expanded',opening);details.open=true;
  const entry={opening,motion:null};detailsState.set(details,entry);
  const finish=()=>{if(detailsState.get(details)!==entry)return;if(!opening)details.open=false;entry.motion?.cancel();entry.motion=null;delete details.dataset.detailsAnimating;for(const element of tracked){const state=states.get(element);if(ready(element)&&!state.animation)state.previous=measure(element);}};
  if(!enabled()||!body.animate){finish();return;}
  entry.motion=body.animate([{height:current+'px',opacity},{height:(opening?body.scrollHeight:0)+'px',opacity:opening?1:0}],{duration:typeof motionDuration==='function'?motionDuration(240):240,easing:'cubic-bezier(.2,.7,.2,1)',fill:'both'});entry.motion.id='gs-details-resize';entry.motion.finished.then(finish).catch(()=>{});
 });
 window.GameShelfMotion={track,reset};
})();
