/* Family controls: browser affordances plus scoped, short-lived server grants. */
(() => {
 const nativeFetch=window.fetch.bind(window),$=id=>document.getElementById(id);
 let permit=null,menuLease=null,pinHandler=null,pinSettingsResolve=null,pinSettingsSaved=false;
 let state={configured:false,policy:{rules:{}},actions:{},grants:{}},promptPromise=null,promptResolve=null,promptActions=[],loaded=false;
 const replaying=new WeakSet();const controls=new WeakMap();let scheduled=false;
 const labels=()=>state.actions||{};const managerTools=new Set(['sources','storage','refresh','health','healthView']);
 function rule(action){return state.policy?.rules?.[action]||{mode:'allow',hidden:false};}
 function unlocked(action){return menuLease&&menuLease.gates[action]&&Date.parse(menuLease.expiresAt)>Date.now()||Date.parse(state.grants?.[action]||'')>Date.now()||permit&&permit.actions.includes(action)&&Date.parse(permit.until)>Date.now();}
 function mode(action){if(action==='admin')return state.configured?'pin':'allow';if(action==='wipe')return rule(action).mode==='disable'?'disable':state.configured?'pin':'allow';return rule(action).mode||'allow';}
 function actionsFor(action){
  const actions=action==='wipe'?['wipe','admin','sources','storage','refresh','logging','health','playlistRemove','covers','titles','metadata','favoriteRemove','theme','uiScale','motion','tileAnimation','buttonHints','staticTitles','placeholderArt','cardDepth','playlistFeature','listImages','favoritesFirst','pinnedStars','hoverNames','listOpacity','recentRange','imageExpand','stretchDefault']:[action];
  if(managerTools.has(action))actions.push('libraryManager');
  if(action!=='admin'&&!document.body.classList.contains('gs-needs-setup')&&(state.levels?.[action]||managerTools.has(action)||action==='advanced')){
   actions.push('settings');const level=rule(action).level||state.levels?.[action];if(action==='advanced'||level==='advanced'||managerTools.has(action)&&(rule('libraryManager').level||state.levels?.libraryManager)==='advanced')actions.push('advanced');
  }
  return [...new Set(actions)];
 }
 function disabled(action){return actionsFor(action).some(item=>mode(item)==='disable');}
 function locked(actions){return actions.filter(action=>mode(action)==='pin'&&!unlocked(action));}
 async function read(response){try{return await (response.clone?response.clone():response).json();}catch{return null;}}
 function closePrompt(approved){const resolve=promptResolve;promptResolve=null;promptPromise=null;pinHandler=null;$('pin-dialog').close();$('pin-entry').value='';resolve?.(approved);}
 async function ask(actions,force=false){
  actions=[...new Set(actions)];if(promptPromise){const prior=await promptPromise;return prior?ask(actions,force):false;}
  const required=force?actions:locked(actions);if(!required.length)return true;
  if(!state.configured){showNotification('An item requiring a PIN has been selected, but no PIN has been set.','error');return false;}
  pinHandler=null;promptActions=required;$('pin-entry').setAttribute('aria-label','Four-digit Guardian PIN');const remembrance=state.policy.remember||{enabled:true,minutes:5};$('pin-remember-option').hidden=force||!remembrance.enabled;$('pin-remember').checked=false;$('pin-remember').disabled=!remembrance.enabled;$('pin-remember-label').textContent='Remember me for '+remembrance.minutes+' minute'+(remembrance.minutes===1?'':'s')+'.';$('pin-action-label').textContent=required.map(action=>action==='admin'?'Family Controls':labels()[action]||action).join(', ');$('pin-status').textContent='';$('pin-entry').value='';
  promptPromise=new Promise(resolve=>promptResolve=resolve);openModal($('pin-dialog'));setTimeout(()=>$('pin-entry').focus({preventScroll:true}),100);return promptPromise;
 }
 async function authorizedFetch(input,options){
 const path=typeof input==='string'?input:input?.url||'';
 const url=new URL(path,location.href);
 let requestOptions=options;
 if(url.origin===location.origin&&(path.startsWith('/api/')||path.startsWith('/download')||url.pathname.startsWith('/api/')||url.pathname.startsWith('/download'))){
  const headers=new Headers(options?.headers||input?.headers);
  if(permit&&Date.parse(permit.until)>Date.now())headers.set('X-GameShelf-PIN',permit.token);
  if(menuLease&&Date.parse(menuLease.expiresAt)>Date.now())headers.set('X-GameShelf-Menu',menuLease.lease);
  requestOptions={...options,headers};
 }
 const response=await nativeFetch(input,requestOptions);
 if(response.headers?.get('X-GameShelf-PIN-Consumed')==='true')permit=null;
 return response;
}
 async function refresh(manage=false){const response=await authorizedFetch('/api/access'+(manage?'?manage=1':''),{cache:'no-store'});if(!response.ok)throw new Error('Family controls could not be loaded.');state=await response.json();state.policy||={rules:{}};state.grants||={};loaded=true;refreshUI();return state;}
 window.fetch=async(input,options)=>{
  let response=await authorizedFetch(input,options);const path=typeof input==='string'?input:input?.url||'';
  if(path==='/api/access/unlock')return response;
  if(response.status===423){const detail=await read(response);if(detail?.code==='pin_required'){
   permit=null;await refresh();if(await ask(detail.actions||[],(detail.actions||[]).includes('wipe')))response=await authorizedFetch(input,options);else return new Response('Action cancelled.',{status:403});
  }}
  if(response.status===403||response.status===428){const detail=await read(response);if(detail?.message){showNotification(detail.message,'error');await refresh().catch(()=>{});return new Response(detail.message,{status:response.status});}}
  return response;
 };
 function setAction(element,action){if(element&&element.dataset.accessAction!==action)element.dataset.accessAction=action;}
 function bindUI(){
  const rows={'export-library-data':'export','open-library-restore':'restore','open-library-manager':'libraryManager','open-server-settings':'sources','open-refresh-settings':'refresh','configure-logs':'logging','view-logs':'logs','open-reset-settings':'wipe','resume-setup':'setup','open-library-health':'healthView','open-family-controls':'admin'};
  for(const [id,action]of Object.entries(rows)){const button=$(id);if(button){setAction(button,action);if(action==='admin'){const row=button.closest('.gs-settings-backup');if(row)row.dataset.accessLevelSetting='admin';}if(action!=='admin'){const row=button.closest('.gs-settings-backup');if(['logs','logging'].includes(action)){if(row)delete row.dataset.accessSetting;button.dataset.accessLevelSetting=action;}else if(row&&row.dataset.accessSetting!==action)row.dataset.accessSetting=action;}}}
  const preferences={'theme-select':'theme','ui-scale':'uiScale','dynamic-scale':'uiScale','animation-speed':'motion','animate-tiles':'tileAnimation','show-hover-text':'buttonHints','show-game-titles':'staticTitles','show-placeholder-images':'placeholderArt','card-depth':'cardDepth','enable-playlist':'playlistFeature','show-list-images':'listImages','favorites-first':'favoritesFirst','favorite-stars-only':'pinnedStars','hover-game-titles':'hoverNames','list-opacity':'listOpacity','open-recent-settings':'recentRange','expand-list-image':'imageExpand','stretch-covers':'stretchDefault'};
  for(const [id,action]of Object.entries(preferences)){const input=$(id);if(input){const row=input.closest('.gs-settings-option,.gs-settings-backup')||input;if(row.dataset.accessSetting!==action)row.dataset.accessSetting=action;}}

  const fixed={'source-alert-manage':'libraryManager','edit-game-cover':'covers','cover-editor-save':'covers','cover-editor-file':'covers','cover-editor-folder':'covers','cover-rotate-left':'covers','cover-mirror':'covers','cover-snap':'covers','cover-editor-reset':'covers','cover-zoom':'covers','cover-tilt':'covers','game-cover-stretch':'covers','save-game-title':'titles','reset-game-metadata':'metadata','reset-metadata-next':'metadata','favorite-confirm':'favoriteRemove','cart-clear':'playlistRemove','playlist-confirm-accept':'playlistRemove','cart-checkout':'downloads','setup-next':'setup','setup-save':'setup','setup-defer':'setup','setup-add-folder':'sources','setup-add-network':'sources','server-add-folder':'sources','server-add-network':'sources','server-settings-save':'sources','network-test':'sources','network-use':'sources','source-folder-use':'sources','source-remove-confirm':'sources','reset-settings-confirm':'wipe','restore-apply':'restore','restore-browse':'restore','export-confirm':'export','wipe-export-data':'export','logs-copy':'logs','logs-download':'logs','health-check':'healthView','health-save':'health','health-configure':'health','health-view-logs':'healthView','health-logs-copy':'healthView','health-logs-download':'healthView','open-family-controls-setup':'admin'};
  for(const [id,action]of Object.entries(fixed))setAction($(id),action);setAction($('settings-advanced'),'advanced');if(document.body.classList.contains('gs-needs-setup')){delete $('build-info').dataset.accessAction;}else setAction($('build-info'),'settings');setAction(document.querySelector('.gs-cover-preview-upload'),'covers');
  for(const button of document.querySelectorAll('.gs-favorite-star'))setAction(button,button.closest('.gs-card')?.dataset.favorite==='true'?'favoriteRemove':'favoriteAdd');
  const game=typeof gamesCache!=='undefined'?gamesCache.find(item=>item.id===detailsGameId):null;for(const id of ['game-details-favorite','game-details-favorite-mobile'])setAction($(id),game?.favorite?'favoriteRemove':'favoriteAdd');
  for(const button of document.querySelectorAll('.gs-card-cart'))setAction(button,button.classList.contains('is-added')?'playlistRemove':'playlistAdd');
  for(const link of document.querySelectorAll('a[href^="/download"],a[href^="/api/game-file/"]'))setAction(link,'downloads');
 }
 function refreshUI(){
  if(!loaded)return;bindUI();
  for(const element of document.querySelectorAll('[data-access-action],[data-access-setting]')){
   const action=element.dataset.accessAction||element.dataset.accessSetting,blocked=disabled(action),hidden=rule(action).hidden;
   if(blocked)element.dataset.guardianTooltip='This option has been disabled by a GameShelf Guardian.';else delete element.dataset.guardianTooltip;
   element.classList.toggle('gs-access-hidden',!!hidden);element.classList.toggle('gs-access-disabled',blocked);element.classList.toggle('gs-access-locked',!blocked&&locked(actionsFor(action)).length>0);
   for(const control of [element,...element.querySelectorAll('button,input,select,textarea')]){
    if(blocked){
     if(!controls.has(control))controls.set(control,{aria:control.getAttribute('aria-disabled'),inert:control.inert});
     control.inert=true;control.setAttribute('aria-disabled','true');
    }else if(controls.has(control)){
     const previous=controls.get(control);
     control.inert=previous.inert;controls.delete(control);
     if(control.dataset.unavailable!==undefined)control.setAttribute('aria-disabled',String(control.dataset.unavailable==='true'));
     else if(previous.aria===null)control.removeAttribute('aria-disabled');else control.setAttribute('aria-disabled',previous.aria);
    }
   }
  }
  for(const element of document.querySelectorAll('[data-access-setting],[data-access-level-setting]')){if(!element.closest('#settings-dialog'))continue;const action=element.dataset.accessSetting||element.dataset.accessLevelSetting;const level=rule(action).level||state.levels?.[action];if(level==='advanced')element.dataset.settingLevel='advanced';else if(level==='basic')delete element.dataset.settingLevel;}
 }
 function schedule(){if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;refreshUI();});}
 new MutationObserver(schedule).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['data-access-action','data-access-setting','data-favorite']});
 async function intercept(event){
  const element=event.target.closest?.('[data-access-action],[data-access-setting]');if(!element)return;
  if(event.target.closest('#build-info,#settings-advanced,#open-library-manager,#open-family-controls,#open-family-controls-setup,#open-reset-settings,#reset-settings-confirm,#wipe-export-data'))return;
  if(event.target.closest('.gs-settings-close,.gs-cancel-action,[data-access-exempt]'))return;
  const replay=event.target.closest('button,a,input,select');if(replay&&replaying.has(replay))return;
  const action=element.dataset.accessAction||element.dataset.accessSetting,actions=actionsFor(action);
  if(disabled(action)){event.preventDefault();event.stopImmediatePropagation();return;}
  if(event.type==='click'&&permit&&permit.actions.includes(action)&&(action==='playlistAdd'||event.target.closest('#edit-game-cover,#playlist-confirm-accept'))){
    event.preventDefault();event.stopImmediatePropagation();const target=event.target.closest('button,a');if(await enter(action)){replaying.add(target);target.click();replaying.delete(target);}return;
  }
  const required=locked(actions);if(!required.length){if(event.type==='click'&&element.dataset.menuScope&&actionsFor(element.dataset.menuScope).some(a=>mode(a)==='pin')&&!replaying.has(event.target.closest('button'))){event.preventDefault();event.stopImmediatePropagation();const target=event.target.closest('button');if(await enter(element.dataset.menuScope)){replaying.add(target);target.click();replaying.delete(target);}}return;}
  if(event.type==='keydown'&&!['Enter',' ','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','F4'].includes(event.key))return;
  const target=event.target.closest('button,a,input,select,label[for]');
  if(event.type==='pointerdown'&&!target?.matches('select,input[type="range"]'))return;
  if(event.type==='click'&&target?.matches('select,input[type="range"]'))return;
  event.preventDefault();event.stopImmediatePropagation();
  if(await ask(actions)){refreshUI();const scope=element.dataset.menuScope;if(scope&&!await enter(scope))return;if(event.type==='click'&&target){replaying.add(target);target.click();replaying.delete(target);}else if(target?.matches('select')&&window.GameShelfSelect)window.GameShelfSelect.open(target,event.type==='keydown');else target?.focus({preventScroll:true});}
 }
 document.addEventListener('click',intercept,true);document.addEventListener('pointerdown',intercept,true);document.addEventListener('keydown',intercept,true);
 $('pin-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=$('pin-submit');if(button.disabled)return;button.disabled=true;if(!/^\d{4}$/.test($('pin-entry').value)){button.disabled=false;showNotification('Enter a four-digit PIN.','error');return;}
  try{if(pinHandler){const handler=pinHandler;await handler($('pin-entry').value);closePrompt(true);return;}const response=await nativeFetch('/api/access/unlock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:$('pin-entry').value,actions:promptActions,remember:$('pin-remember').checked&&!$('pin-remember-option').hidden})});const result=await read(response);if(!response.ok)throw new Error(result?.message||'Could not unlock. Try again.');if(result.token)permit={token:result.token,actions:result.unlocked,until:result.expiresAt};else for(const action of result.unlocked)state.grants[action]=result.expiresAt;refreshUI();closePrompt(true);}
  catch(error){showNotification(error.message,'error');$('pin-entry').value='';$('pin-entry').focus();}finally{button.disabled=false;}
 });
 for(const id of ['pin-close','pin-cancel'])$(id).addEventListener('click',()=>closePrompt(false));$('pin-dialog').addEventListener('cancel',event=>{event.preventDefault();closePrompt(false);});$('pin-dialog').addEventListener('close',()=>{if(promptResolve){const resolve=promptResolve;promptResolve=null;promptPromise=null;resolve(false);}});
 $('family-remember-enabled').addEventListener('change',()=>{$('family-remember-minutes').disabled=!$('family-remember-enabled').checked;});
 document.addEventListener('click',event=>{if(event.target.closest?.('a[href^="/download"],a[href^="/api/game-file/"]')&&permit)setTimeout(()=>{permit=null;},0);});
 function controlHelp(action){
 const help={settings:'Open the Settings menu.',advanced:'Open the Advanced tab in Settings.',admin:'Manage the Guardian PIN and all permissions. Always protected by the PIN.',libraryManager:'Manage game locations, refresh timing, and library health.',sources:'Add, edit, or remove local folders and network locations.',storage:'Change where GameShelf saves its own data.',refresh:'Change automatic library scanning intervals.',health:'Enable reachability monitoring and choose its interval.',healthView:'View library reachability and connection history.',theme:'Choose this browser’s theme.',uiScale:'Adjust the interface size from 75% to 150%.',motion:'Adjust the speed of animations, or turn motion off.',tileAnimation:'Animate game tiles as the library loads.',buttonHints:'Show GameShelf hints when hovering over controls.',staticTitles:'Keep game names visible below covers.',placeholderArt:'Show GameShelf artwork for games without covers.',cardDepth:'Add soft shadows and depth to game tiles.',stretchDefault:'Set the default cover fit; individual games can override it.',playlistFeature:'Show Playlist tools for collecting downloads.',listImages:'Display cover previews in list view.',favoritesFirst:'Place favorite games ahead of other games.',pinnedStars:'Keep active favorite stars visible on cards.',hoverNames:'Reveal the game name on hover.',listOpacity:'Choose the background opacity of list tiles.',recentRange:'Choose how many days count as Recently Added.',imageExpand:'Open a larger list image with one click, two clicks, or never.',export:'Download a backup of selected GameShelf data.',restore:'Replace selected saved data using a backup ZIP.',logging:'Choose the log sources and retention limits.',logs:'View, copy, or download application logs.',setup:'Resume unfinished first-time setup.',wipe:'Permanently remove all GameShelf data. Original game files stay untouched.',covers:'Edit artwork and its fit without changing original game files.',titles:'Change the title displayed by GameShelf.',favoriteAdd:'Mark a game as a favorite.',favoriteRemove:'Remove a game from favorites.',metadata:'Reset a game’s saved metadata.',playlistAdd:'Add games to the download Playlist.',playlistRemove:'Remove games from or clear the Playlist.',downloads:'Download games and individual files.'};
 return help[action]||labels()[action]+' controls.';
 }
 function policyRows(){
  const list=$('family-rules');list.replaceChildren();const groupOrder=['Settings access','Appearance','Library View','Data and Diagnostics','Game actions','Library Manager'];
  const entries=Object.entries(labels()).sort((a,b)=>{const ga=state.groups?.[a[0]]||'Game actions',gb=state.groups?.[b[0]]||'Game actions';return groupOrder.indexOf(ga)-groupOrder.indexOf(gb)||(a[0]==='libraryManager'?-1:b[0]==='libraryManager'?1:a[1].localeCompare(b[1]));});let previousGroup='',section=null;
  for(const [action,label]of entries){
   const group=state.groups?.[action]||'Game actions';if(group!==previousGroup){const heading=document.createElement('h3');heading.className='gs-family-group-title';heading.textContent=group;section=document.createElement('section');section.className='gs-family-group';section.append(heading);list.append(section);previousGroup=group;}
   const row=document.createElement('div');row.className='gs-family-rule';row.dataset.action=action;const name=document.createElement('span');name.textContent=label;name.tabIndex=0;name.dataset.tooltip=controlHelp(action);
   const select=document.createElement('select');select.className='gs-family-access';select.setAttribute('aria-label',label+' access');const gate=action==='settings'||action==='advanced',admin=action==='admin';
   for(const [value,text]of [['allow','Allow'],['pin','Require PIN'],['disable','Disable']]){if((gate||admin)&&value==='disable')continue;const option=document.createElement('option');option.value=value;option.textContent=text;select.append(option);}select.value=admin?(state.configured?'pin':'allow'):rule(action).mode||'allow';select.disabled=admin&&state.configured;
   let category;const defaultLevel=state.levels?.[action];if(defaultLevel){category=document.createElement('select');category.className='gs-family-level';category.setAttribute('aria-label',label+' category');for(const value of ['basic','advanced']){const option=document.createElement('option');option.value=value;option.textContent=value==='basic'?'Basic':'Advanced';category.append(option);}category.value=rule(action).level||defaultLevel;}else{category=document.createElement('span');category.className='gs-family-category-note';category.dataset.kind=managerTools.has(action)?'manager':'none';category.textContent='—';}
   const visible=document.createElement('input');visible.type='checkbox';visible.checked=!rule(action).hidden;visible.disabled=gate||admin;visible.setAttribute('aria-label','Show '+label+' controls');row.append(name,select,category,visible);section.appendChild(row);
  }
 }
 async function prepareFamily(){if(state.configured&&!await enter('admin'))return false;await refresh(true);const remember=state.policy.remember||{enabled:true,minutes:5};$('family-remember-enabled').checked=remember.enabled;$('family-remember-minutes').value=remember.minutes;$('family-remember-minutes').disabled=!remember.enabled;$('family-new-pin').value='';$('family-confirm-pin').value='';$('family-pin-label').textContent=state.configured?'New PIN':'PIN';$('family-status').textContent='';$('family-remove').hidden=!state.configured;$('family-open-pin').textContent=state.configured?'PIN Settings':'Create 4-digit PIN';policyRows();return true;}
 async function openFamily(){if(await prepareFamily())openModal($('family-dialog'));}
 async function openPIN(selectedGuardian){if(pinSettingsResolve)return false;if(!$('family-dialog').open&&!await prepareFamily())return false;$('family-new-pin').value='';$('family-confirm-pin').value='';$('family-pin-title').textContent=state.configured?'Guardian PINs':'Create Guardian PIN';$('family-guardian-field').hidden=!state.configured;$('family-guardian-select').value=selectedGuardian||'guardian-1';$('family-guardian-select').options[1].textContent=state.guardians?.some(g=>g.id==='guardian-2')?'Guardian 2':'Add Guardian 2';$('family-auto-profile').checked=false;$('family-pin-label').textContent=state.configured?'New PIN':'PIN';pinSettingsSaved=false;openModal($('family-pin-dialog'));return new Promise(resolve=>pinSettingsResolve=resolve);}
 for(const id of ['open-family-controls'])$(id).addEventListener('click',()=>openFamily().catch(error=>showNotification(error.message)));
 for(const id of ['family-close','family-cancel'])$(id).addEventListener('click',()=>$('family-dialog').close());
 async function savePolicy(pin,remember,button){
  const rules={};for(const row of $('family-rules').querySelectorAll('.gs-family-rule')){const category=row.querySelector('.gs-family-level');rules[row.dataset.action]={mode:row.querySelector('.gs-family-access').value,hidden:!row.querySelector('input').checked,...(category?{level:category.value}:{})};}
  if(!state.configured&&!pin&&Object.values(rules).some(rule=>rule.mode==='pin')){showNotification('An item requiring a PIN has been selected, but no PIN has been set.','error');return false;}
  button.disabled=true;try{
   const response=await window.fetch('/api/access',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({newPin:pin,guardianID:$('family-guardian-select').value||'guardian-1',autoProfile:$('family-auto-profile').checked,policy:{rules,remember}})});
   const saved=await read(response);if(!response.ok){throw new Error(saved?.message||await response.text());}
   permit=null;menuLease=null;await refresh();if(saved?.lease){menuLease=saved;}else if(saved?.created&&pin){const unlocked=await nativeFetch('/api/access/unlock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin,actions:['admin'],remember:false})});const grant=await read(unlocked);if(unlocked.ok&&grant?.token){permit={token:grant.token,actions:grant.unlocked,until:grant.expiresAt};await enter('admin');}}await loadServerSettings();showSaveFeedback(button);showNotification(pin?'Guardian PIN saved.':'Family controls saved.');return true;
  }catch(error){showNotification(error.message||'Could not save family controls.','error');return false;}finally{button.disabled=false;}
 }
 $('family-save').addEventListener('click',async()=>{if(await savePolicy('',state.policy.remember||{enabled:true,minutes:5},$('family-save')))$('family-dialog').close();});
 $('family-guardian-select').addEventListener('change',()=>{$('family-new-pin').value='';$('family-confirm-pin').value='';$('family-auto-profile').checked=false;});
 $('family-open-pin').addEventListener('click',()=>openPIN().catch(error=>showNotification(error.message,'error')));
 for(const id of ['family-pin-close','family-pin-cancel'])$(id).addEventListener('click',()=>$('family-pin-dialog').close());
 $('family-pin-save').addEventListener('click',async()=>{
  const wasConfigured=state.configured,pin=$('family-new-pin').value,minutes=Number($('family-remember-minutes').value);
  if((!state.configured||pin)&&(!/^\d{4}$/.test(pin)||pin!==$('family-confirm-pin').value)){showNotification('Enter the same four-digit PIN twice.','error');return;}
  if(!Number.isInteger(minutes)||minutes<1||minutes>60){showNotification('Choose 1–60 minutes.','error');return;}
  if(await savePolicy(pin,{enabled:$('family-remember-enabled').checked,minutes},$('family-pin-save'))){pinSettingsSaved=true;$('family-pin-dialog').close();policyRows();if(pin&&wasConfigured)$('family-dialog').close();}
 });
 $('family-pin-dialog').addEventListener('close',()=>{$('family-new-pin').value='';$('family-confirm-pin').value='';const resolve=pinSettingsResolve;pinSettingsResolve=null;resolve?.(pinSettingsSaved);});
 addEventListener('DOMContentLoaded',()=>closeOnBackdropClick($('family-pin-dialog')));
 $('family-remove').addEventListener('click',()=>openModal($('family-remove-dialog')));for(const id of ['family-remove-close','family-remove-cancel'])$(id).addEventListener('click',()=>$('family-remove-dialog').close());
 $('family-remove-confirm').addEventListener('click',async()=>{if(!await ask(['admin']))return;const response=await window.fetch('/api/access',{method:'DELETE'});if(!response.ok){showNotification('Could not remove family controls.');return;}await refresh();await loadServerSettings();$('family-remove-dialog').close();$('family-dialog').close();showNotification('Family controls removed.');});
 addEventListener('DOMContentLoaded',()=>{closeOnBackdropClick($('pin-dialog'),()=>closePrompt(false));closeOnBackdropClick($('family-dialog'));closeOnBackdropClick($('family-remove-dialog'));});
 addEventListener('focus',()=>{if(loaded)refresh().catch(()=>{});});setInterval(()=>{if(loaded&&document.visibilityState==='visible')refresh().catch(()=>{});},30000);
 async function enter(action){
  const level=action==='settings'&&typeof settingsLevel!=='undefined'?settingsLevel:undefined;
  const response=await window.fetch('/api/access/enter',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,level})});
  if(response.status===428&&!state.configured&&['settings','advanced'].includes(action)){await openFamily();$('family-open-pin').click();return false;}
  if(response.ok&&response.status!==204){const result=await read(response);if(result?.lease)menuLease=result;refreshUI();}if(response.ok&&['libraryManager','sources','storage','refresh','logging','health'].includes(action)&&!await loadServerSettings()){showNotification('Could not load settings. Please try again.','error');return false;}return response.ok;
 }
 async function leave(scope){if(!menuLease)return;const headers={'Content-Type':'application/json','X-GameShelf-Menu':menuLease.lease};if(scope==='settings')menuLease=null;else delete menuLease.gates[scope];await nativeFetch('/api/access/leave',{method:'POST',headers,body:JSON.stringify({scope})});refreshUI();}
 for(const [id,scope]of [['settings-dialog','settings'],['family-dialog','admin'],['library-manager-dialog','libraryManager']])$(id).addEventListener('close',()=>leave(scope).catch(()=>{}));

 for(const [id,scope,dialog]of [['open-reset-settings','wipe','reset-settings-dialog'],['open-server-settings','sources','server-settings-dialog'],['open-refresh-settings','refresh','refresh-settings-dialog'],['configure-logs','logging','logs-settings-dialog'],['view-logs','logs','logs-dialog'],['open-library-health','healthView','health-dialog'],['health-configure','health','health-config-dialog'],['export-library-data','export','export-dialog'],['open-library-restore','restore','restore-dialog'],['edit-game-cover','covers','cover-editor-dialog'],['open-recent-settings','recentRange','recent-settings-dialog']]){if($(id))$(id).dataset.menuScope=scope;if($(dialog)&&scope!=='wipe')$(dialog).addEventListener('close',()=>leave(scope).catch(()=>{}));}
 for(const id of ['reset-settings-dialog','wipe-final-dialog'])$(id).addEventListener('close',()=>setTimeout(()=>{if(!$('reset-settings-dialog').open&&!$('wipe-final-dialog').open)leave('wipe').catch(()=>{});},0));
 $('family-dialog').addEventListener('close',()=>refresh().catch(()=>{}));
 async function promptPIN(label,handler){if(promptPromise)await promptPromise;pinHandler=handler;promptActions=[];$('pin-title').textContent='PIN Required';$('pin-action-label').textContent=label;$('pin-entry').setAttribute('aria-label','PIN for '+label);$('pin-remember-option').hidden=true;$('pin-entry').value='';promptPromise=new Promise(resolve=>promptResolve=resolve);openModal($('pin-dialog'));setTimeout(()=>$('pin-entry').focus({preventScroll:true}),100);return promptPromise;}
 window.GameShelfAccess={fresh:async actions=>{await refresh();return ask([...new Set(actions)],true);},actionsFor,available:action=>!rule(action).hidden&&mode(action)!=='disable',configured:()=>state.configured,help:controlHelp,openPIN,promptPIN,initialize:refresh,refresh,refreshUI,mode,ask,enter,openFamily,leave,canUse:action=>mode(action)==='allow'||unlocked(action)};
})();
