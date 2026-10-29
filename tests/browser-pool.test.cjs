const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process'),{pathToFileURL}=require('node:url');
const {waitForEndpoint}=require('./browser-pool.cjs');
test('browser startup waits for a delayed, fully written endpoint',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gs-pool-startup-')),browser={exitCode:null,signalCode:null};
 let timer;
 try{
  const file=path.join(dir,'DevToolsActivePort');fs.writeFileSync(file,'12345\n');
  timer=setTimeout(()=>fs.writeFileSync(file,'12345\n/devtools/browser/delayed\n'),150);
  assert.equal(await waitForEndpoint(browser,dir,{timeoutMs:2000,pollMs:10}),'ws://127.0.0.1:12345/devtools/browser/delayed');
 }finally{clearTimeout(timer);fs.rmSync(dir,{recursive:true,force:true});}
});
test('browser startup reports timeout and early exit diagnostics',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gs-pool-startup-'));
 try{
  const options={timeoutMs:40,pollMs:5,diagnostics:()=> 'Chrome stderr detail'};
  await assert.rejects(waitForEndpoint({exitCode:null,signalCode:null},dir,options),/within 40ms.*Chrome stderr detail/);
  await assert.rejects(waitForEndpoint({exitCode:1,signalCode:null},dir,options),/Chrome exited.*Chrome stderr detail/);
  await assert.rejects(waitForEndpoint({exitCode:null,signalCode:'SIGKILL'},dir,options),/Chrome exited/);
  await assert.rejects(waitForEndpoint({exitCode:null,signalCode:null},dir,{...options,launchError:()=>Error('Chrome executable missing')}),/Chrome executable missing/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('reused Chrome isolates storage between probes and survives a failed probe', {skip:!process.env.GAMESHELF_BROWSER_ENDPOINT},()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gs-pool-isolation-'));
 try{
  const file=path.join(dir,'probe.html'),runner=path.join(__dirname,'live-browser.cjs');
  const run=script=>{fs.writeFileSync(file,'<script>'+script+'</script>');return spawnSync(process.execPath,[runner,pathToFileURL(file).href,'unused','', '1280','1000'],{encoding:'utf8',timeout:15000});};
  let result=run("localStorage.setItem('sentinel','previous probe');document.write('<pre id=family-report>first</pre>');");assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/first/);
  result=run("document.write('<pre id=family-report>'+JSON.stringify(localStorage.getItem('sentinel'))+'</pre>');");assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/>null</);
  // A rejected probe must not close the shared browser used by subsequent probes.
  const failure=spawnSync(process.execPath,[runner,'about:blank','unused','', '-1','1000'],{encoding:'utf8',timeout:15000});assert.notEqual(failure.status,0);
  result=run("document.write('<pre id=family-report>still running</pre>');");assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/still running/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
