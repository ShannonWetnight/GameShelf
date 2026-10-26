/* A profile is a personal shelf, not a Guardian unlock. All permissions are
   checked again by the server; browser state only controls presentation. */
(() => {
  const $ = id => document.getElementById(id);
  let state = {enabled:false, profiles:[]}, management, catalog = [], editing, editingRole, pendingRemoval;
  let required = false, initializing;
  const builtins = new Set(['child','adult','elevated','administrator']);
  const notifyError = error => showNotification(error.message || 'Could not save these choices.', 'error');
  async function request(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) {
      const text = await response.text();
      let message = text; try { message = JSON.parse(text).message || text; } catch { /* plain server error */ }
      throw new Error(message || 'GameShelf could not complete that request.');
    }
    return response.status === 204 ? null : response.json();
  }
  async function ownerAccess(){if(!await GameShelfAccess.enter('admin'))throw new Error('Guardian approval is required.');}
  const post = async body => {await ownerAccess();return request('/api/profiles', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});};
  function button(text, action, danger = false) {
    const node = document.createElement('button'); node.type = 'button'; node.className = danger ? 'gs-danger-action' : 'gs-detail-action';
    node.textContent = text; node.addEventListener('click', () => Promise.resolve(action()).catch(notifyError)); return node;
  }
  function choice(text, value, checked) {
    const label = document.createElement('label'), input = document.createElement('input');
    label.className = 'gs-profile-choice'; input.type = 'checkbox'; input.value = value; input.checked = checked;
    label.append(input, document.createTextNode(text)); return label;
  }
  function clearIdentityState() {
    // A cookie change in another tab must never leave the previous catalog on screen.
    if (typeof gamesCache !== 'undefined') gamesCache = [];
    document.getElementById('games-grid')?.replaceChildren();
    document.querySelectorAll('.gs-card').forEach(card => card.remove());
    document.body.classList.add('gs-profile-required');
  }
  function persistIdentity(profile) {
    const previous = localStorage.getItem('gameshelf:active-profile') || '';
    const next = profile?.id || '';
    if (previous !== next) {
      localStorage.setItem('gameshelf:playlist-profile:' + previous, localStorage.getItem('gameshelf:cart') || '[]');
      localStorage.setItem('gameshelf:cart', localStorage.getItem('gameshelf:playlist-profile:' + next) || '[]');
      for (const key of preferenceKeys) localStorage.removeItem('gameshelf:' + key);
    }
    if (profile) importPreferences(profile.preferences || {});
    localStorage.setItem('gameshelf:active-profile', next);
    sessionStorage.setItem('gameshelf:profile-context', next);
  }
  function avatarImage(value,label=''){const img=document.createElement('img');img.src=window.GameShelfAvatars?.url(value)||'/profile-avatars/pixel-robot.webp';img.alt=label;img.loading='lazy';return img;}
  function renderPicker(canClose = false) {
    $('profile-picker-list').replaceChildren();$('profile-picker-close').hidden=!canClose;$('profile-sign-out').hidden=!state.active;
    for(const profile of state.profiles){const item=button('',async()=>{const login=async pin=>{const result=await request('/api/profiles/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:profile.id,pin})});persistIdentity(result.profile);localStorage.setItem('gameshelf:profile-change',String(Date.now()));location.reload();};if(profile.pinRequired===false)await login('');else await GameShelfAccess.promptPIN(profile.nickname,login);});item.classList.add('gs-profile-tile');item.setAttribute('aria-label',profile.nickname);const name=document.createElement('span');name.textContent=profile.nickname;item.append(avatarImage(profile.avatar),name);$('profile-picker-list').append(item);}
    if(!state.profiles.length){const text=document.createElement('p');text.textContent='Ask a Guardian to add a profile.';$('profile-picker-list').append(text);}
    if(!$('profile-picker').open)openModal($('profile-picker'));
  }
  async function initialize() {
    if (initializing) return initializing;
    initializing = (async () => {
      state = await request('/api/profiles');
      if (!state || typeof state.enabled !== 'boolean') return true; // Test/older-server compatibility.
      $('profile-switcher').hidden = !state.enabled;
      if (state.active) {
        const old = sessionStorage.getItem('gameshelf:profile-context');
        const changed = old !== state.active.id || Object.entries(state.active.preferences||{}).some(([key,value])=>preferenceKeys.includes(key)&&localStorage.getItem('gameshelf:'+key)!==value);
        persistIdentity(state.active);
        if (changed) { location.reload(); return false; }
        $('profile-switcher').dataset.tooltip = 'Switch Profile · ' + state.active.nickname;
      } else if (!state.enabled && localStorage.getItem('gameshelf:active-profile')) persistIdentity(null);
      if (state.needsProfile) { required=true; clearIdentityState(); document.body.classList.remove('gs-booting'); renderPicker(); return false; }
      document.body.classList.remove('gs-profile-required'); required=false; return true;
    })();
    try { return await initializing; } finally { initializing=null; }
  }
  $('profile-switcher').addEventListener('click',async()=>{try{state=await request('/api/profiles');renderPicker(!state.needsProfile);}catch(error){notifyError(error);}});
  $('profile-picker-close').addEventListener('click',()=>{if(!required)$('profile-picker').close();});
  $('profile-picker').addEventListener('cancel',event=>{if(required)event.preventDefault();});
  $('profile-sign-out').addEventListener('click',async()=>{try{clearIdentityState();await request('/api/profiles/logout',{method:'POST'});sessionStorage.removeItem('gameshelf:profile-context');localStorage.setItem('gameshelf:profile-change',String(Date.now()));location.reload();}catch(error){notifyError(error);}});
  $('profile-guardian').addEventListener('click',()=>GameShelfAccess.openFamily().catch(notifyError));
  addEventListener('storage',event=>{if(event.key==='gameshelf:profile-change'){clearIdentityState();location.reload();}});
  addEventListener('focus',async()=>{
    if(!state.enabled||management)return;
    try{const next=await request('/api/profiles');if(next.needsProfile||next.active?.id!==state.active?.id){clearIdentityState();location.reload();}}catch{/* Keep the current screen on a transient network failure. */}
  });
  $('profiles-pin').addEventListener('click',()=>GameShelfAccess.openPIN().catch(notifyError));
  function renderManagement() {
    $('profiles-enabled').checked=management.enabled;
    $('profiles-list').replaceChildren();
    for(const profile of management.profiles){
      const row=document.createElement('article');row.className='gs-profile-row gs-profile-entry';
      const summary=document.createElement('div'),name=document.createElement('strong'),roles=document.createElement('small');name.textContent=profile.nickname;
      roles.textContent=profile.roles.map(id=>management.roles[id]?.name||id).join(' · ');summary.append(name,roles);
      const actions=document.createElement('div');actions.className='gs-profile-row-actions';actions.append(button('Edit',()=>editProfile(profile)),button('Remove',()=>confirmRemove('Remove '+profile.nickname+'?',{operation:'deleteProfile',profile:{id:profile.id}}),true));row.append(avatarImage(profile.avatar),summary,actions);$('profiles-list').append(row);
    }
    if(!management.profiles.length){const p=document.createElement('p');p.className='gs-profile-empty';p.textContent='Add a nickname and PIN for each person. Profiles stay optional until you turn them on.';$('profiles-list').append(p);}
    $('roles-list').replaceChildren();
    for(const role of Object.values(management.roles).sort((a,b)=>a.name.localeCompare(b.name))){
      const row=document.createElement('article');row.className='gs-profile-row';const name=document.createElement('strong');name.textContent=role.name;
      const actions=document.createElement('div');actions.className='gs-profile-row-actions';actions.append(button('Edit',()=>editRole(role)));
      if(!builtins.has(role.id))actions.append(button('Remove',()=>confirmRemove('Remove '+role.name+'?',{operation:'deleteRole',role:{id:role.id}}),true));row.append(name,actions);$('roles-list').append(row);
    }
  }
  async function reloadManagement(){await ownerAccess();management=await request('/api/profiles?manage=1');renderManagement();}
  async function openManager(){
    if(!await GameShelfAccess.enter('admin'))return;
    await reloadManagement(); openModal($('profiles-dialog'));
  }
  for(const id of ['family-open-profiles','setup-family-profiles'])$(id).addEventListener('click',()=>openManager().catch(notifyError));
  $('profiles-close').addEventListener('click',()=>$('profiles-dialog').close());
  $('profiles-dialog').addEventListener('close',()=>{management=null;if(!$('family-dialog').open)GameShelfAccess.leave('admin').catch(()=>{});initialize().catch(notifyError);});
  $('profiles-enabled').addEventListener('change',async()=>{
    const input=$('profiles-enabled');input.disabled=true;
    try{if(input.checked&&!GameShelfAccess.configured()){if(!await GameShelfAccess.openPIN()){input.checked=false;return;}}await post({operation:'configure',enabled:input.checked});await reloadManagement();if(input.checked)clearIdentityState();showNotification(input.checked?'Family profiles enabled. Choose a profile when you open your shelf.':'Family profiles turned off.');}
    catch(error){input.checked=!input.checked;notifyError(error);}finally{input.disabled=false;}
  });
  $('profile-add').addEventListener('click',()=>editProfile().catch(notifyError));
  function renderGameChoices(){
    const area=$('profile-game-choices'),filter=$('profile-game-search').value.trim().toLocaleLowerCase();
    // Keep selected IDs in memory so filtering cannot drop assignments.
    area.replaceChildren();const libraries=new Set([...$('profile-library-choices').querySelectorAll('input:checked')].map(n=>n.value));
    const games=catalog.filter(game=>(!filter||game.name.toLocaleLowerCase().includes(filter))&&($('profile-all-libraries').checked||libraries.has(game.library)));
    for(const game of games){const row=choice(game.name,game.id,editing.selectedGames.has(game.id));row.querySelector('input').addEventListener('change',event=>{if(event.target.checked)editing.selectedGames.add(game.id);else editing.selectedGames.delete(game.id);});area.append(row);}
    if(!games.length){const p=document.createElement('p');p.textContent='No games match these libraries and search.';area.append(p);}
  }
  function syncAssignments(){
    $('profile-library-choices').hidden=$('profile-all-libraries').checked;
    $('profile-game-choices').hidden=$('profile-all-games').checked;$('profile-game-search').hidden=$('profile-all-games').checked;
    renderGameChoices();
  }
  async function editProfile(profile){
    await ownerAccess();catalog=await request('/api/profiles/catalog');editing={...(profile||{}),avatar:profile?.avatar||'builtin:pixel-robot',pinPreference:profile?.pinRequired!==false,selectedGames:new Set(profile?.games||[])};
    $('profile-photo-image').src=GameShelfAvatars.url(editing.avatar);$('profile-editor-title').textContent=profile?'Edit Profile':'Add Profile';$('profile-nickname').value=profile?.nickname||'';
    $('profile-new-pin').value='';$('profile-confirm-pin').value='';$('profile-new-pin').placeholder=profile&&profile.pinRequired!==false?'Keep current PIN':'';
    $('profile-role-choices').replaceChildren();
    for(const role of Object.values(management.roles)){const selected=profile?profile.roles.includes(role.id):role.id==='child';$('profile-role-choices').append(choice(role.name,role.id,selected));}
    syncProfilePIN();$('profile-theme').replaceChildren(...[...$('theme-select').options].map(option=>option.cloneNode(true)));
    $('profile-theme').value=profile?.preferences?.theme||'classic';
    $('profile-all-libraries').checked=profile?.allLibraries??true;$('profile-all-games').checked=profile?.allGames??true;
    $('profile-library-choices').replaceChildren();
    for(const library of management.libraries){const row=choice(library.name||library.location,library.id,profile?.libraries?.includes(library.id)||false);row.dataset.tooltip=library.location;row.querySelector('input').addEventListener('change',renderGameChoices);$('profile-library-choices').append(row);}
    $('profile-game-search').value='';syncAssignments();openModal($('profile-editor-dialog'));
  }
  function syncProfilePIN(){
    const ids=[...$('profile-role-choices').querySelectorAll('input:checked')].map(n=>n.value),protectedActions=management.pinProtectedActions||['settings','advanced','admin','libraryManager','sources','storage','refresh','logging','health','export','restore','wipe','setup','covers','titles','metadata'];
    const forced=protectedActions.some(action=>!ids.some(id=>management.roles[id]?.rules?.[action]?.mode==='disable'));
    const checkbox=$('profile-require-pin');checkbox.checked=forced||editing.pinPreference;checkbox.disabled=forced;
    $('profile-require-pin-option').dataset.tooltip=forced?'Administrative permissions require a profile PIN.':'Ask for a four-digit PIN when opening this profile.';
    const area=$('profile-pin-fields');area.classList.toggle('is-expanded',checkbox.checked);area.inert=!checkbox.checked;area.setAttribute('aria-hidden',String(!checkbox.checked));
    if(!checkbox.checked){$('profile-new-pin').value='';$('profile-confirm-pin').value='';}
  }
  $('profile-role-choices').addEventListener('change',syncProfilePIN);
  $('profile-require-pin').addEventListener('change',()=>{editing.pinPreference=$('profile-require-pin').checked;syncProfilePIN();});
  for(const id of ['profile-all-libraries','profile-all-games'])$(id).addEventListener('change',syncAssignments);
  $('profile-game-search').addEventListener('input',renderGameChoices);
  for(const id of ['profile-photo','profile-photo-change'])$(id).addEventListener('click',async()=>{const chosen=await GameShelfAvatars.choose(editing.avatar);if(chosen){editing.avatar=chosen;$('profile-photo-image').src=GameShelfAvatars.url(chosen);showNotification('Profile photo selected. Save the profile to apply.');}});
  $('profile-editor-save').addEventListener('click',async()=>{
    const save=$('profile-editor-save');if(save.disabled)return;save.disabled=true;
    try{
      const profile={id:editing.id||'',avatar:editing.avatar,pinRequired:$('profile-require-pin').checked,nickname:$('profile-nickname').value.trim(),roles:[...$('profile-role-choices').querySelectorAll('input:checked')].map(n=>n.value),allLibraries:$('profile-all-libraries').checked,libraries:[...$('profile-library-choices').querySelectorAll('input:checked')].map(n=>n.value),allGames:$('profile-all-games').checked,games:[...editing.selectedGames],preferences:{theme:$('profile-theme').value}};
      await post({operation:'profile',profile,pin:$('profile-new-pin').value,confirmPIN:$('profile-confirm-pin').value});
      await reloadManagement();if(management.enabled)clearIdentityState();$('profile-editor-dialog').close();showNotification('Family profile saved. Active profile sessions must sign in again.');
    }catch(error){notifyError(error);}finally{save.disabled=false;}
  });
  for(const id of ['profile-editor-close','profile-editor-cancel'])$(id).addEventListener('click',()=>$('profile-editor-dialog').close());
  $('profile-editor-dialog').addEventListener('close',()=>{$('profile-new-pin').value='';$('profile-confirm-pin').value='';});
  function renderRoleRules(rules={}){
    const area=$('role-rules');area.replaceChildren();
    const groups=['Settings access','Appearance','Library View','Data and Diagnostics','Game actions','Library Manager'];
    const actions=Object.entries(management.actions||{}).sort((a,b)=>groups.indexOf(management.groups[a[0]])-groups.indexOf(management.groups[b[0]])||a[1].localeCompare(b[1]));
    let section,previous;
    for(const [action,label]of actions){const group=management.groups[action]||'Game actions';if(previous!==group){section=document.createElement('section');section.className='gs-family-group';const heading=document.createElement('h3');heading.className='gs-family-group-title';heading.textContent=group;section.append(heading);area.append(section);previous=group;}
      const row=document.createElement('div');row.className='gs-role-rule';row.dataset.action=action;const name=document.createElement('span');name.textContent=label;name.tabIndex=0;name.dataset.tooltip=GameShelfAccess.help(action);
      const select=document.createElement('select');select.setAttribute('aria-label',label+' access');for(const [value,text]of [['allow','Allow'],['pin','Require PIN'],['disable','Disable']]){const option=document.createElement('option');option.value=value;option.textContent=text;select.append(option);}select.value=rules[action]?.mode||'allow';row.append(name,select);section.append(row);
    }
  }
  function editRole(role){
    editingRole=role||null;$('role-editor-title').textContent=role?'Edit Role or Group':'Add Role or Group';$('role-name').value=role?.name||'';
    $('role-template').replaceChildren();const blank=document.createElement('option');blank.value='';blank.textContent='Custom';$('role-template').append(blank);
    for(const item of Object.values(management.roles)){const option=document.createElement('option');option.value=item.id;option.textContent=item.name;$('role-template').append(option);}
    $('role-template').value=role?.id||'';renderRoleRules(role?.rules);openModal($('role-editor-dialog'));
  }
  $('role-add').addEventListener('click',()=>editRole());$('role-template').addEventListener('change',()=>renderRoleRules(management.roles[$('role-template').value]?.rules));
  $('role-editor-save').addEventListener('click',async()=>{
    const save=$('role-editor-save');if(save.disabled)return;save.disabled=true;
    try{const rules={};for(const row of $('role-rules').querySelectorAll('[data-action]'))rules[row.dataset.action]={...(editingRole?.rules[row.dataset.action]||{}),mode:row.querySelector('select').value};
      await post({operation:'role',role:{id:editingRole?.id||'',name:$('role-name').value.trim(),rules}});await reloadManagement();if(management.enabled)clearIdentityState();$('role-editor-dialog').close();showNotification('Role saved. Active profile sessions must sign in again.');
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
  window.GameShelfProfiles={initialize,open:openManager,hasProfiles:async()=>{const value=await request('/api/profiles');return value.profiles?.length>0;}};
})();
