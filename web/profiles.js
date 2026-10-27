/* Personal shelves use their own identity; the shared Guardian PIN protects management. */
(() => {
 const $=id=>document.getElementById(id),builtins=new Set(['child','adult','elevated','administrator']);
 let state={enabled:false,profiles:[]},management,catalog=[],editing,editingRole,pendingRemoval,required=false,initializing,enabledDraft=false,libraryWarningApproved=false;
 const notifyError=error=>showNotification(error.message||'Could not save these choices.','error');
 async function request(url,options){const response=await fetch(url,options);if(!response.ok){const text=await response.text();let message=text;try{message=JSON.parse(text).message||text;}catch{}throw new Error(message||'GameShelf could not complete that request.');}return response.status===204?null:response.json();}
 async function ownerAccess(){if(!await GameShelfAccess.enter('admin'))throw new Error('Guardian approval is required.');}
 const post=async body=>{await ownerAccess();return request('/api/profiles',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});};
 function button(text,action,danger=false){const node=document.createElement('button');node.type='button';node.className=danger?'gs-danger-action':'gs-detail-action';node.textContent=text;node.addEventListener('click',()=>Promise.resolve(action()).catch(notifyError));return node;}
 function iconButton(label,action,path,danger=false){const node=button('',action,danger);node.className='gs-settings-close'+(danger?' gs-danger-icon':'');node.setAttribute('aria-label',label);node.dataset.tooltip=label;node.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="'+path+'"/></svg>';return node;}
 function roleName(id){return id==='administrator'?'Guardian':management?.roles?.[id]?.name||state.roleNames?.[id]||({child:'Child',adult:'Adult',elevated:'Elevated User'}[id])||id;}
 function roleBadge(id){const span=document.createElement('span');span.className='gs-role-badge';span.dataset.role=id;span.textContent=roleName(id);return span;}
 function roleBadges(roles){const area=document.createElement('div');area.className='gs-profile-badges';for(const id of roles||[])area.append(roleBadge(id));return area;}
 function choice(text,value,checked){const label=document.createElement('label'),input=document.createElement('input');label.className='gs-profile-choice';input.type='checkbox';input.value=value;input.checked=checked;label.append(input,document.createTextNode(text));return label;}
 function clearIdentityState(){if(document.body.classList.contains('gs-needs-setup'))return;if(typeof gamesCache!=='undefined')gamesCache=[];document.querySelectorAll('.gs-card').forEach(card=>card.remove());document.body.classList.add('gs-profile-required');}
 function persistIdentity(profile){const previous=localStorage.getItem('gameshelf:active-profile')||'',next=profile?.id||'';if(previous!==next){localStorage.setItem('gameshelf:playlist-profile:'+previous,localStorage.getItem('gameshelf:cart')||'[]');localStorage.setItem('gameshelf:cart',localStorage.getItem('gameshelf:playlist-profile:'+next)||'[]');for(const key of preferenceKeys)localStorage.removeItem('gameshelf:'+key);}if(profile)importPreferences(profile.preferences||{});localStorage.setItem('gameshelf:active-profile',next);sessionStorage.setItem('gameshelf:profile-context',next);}
 function avatarImage(value){const img=document.createElement('img');img.src=GameShelfAvatars.url(value);img.alt='';img.loading='lazy';return img;}
 function renderPicker(canClose=false){
  $('profile-picker-list').replaceChildren();$('profile-picker-close').hidden=!canClose;$('profile-sign-out').hidden=!state.active;
  for(const profile of state.profiles){const item=button('',async()=>{const login=async pin=>{const result=await request('/api/profiles/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:profile.id,pin})});persistIdentity(result.profile);if(result.showTour)sessionStorage.setItem('gameshelf:profile-tour',result.profile.id);localStorage.setItem('gameshelf:profile-change',String(Date.now()));location.reload();};if(profile.pinRequired===false)await login('');else await GameShelfAccess.promptPIN(profile.nickname,login);});item.classList.add('gs-profile-tile');item.setAttribute('aria-label',profile.nickname);const caption=document.createElement('div'),name=document.createElement('span');caption.className='gs-profile-caption';name.className='gs-profile-name';name.textContent=profile.nickname;caption.append(name,roleBadges(profile.roles));item.append(avatarImage(profile.avatar),caption);$('profile-picker-list').append(item);}
  if(!state.profiles.length){const p=document.createElement('p');p.textContent='Ask a Guardian to add a profile.';$('profile-picker-list').append(p);}if(!$('profile-picker').open)openModal($('profile-picker'));
 }
 async function initialize(){if(initializing)return initializing;initializing=(async()=>{state=await request('/api/profiles');if(typeof state.enabled!=='boolean')return true;$('profile-switcher').hidden=!state.enabled;
  if(state.active){const old=sessionStorage.getItem('gameshelf:profile-context'),changed=old!==state.active.id||Object.entries(state.active.preferences||{}).some(([key,value])=>preferenceKeys.includes(key)&&localStorage.getItem('gameshelf:'+key)!==value);persistIdentity(state.active);if(changed){location.reload();return false;}$('profile-switcher').dataset.tooltip='Switch Profile · '+state.active.nickname;}
  else if(!state.enabled&&localStorage.getItem('gameshelf:active-profile'))persistIdentity(null);
  if(state.needsProfile){required=true;clearIdentityState();document.body.classList.remove('gs-booting');renderPicker();return false;}document.body.classList.remove('gs-profile-required');required=false;return true;
 })();try{return await initializing;}finally{initializing=null;}}
 function offerTour(){if(!document.body.classList.contains('gs-needs-setup')&&state.active&&sessionStorage.getItem('gameshelf:profile-tour')===state.active.id){sessionStorage.removeItem('gameshelf:profile-tour');GameShelfTour.prepare();GameShelfTour.offer();}}
 $('profile-switcher').addEventListener('click',async()=>{try{state=await request('/api/profiles');renderPicker(!state.needsProfile);}catch(error){notifyError(error);}});
 $('profile-picker-close').addEventListener('click',()=>{if(!required)$('profile-picker').close();});$('profile-picker').addEventListener('cancel',event=>{if(required)event.preventDefault();});
 $('profile-sign-out').addEventListener('click',async()=>{try{clearIdentityState();await request('/api/profiles/logout',{method:'POST'});sessionStorage.removeItem('gameshelf:profile-context');localStorage.setItem('gameshelf:profile-change',String(Date.now()));location.reload();}catch(error){notifyError(error);}});
 $('profile-guardian').addEventListener('click',()=>GameShelfAccess.openFamily().catch(notifyError));
 addEventListener('storage',event=>{if(event.key==='gameshelf:profile-change'){clearIdentityState();location.reload();}});
 addEventListener('focus',async()=>{if(!state.enabled||management)return;try{const next=await request('/api/profiles');if(next.needsProfile||next.active?.id!==state.active?.id){clearIdentityState();location.reload();}}catch{}});
 $('profiles-pin').addEventListener('click',()=>GameShelfAccess.openPIN().catch(notifyError));
 function syncManagement(){const enabled=$('profiles-enabled').checked;enabledDraft=enabled;$('profiles-options').inert=!enabled;$('profiles-options').classList.toggle('gs-options-disabled',!enabled);$('profiles-associate').disabled=!enabled;$('profiles-save').disabled=enabled===management.enabled;}
 function renderManagement(){
  $('profiles-enabled').checked=enabledDraft;$('profiles-list').replaceChildren();
  const add=button('',()=>editProfile());add.id='profile-add';add.classList.add('gs-profile-add');add.setAttribute('aria-label','Add Profile');add.dataset.tooltip='Add Profile';add.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="7" r="4"/><path d="M1 22v-3a8 8 0 0 1 16 0v3M19 8v8m-4-4h8"/></svg><span>Add Profile</span>';$('profiles-list').append(add);
  const profiles=[...management.profiles];if(!profiles.some(p=>p.usesGuardianPIN))profiles.unshift({id:'guardian',nickname:'GameShelf Guardian',avatar:'builtin:ember-knight',roles:['administrator'],standaloneGuardian:true});
  for(const profile of profiles){const row=document.createElement('article');row.className='gs-profile-row gs-profile-entry';const summary=document.createElement('div'),name=document.createElement('strong');name.textContent=profile.nickname;summary.className='gs-profile-summary';summary.append(name,roleBadges(profile.roles));const actions=document.createElement('div');actions.className='gs-profile-row-actions';if(profile.standaloneGuardian)actions.append(iconButton('Associate Guardian PIN with a Profile',()=>associateGuardian(),'M8 12h8m-4-4v8M5 3h14v18H5z'));else actions.append(iconButton('Edit '+profile.nickname,()=>editProfile(profile),'m4 16 12-12 4 4L8 20H4zM13 7l4 4'),iconButton('Remove '+profile.nickname,()=>confirmRemove('Remove '+profile.nickname+'?',{operation:'deleteProfile',profile:{id:profile.id}}),'M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7',true));row.append(avatarImage(profile.avatar),summary,actions);$('profiles-list').append(row);}
  $('roles-list').replaceChildren();for(const role of Object.values(management.roles).sort((a,b)=>roleName(a.id).localeCompare(roleName(b.id)))){const row=document.createElement('article');row.className='gs-profile-row';const actions=document.createElement('div');actions.className='gs-profile-row-actions';actions.append(button('Edit',()=>editRole(role)));if(!builtins.has(role.id))actions.append(button('Remove',()=>confirmRemove('Remove '+role.name+'?',{operation:'deleteRole',role:{id:role.id}}),true));row.append(roleBadge(role.id),actions);$('roles-list').append(row);}syncManagement();
 }
 async function reloadManagement(){await ownerAccess();management=await request('/api/profiles?manage=1');renderManagement();}
 async function openManager(){if(!await GameShelfAccess.enter('admin'))return;management=await request('/api/profiles?manage=1');enabledDraft=management.enabled;renderManagement();openModal($('profiles-dialog'));}
 for(const id of ['family-open-profiles','setup-family-profiles'])$(id).addEventListener('click',()=>openManager().catch(notifyError));
 $('profiles-close').addEventListener('click',()=>$('profiles-dialog').close());$('profiles-dialog').addEventListener('close',()=>{management=null;if(!$('family-dialog').open)GameShelfAccess.leave('admin').catch(()=>{});initialize().catch(notifyError);});
 $('profiles-enabled').addEventListener('change',async()=>{const input=$('profiles-enabled');if(input.checked&&!GameShelfAccess.configured()){input.disabled=true;try{if(!await GameShelfAccess.openPIN())input.checked=false;}catch(error){input.checked=false;notifyError(error);}finally{input.disabled=false;}}syncManagement();});
 $('profiles-save').addEventListener('click',async()=>{const save=$('profiles-save');if(save.disabled)return;save.disabled=true;try{await ownerAccess();if(!enabledDraft&&!await GameShelfAccess.fresh(['admin']))return;await request('/api/profiles',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'configure',enabled:enabledDraft})});await reloadManagement();if(enabledDraft)clearIdentityState();showNotification(enabledDraft?'Family Profiles enabled.':'Family Profiles turned off.');}catch(error){notifyError(error);}finally{if(management)syncManagement();}});
 async function associateGuardian(){if(!GameShelfAccess.configured()&&!await GameShelfAccess.openPIN())return;await editProfile(null,true);}
 $('profiles-associate').addEventListener('click',()=>associateGuardian().catch(notifyError));
 function renderGameChoices(){
  const area=$('profile-game-choices'),filter=$('profile-game-search').value.trim().toLocaleLowerCase();area.replaceChildren();const libraries=new Set(editing.selectedLibraries);
  const games=catalog.filter(game=>(!filter||game.name.toLocaleLowerCase().includes(filter))&&($('profile-all-libraries').checked||libraries.has(game.library)));
  for(const game of games){const all=$('profile-all-games').checked,row=choice(game.name,game.id,all||editing.selectedGames.has(game.id)),input=row.querySelector('input');input.disabled=all;input.addEventListener('change',()=>{if(input.checked)editing.selectedGames.add(game.id);else editing.selectedGames.delete(game.id);});area.append(row);}if(!games.length){const p=document.createElement('p');p.textContent='No games match these libraries and search.';area.append(p);}
 }
 function syncAssignments(event){
  const all=$('profile-all-libraries').checked;if(event?.target===$('profile-all-libraries')&&!all&&editing.allLibraries)editing.selectedLibraries=new Set(management.libraries.map(l=>l.id));editing.allLibraries=all;
  for(const input of $('profile-library-choices').querySelectorAll('input')){input.checked=all||editing.selectedLibraries.has(input.value);input.disabled=all;}
  $('profile-library-choices').hidden=false;$('profile-game-choices').hidden=false;$('profile-game-search').hidden=false;renderGameChoices();
 }
 async function editProfile(profile,associated=false){
  await ownerAccess();catalog=await request('/api/profiles/catalog');editing={...(profile||{}),avatar:profile?.avatar||'',pinPreference:profile?.pinRequired!==false,selectedGames:new Set(profile?.games||[]),selectedLibraries:new Set(profile?.libraries||[]),allLibraries:profile?.allLibraries??true};libraryWarningApproved=false;
  $('profile-photo-image').src=GameShelfAvatars.url(editing.avatar);$('profile-photo-image').hidden=!editing.avatar;$('profile-photo').classList.toggle('has-photo',!!editing.avatar);
  $('profile-editor-title').textContent=profile?'Edit Profile':associated?'Associate Guardian Profile':'Add Profile';$('profile-nickname').value=profile?.nickname||'';$('profile-tour-next').checked=profile?.tourPending||false;
  $('profile-guardian-pin').checked=associated||profile?.usesGuardianPIN||false;$('profile-new-pin').value='';$('profile-confirm-pin').value='';$('profile-new-pin').placeholder=profile&&!profile.usesGuardianPIN&&profile.pinRequired!==false?'Keep current PIN':'';
  $('profile-role-choices').replaceChildren();for(const role of Object.values(management.roles)){const selected=associated?role.id==='administrator':profile?profile.roles.includes(role.id):role.id==='child',row=choice('',role.id,selected);row.append(roleBadge(role.id));$('profile-role-choices').append(row);}
  $('profile-theme').replaceChildren(...[...$('theme-select').options].map(option=>option.cloneNode(true)));$('profile-theme').value=profile?.preferences?.theme||'classic';
  $('profile-all-libraries').checked=profile?.allLibraries??true;$('profile-all-games').checked=profile?.allGames??true;$('profile-library-choices').replaceChildren();
  for(const library of management.libraries){const row=choice(library.name||library.location,library.id,editing.selectedLibraries.has(library.id)),input=row.querySelector('input');row.dataset.tooltip=library.location;input.addEventListener('change',()=>{if(input.checked)editing.selectedLibraries.add(input.value);else editing.selectedLibraries.delete(input.value);renderGameChoices();});$('profile-library-choices').append(row);}
  $('profile-game-search').value='';syncProfilePIN();syncAssignments();openModal($('profile-editor-dialog'));GameShelfTheme?.preview($('profile-theme').value);
 }
 function syncProfilePIN(){
  const linked=$('profile-guardian-pin').checked,admin=$('profile-role-choices').querySelector('[value="administrator"]');if(linked)admin.checked=true;admin.disabled=linked;
  const ids=[...$('profile-role-choices').querySelectorAll('input:checked')].map(n=>n.value),actions=management.pinProtectedActions||['settings','advanced','admin','libraryManager','sources','storage','refresh','logging','health','export','restore','wipe','setup','covers','titles','metadata'];
  const forced=linked||actions.some(action=>!ids.some(id=>management.roles[id]?.rules?.[action]?.mode==='disable')),checkbox=$('profile-require-pin');checkbox.checked=forced||editing.pinPreference;checkbox.disabled=forced;
  delete $('profile-require-pin-option').dataset.tooltip;$('profile-require-pin-option').querySelector('span').dataset.tooltip=linked?'This profile uses the shared Guardian PIN.':forced?'Administrative permissions require a profile PIN.':'Ask for a four-digit PIN when opening this profile.';
  const expanded=checkbox.checked&&!linked,area=$('profile-pin-fields');area.classList.toggle('is-expanded',expanded);area.inert=!expanded;area.setAttribute('aria-hidden',String(!expanded));if(!expanded){$('profile-new-pin').value='';$('profile-confirm-pin').value='';}
 }
 $('profile-role-choices').addEventListener('change',syncProfilePIN);$('profile-guardian-pin').addEventListener('change',syncProfilePIN);
 $('profile-require-pin').addEventListener('change',()=>{editing.pinPreference=$('profile-require-pin').checked;syncProfilePIN();});
 for(const id of ['profile-all-libraries','profile-all-games'])$(id).addEventListener('change',syncAssignments);$('profile-game-search').addEventListener('input',renderGameChoices);
 $('profile-photo').addEventListener('click',async()=>{const chosen=await GameShelfAvatars.choose(editing.avatar);if(chosen!==null){editing.avatar=chosen;editing.clearAvatar=chosen==='';$('profile-photo-image').src=GameShelfAvatars.url(chosen);$('profile-photo-image').hidden=!chosen;$('profile-photo').classList.toggle('has-photo',!!chosen);showNotification(chosen?'Profile photo selected. Save the profile to apply.':'Profile photo cleared. Save the profile to apply.');}});
 $('profile-theme').addEventListener('change',()=>GameShelfTheme?.preview($('profile-theme').value));
 async function saveEditedProfile(skipWarning=false){
  const save=$('profile-editor-save');if(save.disabled)return;
  if(!skipWarning&&!$('profile-all-libraries').checked&&!editing.selectedLibraries.size){openModal($('profile-no-library-dialog'));return;}
  save.disabled=true;try{const profile={id:editing.id||'',avatar:editing.avatar,pinRequired:$('profile-require-pin').checked,usesGuardianPIN:$('profile-guardian-pin').checked,tourPending:$('profile-tour-next').checked,nickname:$('profile-nickname').value.trim(),roles:[...$('profile-role-choices').querySelectorAll('input:checked')].map(n=>n.value),allLibraries:$('profile-all-libraries').checked,libraries:[...editing.selectedLibraries],allGames:$('profile-all-games').checked,games:[...editing.selectedGames],preferences:{theme:$('profile-theme').value}};
   await post({operation:'profile',profile,clearAvatar:!!editing.clearAvatar,pin:$('profile-new-pin').value,confirmPIN:$('profile-confirm-pin').value});await GameShelfTheme?.restore();await reloadManagement();if(management.enabled)clearIdentityState();$('profile-editor-dialog').close();showNotification('Family profile saved. Active profile sessions must sign in again.');
  }catch(error){notifyError(error);}finally{save.disabled=false;}
 }
 $('profile-editor-save').addEventListener('click',()=>saveEditedProfile());
 $('profile-no-library-save').addEventListener('click',()=>{$('profile-no-library-dialog').close();saveEditedProfile(true);});for(const id of ['profile-no-library-close','profile-no-library-back'])$(id).addEventListener('click',()=>$('profile-no-library-dialog').close());closeOnBackdropClick($('profile-no-library-dialog'));
 for(const id of ['profile-editor-close','profile-editor-cancel'])$(id).addEventListener('click',()=>$('profile-editor-dialog').close());$('profile-editor-dialog').addEventListener('close',()=>{$('profile-new-pin').value='';$('profile-confirm-pin').value='';GameShelfTheme?.restore();});
  function renderRoleRules(rules={}){
    const area=$('role-rules');area.replaceChildren();
    const groups=['Settings access','Appearance','Library View','Data and Diagnostics','Game actions','Library Manager'];
    const actions=Object.entries(management.actions||{}).sort((a,b)=>groups.indexOf(management.groups[a[0]])-groups.indexOf(management.groups[b[0]])||a[1].localeCompare(b[1]));
    let section,previous;
    for(const [action,label]of actions){const group=management.groups[action]||'Game actions';if(previous!==group){section=document.createElement('fieldset');section.className='gs-family-group';const heading=document.createElement('legend');heading.className='gs-family-group-title';heading.textContent=group;section.append(heading);area.append(section);previous=group;}
      const row=document.createElement('div');row.className='gs-role-rule';row.dataset.action=action;const name=document.createElement('span');name.textContent=label;name.tabIndex=0;name.dataset.tooltip=GameShelfAccess.help(action);
      const select=document.createElement('select');select.setAttribute('aria-label',label+' access');for(const [value,text]of [['allow','Allow'],['pin','Require PIN'],['disable','Disable']]){const option=document.createElement('option');option.value=value;option.textContent=text;select.append(option);}select.value=rules[action]?.mode||'allow';row.append(name,select);section.append(row);
    }
  }
  function editRole(role){
    editingRole=role||null;$('role-editor-title').textContent=role?'Edit Role or Group':'Add Role or Group';$('role-name').value=role?.name||'';
    $('role-template').replaceChildren();const blank=document.createElement('option');blank.value='';blank.textContent='Custom';$('role-template').append(blank);
    for(const item of Object.values(management.roles)){const option=document.createElement('option');option.value=item.id;option.textContent=roleName(item.id);option.dataset.role=item.id;$('role-template').append(option);}
    $('role-template').value=role?.id||'';renderRoleRules(role?.rules);openModal($('role-editor-dialog'));
  }
  $('role-add').addEventListener('click',()=>editRole());$('role-template').addEventListener('change',()=>renderRoleRules(management.roles[$('role-template').value]?.rules));
  $('role-editor-save').addEventListener('click',async()=>{
    const save=$('role-editor-save');if(save.disabled)return;save.disabled=true;
    try{const rules={};for(const row of $('role-rules').querySelectorAll('[data-action]'))rules[row.dataset.action]={...(editingRole?.rules[row.dataset.action]||{}),mode:row.querySelector('select').value};
      await post({operation:'role',role:{id:editingRole?.id||'',name:$('role-name').value.trim(),rules}});await reloadManagement();if(management.enabled&&!document.body.classList.contains('gs-needs-setup'))clearIdentityState();$('role-editor-dialog').close();showNotification('Role saved. Active profile sessions must sign in again.');
    }catch(error){notifyError(error);}finally{save.disabled=false;}
  });
  for(const id of ['role-editor-close','role-editor-cancel'])$(id).addEventListener('click',()=>$('role-editor-dialog').close());
  function confirmRemove(message,payload){pendingRemoval=payload;$('profile-remove-question').textContent=message+' This cannot be undone.';openModal($('profile-remove-dialog'));}
  $('profile-remove-confirm').addEventListener('click',async()=>{const save=$('profile-remove-confirm');save.disabled=true;try{await post(pendingRemoval);await reloadManagement();$('profile-remove-dialog').close();showNotification('Removed.');}catch(error){notifyError(error);}finally{save.disabled=false;}});
  for(const id of ['profile-remove-close','profile-remove-cancel'])$(id).addEventListener('click',()=>$('profile-remove-dialog').close());
  for(const id of ['profiles-dialog','profile-editor-dialog','role-editor-dialog','profile-remove-dialog'])closeOnBackdropClick($(id));
  const originalFetch=window.fetch;
  window.fetch=async(...args)=>{
    const response=await originalFetch(...args);
    if(response.status===401){let result;try{result=await response.clone().json();}catch{/* Not an access response. */}if(result?.code==='profile_required'){clearIdentityState();initialize().catch(notifyError);}}
    return response;
  };
  window.GameShelfProfiles={initialize,open:openManager,offerTour,hasProfiles:async()=>{const value=await request('/api/profiles');return value.hasProfileData||value.profiles?.some(p=>!p.standaloneGuardian);}};
})();
