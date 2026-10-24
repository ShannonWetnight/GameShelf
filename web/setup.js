/* First-run setup and the shared, mount-confined library folder picker. */
(() => {
  const byId = id => document.getElementById(id);
  let current = null, target = null, browseVersion = 0, folderState = null;
  const rootsOf = settings => settings.rootDirs?.length ? settings.rootDirs : settings.rootDir ? [settings.rootDir] : [];
  async function jsonRequest(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error((await response.text()).trim() || 'Could not connect to GameShelf.');
    return response.json();
  }
  async function initialize(settings) {
    try {
      current = await jsonRequest('/api/setup', {cache:'no-store'});
      if (typeof current.required !== 'boolean') throw new Error('Could not read setup options.');
      byId('setup-page').hidden = !current.required;
      document.body.classList.toggle('gs-needs-setup', current.required);
      if (!current.required) return;
      byId('setup-retry').hidden = true; byId('setup-status').textContent = '';
      const value = current.settings || settings;
      serverSettings = value;
      byId('setup-roots').value = rootsOf(value).join('\n') || (current.mounts.length === 1 ? current.mounts[0] : '');
      byId('setup-data').value = value.dataDir || '/data';
      const hours = value.refreshInterval === '0' ? 0 : Number(String(value.refreshInterval).replace(/h$/, ''));
      byId('setup-refresh').value = Number.isInteger(hours) && hours <= 8760 ? hours : 168;
      byId('setup-mount-summary').textContent = current.mounts.length ? `${current.mounts.length} mounted folder${current.mounts.length === 1 ? '' : 's'} available.` : 'No readable game folders are available yet.';
      byId('setup-mapping-help').open = current.mounts.length === 0;
    } catch (error) {
      if (!settings.rootDir) {
        byId('setup-page').hidden = false; document.body.classList.add('gs-needs-setup');
        byId('setup-status').textContent = error.message; byId('setup-retry').hidden = false;
      } else showNotification('Could not check first-time setup. Reload to try again.');
    }
  }
  byId('setup-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = byId('setup-save'); if (button.disabled) return;
    if (!current || !serverSettings) { byId('setup-status').textContent = 'Use Retry connection before saving setup.'; return; }
    const roots = byId('setup-roots').value.split(/\r?\n/).map(path=>path.trim()).filter(Boolean);
    const hours = Number(byId('setup-refresh').value);
    if (!roots.length) { byId('setup-status').textContent = 'Choose at least one game library folder.'; byId('setup-roots').focus(); return; }
    if (roots.length > 16 || !Number.isInteger(hours) || hours < 0 || hours > 8760) { byId('setup-status').textContent = 'Choose up to 16 folders and a refresh interval of 0–8760 whole hours.'; return; }
    const value = {...serverSettings,rootDir:roots[0],rootDirs:roots,dataDir:byId('setup-data').value.trim(),refreshInterval:hours===0?'0':`${hours}h`};
    button.disabled = true; byId('setup-status').textContent = 'Saving your choices and finding your games…';
    try {
      await jsonRequest('/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
      serverSettings = value; current.required = false; showSaveFeedback(button);
      byId('setup-page').hidden = true; document.body.classList.remove('gs-needs-setup');
      await loadGames(); showNotification('Setup complete. Welcome to GameShelf!');
    } catch (error) { byId('setup-status').textContent = error.message; }
    finally { button.disabled = false; }
  });
  byId('setup-retry').addEventListener('click',()=>initialize(serverSettings || {}));
  const browser = byId('source-browser-dialog');
  async function browse(directory='') {
    const version=++browseVersion; byId('source-browser-select').disabled=true; byId('source-browser-status').textContent='Loading folders…';
    try {
      const state=await jsonRequest('/api/library-folders'+(directory?'?path='+encodeURIComponent(directory):''),{cache:'no-store'});
      if(version!==browseVersion || !browser.open)return;
      folderState=state; byId('source-browser-path').textContent=state.path || 'Folders shared with GameShelf';
      byId('source-browser-up').disabled=!state.path; byId('source-browser-select').disabled=!state.path;
      const list=byId('source-browser-folders');list.replaceChildren();
      for(const path of state.folders){const button=document.createElement('button');button.type='button';button.className='gs-source-folder';button.textContent=state.path?path.split('/').pop():path;button.addEventListener('click',()=>browse(path));list.appendChild(button);}
      byId('source-browser-status').textContent=state.folders.length?'':state.path?'No subfolders. You can select this folder.':'No game folders are shared yet. Add a Docker folder mapping, then recreate the container.';
    } catch(error){if(version===browseVersion)byId('source-browser-status').textContent=error.message;}
  }
  function openPicker(input){target=input;folderState=null;openModal(browser);browse();}
  byId('setup-browse').addEventListener('click',()=>openPicker(byId('setup-roots')));
  byId('server-browse-source').addEventListener('click',()=>openPicker(byId('server-root-path')));
  byId('source-browser-home').addEventListener('click',()=>browse());
  byId('source-browser-up').addEventListener('click',()=>browse(folderState?.parent || ''));
  byId('source-browser-select').addEventListener('click',()=>{if(!folderState?.path || !target)return;const paths=target.value.split(/\r?\n/).map(p=>p.trim()).filter(Boolean);if(!paths.includes(folderState.path))paths.push(folderState.path);target.value=paths.join('\n');browser.close();showNotification('Library folder selected. Save to apply your choices.');});
  for(const id of ['source-browser-close','source-browser-cancel'])byId(id).addEventListener('click',()=>browser.close());
  browser.addEventListener('close',()=>{browseVersion++;});closeOnBackdropClick(browser);
  window.GameShelfSetup={initialize};
})();
