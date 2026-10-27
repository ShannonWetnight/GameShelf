/* One source editor serves first-run setup and Library Sources. Passwords remain
   only in unsaved memory; the API returns redacted settings after every save. */
(() => {
  const $ = id => document.getElementById(id);
  const drafts = { setup: [], settings: [] };
  let current = null, step = 1, panel = 'setup', editing = null;
  let saveAfterTrust = false;
  let editorID = '', editorHasPassword = false, editorHostKey = '', tested = '', testing = false, pendingTrust = null;
  let folderFailedPath='',folderOriginal = null, folderPanel = 'setup', pickerTarget = null, folderState = null, browseVersion = 0;
  let statusTimer, lastStates = [], watchedBusy = false;
  let editorVersion = 0, networkController = null, folderVersion = 0;
  const rootsInput = owner => $(owner === 'setup' ? 'setup-roots' : 'server-root-path');
  const roots = owner => rootsInput(owner).value.split(/\r?\n/).map(path => path.trim()).filter(Boolean);
  const sourceCount = owner => roots(owner).length + drafts[owner].length;
  const rootsOf = value => value.rootDirs?.length ? value.rootDirs : value.rootDir ? [value.rootDir] : [];
  const folderIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5h6l2 2h10v12H3z"/></svg>';
  const networkIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="3" width="10" height="6" rx="1"/><path d="M12 9v5M4 17v-3h16v3"/><rect x="2" y="17" width="5" height="4" rx="1"/><rect x="17" y="17" width="5" height="4" rx="1"/></svg>';
  const editIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 16 12-12 4 4L8 20H4zM14 6l4 4"/></svg>';
  const removeIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/></svg>';
  async function jsonRequest(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error((await response.text()).trim() || 'Could not connect to GameShelf.');
    return response.json();
  }
  function iconButton(label, svg, action, danger = false) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'gs-source-icon' + (danger ? ' gs-source-remove' : '');
    button.setAttribute('aria-label', label); button.title = label; button.innerHTML = svg; button.addEventListener('click', action); return button;
  }
  let pendingRemoval=null;
  function confirmRemoval(title,action){pendingRemoval=action;$('source-remove-name').textContent=title;openModal($('source-remove-dialog'));}
  $('source-remove-confirm').addEventListener('click',()=>{const action=pendingRemoval;pendingRemoval=null;action?.();$('source-remove-dialog').close();showNotification('Location removed from your choices. Save to apply.');});
  for(const id of ['source-remove-close','source-remove-cancel'])$(id).addEventListener('click',()=>{$('source-remove-dialog').close();});
  $('source-remove-dialog').addEventListener('close',()=>{pendingRemoval=null;});closeOnBackdropClick($('source-remove-dialog'));
  function render(owner) {
    const list = $(owner === 'setup' ? 'setup-source-list' : 'server-source-list'); list.replaceChildren();
    const addCard = (title, location, badge, icon, edit, remove, state) => {
 const offline=state==="offline";
      const card = document.createElement('article'); card.className = 'gs-source-card';
      const symbol = document.createElement('span'); symbol.className = 'gs-source-symbol'; symbol.innerHTML = icon;
      const content = document.createElement('div'); content.className = 'gs-source-card-content';
      const heading = document.createElement('strong'); heading.textContent = title;if(badge!=='Folder'){const dot=document.createElement('i');dot.className='gs-health-dot';dot.dataset.state=state==='offline'?'critical':(state==='healthy'||state==='ready')?'healthy':state==='degraded'?'degraded':'unknown';dot.dataset.tooltip=(state==='healthy'||state==='ready')?'Connected':state==='offline'?'Offline':state==='degraded'?'Connection needs attention':'Not checked yet';heading.prepend(dot);}
      const address = document.createElement('span'); address.textContent = location; address.title = location;
      const label = document.createElement('small'); label.textContent = offline ? 'Offline — check connection' : badge; if (offline) label.className = 'gs-source-offline';
      content.append(heading, address, label); const actions = document.createElement('div'); actions.className = 'gs-source-card-actions';
      actions.append(iconButton('Edit ' + title, editIcon, edit), iconButton('Remove ' + title, removeIcon, () => confirmRemoval(title,remove), true));
      card.append(symbol, content, actions); list.append(card);
    };
    roots(owner).forEach((path, index) => addCard(path.split('/').filter(Boolean).pop() || path, path, 'Folder', folderIcon,
      () => openFolder(owner, path), () => { const next = roots(owner); next.splice(index, 1); rootsInput(owner).value = next.join('\n'); render(owner); }));
    drafts[owner].forEach((source, index) => addCard(source.name || source.url, source.url, source.protocol === 'webdav' ? 'WebDAV' : source.protocol.toUpperCase(), networkIcon,
      () => openNetwork(owner, index), () => { drafts[owner].splice(index, 1); render(owner); }, lastStates.find(state => state.id === source.id)?.state));
    $(owner === 'setup' ? 'setup-source-empty' : 'server-source-empty').hidden = sourceCount(owner) > 0;
    if(owner==='setup'){$('setup-status').textContent='';$('setup-next').disabled=sourceCount(owner)===0;$('setup-next').dataset.tooltip=sourceCount(owner)?'Continue to Your Shelf':'Add at least one folder or network location before continuing.';}
  }
  function populate(owner, value) {
    rootsInput(owner).value = rootsOf(value).join('\n'); drafts[owner] = (value.sources || []).map(source => ({ ...source })); render(owner);
  }
  function canAdd(owner) {
    if (sourceCount(owner) < 16) return true;
    showNotification('A library can have up to 16 locations.'); return false;
  }
  function settingsSources() { return { roots: roots('settings'), sources: drafts.settings.map(source => ({ ...source })) }; }
  function prepareSettings(value) { populate('settings', value); }
  function savedSettings(value) {
    if(!$('server-settings-dialog').open)populate('settings',value);
    else {rootsInput('settings').value=rootsOf(value).join('\n');drafts.settings=(value.sources||[]).map(source=>({...source}));}
  }
  function syncSetupHeader(required){
    for(const id of ['gs-home-trigger','gs-refresh-trigger'])$(id).disabled=required;
    $('gs-logo-text').textContent='GAMESHELF';$('build-info').setAttribute('aria-label',required?'Setup options':'Open settings');$('build-info').dataset.tooltip=required?'Setup options':'Settings';
  }
  const setupTheme=$('setup-theme');setupTheme.replaceChildren(...[...$('theme-select').options].map(option=>option.cloneNode(true)));
  setupTheme.addEventListener('change',()=>{$('theme-select').value=setupTheme.value;$('theme-select').dispatchEvent(new Event('change'));});
  function openOptions(){$('setup-options-status').textContent='';openModal($('setup-options-dialog'));}
  for(const id of ['setup-options-close','setup-options-cancel'])$(id).addEventListener('click',()=>$('setup-options-dialog').close());
  closeOnBackdropClick($('setup-options-dialog'));
  $('setup-import').addEventListener('click',()=>$('open-library-restore').click());
  $('setup-defer').addEventListener('click',async()=>{
    const button=$('setup-defer');if(button.disabled)return;button.disabled=true;$('setup-options-status').textContent='Opening your shelf…';
    try{await jsonRequest('/api/setup?skip=1',{method:'POST'});$('setup-options-dialog').close();await boot();showNotification('Add your games later in Advanced Settings → Library Manager → Library Sources.');}
    catch(error){$('setup-options-status').textContent=error.message;}finally{button.disabled=false;}
  });

  async function readStatus() {
    try {
      const state = await jsonRequest('/api/source-status', { cache: 'no-store' });
      if (!Array.isArray(state.sources)) return null;
      lastStates = state.sources;for(const owner of ['setup','settings'])render(owner);
      const offline = state.sources.filter(source => source.state === 'offline');
      const alert = $('source-alert'); alert.hidden = !state.busy && !offline.length;
      $('source-alert-text').textContent = state.busy ? state.message || 'Connecting to your libraries…' : `${offline.length} location${offline.length === 1 ? ' is' : 's are'} offline. Cached games remain visible; downloads require a connection and refresh.`;
      if (state.busy && !$('setup-page').hidden) $('setup-status').textContent = state.message || 'Finding your games…';
      if (state.busy && $('server-settings-dialog').open && $('server-settings-save').disabled) $('server-settings-status').textContent = state.message || 'Reading your libraries…';
      return state;
    } catch { return null; }
  }
  async function watchScan() {
    clearTimeout(statusTimer); const state = await readStatus();
    if (state?.busy) { watchedBusy = true; statusTimer = setTimeout(watchScan, 1200); }
    else if (watchedBusy) { watchedBusy = false; if (!document.body.classList.contains('gs-needs-setup')) await loadGames(); }
  }
  async function boot() {
    $('boot-retry').hidden = true; $('boot-message').textContent = 'Opening GameShelf…'; document.body.classList.add('gs-booting');
    try {
      if(window.GameShelfProfiles&&!await GameShelfProfiles.initialize())return;
      current = await jsonRequest('/api/setup', { cache: 'no-store' });
      if (typeof current.required !== 'boolean' || !current.settings) throw new Error('GameShelf could not read its setup options.');
      serverSettings = current.settings;syncSetupResume();
      if(serverSettings.preferences && !hasSavedPreferences){
        importPreferences(serverSettings.preferences);
        if(Object.keys(serverSettings.preferences).length){window.location.reload();return;}
      }
      syncSetupHeader(current.required);setupTheme.value=themePreference;
      $('setup-page').hidden = !current.required; document.body.classList.toggle('gs-needs-setup', current.required);
      if (current.required) {
        const value = { ...serverSettings };
        if (!rootsOf(value).length && !(value.sources || []).length && current.mounts?.length === 1) value.rootDir = current.mounts[0];
        populate('setup', value); $('setup-data').value = value.dataDir || '/data';
        const hours = value.refreshInterval === '0' ? 0 : Number(String(value.refreshInterval).replace(/h$/, ''));
        $('setup-refresh').value = Number.isInteger(hours) && hours >= 0 && hours <= 8760 ? hours : 168;
        $('setup-refresh-preset').value = ['168', '24', '0'].includes($('setup-refresh').value) ? $('setup-refresh').value : 'custom';
        syncRefresh(); setStep(1, false); $('setup-status').textContent = '';
      }
      document.body.classList.remove('gs-booting');
      if (!current.required) { await loadGames(); watchScan();window.GameShelfProfiles?.offerTour();if(localStorage.getItem('gameshelf:pending-tour')==='true'){localStorage.removeItem('gameshelf:pending-tour');window.GameShelfTour?.prepare();window.GameShelfTour?.offer();}const notice=localStorage.getItem('gameshelf:restore-notice');if(notice){localStorage.removeItem('gameshelf:restore-notice');showNotification(notice);} }
    } catch {
      $('boot-message').textContent = 'Could not connect to GameShelf. Try again when the server is ready.'; $('boot-retry').hidden = false;
    }
  }
  $('boot-retry').addEventListener('click', boot);
  function setStep(next, animate = true) {
    step = next;
    const apply = () => {
      $('setup-libraries-panel').hidden = step !== 1; $('setup-finish-panel').hidden = step !== 2;
      $('setup-back').hidden = step === 1; $('setup-next').hidden = step === 2; $('setup-save').hidden = step !== 2; $('setup-import').hidden = step !== 1;
      $('setup-step-libraries').setAttribute('aria-current', step === 1 ? 'step' : 'false'); $('setup-step-finish').setAttribute('aria-current', step === 2 ? 'step' : 'false');
      $('setup-summary').textContent = '';
    };
    apply();
    if (animate && !disableEffects && !matchMedia('(prefers-reduced-motion: reduce)').matches) $(step === 1 ? 'setup-libraries-panel' : 'setup-finish-panel').animate?.([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: motionDuration(220), easing: 'ease-out' });
  }
  function validateSelection() {
    if (!sourceCount('setup')) return false;
    if (sourceCount('setup') > 16) { $('setup-status').textContent = 'Choose up to 16 locations.'; return false; }
    $('setup-status').textContent = ''; return true;
  }
  $('setup-next').addEventListener('click', () => { if (validateSelection()) setStep(2); });
  $('setup-back').addEventListener('click', () => setStep(1));
  function syncRefresh() { const preset = $('setup-refresh-preset').value; $('setup-refresh-custom').hidden = preset !== 'custom'; if (preset !== 'custom') $('setup-refresh').value = preset; }
  $('setup-refresh-preset').addEventListener('change', syncRefresh);
  $('setup-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!validateSelection()) return; if (step === 1) { setStep(2); return; }
    const button = $('setup-save'); if (button.disabled || !serverSettings) return;
    const hours = Number($('setup-refresh').value);
    if (!$('setup-refresh').value.trim() || !Number.isInteger(hours) || hours < 0 || hours > 8760) { $('setup-status').textContent = 'Choose 0–8760 whole hours.'; return; }
    const paths = roots('setup');
    const value = { ...serverSettings, rootDir: paths[0] || '', rootDirs: paths, sources: drafts.setup, dataDir: $('setup-data').value.trim(), refreshInterval: hours === 0 ? '0' : `${hours}h` };
    const tour = $('setup-tour').checked; const controls = [...$('setup-form').querySelectorAll('input,select,button')]; controls.forEach(control => control.disabled = true);
    $('setup-status').textContent = 'Connecting and finding your games…';
    const progress = setInterval(readStatus, 1200);
    try {
      const result = await jsonRequest('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
      serverSettings = result.settings || value; drafts.setup = []; $('setup-roots').value = ''; current.required = false;
      if(window.GameShelfProfiles&&!await GameShelfProfiles.initialize()){if(tour)localStorage.setItem('gameshelf:pending-tour','true');return;}
      if(tour)window.GameShelfTour?.prepare();$('setup-page').hidden = true; document.body.classList.remove('gs-needs-setup'); syncSetupHeader(false);await loadGames(); showNotification('Your shelf is ready. Welcome to GameShelf!'); watchScan();
      if (tour) window.GameShelfTour?.offer();
    } catch (error) { $('setup-status').textContent = error.message; }
    finally { clearInterval(progress); controls.forEach(control => control.disabled = false);$('setup-next').disabled=sourceCount('setup')===0; }
  });

  function editorSource() {
    const nfs = $('network-protocol').value === 'nfs';
    return { id: editorID, protocol: $('network-protocol').value, url: $('network-url').value.trim(), name: $('network-name').value.trim(), username: nfs ? '' : $('network-username').value,
      password: nfs ? '' : $('network-password').value, hasPassword: nfs ? false : editorHasPassword, domain: nfs ? '' : $('network-domain').value, hostKey: editorHostKey, nfsVersion: Number($('network-nfs-version').value), uid: Number($('network-uid').value), gid: Number($('network-gid').value) };
  }
  function signature(source = editorSource()) { const { name, ...connection } = source; return JSON.stringify(connection); }
  function invalidateTest() { tested = ''; saveAfterTrust=false;$('network-use').disabled = testing || !$('network-url').value.trim();   }
  function updateProtocol() {
    const protocol = $('network-protocol').value;
    $('network-signin').hidden = protocol === 'nfs'; $('network-domain-field').hidden = protocol !== 'smb'; $('network-nfs-options').hidden = protocol !== 'nfs'; $('network-key-options').hidden = protocol !== 'sftp';
    const placeholders = { smb: 'smb://server/games', nfs: 'nfs://server/export/games', sftp: 'sftp://server/home/games', webdav: 'https://server/webdav/games', ftp: 'ftp://server/games', ftps: 'ftps://server/games' };
    $('network-url').placeholder = placeholders[protocol];
    $('network-address-hint').textContent = protocol === 'smb' ? 'A server name or IP address and share name.' : protocol === 'nfs' ? 'A server name or IP address and exported folder.' : 'Include the folder you want to use.';
    $('network-key-state').textContent = editorHostKey ? 'A server key is pinned for this connection.' : 'We’ll verify the server on your first connection.';
  }
  function openNetwork(owner, index = null) {
    if (index === null && !canAdd(owner)) return;
    editorVersion++; networkController?.abort(); testing = false; $('network-test').disabled = false;$('network-test').removeAttribute('aria-busy');$('network-test').classList.remove('is-saved');$('network-test').removeAttribute('aria-busy');
    panel = owner; editing = index; const source = index === null ? {} : drafts[owner][index]; editorID = source.id || ''; editorHasPassword = !!source.hasPassword; editorHostKey = source.hostKey || '';
    $('network-editor-title').textContent = index === null ? 'Add Network Location' : 'Edit Network Location'; $('network-use').classList.toggle('gs-title-save',index!==null);$('network-use').classList.toggle('gs-standard-action',index===null);
    $('network-use').innerHTML=index===null?'Add Location':'<svg class="gs-save-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h13l3 3v15H4zM7 3v7h9V3M7 21v-8h10v8"/></svg><svg class="gs-save-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m4 12 5 5L20 6"/></svg>';
    $('network-use').setAttribute('aria-label',index===null?'Add Location':'Save location');
    $('network-protocol').value = source.protocol || 'smb'; $('network-url').value = source.url || ''; $('network-name').value = source.name || '';
    $('network-username').value = source.username || ''; $('network-password').value = source.password || ''; $('network-domain').value = source.domain || '';
    $('network-password').classList.toggle('gs-password-saved',editorHasPassword&&!source.password);$('network-password').placeholder = editorHasPassword && !source.password ? '••••••••' : 'Optional';
    $('network-nfs-version').value = String(source.nfsVersion || 0); $('network-uid').value = String(source.uid || 10001); $('network-gid').value = String(source.gid || 10001);
    $('network-advanced').open = false; invalidateTest(); updateProtocol(); openModal($('network-editor-dialog'));
  }
  async function testConnection(save = false) {
    if (testing) return; const version = editorVersion;let failed=false; networkController = new AbortController(); testing = true; $('network-test').disabled = true;$('network-test').setAttribute('aria-busy','true');animateControl($('network-test')); $('network-use').disabled = true;

    try {
      const source = editorSource();const requested=signature(source); const result = await jsonRequest('/api/network-test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(source), signal: networkController.signal });
      if (version !== editorVersion || !$('network-editor-dialog').open || requested!==signature()) return;
      if (result.requiresTrust) { saveAfterTrust=save;pendingTrust = result.hostKey; $('network-fingerprint').textContent = result.fingerprint;  openModal($('network-trust-dialog')); return; }
      const normalized = result.source || source; editorID = normalized.id; editorHasPassword = !!normalized.hasPassword;
      $('network-url').value = normalized.url; if (!$('network-name').value) $('network-name').value = normalized.name || '';
      tested = signature(); $('network-use').disabled = false; lastStates=lastStates.filter(item=>item.id!==editorID);lastStates.push({id:editorID,state:'healthy'});if(!save)showNotification(result.folders ? 'Connected — '+result.folders+' game folder'+(result.folders===1?'':'s')+' found.' : 'Connected. Ready for game folders.');
      if(!save)showSaveFeedback($('network-test'));if(save)commitNetwork();
    } catch (error) { if (version === editorVersion && error.name !== 'AbortError') { failed=true;tested = ''; $('network-use').disabled=true;showNotification(error.message,'error'); } }
    finally { if (version === editorVersion) { testing = false; $('network-test').disabled = false;$('network-test').removeAttribute('aria-busy');
      if (!tested&&!failed) $('network-use').disabled = !$('network-url').value.trim();
    } }
  }
  $('network-test').addEventListener('click', () => testConnection(false));
  function commitNetwork() {
    const source = editorSource(); const duplicate = drafts[panel].findIndex(item => item.url === source.url);
    if (duplicate !== -1 && duplicate !== editing) { showNotification('This location is already in your library.','error'); return; }
    if (editing === null) drafts[panel].push(source); else drafts[panel][editing] = source;
    const edited=editing!==null;render(panel); closeNetwork(); showNotification(edited?'Location edits saved. '+(panel==='setup'?'Continue setup to apply them.':'Save your library to apply them.'):'Network location added. Save to apply your choices.');
  }
  $('network-use').addEventListener('click',()=>{if(testing)return;if(tested===signature())commitNetwork();else testConnection(true);});
  for (const id of ['network-url', 'network-username', 'network-password', 'network-domain', 'network-uid', 'network-gid', 'network-nfs-version']) $(id).addEventListener('input', invalidateTest);
  $('network-url').addEventListener('input', () => { const match = /^([a-z]+):\/\//i.exec($('network-url').value.trim()); const protocol = match ? ({ http: 'webdav', https: 'webdav', webdav: 'webdav', webdavs: 'webdav' }[match[1]] || match[1]) : null; if (['smb', 'nfs', 'sftp', 'webdav', 'ftp', 'ftps'].includes(protocol)) { $('network-protocol').value = protocol; updateProtocol(); } });
  $('network-protocol').addEventListener('change', () => { const prefix = $('network-protocol').value === 'webdav' ? 'https' : $('network-protocol').value; $('network-url').value = $('network-url').value.replace(/^[a-z]+:\/\//i, prefix + '://'); invalidateTest(); updateProtocol(); });
  $('network-recheck-key').addEventListener('click', () => { editorHostKey = ''; invalidateTest(); updateProtocol(); testConnection(); });
  $('network-trust-confirm').addEventListener('click', () => { editorHostKey = pendingTrust || ''; pendingTrust = null; $('network-trust-dialog').close(); updateProtocol();const save=saveAfterTrust;saveAfterTrust=false;testConnection(save); });
  for (const id of ['network-trust-close', 'network-trust-cancel']) $(id).addEventListener('click', () => { pendingTrust = null;saveAfterTrust=false;$('network-trust-dialog').close(); });
  function releaseEditor() { editorVersion++; networkController?.abort(); testing = false; $('network-password').value = '';$('network-test').removeAttribute('aria-busy');$('network-test').classList.remove('is-saved'); }
  function closeNetwork() { releaseEditor(); $('network-editor-dialog').close(); }
  for (const id of ['network-editor-close', 'network-editor-cancel']) $(id).addEventListener('click', closeNetwork);
  $('network-editor-dialog').addEventListener('close', () => { if (!$('network-editor-dialog').open) releaseEditor(); });
  closeOnBackdropClick($('network-editor-dialog')); closeOnBackdropClick($('network-trust-dialog'));

  function openFolder(owner, original = null) { if (original === null && !canAdd(owner)) return; folderVersion++; folderPanel = owner; folderOriginal = original;folderFailedPath=''; $('source-folder-path').value = original || ''; $('source-folder-status').textContent = ''; syncFolderButton();openModal($('source-folder-dialog')); }
  function syncFolderButton(){const path=$('source-folder-path').value.trim();$('source-folder-use').disabled=!path||path===(folderOriginal||'')||path===folderFailedPath;}
  $('source-folder-path').addEventListener('input',()=>{$('source-folder-status').textContent='';syncFolderButton();});
  $('source-folder-use').addEventListener('click', async () => {
    const button = $('source-folder-use'); if (button.disabled) return; const version = folderVersion; button.disabled = true;
    try {
      const path = $('source-folder-path').value.trim(); if (!path) throw new Error('Choose a folder first.');
      const result = await jsonRequest('/api/library-folders?path=' + encodeURIComponent(path), { cache: 'no-store' });
      if (version !== folderVersion || !$('source-folder-dialog').open) return;
      const paths = roots(folderPanel); const existing = paths.indexOf(folderOriginal);
      if (paths.includes(result.path) && result.path !== folderOriginal) throw new Error('This folder is already in your library.');
      if (existing !== -1) paths[existing] = result.path; else paths.push(result.path);
      rootsInput(folderPanel).value = paths.join('\n'); render(folderPanel); $('source-folder-dialog').close(); showNotification(folderOriginal?'Folder edits saved to your choices. Save your library to apply.':'Folder added. Save to apply your choices.');
    } catch (error) { folderFailedPath=$('source-folder-path').value.trim();$('source-folder-status').textContent = error.message; }
    finally { syncFolderButton(); }
  });
  for (const id of ['source-folder-close', 'source-folder-cancel']) $(id).addEventListener('click', () => $('source-folder-dialog').close());
  $('source-folder-dialog').addEventListener('close', () => { folderVersion++; });
  closeOnBackdropClick($('source-folder-dialog'));
  const browser = $('source-browser-dialog');
  async function browse(directory = '') {
    const version = ++browseVersion; $('source-browser-select').disabled = true; $('source-browser-status').textContent = 'Loading folders…';
    try {
      const state = await jsonRequest('/api/library-folders' + (directory ? '?path=' + encodeURIComponent(directory) : ''), { cache: 'no-store' });
      if (version !== browseVersion || !browser.open) return;
      folderState = state; $('source-browser-path').textContent = state.path || 'Folders shared with GameShelf'; $('source-browser-up').disabled = !state.path; $('source-browser-select').disabled = !state.path;
      const list = $('source-browser-folders'); list.replaceChildren();
      for (const path of state.folders) { const button = document.createElement('button'); button.type = 'button'; button.className = 'gs-source-folder'; button.textContent = state.path ? path.split('/').pop() : path; button.addEventListener('click', () => browse(path)); list.appendChild(button); }
      $('source-browser-status').textContent = state.folders.length ? '' : state.path ? 'No subfolders. You can select this folder.' : 'No mounted folders found. You can add a Network location instead, or share a folder through Docker.';
    } catch (error) { if (version === browseVersion) $('source-browser-status').textContent = error.message; }
  }
  $('source-folder-browse').addEventListener('click', () => { pickerTarget = $('source-folder-path'); folderState = null; openModal(browser); browse(); });
  $('source-browser-home').addEventListener('click', () => browse()); $('source-browser-up').addEventListener('click', () => browse(folderState?.parent || ''));
  $('source-browser-select').addEventListener('click', () => { if (!folderState?.path || !pickerTarget) return; pickerTarget.value = folderState.path;pickerTarget.dispatchEvent(new Event('input',{bubbles:true})); browser.close(); });
  for (const id of ['source-browser-close', 'source-browser-cancel']) $(id).addEventListener('click', () => browser.close());
  browser.addEventListener('close', () => { browseVersion++; }); closeOnBackdropClick(browser);
  for (const owner of ['setup', 'server']) {
    const draftOwner = owner === 'server' ? 'settings' : 'setup';
    $(owner + '-add-folder').addEventListener('click', () => openFolder(draftOwner)); $(owner + '-add-network').addEventListener('click', () => openNetwork(draftOwner));
  }
  $('source-alert-manage').addEventListener('click',async()=>{if(await window.GameShelfLibraryManager?.open())$('open-server-settings').click();});
  function beginSaveProgress() { readStatus(); const timer=setInterval(readStatus,1200);return ()=>clearInterval(timer); }
  window.GameShelfSetup = { openOptions, beginSaveProgress, boot, initialize: boot, prepareSettings, settingsSources, savedSettings, watchScan };
})();

(() => {
 const layer=document.querySelector('.gs-onboarding-ambient'),tiles=[...layer.querySelectorAll('i')];
 function layoutSetupArt(){
   if(!document.body.classList.contains('gs-needs-setup'))return;
   const mobile=matchMedia('(pointer:coarse)').matches;
   const zoom=mobile?1:Math.max(.25,Math.min(5,window.outerWidth>0?window.outerWidth/innerWidth:1));
   const appScale=typeof uiScale==='number'?uiScale:1;
   layer.style.inset='auto';layer.style.left='0';layer.style.top='0';layer.style.width=innerWidth*zoom+'px';layer.style.height=innerHeight*zoom+'px';layer.style.transformOrigin='top left';layer.style.transform='scale('+(1/(zoom*appScale))+')';
   const w=innerWidth*zoom,h=innerHeight*zoom,box=document.querySelector('#setup-form').getBoundingClientRect();
   const size=mobile?88:Math.min(156,Math.max(110,w*.085));
   const spots=[[.05,.03],[.94,.07],[.10,.78],[.91,.77],[.32,.06],[.68,.08],[.20,.39],[.79,.43],[.35,.82],[.65,.79]];
   const headerBottom=document.querySelector('.gs-header').getBoundingClientRect().bottom*zoom;const minimumTop=headerBottom+Math.max(30,size*.35);
   tiles.forEach((tile,index)=>{const [x,y]=spots[index];tile.style.width=size+'px';tile.style.left=Math.max(8,Math.min(w-size-8,w*x-size/2))+'px';tile.style.top=Math.max(minimumTop,Math.min(h-size*1.5-24,minimumTop+(h-minimumTop-size*1.5-24)*y))+'px';tile.style.right=tile.style.bottom='auto';tile.style.opacity=mobile?'.32':'.5';});
 }
 new ResizeObserver(layoutSetupArt).observe(document.querySelector('#setup-form'));
 addEventListener('resize',layoutSetupArt);window.visualViewport?.addEventListener('resize',layoutSetupArt);new MutationObserver(layoutSetupArt).observe(document.body,{attributes:true,attributeFilter:['class']});
})();
