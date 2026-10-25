/* Family controls: browser affordances plus scoped, short-lived server grants. */
(() => {
 const nativeFetch=window.fetch.bind(window),$=id=>document.getElementById(id);
 let state={configured:false,policy:{rules:{}},actions:{},grants:{}},promptPromise=null,promptResolve=null,promptActions=[],loaded=false;
 const controls=new WeakMap();let scheduled=false;
 const labels=()=>state.actions||{};
 function rule(action){return state.policy?.rules?.[action]||{mode:'allow',hidden:false};}
 function unlocked(action){return Date.parse(state.grants?.[action]||'')>Date.now();}
 function mode(action){if(action==='admin')return state.configured?'pin':'allow';return rule(action).mode||'allow';}
 function actionsFor(action){return action==='wipe'?['wipe','sources','storage','refresh','logging','health','playlistRemove','theme','motion','tileAnimation','buttonHints','staticTitles','placeholderArt','cardDepth','playlistFeature','listImages','favoritesFirst','pinnedStars','hoverNames','listOpacity','recentRange','imageExpand','stretchDefault']:[action];}
 function disabled(action){return actionsFor(action).some(item=>mode(item)==='disable');}
 function locked(actions){return actions.filter(action=>mode(action)==='pin'&&!unlocked(action));}
 async function read(response){try{return await (response.clone?response.clone():response).json();}catch{return null;}}
 function closePrompt(approved){const resolve=promptResolve;promptResolve=null;promptPromise=null;$('pin-dialog').close();$('pin-entry').value='';resolve?.(approved);}
 async function ask(actions){
  actions=[...new Set(actions)];if(promptPromise){const prior=await promptPromise;return prior?ask(actions):false;}
  const required=locked(actions);if(!required.length)return true;
  if(!state.configured){showNotification('Create a new family PIN in Advanced Settings to activate restored controls.');return false;}
  promptActions=required;$('pin-action-label').textContent=required.map(action=>action==='admin'?'Family Controls':labels()[action]||action).join(', ');$('pin-status').textContent='';$('pin-entry').value='';
  promptPromise=new Promise(resolve=>promptResolve=resolve);openModal($('pin-dialog'));setTimeout(()=>$('pin-entry').focus({preventScroll:true}),100);return promptPromise;
 }
 async function refresh(){const response=await nativeFetch('/api/access',{cache:'no-store'});if(!response.ok)throw new Error('Family controls could not be loaded.');state=await response.json();state.policy||={rules:{}};state.grants||={};loaded=true;refreshUI();return state;}
 window.fetch=async(input,options)=>{
  let response=await nativeFetch(input,options);const path=typeof input==='string'?input:input?.url||'';
  if(path==='/api/access/unlock')return response;
  if(response.status===423){const detail=await read(response);if(detail?.code==='pin_required'){
   await refresh();if(await ask(detail.actions||[]))response=await nativeFetch(input,options);else return new Response('Action cancelled.',{status:403});
  }}
  if(response.status===403||response.status===428){const detail=await read(response);if(detail?.message){showNotification(detail.message);await refresh().catch(()=>{});return new Response(detail.message,{status:response.status});}}
  return response;
 };
 function setAction(element,action){if(element&&element.dataset.accessAction!==action)element.dataset.accessAction=action;}
 function bindUI(){
  const rows={'export-library-data':'export','open-library-restore':'restore','open-server-settings':'sources','open-refresh-settings':'refresh','configure-logs':'logging','view-logs':'logs','open-reset-settings':'wipe','resume-setup':'setup','open-library-health':'healthView','open-family-controls':'admin'};
  for(const [id,action]of Object.entries(rows)){const button=$(id);if(button){setAction(button,action);if(action!=='admin'){const row=button.closest('.gs-settings-backup');if(row&&row.dataset.accessSetting!==action)row.dataset.accessSetting=action;}}}
  const preferences={'theme-select':'theme','animation-speed':'motion','animate-tiles':'tileAnimation','show-hover-text':'buttonHints','show-game-titles':'staticTitles','show-placeholder-images':'placeholderArt','card-depth':'cardDepth','enable-playlist':'playlistFeature','show-list-images':'listImages','favorites-first':'favoritesFirst','favorite-stars-only':'pinnedStars','hover-game-titles':'hoverNames','list-opacity':'listOpacity','open-recent-settings':'recentRange','expand-list-image':'imageExpand','stretch-covers':'stretchDefault'};
  for(const [id,action]of Object.entries(preferences)){const input=$(id);if(input){const row=input.closest('.gs-settings-option,.gs-settings-backup')||input;if(row.dataset.accessSetting!==action)row.dataset.accessSetting=action;}}

  const fixed={'edit-game-cover':'covers','cover-editor-save':'covers','cover-editor-file':'covers','cover-editor-folder':'covers','cover-rotate-left':'covers','cover-mirror':'covers','cover-editor-reset':'covers','cover-zoom':'covers','cover-tilt':'covers','game-cover-stretch':'covers','save-game-title':'titles','reset-game-metadata':'metadata','reset-metadata-next':'metadata','favorite-confirm':'favoriteRemove','cart-clear':'playlistRemove','cart-checkout':'downloads','setup-next':'setup','setup-save':'setup','setup-defer':'setup','setup-add-folder':'sources','setup-add-network':'sources','server-add-folder':'sources','server-add-network':'sources','server-settings-save':'sources','network-test':'sources','network-use':'sources','source-folder-use':'sources','source-remove-confirm':'sources','reset-settings-confirm':'wipe','restore-apply':'restore','export-confirm':'export','logs-copy':'logs','logs-download':'logs','health-check':'healthView','health-save':'health','open-family-controls-setup':'admin'};
  for(const [id,action]of Object.entries(fixed))setAction($(id),action);setAction(document.querySelector('.gs-cover-preview-upload'),'covers');
  for(const button of document.querySelectorAll('.gs-favorite-star'))setAction(button,button.closest('.gs-card')?.dataset.favorite==='true'?'favoriteRemove':'favoriteAdd');
  const game=typeof gamesCache!=='undefined'?gamesCache.find(item=>item.id===detailsGameId):null;for(const id of ['game-details-favorite','game-details-favorite-mobile'])setAction($(id),game?.favorite?'favoriteRemove':'favoriteAdd');
  for(const button of document.querySelectorAll('.gs-card-cart'))setAction(button,button.classList.contains('is-added')?'playlistRemove':'playlistAdd');
  for(const link of document.querySelectorAll('a[href^="/download"],a[href^="/api/game-file/"]'))setAction(link,'downloads');
 }
 function refreshUI(){
  if(!loaded)return;bindUI();
  for(const element of document.querySelectorAll('[data-access-action],[data-access-setting]')){
   const action=element.dataset.accessAction||element.dataset.accessSetting,blocked=disabled(action),hidden=rule(action).hidden;
   element.classList.toggle('gs-access-hidden',!!hidden);element.classList.toggle('gs-access-disabled',blocked);element.classList.toggle('gs-access-locked',!blocked&&locked(actionsFor(action)).length>0);
   for(const control of [element,...element.querySelectorAll('button,input,select,textarea')]){
    if(blocked){
     if(!controls.has(control))controls.set(control,{disabled:control.disabled||false,aria:control.getAttribute('aria-disabled'),inert:control.inert});
     if('disabled'in control)control.disabled=true;control.inert=true;control.setAttribute('aria-disabled','true');
    }else if(controls.has(control)){
     const previous=controls.get(control);if('disabled'in control&&control.disabled)control.disabled=previous.disabled;
     control.inert=previous.inert;controls.delete(control);
     if(control.dataset.unavailable!==undefined)control.setAttribute('aria-disabled',String(control.dataset.unavailable==='true'));
     else if(previous.aria===null)control.removeAttribute('aria-disabled');else control.setAttribute('aria-disabled',previous.aria);
    }
   }
  }
 }
 function schedule(){if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;refreshUI();});}
 new MutationObserver(schedule).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['data-access-action','data-access-setting','data-favorite']});
 async function intercept(event){
  const element=event.target.closest?.('[data-access-action],[data-access-setting]');if(!element)return;
  if(event.target.closest('.gs-settings-close,.gs-cancel-action,[data-access-exempt]'))return;
  const action=element.dataset.accessAction||element.dataset.accessSetting,actions=actionsFor(action);
  if(disabled(action)){event.preventDefault();event.stopImmediatePropagation();return;}
  const required=locked(actions);if(!required.length)return;
  if(event.type==='keydown'&&!['Enter',' ','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key))return;
  const target=event.target.closest('button,a,input,select,label[for]');
  if(event.type==='pointerdown'&&!target?.matches('select,input[type="range"]'))return;
  if(event.type==='click'&&target?.matches('select,input[type="range"]'))return;
  event.preventDefault();event.stopImmediatePropagation();
  if(await ask(actions)){refreshUI();if(event.type==='click'&&target)target.click();else target?.focus({preventScroll:true});}
 }
 document.addEventListener('click',intercept,true);document.addEventListener('pointerdown',intercept,true);document.addEventListener('keydown',intercept,true);
 $('pin-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=$('pin-submit');if(button.disabled)return;button.disabled=true;$('pin-status').textContent='Checking PIN…';
  try{const response=await nativeFetch('/api/access/unlock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:$('pin-entry').value,actions:promptActions})});const result=await read(response);if(!response.ok)throw new Error(result?.message||'Could not unlock. Try again.');for(const action of result.unlocked)state.grants[action]=result.expiresAt;refreshUI();closePrompt(true);}
  catch(error){$('pin-status').textContent=error.message;$('pin-entry').value='';$('pin-entry').focus();}finally{button.disabled=false;}
 });
 for(const id of ['pin-close','pin-cancel'])$(id).addEventListener('click',()=>closePrompt(false));$('pin-dialog').addEventListener('cancel',event=>{event.preventDefault();closePrompt(false);});$('pin-dialog').addEventListener('close',()=>{if(promptResolve){const resolve=promptResolve;promptResolve=null;promptPromise=null;resolve(false);}});
 function policyRows(){
  const list=$('family-rules');list.replaceChildren();for(const [action,label]of Object.entries(labels())){
   const row=document.createElement('div');row.className='gs-family-rule';row.dataset.action=action;const name=document.createElement('span');name.textContent=label;
   const select=document.createElement('select');select.setAttribute('aria-label',label+' access');for(const [value,text]of [['allow','Allow'],['pin','Require PIN'],['disable','Disable']]){const option=document.createElement('option');option.value=value;option.textContent=text;select.appendChild(option);}select.value=rule(action).mode||'allow';
   const visible=document.createElement('input');visible.type='checkbox';visible.checked=!rule(action).hidden;visible.setAttribute('aria-label','Show '+label+' controls');row.append(name,select,visible);list.appendChild(row);
  }
 }
 async function openFamily(){if(!await ask(['admin']))return;await refresh();$('family-new-pin').value='';$('family-confirm-pin').value='';$('family-pin-label').textContent=state.configured?'New PIN (optional)':'Create a four-digit PIN';$('family-status').textContent='';$('family-remove').hidden=!state.configured;policyRows();openModal($('family-dialog'));}
 for(const id of ['open-family-controls','open-family-controls-setup'])$(id).addEventListener('click',()=>openFamily().catch(error=>showNotification(error.message)));
 for(const id of ['family-close','family-cancel'])$(id).addEventListener('click',()=>$('family-dialog').close());
 $('family-save').addEventListener('click',async()=>{
  const pin=$('family-new-pin').value,confirm=$('family-confirm-pin').value;if((!state.configured||pin)&&(!/^\d{4}$/.test(pin)||pin!==confirm)){$('family-status').textContent='Enter the same four-digit PIN twice.';return;}
  const rules={};for(const row of $('family-rules').children)rules[row.dataset.action]={mode:row.querySelector('select').value,hidden:!row.querySelector('input').checked};const button=$('family-save');button.disabled=true;
  try{const response=await window.fetch('/api/access',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({newPin:pin,policy:{rules}})});if(!response.ok){const detail=await read(response);throw new Error(detail?.message||await response.text());}await refresh();await loadServerSettings();showSaveFeedback(button);$('family-dialog').close();showNotification('Family controls saved.');}
  catch(error){$('family-status').textContent=error.message||'Could not save family controls.';}finally{button.disabled=false;}
 });
 $('family-remove').addEventListener('click',()=>openModal($('family-remove-dialog')));for(const id of ['family-remove-close','family-remove-cancel'])$(id).addEventListener('click',()=>$('family-remove-dialog').close());
 $('family-remove-confirm').addEventListener('click',async()=>{if(!await ask(['admin']))return;const response=await window.fetch('/api/access',{method:'DELETE'});if(!response.ok){showNotification('Could not remove family controls.');return;}await refresh();await loadServerSettings();$('family-remove-dialog').close();$('family-dialog').close();showNotification('Family controls removed.');});
 addEventListener('DOMContentLoaded',()=>{closeOnBackdropClick($('pin-dialog'),()=>closePrompt(false));closeOnBackdropClick($('family-dialog'));closeOnBackdropClick($('family-remove-dialog'));});
 addEventListener('focus',()=>{if(loaded)refresh().catch(()=>{});});setInterval(()=>{if(loaded&&document.visibilityState==='visible')refresh().catch(()=>{});},30000);
 window.GameShelfAccess={initialize:refresh,refresh,refreshUI,mode,ask};
})();
