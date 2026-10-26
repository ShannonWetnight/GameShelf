// Optional integration journey against a real Go httptest server, without API mocks.
const assert=require('node:assert/strict'),{spawn}=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
(async()=>{
 const origin=process.argv[2],chrome=process.env.CHROME_BIN||(process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':'google-chrome');
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'gs-profile-live-'));
 const browser=spawn(chrome,['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--remote-debugging-pipe','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe','pipe','pipe']});
 const pending=new Map();let id=0,buffer='',session;const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 browser.stdio[4].on('data',data=>{buffer+=data;let end;while((end=buffer.indexOf('\0'))>=0){const raw=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!raw)continue;const value=JSON.parse(raw),request=pending.get(value.id);if(request){pending.delete(value.id);value.error?request.reject(new Error(JSON.stringify(value.error))):request.resolve(value.result);}}});
 const command=(method,params={},sessionId=session)=>new Promise((resolve,reject)=>{const current=++id;pending.set(current,{resolve,reject});browser.stdio[3].write(JSON.stringify({id:current,method,params,sessionId})+'\0');});
 const evaluate=async expression=>{const result=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
 async function waitFor(expression){for(let i=0;i<160;i++){if(await evaluate(expression))return;await pause(50);}throw new Error('Timed out waiting for '+expression);}
 const deadline=setTimeout(()=>{browser.kill();process.stderr.write('Profile integration timed out');process.exitCode=1;},30000);deadline.unref();
 try{
  const {targetId}=await command('Target.createTarget',{url:'about:blank'},undefined);session=(await command('Target.attachToTarget',{targetId,flatten:true},undefined)).sessionId;
  await command('Page.navigate',{url:origin});await waitFor("document.querySelector('#profile-picker')?.open");
  assert.equal(await evaluate("document.querySelectorAll('.gs-card').length"),0,'catalog exposed before profile login');
  await evaluate("document.querySelector('.gs-profile-tile').click();document.querySelector('#pin-entry').value='0000';document.querySelector('#pin-form').requestSubmit()");
  await waitFor("document.querySelector('#notification-banner').classList.contains('gs-notification-error')&&!document.querySelector('#pin-submit').disabled");
  assert.equal(await evaluate("document.querySelector('#pin-dialog').open&&document.querySelector('#profile-picker').open"),true,'failed sign-in lost the picker');
  await evaluate("document.querySelector('#pin-entry').value='2468';document.querySelector('#pin-form').requestSubmit()");
  await waitFor("document.querySelectorAll('.gs-card').length===1&&!document.body.classList.contains('gs-booting')");
  assert.deepEqual(await evaluate("gamesCache.map(game=>game.name)"),['Allowed']);
  assert.equal(await evaluate("fetch('/download/hidden').then(r=>r.status)"),404);
  assert.equal(await evaluate("fetch('/covers/hidden').then(r=>r.status)"),404);
  await evaluate("document.querySelector('.gs-favorite-star').click()");await waitFor("gamesCache[0].favorite===true");
  await evaluate("document.querySelector('#profile-switcher').click()");await waitFor("document.querySelector('#profile-picker').open");
  await evaluate("document.querySelector('#profile-guardian').click()");await waitFor("document.querySelector('#pin-dialog').open");
  assert.equal(await evaluate("document.querySelector('#pin-title').textContent"),'PIN Required');
  await evaluate("document.querySelector('#pin-entry').value='7392';document.querySelector('#pin-form').requestSubmit()");
  await waitFor("document.querySelector('#family-dialog').open&&!document.querySelector('#pin-dialog').open");
  await evaluate("document.querySelector('#family-open-profiles').click()");await waitFor("document.querySelector('#profiles-dialog').open&&document.querySelector('#profiles-list').textContent.includes('Jamie')");
  assert.equal(await evaluate("document.querySelector('#pin-dialog').open"),false,'Guardian lease prompted twice');
  assert.equal(await evaluate("fetch('/api/profiles?manage=1').then(r=>r.json()).then(r=>r.profiles[0].favorites.allowed)"),true);
  await evaluate("document.querySelector('#profiles-list button').click()");await waitFor("document.querySelector('#profile-editor-dialog').open");
  await evaluate("document.querySelector('#profile-photo-change').click()");await waitFor("document.querySelector('#avatar-dialog').open");
  await waitFor("document.querySelector('[data-avatar=\"builtin:cosmic-fox\"] img').naturalWidth===256");
  await evaluate("document.querySelector('[data-avatar=\"builtin:cosmic-fox\"]').click();document.querySelector('#avatar-select').click()");
  await waitFor("!document.querySelector('#avatar-dialog').open&&document.querySelector('#profile-photo-image').src.includes('cosmic-fox')");
  await evaluate("document.querySelector('#profile-nickname').value='Jamie Updated';document.querySelector('#profile-editor-save').click()");
  await waitFor("document.querySelector('#profiles-list').textContent.includes('Jamie Updated')");
  assert.equal(await evaluate("document.querySelector('#pin-dialog').open"),false,'save repeated Guardian PIN prompt');
  assert.equal(await evaluate("fetch('/api/profiles').then(r=>r.json()).then(r=>r.needsProfile)"),true,'profile edit failed to revoke login');
  assert.equal(await evaluate("fetch('/api/profiles').then(r=>r.json()).then(r=>r.profiles[0].avatar)"),'builtin:cosmic-fox');
  process.stdout.write('Live profile login, personal favorite, restricted direct routes, Guardian recovery, edit, and revocation passed.\n');
 }finally{clearTimeout(deadline);command('Browser.close').catch(()=>{});await pause(100);browser.kill();await pause(150);const resolved=path.resolve(profile);if(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('gs-profile-live-')){try{fs.rmSync(resolved,{recursive:true,force:true});}catch{}}}
})().catch(error=>{process.stderr.write(error.stack);process.exitCode=1;});
