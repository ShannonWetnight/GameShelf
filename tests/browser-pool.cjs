// One Chrome process per suite run; every probe still receives a fresh browser context.
const {spawn}=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
async function main(){
 const separator=process.argv.indexOf('--'),command=process.argv.slice(separator+1);if(separator<0||!command.length)throw Error('Usage: node browser-pool.cjs -- node --test ...');
 const chrome=process.env.CHROME_BIN||(process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':'google-chrome');
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'gs-browser-pool-')),browser=spawn(chrome,['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
 const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));let child,launchError;browser.on('error',error=>launchError=error);
 const stop=()=>{child?.kill();browser.kill();};process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try{
  let endpoint;for(let n=0;n<200;n++){if(launchError)throw launchError;if(browser.exitCode!==null)throw Error('Chrome exited before opening its debugging endpoint.');try{const [port,url]=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').trim().split(/\r?\n/);if(port&&url){endpoint='ws://127.0.0.1:'+port+url;break;}}catch{}await pause(25);}
  if(!endpoint)throw Error('Chrome debugging endpoint did not start.');
  child=spawn(command[0],command.slice(1),{windowsHide:true,stdio:'inherit',env:{...process.env,GAMESHELF_BROWSER_ENDPOINT:endpoint}});
  return await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve(signal?1:code??1));});
 }finally{
  browser.kill();await pause(150);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  const resolved=path.resolve(profile);if(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('gs-browser-pool-')){try{fs.rmSync(resolved,{recursive:true,force:true});}catch{}}
 }
}
if(require.main===module)main().then(code=>process.exitCode=code).catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
