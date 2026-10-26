// Optional integration journey against a real Go httptest server, without API mocks.
const assert=require('node:assert/strict'),{spawn}=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
(async()=>{
 const origin=process.argv[2],chrome=process.env.CHROME_BIN||(process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':'google-chrome');
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'gs-smb-playlist-'));
 const browser=spawn(chrome,['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--remote-debugging-pipe','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe','pipe','pipe']});
 const pending=new Map();let id=0,buffer='',session;const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 browser.stdio[4].on('data',data=>{buffer+=data;let end;while((end=buffer.indexOf('\0'))>=0){const raw=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!raw)continue;const value=JSON.parse(raw),request=pending.get(value.id);if(request){pending.delete(value.id);value.error?request.reject(new Error(JSON.stringify(value.error))):request.resolve(value.result);}}});
 const command=(method,params={},sessionId=session)=>new Promise((resolve,reject)=>{const current=++id;pending.set(current,{resolve,reject});browser.stdio[3].write(JSON.stringify({id:current,method,params,sessionId})+'\0');});
 const evaluate=async expression=>{const result=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
 async function waitFor(expression){for(let i=0;i<160;i++){if(await evaluate(expression))return;await pause(50);}throw new Error('Timed out waiting for '+expression);}
 const deadline=setTimeout(()=>{browser.kill();process.stderr.write('SMB Playlist integration timed out');process.exitCode=1;},30000);deadline.unref();
 try{
  const {targetId}=await command('Target.createTarget',{url:'about:blank'},undefined);session=(await command('Target.attachToTarget',{targetId,flatten:true},undefined)).sessionId;
  await command('Page.setDownloadBehavior',{behavior:'allow',downloadPath:profile});
  await command('Page.navigate',{url:origin});
  await waitFor("document.querySelectorAll('.gs-card[data-id]').length===2&&!document.body.classList.contains('gs-booting')");
  // Dismiss optional onboarding so this journey focuses on Playlist controls.
  await evaluate("document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close())");
  await evaluate("document.querySelectorAll('.gs-card[data-id] .gs-card-cart').forEach(button=>button.click())");
  await waitFor("document.querySelector('#cart-count').textContent==='2'");
  await evaluate("document.querySelector('#open-cart').click()");
  await waitFor("document.querySelector('#cart-dialog').open&&document.querySelectorAll('#cart-items li').length===2");
  await evaluate("document.querySelector('#cart-items button').click()");
  await waitFor("document.querySelector('#playlist-confirm-dialog').open");
  await evaluate("document.querySelector('#playlist-confirm-accept').click()");
  await waitFor("document.querySelector('#cart-count').textContent==='1'");
  await evaluate("document.querySelector('#cart-clear').click()");
  await waitFor("document.querySelector('#playlist-confirm-dialog').open");
  await evaluate("document.querySelector('#playlist-confirm-accept').click()");
  await waitFor("document.querySelector('#cart-count').textContent==='0'&&document.querySelector('#cart-checkout').disabled");
  assert.deepEqual(await evaluate("JSON.parse(localStorage.getItem('gameshelf:cart'))"),[]);
  await evaluate("document.querySelector('#cart-close').click();document.querySelectorAll('.gs-card[data-id] .gs-card-cart').forEach(button=>button.click());document.querySelector('#open-cart').click();document.querySelector('#cart-checkout').click()");
  for(let attempt=0;attempt<200;attempt++){
   const file=path.join(profile,'gameshelf-playlist.zip');
   if(fs.existsSync(file)&&fs.statSync(file).size>0){assert.equal(fs.readFileSync(file).subarray(0,2).toString(),'PK');break;}
   if(attempt===199)throw new Error('Playlist browser ZIP did not complete');
   await pause(100);
  }
  assert.equal(await evaluate("document.querySelector('#cart-dialog').open"),false);
  process.stdout.write('PASS: real SMB Playlist add, confirmed remove, confirmed clear, re-add, completed ZIP download\n');
 }finally{clearTimeout(deadline);command('Browser.close').catch(()=>{});await pause(100);browser.kill();await pause(150);const resolved=path.resolve(profile);if(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('gs-smb-playlist-')){try{fs.rmSync(resolved,{recursive:true,force:true});}catch{}}}
})().catch(error=>{process.stderr.write(error.stack);process.exitCode=1;});
