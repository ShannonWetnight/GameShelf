const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process'),{pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..'),chrome=process.env.CHROME_BIN||(process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':'google-chrome');
function fullUI(probe,{rules={},configured=true,setup=false,width=1280}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gs-family-health-'));
 try{
 const stub=`localStorage.clear();localStorage.setItem('gameshelf:animation-speed','0');let accessState={configured:${configured},policy:{rules:${JSON.stringify(rules)}},actions:{theme:'Theme',covers:'Edit covers',favoriteAdd:'Add favorites',sources:'Library Sources',wipe:'Wipe Settings',health:'Configure health monitoring',healthView:'View Library Health'},grants:{}};let config={rootDir:'/library',rootDirs:['/library'],dataDir:'/data',refreshInterval:'168h',sources:[],setupCompleted:true,setupStatus:'skipped'};const requests=[];let checks=0;
 const response=(data,status=200)=>new Response(typeof data==='string'?data:JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
 window.fetch=async(url,options={})=>{requests.push({url,method:options.method||'GET',body:options.body});
 if(url==='/api/access/unlock'){const request=JSON.parse(options.body);if(request.pin!=='7392')return response({message:'That PIN did not match.'},401);const expiresAt=new Date(Date.now()+120000).toISOString();for(const action of request.actions)accessState.grants[action]=expiresAt;return response({unlocked:request.actions,expiresAt});}
 if(url==='/api/access'){if(options.method==='PUT'){const body=JSON.parse(options.body);accessState.configured=true;accessState.policy=body.policy;}if(options.method==='DELETE'){accessState.configured=false;accessState.policy={rules:{}};}return response(accessState);}
 if(url==='/api/setup')return response({required:${setup},mounts:['/library'],port:8080,settings:config});
 if(url==='/api/server-settings'){if(options.method==='PUT')config=JSON.parse(options.body);return response(options.method==='PUT'?{settings:config}:config);}
 if(url==='/api/health/check'){checks++;return response({checking:true},202);}
 if(url==='/api/health')return response({state:'degraded',checking:false,options:config.health||{enabled:true,intervalSeconds:300},sources:[{id:'a',name:'Home NAS',location:'smb://nas/games',state:'healthy',message:'Location is readable',games:4,lastChecked:'2026-10-25T12:00:00Z',lastSuccess:'2026-10-25T12:00:00Z'},{id:'b',name:'Archive',location:'sftp://archive/games',state:'degraded',message:'Connection check failed',games:2,lastChecked:'2026-10-25T12:00:00Z',lastSuccess:'2026-10-24T12:00:00Z'}],events:[{name:'Home NAS',state:'healthy',message:'Location is readable',at:'2026-10-25T12:00:00Z'}]});
 if(url==='/api/version')return response({channel:'edge',version:'test'});
 if(url==='/api/source-status')return response({busy:false,sources:[]});
 if(url==='/api/settings-events')return response({saved:true});
 if(url.startsWith('/api/cover-fit/'))return response({coverStretch:JSON.parse(options.body).stretch});
 return response([{id:'game',name:'Family Game',hasCover:false,favorite:false,path:'/library/Family Game',fileCount:2,sizeBytes:1024}]);};`;
 let html=fs.readFileSync(path.join(root,'web/index.html'),'utf8').replace('<link rel="stylesheet" href="/styles.css">','<style>'+fs.readFileSync(path.join(root,'web/styles.css'),'utf8')+fs.readFileSync(path.join(root,'web/themes.css'),'utf8')+'</style>');
 html=html.replace('<script src="/access.js"></script>','<script>'+stub+'</script><script>'+fs.readFileSync(path.join(root,'web/access.js'),'utf8')+'</script>');
 for(const name of ['app','setup','tour','health','tooltips'])html=html.replace('<script src="/'+name+'.js"></script>','<script>'+fs.readFileSync(path.join(root,'web/'+name+'.js'),'utf8')+'</script>');
 html+=`<script>addEventListener('load',()=>setTimeout(async()=>{const $=id=>document.getElementById(id),pause=(ms=45)=>new Promise(resolve=>setTimeout(resolve,ms)),result={};try{GameShelfAccess.refreshUI();${probe}}catch(error){result.error=error.stack;}const report=document.createElement('pre');report.id='family-report';report.textContent=JSON.stringify(result);document.body.append(report);},80));</script>`;
 const file=path.join(dir,'test.html');fs.writeFileSync(file,html);
 const run=spawnSync(chrome,['--headless','--disable-gpu','--no-sandbox','--disable-dev-shm-usage','--window-size='+width+',1000','--virtual-time-budget=4000','--dump-dom',pathToFileURL(file).href],{encoding:'utf8',timeout:20000,maxBuffer:16*1024*1024});
 assert.equal(run.status,0,run.stderr);const found=run.stdout.match(/<pre id="family-report">([^<]+)<\/pre>/);assert.ok(found,'Browser did not report family/health UI');const value=JSON.parse(found[1].replaceAll('&amp;','&').replaceAll('&lt;','<').replaceAll('&gt;','>'));assert.equal(value.error,undefined,value.error);return value;
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
test('family policy greys actions, hides settings, and unlocks the intended cover action only',()=>{
 const r=fullUI(`
 result.loaded=document.querySelectorAll('.gs-card').length;result.disabled=document.querySelector('.gs-favorite-star').disabled;result.hidden=$('open-server-settings').closest('.gs-settings-backup').classList.contains('gs-access-hidden');
 document.querySelector('.gs-card-info').click();$('edit-game-cover').click();await pause();result.prompt=$('pin-dialog').open;result.editorClosed=!$('cover-editor-dialog').open;
 $('pin-entry').value='0000';$('pin-form').dispatchEvent(new Event('submit',{cancelable:true}));await pause();result.wrong=$('pin-status').textContent;
 $('pin-entry').value='7392';$('pin-form').dispatchEvent(new Event('submit',{cancelable:true}));await pause(120);result.editor=$('cover-editor-dialog').open;result.parent=$('game-details-dialog').open;result.scopes=Object.keys(accessState.grants);result.stretchMoved=$('cover-editor-dialog').contains($('game-cover-stretch'));
 $('game-cover-stretch').click();await pause();result.enabled=$('game-cover-stretch').getAttribute('aria-pressed');result.slash=$('game-cover-stretch').querySelector('.gs-stretch-slash')!==null;
 `,{rules:{favoriteAdd:{mode:'disable',hidden:false},sources:{mode:'allow',hidden:true},covers:{mode:'pin',hidden:false}}});
 assert.equal(r.loaded,1);assert.equal(r.disabled,true);assert.equal(r.hidden,true);assert.equal(r.prompt,true);assert.equal(r.editorClosed,true);assert.match(r.wrong,/did not match/);assert.equal(r.editor,true);assert.equal(r.parent,true);assert.deepEqual(r.scopes,['covers']);assert.equal(r.stretchMoved,true);assert.equal(r.enabled,'true');assert.equal(r.slash,false);
});
test('family settings create a PIN, save granular modes, and require PIN to reopen management',()=>{
 const r=fullUI(`
 $('build-info').click();$('settings-advanced').click();$('open-family-controls').click();await pause();result.open=$('family-dialog').open;result.removeHidden=getComputedStyle($('family-remove')).display==='none';
 $('family-new-pin').value='7392';$('family-confirm-pin').value='7392';const row=document.querySelector('[data-action="theme"]');row.querySelector('select').value='disable';row.querySelector('input').checked=false;$('family-save').click();await pause(230);
 result.saved=accessState.configured;result.rule=accessState.policy.rules.theme;result.size=[$('family-save').offsetWidth,$('family-save').offsetHeight];result.disabled=$('theme-select').disabled;
 accessState.grants={};await GameShelfAccess.refresh();$('open-family-controls').click();await pause();result.asked=$('pin-dialog').open;$('pin-cancel').click();await pause(200);result.notReopened=!$('family-dialog').open;
 `,{configured:false});assert.equal(r.open,true);assert.equal(r.removeHidden,true);assert.equal(r.saved,true);assert.deepEqual(r.rule,{mode:'disable',hidden:true});assert.equal(r.disabled,true);assert.equal(r.asked,true);assert.equal(r.notReopened,true);
});
test('health shows themed statuses and saves monitoring separately from viewing status',()=>{
 const r=fullUI(`
 $('build-info').click();$('open-library-health').click();await pause();result.open=$('health-dialog').open;result.badges=[...document.querySelectorAll('.gs-health-badge')].map(el=>el.dataset.state);result.history=$('health-history').children.length;
 $('health-check').click();await pause(300);result.checked=checks;document.querySelector('.gs-health-config').open=true;$('health-interval').value=60;$('health-interval').dispatchEvent(new Event('input'));$('health-save').click();await pause();result.saved=config.health;result.banner=$('notification-text').textContent;result.saveSize=[$('health-save').offsetWidth,$('health-save').offsetHeight];
 `);assert.equal(r.open,true);assert.deepEqual(r.badges,['healthy','degraded']);assert.equal(r.history,1);assert.equal(r.checked,1);assert.deepEqual(r.saved,{enabled:true,intervalSeconds:60});assert.match(r.banner,/monitoring saved/);assert.deepEqual(r.saveSize,[38,38]);
});
test('one themed tooltip replaces native titles, follows changes, and closes on leaving',()=>{
 const r=fullUI(`
 const button=$('random-game');button.title='One shared tooltip';await pause();button.dispatchEvent(new PointerEvent('pointerover',{bubbles:true}));await pause(210);result.native=document.querySelectorAll('[title]').length;result.visible=$('app-tooltip').matches(':popover-open');result.text=$('app-tooltip').textContent;result.legacy=getComputedStyle(button,'::after').content;
 button.title='Updated hint';await pause();result.updated=$('app-tooltip').textContent;button.dispatchEvent(new PointerEvent('pointerout',{bubbles:true,relatedTarget:document.body}));result.closed=$('app-tooltip').hidden;result.single=document.querySelectorAll('#app-tooltip').length;
 `);assert.equal(r.native,0);assert.equal(r.visible,true);assert.equal(r.text,'One shared tooltip');assert.equal(r.legacy,'none');assert.equal(r.updated,'Updated hint');assert.equal(r.closed,true);assert.equal(r.single,1);
});
test('all themes use the same rounded card clip, folder action widths, and readable return button',()=>{
 const r=fullUI(`
 result.radii=[];for(const theme of ['classic','light','dark','retro','neon','cartridge','cosmos','ion','rose','midnight','lattice','rain','storm','autumn']){document.documentElement.dataset.theme=theme;const card=document.querySelector('.gs-card');result.radii.push([theme,getComputedStyle(card).borderRadius,getComputedStyle(card.querySelector('img')).borderRadius]);}
 document.documentElement.dataset.theme='cartridge';result.returnBackground=getComputedStyle($('show-all-games')).backgroundColor;result.returnColor=getComputedStyle($('show-all-games')).color;
 openModal($('source-folder-dialog'));result.folder=[$('source-folder-use').offsetWidth,$('source-folder-cancel').offsetWidth];$('source-folder-dialog').close();await pause();openModal($('export-dialog'));result.metadataBorder=getComputedStyle($('reset-game-metadata')).borderColor;result.exportFont=getComputedStyle($('export-confirm')).font;result.cancelFont=getComputedStyle($('export-cancel')).font;result.exportBase=getComputedStyle($('export-confirm')).color;result.cancelBase=getComputedStyle($('export-cancel')).color;
 `);for(const [theme,radius,image]of r.radii){assert.equal(radius,'18px',theme);assert.equal(image,'0px',theme);}assert.equal(r.returnBackground,'rgb(245, 244, 239)');assert.equal(r.returnColor,'rgb(36, 34, 37)');assert.equal(r.folder[0],r.folder[1]);assert.equal(r.exportFont,r.cancelFont);assert.equal(r.exportBase,r.cancelBase);assert.equal(r.metadataBorder,'rgb(202, 89, 100)');
});
test('skipped setup resumes in Basic and ten tilted setup cases stay below the header',()=>{
 const r=fullUI(`
 $('build-info').click();result.basic=$('resume-setup-option').dataset.settingLevel;result.visible=!$('resume-setup-option').hidden&&getComputedStyle($('resume-setup-option')).display!=='none';$('settings-close').click();await pause(200);
 result.cases=document.querySelectorAll('.gs-onboarding-ambient i').length;result.slogan=$('setup-title').textContent;
 `);assert.equal(r.basic,undefined);assert.equal(r.visible,true);assert.equal(r.cases,10);assert.equal(r.slogan,'Your games. Ready to share.');
});

test('rain draws visible splashes on a separate bottom-edge layer and removes both layers',()=>{
 const vm=require('node:vm'),frames=new Map(),canvases=[];let next=0,now=0;
 function host(){return {isConnected:true,children:[],getBoundingClientRect:()=>({width:240,height:360}),appendChild(child){this.children.push(child);child.parentElement=this;}};}
 const cover=host(),ambience=host();ambience.parentElement=cover;
 const document={body:host(),createElement(){const canvas={className:'',strokes:0,setAttribute(){},remove(){this.removed=true;},getContext(){const self=this;return {scale(){},clearRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){self.strokes++;},ellipse(){},fill(){}};}};canvases.push(canvas);return canvas;}};
 const window={devicePixelRatio:1,addEventListener(){},removeEventListener(){}};
 vm.runInNewContext(fs.readFileSync(path.join(root,'web/rain.js'),'utf8'),{document,window,innerWidth:240,innerHeight:360,performance:{now:()=>now},Math,matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}}),requestAnimationFrame:callback=>{frames.set(++next,callback);return next;},cancelAnimationFrame:id=>frames.delete(id)});
 const effect=window.GameShelfRain.start(ambience,'storm',()=>1);
 for(let i=0;i<100;i++){now+=16;const callbacks=[...frames.values()];frames.clear();for(const callback of callbacks)callback(now);}
 const splashes=canvases.find(canvas=>canvas.className==='gs-rain-splash-canvas');assert.ok(splashes.strokes>0,'splash arcs must be drawn');assert.equal(splashes.parentElement,cover,'splashes must sit above the title tray, outside the dim ambience');assert.equal(splashes.height,70);effect.stop();assert.ok(canvases.every(canvas=>canvas.removed));assert.equal(frames.size,0);
});

test('permission changes preserve offline downloads and completed native loading states',()=>{
 const r=fullUI(`
 const link=document.querySelector('.gs-card-download');link.dataset.unavailable='true';link.setAttribute('aria-disabled','true');link.removeAttribute('href');
 accessState.policy.rules={downloads:{mode:'disable',hidden:false},logs:{mode:'disable',hidden:false}};await GameShelfAccess.refresh();result.inert=link.inert;result.blockedCopy=$('logs-copy').disabled;
 $('logs-copy').disabled=false;accessState.policy.rules={};await GameShelfAccess.refresh();result.stillOffline=link.getAttribute('aria-disabled');result.noHref=!link.hasAttribute('href');result.inertCleared=!link.inert;result.readyCopy=!$('logs-copy').disabled;
 `);assert.equal(r.inert,true);assert.equal(r.blockedCopy,true);assert.equal(r.stillOffline,'true');assert.equal(r.noHref,true);assert.equal(r.inertCleared,true);assert.equal(r.readyCopy,true);
});
