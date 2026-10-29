// Shared browser transport, with isolated contexts and real time for animation probes.
const {spawn}=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
(async()=>{
 const [url,chrome,output,width='1280',height='1000']=process.argv.slice(2),endpoint=process.env.GAMESHELF_BROWSER_ENDPOINT;
 const profile=endpoint?null:fs.mkdtempSync(path.join(os.tmpdir(),'gs-live-browser-'));
 const browser=endpoint?null:spawn(chrome,['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--remote-debugging-pipe','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe','pipe','pipe']});
 const pending=new Map();let id=0,buffer='',socket,context;const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 function receive(raw){const result=JSON.parse(raw),request=pending.get(result.id);if(request){pending.delete(result.id);result.error?request.reject(new Error(JSON.stringify(result.error))):request.resolve(result.result);}}
 if(endpoint){socket=new WebSocket(endpoint);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});socket.addEventListener('message',event=>receive(event.data));}
 else browser.stdio[4].on('data',data=>{buffer+=data;let end;while((end=buffer.indexOf('\0'))>=0){const raw=buffer.slice(0,end);buffer=buffer.slice(end+1);if(raw)receive(raw);}});
 const command=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const current=++id;pending.set(current,{resolve,reject});const value=JSON.stringify({id:current,method,params,sessionId});socket?socket.send(value):browser.stdio[3].write(value+'\0');});
 const deadline=setTimeout(()=>{browser?.kill();socket?.close();process.stderr.write('Browser probe timed out\n');process.exit(1);},12000);deadline.unref();
 try{
  context=(await command('Target.createBrowserContext',{disposeOnDetach:true})).browserContextId;
  const {targetId}=await command('Target.createTarget',{url:'about:blank',browserContextId:context});const {sessionId}=await command('Target.attachToTarget',{targetId,flatten:true});
  await command('Emulation.setDeviceMetricsOverride',{width:Number(width),height:Number(width)<600?844:Number(height),deviceScaleFactor:1,mobile:Number(width)<600},sessionId);
  await command('Page.navigate',{url},sessionId);
  // Multi-scale animation probes intentionally spend over four seconds in UI waits.
  let report;for(let attempt=0;attempt<320;attempt++){await delay(25);const value=await command('Runtime.evaluate',{expression:"document.querySelector('#family-report')?.outerHTML||''",returnByValue:true},sessionId);report=value.result.value;if(report)break;}
  if(!report)throw new Error('Browser did not finish the probe');
  if(output){await command('Runtime.evaluate',{expression:"document.querySelector('#family-report').style.display='none'",returnByValue:true},sessionId);const {data}=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},sessionId);fs.writeFileSync(output,Buffer.from(data,'base64'));}
  process.stdout.write(report);
 }finally{
  clearTimeout(deadline);if(context)await command('Target.disposeBrowserContext',{browserContextId:context}).catch(()=>{});
  if(socket)socket.close();if(browser){browser.kill();await delay(150);const resolved=path.resolve(profile);if(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('gs-live-browser-')){try{fs.rmSync(resolved,{recursive:true,force:true});}catch{}}}
 }
})().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
