// A real-time Chrome runner for animation checks (virtual time can suspend rAF).
const {spawn}=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
(async()=>{
 const [url,chrome,output,width='1280',height='1000']=process.argv.slice(2),profile=fs.mkdtempSync(path.join(os.tmpdir(),'gs-live-browser-'));
 const browser=spawn(chrome,['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--remote-debugging-pipe','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe','pipe','pipe']});
 const pending=new Map();let id=0,buffer='';const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 browser.stdio[4].on('data',data=>{buffer+=data;let end;while((end=buffer.indexOf('\0'))>=0){const raw=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!raw)continue;const result=JSON.parse(raw),request=pending.get(result.id);if(request){pending.delete(result.id);result.error?request.reject(new Error(JSON.stringify(result.error))):request.resolve(result.result);}}});
 const command=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const current=++id;pending.set(current,{resolve,reject});browser.stdio[3].write(JSON.stringify({id:current,method,params,sessionId})+'\0');});
 const deadline=setTimeout(()=>{browser.kill();process.stderr.write('Live browser timed out');process.exitCode=1;},12000);deadline.unref();
 try{
  const {targetId}=await command('Target.createTarget',{url:'about:blank'});const {sessionId}=await command('Target.attachToTarget',{targetId,flatten:true});
  await command('Emulation.setDeviceMetricsOverride',{width:Number(width),height:Number(width)<600?844:Number(height),deviceScaleFactor:1,mobile:Number(width)<600},sessionId);
  await command('Page.navigate',{url},sessionId);
  let report;for(let attempt=0;attempt<160;attempt++){await delay(50);const value=await command('Runtime.evaluate',{expression:"document.querySelector('#family-report')?.outerHTML||''",returnByValue:true},sessionId);report=value.result.value;if(report)break;}
  if(!report)throw new Error('Live browser did not finish the probe');
  if(output){await command('Runtime.evaluate',{expression:"document.querySelector('#family-report').style.display='none'",returnByValue:true},sessionId);const {data}=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},sessionId);fs.writeFileSync(output,Buffer.from(data,'base64'));}
  process.stdout.write(report);command('Browser.close').catch(()=>{});await delay(100);
 }finally{clearTimeout(deadline);browser.kill();await delay(150);const resolved=path.resolve(profile);if(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('gs-live-browser-')){try{fs.rmSync(resolved,{recursive:true,force:true});}catch{}}}
})().catch(error=>{process.stderr.write(error.stack);process.exitCode=1;});
