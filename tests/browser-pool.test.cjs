const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process'),{pathToFileURL}=require('node:url');
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
