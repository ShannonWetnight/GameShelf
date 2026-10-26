/* A shared accessible listbox keeps selects joined to their themed parent control. */
(() => {
 const menu=document.createElement('div');menu.id='gs-select-menu';menu.className='gs-select-menu';menu.setAttribute('role','listbox');menu.setAttribute('popover','manual');menu.tabIndex=-1;document.body.append(menu);
 let anchor=null,index=0,keyboard=false,search='',searchTimer,motion=null,version=0,ignoreScrollUntil=0,positionFrame=null;
 function options(){return [...(anchor?.options||[])].filter(option=>!option.disabled);}
 function position(){if(!anchor)return;const scale=typeof uiScale==='number'?uiScale:1,raw=anchor.getBoundingClientRect(),rect={width:raw.width/scale,left:raw.left/scale,top:raw.top/scale,bottom:raw.bottom/scale};const viewWidth=innerWidth/scale,viewHeight=innerHeight/scale,style=(key,value)=>{if(menu.style[key]!==value)menu.style[key]=value;};style('width',rect.width+'px');style('left',Math.max(8,Math.min(viewWidth-rect.width-8,rect.left))+'px');const room=viewHeight-rect.bottom-12,above=room<100&&rect.top>room;menu.classList.toggle('gs-select-above',above);anchor.classList.toggle('gs-select-above',above);const row=Math.ceil((menu.firstElementChild?.getBoundingClientRect().height/scale||38)-.01),space=Math.max(row,Math.min(320,above?rect.top-12:room)),count=Math.max(1,Math.min(menu.children.length,Math.floor((space-1)/row)));for(const item of menu.children)item.style.height=row+'px';style('height',(count*row+1)+'px');style('maxHeight','none');style('top',above?'auto':rect.bottom-1+'px');style('bottom',above?viewHeight-rect.top-1+'px':'auto');}
 function animateMenu(opening,done){
  const current=motion?.playState==='running'?{clipPath:getComputedStyle(menu).clipPath,opacity:getComputedStyle(menu).opacity}:null;motion?.cancel();const reduced=document.body.classList.contains('gs-no-animations')||matchMedia('(prefers-reduced-motion: reduce)').matches;
  const edge=menu.classList.contains('gs-select-above')?'inset(100% 0 0 0)':'inset(0 0 100% 0)';
  if(reduced||!menu.animate){done?.();return;}
  motion=menu.animate(opening?[{clipPath:edge,opacity:0},{clipPath:'inset(0 0 0 0)',opacity:1}]:[current||{clipPath:'inset(0 0 0 0)',opacity:1},{clipPath:edge,opacity:0}],{duration:typeof motionDuration==='function'?motionDuration(190):190,easing:'cubic-bezier(.2,.7,.2,1)',fill:'both'});
  motion.id='gs-dropdown';motion.finished.then(()=>done?.()).catch(()=>{});
 }
 function close(restore=false,immediate=false){
  if(!anchor)return;cancelAnimationFrame(positionFrame);const select=anchor,closing=++version;anchor=null;menu.inert=true;select.setAttribute('aria-expanded','false');select.classList.add('gs-select-closing');
  const finish=()=>{if(closing!==version)return;if(menu.matches(':popover-open'))menu.hidePopover();motion?.cancel();select.classList.remove('gs-select-open','gs-select-above','gs-select-closing');menu.replaceChildren();document.body.append(menu);menu.inert=false;};
  if(immediate){motion?.cancel();finish();}else animateMenu(false,finish);
  if(restore)select.focus({preventScroll:true});else select.blur();
 }
 function highlight(){const items=[...menu.children];items.forEach((item,i)=>{item.classList.toggle('is-highlighted',i===index);item.setAttribute('aria-selected',String(item.dataset.value===anchor.value));});const item=items[index];if(item){menu.setAttribute('aria-activedescendant',item.id);if(item.offsetTop<menu.scrollTop)menu.scrollTop=item.offsetTop;else if(item.offsetTop+item.offsetHeight>menu.scrollTop+menu.clientHeight)menu.scrollTop=item.offsetTop+item.offsetHeight-menu.clientHeight;}}
 function choose(){if(!anchor)return;const select=anchor,option=options()[index];if(!option)return;select.value=option.value;select.dispatchEvent(new Event('input',{bubbles:true}));select.dispatchEvent(new Event('change',{bubbles:true}));close(keyboard);select.classList.add('gs-select-changed');}
 function open(select,fromKeyboard=false){
  if(select.disabled||select.closest('[inert],.gs-access-disabled,.gs-access-locked'))return;if(anchor===select){close();return;}close(false,true);motion?.cancel();version++;menu.replaceChildren();menu.inert=false;anchor=select;keyboard=fromKeyboard;const entries=options();index=Math.max(0,entries.findIndex(option=>option.value===select.value));
  const bounds=select.getBoundingClientRect();if(bounds.top<0||bounds.bottom>innerHeight)select.scrollIntoView({block:'nearest',behavior:'instant'});ignoreScrollUntil=Date.now()+100;
  const dialog=select.closest('dialog');(dialog||document.body).append(menu);menu.setAttribute('aria-label',select.getAttribute('aria-label')||select.closest('label')?.textContent.trim()||'Choose an option');
  for(const [i,option]of entries.entries()){const item=document.createElement('div');item.id='gs-select-option-'+i;item.setAttribute('role','option');item.dataset.value=option.value;item.textContent=option.textContent;item.addEventListener('pointermove',()=>{if(index!==i){index=i;highlight();}});item.addEventListener('click',()=>{index=i;choose();});menu.append(item);}
  select.classList.remove('gs-select-closing');select.classList.add('gs-select-open');select.classList.remove('gs-select-changed');select.setAttribute('aria-expanded','true');select.setAttribute('aria-controls',menu.id);menu.showPopover();position();highlight();menu.focus({preventScroll:true});cancelAnimationFrame(positionFrame);let lastBounds='';const follow=()=>{if(anchor!==select)return;const rect=select.getBoundingClientRect(),bounds=[rect.x,rect.y,rect.width,rect.height].map(n=>Math.round(n*10)).join(',');if(bounds!==lastBounds){position();lastBounds=bounds;}positionFrame=requestAnimationFrame(follow);};positionFrame=requestAnimationFrame(follow);animateMenu(true);
 }
 document.addEventListener('pointerdown',event=>{const select=event.target.closest('select');if(select){event.preventDefault();open(select);return;}if(anchor&&!menu.contains(event.target))close();},true);
 document.addEventListener('mousedown',event=>{if(event.target.closest('select'))event.preventDefault();},true);
 document.addEventListener('click',event=>{const select=event.target.closest('select');if(select){event.preventDefault();if(event.detail===0&&!anchor)open(select,true);}},true);
 document.addEventListener('keydown',event=>{
  const select=event.target.closest('select');if(!anchor&&select&&['ArrowDown','ArrowUp','Enter',' ','F4'].includes(event.key)){event.preventDefault();open(select,true);return;}if(!anchor)return;
  const entries=options();if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();close(true);return;}if(event.key==='Tab'){close(true);return;}
  if(['ArrowDown','ArrowUp','Home','End','Enter',' '].includes(event.key)){event.preventDefault();if(event.key==='Enter'||event.key===' '){choose();return;}index=event.key==='Home'?0:event.key==='End'?entries.length-1:Math.max(0,Math.min(entries.length-1,index+(event.key==='ArrowDown'?1:-1)));highlight();}
  else if(event.key.length===1&&!event.ctrlKey&&!event.metaKey){event.preventDefault();event.stopPropagation();clearTimeout(searchTimer);search+=event.key.toLowerCase();const found=entries.findIndex(option=>option.textContent.toLowerCase().startsWith(search));if(found>=0){index=found;highlight();}searchTimer=setTimeout(()=>search='',600);}
 },true);
 document.addEventListener('focusout',event=>{if(event.target.matches('select'))event.target.classList.remove('gs-select-changed');});
 addEventListener('resize',()=>close());document.addEventListener('scroll',event=>{if(anchor&&!menu.contains(event.target)){if(Date.now()<ignoreScrollUntil)position();else close();}},true);document.addEventListener('close',()=>close(),true);
 document.addEventListener('change',event=>{if(event.target.matches('select')&&!anchor)event.target.blur();});
 window.GameShelfSelect={close,open};
})();
