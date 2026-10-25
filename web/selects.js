/* A shared accessible listbox keeps selects joined to their themed parent control. */
(() => {
 const menu=document.createElement('div');menu.id='gs-select-menu';menu.className='gs-select-menu';menu.setAttribute('role','listbox');menu.setAttribute('popover','manual');menu.tabIndex=-1;document.body.append(menu);
 let anchor=null,index=0,keyboard=false,search='',searchTimer;
 function options(){return [...(anchor?.options||[])].filter(option=>!option.disabled);}
 function position(){if(!anchor)return;const rect=anchor.getBoundingClientRect();menu.style.width=rect.width+'px';menu.style.left=Math.max(8,Math.min(innerWidth-rect.width-8,rect.left))+'px';const room=innerHeight-rect.bottom-12;const above=room<100&&rect.top>room;menu.classList.toggle('gs-select-above',above);anchor.classList.toggle('gs-select-above',above);menu.style.maxHeight=Math.max(80,Math.min(320,above?rect.top-12:room))+'px';menu.style.top=above?'auto':rect.bottom-1+'px';menu.style.bottom=above?innerHeight-rect.top-1+'px':'auto';}
 function close(restore=false){if(!anchor)return;const select=anchor;anchor=null;select.classList.remove('gs-select-open','gs-select-above');select.setAttribute('aria-expanded','false');if(menu.matches(':popover-open'))menu.hidePopover();menu.replaceChildren();document.body.append(menu);if(restore)select.focus({preventScroll:true});else select.blur();}
 function highlight(){const items=[...menu.children];items.forEach((item,i)=>{item.classList.toggle('is-highlighted',i===index);item.setAttribute('aria-selected',String(item.dataset.value===anchor.value));});const item=items[index];if(item){menu.setAttribute('aria-activedescendant',item.id);if(item.offsetTop<menu.scrollTop)menu.scrollTop=item.offsetTop;else if(item.offsetTop+item.offsetHeight>menu.scrollTop+menu.clientHeight)menu.scrollTop=item.offsetTop+item.offsetHeight-menu.clientHeight;}}
 function choose(){if(!anchor)return;const select=anchor,option=options()[index];if(!option)return;select.value=option.value;select.dispatchEvent(new Event('input',{bubbles:true}));select.dispatchEvent(new Event('change',{bubbles:true}));close(keyboard);select.classList.add('gs-select-changed');}
 function open(select,fromKeyboard=false){
  if(select.disabled||select.closest('[inert],.gs-access-disabled,.gs-access-locked'))return;if(anchor===select){close();return;}close();anchor=select;keyboard=fromKeyboard;const entries=options();index=Math.max(0,entries.findIndex(option=>option.value===select.value));
  const dialog=select.closest('dialog');(dialog||document.body).append(menu);menu.setAttribute('aria-label',select.getAttribute('aria-label')||select.closest('label')?.textContent.trim()||'Choose an option');
  for(const [i,option]of entries.entries()){const item=document.createElement('div');item.id='gs-select-option-'+i;item.setAttribute('role','option');item.dataset.value=option.value;item.textContent=option.textContent;item.addEventListener('pointermove',()=>{index=i;highlight();});item.addEventListener('click',()=>{index=i;choose();});menu.append(item);}
  select.classList.add('gs-select-open');select.classList.remove('gs-select-changed');select.setAttribute('aria-expanded','true');select.setAttribute('aria-controls',menu.id);menu.showPopover();position();highlight();menu.focus({preventScroll:true});
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
 addEventListener('resize',()=>close());document.addEventListener('scroll',event=>{if(anchor&&!menu.contains(event.target))close();},true);document.addEventListener('close',()=>close(),true);
 document.addEventListener('change',event=>{if(event.target.matches('select')&&!anchor)event.target.blur();});
 window.GameShelfSelect={close,open};
})();
