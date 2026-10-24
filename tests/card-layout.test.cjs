// Run with Node.js 18+ and Chrome: node --test tests/card-layout.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'web/styles.css'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'web/themes.css'), 'utf8');
const app = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');
const chrome = process.env.CHROME_BIN || (process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'google-chrome');

test('compact cards show hover actions and retain actions in list view', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gameshelf-card-layout-'));
  try {
    const fetchStub = '<script>window.fetch = function(url) {' +
      'const data = url === "/api/version" ? {version:"v-test",channel:"stable"} :' +
      '[{id:"sample",name:"A Sample Game",sizeBytes:1024,path:"/GameShelf/A Sample Game",fileCount:2,hasCover:true,addedAt:""},' +
      '{id:"missing",name:"No Cover",sizeBytes:100,path:"/GameShelf/No Cover",fileCount:1,hasCover:false,addedAt:""}];' +
      'return Promise.resolve({ok:true,json:function(){return Promise.resolve(data);}});' +
      '};</script>';
    const probe = '<script>window.addEventListener("load", function() {' +
      'setTimeout(function() {' +
      'const card = document.querySelector(".gs-card");' +
      'const cover = card.querySelector(".gs-card-cover");' +
      'const actions = card.querySelector(".gs-card-actions");' +
      'const dl = card.querySelector(".gs-card-download");' +
      'const info = card.querySelector(".gs-card-info");' +
      'const missing=document.querySelector(".gs-no-cover");' +
      'const missingImage=missing.querySelector("img");' +
      'const missingTitle=missing.querySelector(".gs-cover-title");' +
      'const placeholderTitle=missing.querySelector(".gs-placeholder-title");' +
      'const inside = function(a,b) {const x=a.getBoundingClientRect(),y=b.getBoundingClientRect();' +
      'return x.left>=y.left-1&&x.right<=y.right+1&&x.top>=y.top-1&&x.bottom<=y.bottom+1;};' +
      'const result = {compact:card.getBoundingClientRect().height<500,' +
      'touchLayout:matchMedia("(hover: none)").matches,' +
      'gridDownloadInside:inside(dl,cover),gridInfoInside:inside(info,cover),' +
      'gridActionsOpacity:getComputedStyle(actions).opacity,' +
      'href:dl.getAttribute("href"),label:dl.getAttribute("aria-label"),' +
      'defaultFooter:getComputedStyle(card.querySelector(".gs-card-body")).display,' +
      'defaultMissingImage:getComputedStyle(missingImage).display,' +
      'defaultMissingTitle:getComputedStyle(missingTitle).display};' +
      'card.click();result.gridBareClickSuppressed=card.classList.contains("gs-hover-suppressed");' +
      'card.dispatchEvent(new PointerEvent("pointerleave"));' +
      'const placeholder=document.querySelector("#show-placeholder-images");' +
      'placeholder.checked=true;placeholder.dispatchEvent(new Event("change"));' +
      'result.placeholderImage=getComputedStyle(missingImage).display;' +
      'result.placeholderTitle=getComputedStyle(missingTitle).display;' +
      'result.placeholderOverlay=getComputedStyle(placeholderTitle).display;' +
      'result.placeholderBackdrop=getComputedStyle(placeholderTitle).backgroundColor;' +
      'result.placeholderText=placeholderTitle.textContent;' +
      'result.placeholderFillsCover=missingImage.getBoundingClientRect().height>=missing.querySelector(".gs-card-cover").getBoundingClientRect().height-1;' +
      'result.placeholderFooter=getComputedStyle(missing.querySelector(".gs-card-body")).display;' +
      'result.realCoverFooter=getComputedStyle(card.querySelector(".gs-card-body")).display;' +
      'const titles=document.querySelector("#show-game-titles");' +
      'titles.checked=true;titles.dispatchEvent(new Event("change"));' +
      'result.allTitlesFooter=getComputedStyle(card.querySelector(".gs-card-body")).display;' +
      'result.titleBackdrop=getComputedStyle(card.querySelector(".gs-card-body")).backgroundColor;' +
      'result.missingCenteredTitle=getComputedStyle(missingTitle).display;' +
      'document.querySelector("#view-toggle").click();' +
      'result.listMissingImage=getComputedStyle(missingImage).display;' +
      'result.listMissingTitle=getComputedStyle(placeholderTitle).display;' +
      'result.listDownloadVisible=getComputedStyle(dl).display!=="none";' +
      'result.listInfoVisible=getComputedStyle(info).display!=="none";' +
      'result.listDownloadInside=inside(dl,card);' +
      'result.listInfoInside=inside(info,card);' +
      'card.click();result.listBareClickSuppressed=card.classList.contains("gs-hover-suppressed");' +
      'card.dispatchEvent(new PointerEvent("pointerleave"));' +
      'result.listActionsPointer=getComputedStyle(actions).pointerEvents;' +
      'dl.focus();result.listFocusedPointer=getComputedStyle(actions).pointerEvents;' +
      'dl.addEventListener("click",function(e){e.preventDefault();},{once:true});dl.click();' +
      'result.downloadSuppressed=card.classList.contains("gs-hover-suppressed");' +
      'result.downloadPointer=getComputedStyle(actions).pointerEvents;' +
      'card.dispatchEvent(new PointerEvent("pointerleave"));' +
      'result.downloadRestored=!card.classList.contains("gs-hover-suppressed");' +
      'info.click();document.querySelector("#game-details-dialog").close();' +
      'setTimeout(function(){' +
      'result.suppressed=card.classList.contains("gs-hover-suppressed");' +
      'result.closedPointer=getComputedStyle(actions).pointerEvents;' +
      'const report=document.createElement("pre");report.id="card-layout-report";' +
      'report.textContent=JSON.stringify(result);document.body.append(report);' +
      '},30);},0);});</script>';
    const source = html
      .replace('<link rel="stylesheet" href="/styles.css">', '<style>' + css + '</style>')
      .replace('<script src="/app.js"></script>', fetchStub + '<script>' + app + '</script>' + probe);
    const file = path.join(dir, 'card.html');
    fs.writeFileSync(file, source);
    const run = spawnSync(chrome, ['--headless', '--disable-gpu', '--no-sandbox',
      '--disable-dev-shm-usage', '--window-size=1280,800', '--virtual-time-budget=2000',
      '--dump-dom', pathToFileURL(file).href], { encoding: 'utf8', timeout: 15000, maxBuffer: 10 * 1024 * 1024 });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
    const match = run.stdout.match(/<pre id="card-layout-report">([^<]+)<\/pre>/);
    assert.ok(match, 'Chrome did not report the rendered card');
    const result = JSON.parse(match[1]);
    assert.equal(result.href, '/download/sample');
    assert.equal(result.label, 'Download A Sample Game');
    assert.equal(result.compact, true);
    assert.equal(result.gridBareClickSuppressed, false);
    assert.equal(result.listBareClickSuppressed, false);
    assert.equal(result.gridDownloadInside, result.gridInfoInside, 'grid actions should move together');
    assert.equal(result.gridActionsOpacity, result.touchLayout ? '1' : '0');
    assert.equal(result.defaultFooter, 'none');
    assert.notEqual(result.defaultMissingImage, 'none');
    assert.equal(result.defaultMissingTitle, 'none');
    assert.notEqual(result.placeholderImage, 'none');
    assert.equal(result.placeholderTitle, 'none');
    assert.equal(result.placeholderOverlay, 'none');
    assert.notEqual(result.placeholderBackdrop, 'rgba(0, 0, 0, 0)');
    assert.equal(result.placeholderText, 'No Cover');
    assert.equal(result.placeholderFillsCover, true);
    assert.equal(result.placeholderFooter, 'none');
    assert.equal(result.realCoverFooter, 'none');
    assert.notEqual(result.allTitlesFooter, 'none');
    assert.equal(result.titleBackdrop, result.placeholderBackdrop);
    assert.equal(result.missingCenteredTitle, 'none');
    assert.equal(result.listMissingImage, 'none');
    assert.equal(result.listMissingTitle, 'none');
    assert.equal(result.listDownloadVisible, true);
    assert.equal(result.listInfoVisible, true);
    assert.equal(result.listDownloadInside, result.listInfoInside, 'list actions should move together');
    assert.equal(result.listActionsPointer, result.touchLayout ? 'auto' : 'none');
    assert.equal(result.listFocusedPointer, 'auto');
    assert.equal(result.downloadSuppressed, false);
    assert.equal(result.downloadPointer, result.touchLayout ? 'auto' : 'none');
    assert.equal(result.downloadRestored, true);
    assert.equal(result.suppressed, false);
    assert.equal(result.closedPointer, result.touchLayout ? 'auto' : 'none');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cover editor crops artwork and updates the card after upload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gameshelf-cover-editor-'));
  try {
    const image = fs.readFileSync(path.join(root, 'web/placeholder.png')).toString('base64');
    const fetchStub = `<script>
      window.fetch = function(url, options) {
        if (url === '/api/version') return Promise.resolve({ok:true,json:async()=>({version:'v-test',channel:'stable'})});
        if (url.startsWith('/api/covers/')) {
          window.coverUpload = {url, type:options.headers['Content-Type'], size:options.body.size};
          return Promise.resolve({ok:true,status:204});
        }
        return Promise.resolve({ok:true,json:async()=>[{
          id:'missing',name:'No Cover',sizeBytes:100,path:'/games/No Cover',fileCount:1,hasCover:false,addedAt:''
        }]});
      };
    </script>`;
    const probe = `<script>window.addEventListener('load', function() {
      setTimeout(async function() {
        document.querySelector('.gs-card-info').click();
        document.querySelector('#edit-game-cover').click();
        const editor = document.querySelector('#cover-editor-dialog');
        const parentStayedOpen = document.querySelector('#game-details-dialog').open;
        const emptyUploadVisible = getComputedStyle(document.querySelector('.gs-cover-preview-upload')).opacity === '1';
        document.querySelector('#cover-editor-file').dispatchEvent(new Event('cancel', {bubbles:true}));
        await new Promise(resolve => setTimeout(resolve, 220));
        const pickerCancelKeepsEditor = editor.open;
        document.querySelector('#cover-editor-cancel').click();
        await new Promise(resolve => setTimeout(resolve, 220));
        const returnedToDetails = document.querySelector('#game-details-dialog').open && !editor.open;
        document.querySelector('#edit-game-cover').click();
        const bytes = Uint8Array.from(atob('${image}'), character => character.charCodeAt(0));
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], 'cover.png', {type:'image/png'}));
        const input = document.querySelector('#cover-editor-file');
        input.files = transfer.files;
        input.dispatchEvent(new Event('change'));
        setTimeout(function() {
          document.querySelector('#cover-rotate-right').click();
          const tilt = document.querySelector('#cover-tilt');
          tilt.value = '8'; tilt.dispatchEvent(new Event('input'));
          const zoom = document.querySelector('#cover-zoom');
          zoom.value = '1.25'; zoom.dispatchEvent(new Event('input'));
          const gridDuringEdit = document.querySelector('#cover-preview').classList.contains('is-adjusting');
          const zoomReadout = document.querySelector('#cover-zoom-value').textContent;
          const tiltReadout = document.querySelector('#cover-tilt-value').textContent;
          document.querySelector('#cover-editor-reset').click();
          const resetZoom = document.querySelector('#cover-zoom-value').textContent;
          const resetTilt = document.querySelector('#cover-tilt-value').textContent;
          const resetSaveDisabled = document.querySelector('#cover-editor-save').disabled;
          const retryTransfer = new DataTransfer();
          retryTransfer.items.add(new File([bytes], 'cover-again.png', {type:'image/png'}));
          input.files = retryTransfer.files;
          input.dispatchEvent(new Event('change'));
          setTimeout(function() {
          const canvas = document.querySelector('#cover-editor-canvas');
          const preview = canvas.toDataURL('image/png');
          canvas.toBlob = callback => callback(new Blob([bytes], {type:'image/png'}));
          document.querySelector('#cover-editor-save').click();
          setTimeout(function() {
            const card = document.querySelector('.gs-card');
            const report = document.createElement('pre');
            report.id = 'cover-editor-report';
            report.textContent = JSON.stringify({
              editorOpened:editor.open === false,
              emptyUploadVisible,parentStayedOpen,pickerCancelKeepsEditor,returnedToDetails,gridDuringEdit,zoomReadout,tiltReadout,
              resetZoom,resetTilt,resetSaveDisabled,
              previewIsPNG:preview.startsWith('data:image/png;base64,'),
              uploaded:window.coverUpload,
              saveDisabled:document.querySelector('#cover-editor-save').disabled,
              status:document.querySelector('#cover-editor-status').textContent,
              returnedAfterSave:document.querySelector('#game-details-dialog').open,
              notification:document.querySelector('#notification-text').textContent,
              hasCover:!card.classList.contains('gs-no-cover'),
              coverUrl:card.querySelector('img').getAttribute('src')
            });
            document.body.append(report);
          }, 1050);
          }, 350);
        }, 100);
      }, 0);
    });</script>`;
    const source = html
      .replace('<link rel="stylesheet" href="/styles.css">', `<style>${css}</style>`)
      .replace('<script src="/app.js"></script>', fetchStub + `<script>${app}</script>` + probe);
    const file = path.join(dir, 'cover-editor.html');
    fs.writeFileSync(file, source);
    const run = spawnSync(chrome, ['--headless', '--disable-gpu', '--no-sandbox',
      '--disable-dev-shm-usage', '--window-size=1280,800', '--virtual-time-budget=3000',
      '--dump-dom', pathToFileURL(file).href], { encoding: 'utf8', timeout: 15000, maxBuffer: 10 * 1024 * 1024 });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
    const match = run.stdout.match(/<pre id="cover-editor-report">([^<]+)<\/pre>/);
    assert.ok(match, 'Chrome did not report the cover editor');
    const result = JSON.parse(match[1]);
    assert.equal(result.editorOpened, true, JSON.stringify(result));
    assert.equal(result.emptyUploadVisible, true);
    assert.equal(result.pickerCancelKeepsEditor, true);
    assert.equal(result.parentStayedOpen, true);
    assert.equal(result.returnedToDetails, true);
    assert.equal(result.gridDuringEdit, true);
    assert.equal(result.zoomReadout, '125%');
    assert.equal(result.tiltReadout, '8°');
    assert.equal(result.resetZoom, '100%');
    assert.equal(result.resetTilt, '0°');
    assert.equal(result.resetSaveDisabled, true);
    assert.equal(result.previewIsPNG, true);
    assert.equal(result.uploaded.url, '/api/covers/missing');
    assert.equal(result.uploaded.type, 'image/png');
    assert.ok(result.uploaded.size > 0);
    assert.equal(result.hasCover, true);
    assert.equal(result.returnedAfterSave, true);
    assert.equal(result.status, '');
    assert.equal(result.notification, 'Cover art saved.');
    assert.match(result.coverUrl, /^\/covers\/missing\?v=/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('editing a GameShelf title updates the card without changing its folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gameshelf-title-editor-'));
  try {
    const fetchStub = `<script>window.fetch = function(url, options) {
      if (url === '/api/version') return Promise.resolve({ok:true,json:async()=>({version:'v-test',channel:'stable'})});
      if (url.startsWith('/api/game-title/')) {
        window.titleRequest = {url, body:JSON.parse(options.body)};
        return Promise.resolve({ok:true,json:async()=>({name:window.titleRequest.body.title})});
      }
      return Promise.resolve({ok:true,json:async()=>[{
        id:'sample',name:'Folder Name',sizeBytes:100,path:'/games/Folder Name',fileCount:1,hasCover:false,addedAt:''
      }]});
    };</script>`;
    const probe = `<script>window.addEventListener('load', function() {
      setTimeout(function() {
        document.querySelector('.gs-card-info').click();
        const menuFocusIsNeutral = document.activeElement === document.querySelector('#game-details-dialog');
        document.querySelector('#game-title-input').value = 'Display Name';
        document.querySelector('#save-game-title').click();
        setTimeout(function() {
          const report = document.createElement('pre'); report.id='title-report';
          report.textContent=JSON.stringify({menuFocusIsNeutral,request:window.titleRequest,
            cardTitle:document.querySelector('.gs-card-title').textContent,
            detailTitle:document.querySelector('#game-details-title').textContent,
            folderPath:document.querySelector('#game-details-path').textContent});
          document.body.append(report);
        },50);
      },0);
    });</script>`;
    const source = html.replace('<link rel="stylesheet" href="/styles.css">', `<style>${css}</style>`)
      .replace('<script src="/app.js"></script>', fetchStub + `<script>${app}</script>` + probe);
    const file = path.join(dir, 'title.html');
    fs.writeFileSync(file, source);
    const run = spawnSync(chrome, ['--headless', '--disable-gpu', '--no-sandbox',
      '--disable-dev-shm-usage', '--window-size=1280,800', '--virtual-time-budget=2000',
      '--dump-dom', pathToFileURL(file).href], { encoding: 'utf8', timeout: 15000, maxBuffer: 10 * 1024 * 1024 });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
    const match = run.stdout.match(/<pre id="title-report">([^<]+)<\/pre>/);
    assert.ok(match, 'Chrome did not report the title edit');
    const result = JSON.parse(match[1]);
    assert.equal(result.menuFocusIsNeutral, true);
    assert.deepEqual(result.request, { url: '/api/game-title/sample', body: { title: 'Display Name' } });
    assert.equal(result.cardTitle, 'Display Name');
    assert.equal(result.detailTitle, 'Display Name');
    assert.equal(result.folderPath, '/games/Folder Name');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('list preview keeps scroll position and the revealed favorite accepts pointer clicks', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gameshelf-list-interaction-'));
  try {
    const setup=`<script>localStorage.setItem('gameshelf:view','list');localStorage.setItem('gameshelf:list-image-click','single');window.fetch=async(url,opts)=>({ok:true,json:async()=>url==='/api/version'?{version:'test',channel:'edge'}:url.startsWith('/api/favorite/')?{favorite:true}:Array.from({length:80},(_,i)=>({id:'game'+i,name:'Game '+String(i).padStart(2,'0'),sizeBytes:100,hasCover:false}))});</script>`;
    const probe=`<script>window.addEventListener('load',()=>setTimeout(async()=>{
      window.scrollTo({top:1600,behavior:'instant'});const before=scrollY;
      const cards=[...document.querySelectorAll('.gs-card')];const card=cards.find(c=>{const r=c.getBoundingClientRect();return r.top>100&&r.bottom<innerHeight-30});
      card.querySelector('.gs-list-image').click();const during=scrollY;document.querySelector('#list-image-dialog').close();
      await new Promise(r=>setTimeout(r,220));const after=scrollY;
      card.querySelector('.gs-card-actions').style.transition='none';card.classList.add('test-hover');card.querySelector('.gs-card-info').focus();await new Promise(r=>setTimeout(r,220));
      const star=card.querySelector('.gs-favorite-star'),b=star.getBoundingClientRect();const hit=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)===star;
      const actions=card.querySelector('.gs-card-actions'),beforeOpacity=getComputedStyle(actions).opacity;
      card.querySelector('.gs-card-cart').click();await new Promise(r=>setTimeout(r,220));
      const hoverRetained=beforeOpacity==='1'&&getComputedStyle(actions).opacity==='1'&&!card.classList.contains('gs-hover-suppressed');
      star.click();await new Promise(r=>setTimeout(r,20));
      const report=document.createElement('pre');report.id='list-scroll-report';report.textContent=JSON.stringify({before,during,after,hit,hoverRetained,favorite:card.dataset.favorite});document.body.append(report);
    },100));</script>`;
    const source=html.replace('<link rel="stylesheet" href="/styles.css">',`<style>${css.replaceAll(':hover',':is(:hover,.test-hover)')}</style>`).replace('<script src="/app.js"></script>',setup+`<script>${app}</script>`+probe);
    const file=path.join(dir,'list.html');fs.writeFileSync(file,source);
    const run=spawnSync(chrome,['--headless','--disable-gpu','--no-sandbox',`--user-data-dir=${path.join(dir,'profile')}`,'--window-size=1280,900','--virtual-time-budget=2500','--dump-dom',pathToFileURL(file).href],{encoding:'utf8',timeout:20000,maxBuffer:12*1024*1024});
    const match=run.stdout?.match(/<pre id="list-scroll-report">([^<]+)<\/pre>/);assert.ok(match,run.stderr||'No list interaction report');const r=JSON.parse(match[1]);
    assert.ok(r.before>500);assert.ok(Math.abs(r.during-r.before)<2,JSON.stringify(r));assert.ok(Math.abs(r.after-r.before)<2,JSON.stringify(r));assert.equal(r.hit,true,JSON.stringify(r));assert.equal(r.favorite,'true');assert.equal(r.hoverRetained,true,JSON.stringify(r));
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('rain effect follows the pointer and releases its canvas when stopped', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gameshelf-rain-'));
  try {
    const rain=fs.readFileSync(path.join(root,'web/rain.js'),'utf8');
    const file=path.join(dir,'rain.html');fs.writeFileSync(file,`<div id="host" style="width:240px;height:360px"></div><script>${rain}</script><script>const host=document.getElementById('host');const effect=GameShelfRain.start(host,'storm',()=>1.1);effect.move(120,150);const canvas=host.querySelector('canvas');const before={width:canvas.width,height:canvas.height};effect.stop();const result={before,removed:!host.querySelector('canvas'),stopped:effect.stopped};const pre=document.createElement('pre');pre.id='rain-report';pre.textContent=JSON.stringify(result);document.body.append(pre);</script>`);
    const run=spawnSync(chrome,['--headless','--disable-gpu','--no-sandbox','--virtual-time-budget=500','--dump-dom',pathToFileURL(file).href],{encoding:'utf8',timeout:15000});const match=run.stdout?.match(/<pre id="rain-report">([^<]+)<\/pre>/);assert.ok(match);const r=JSON.parse(match[1]);assert.ok(r.before.width>=240&&r.before.height>=360);assert.equal(r.removed,true);assert.equal(r.stopped,true);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('viewport rain has no tiled layer and streak direction follows particle motion', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gameshelf-weather-direction-'));
  try {
    const rain=fs.readFileSync(path.join(root,'web/rain.js'),'utf8');
    const setup=`let sample=null,next=null;const ctx={scale(){},clearRect(){sample=null},beginPath(){},moveTo(x,y){if(!sample)sample={x,y}},lineTo(x,y){if(sample&&sample.tx===undefined){sample.tx=x;sample.ty=y}},stroke(){},ellipse(){},fill(){}};HTMLCanvasElement.prototype.getContext=()=>ctx;window.requestAnimationFrame=cb=>{next=cb;return 1};window.cancelAnimationFrame=()=>{};Math.random=()=>.5;`;
    const probe=`GameShelfRain.setTheme('rain',()=>1.1);const first={...sample};const canvas=document.querySelector('.gs-weather-canvas');next(performance.now()+16);const second={...sample};const width=canvas.width;GameShelfRain.setTheme('retro',()=>1.1);const removed=!document.querySelector('.gs-weather-canvas');next=null;GameShelfRain.setTheme('autumn',()=>0);const still=next===null;GameShelfRain.setTheme('classic',()=>1);const report=document.createElement('pre');report.id='weather-report';report.textContent=JSON.stringify({first,second,width,viewport:innerWidth,removed,still});document.body.append(report);`;
    const file=path.join(dir,'weather.html');fs.writeFileSync(file,`<body><script>${setup}</script><script>${rain}</script><script>${probe}</script>`);
    const run=spawnSync(chrome,['--headless','--disable-gpu','--no-sandbox','--virtual-time-budget=500','--dump-dom',pathToFileURL(file).href],{encoding:'utf8',timeout:15000});const match=run.stdout?.match(/<pre id="weather-report">([^<]+)<\/pre>/);assert.ok(match);const r=JSON.parse(match[1]);
    assert.ok(r.width>=r.viewport);assert.ok(r.first.tx>r.first.x&&r.first.ty<r.first.y,'streak should lean into the leftward fall');assert.ok(r.second.x<r.first.x&&r.second.y>r.first.y,'particles should fall left along their streaks');assert.equal(r.removed,true);assert.equal(r.still,true);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});


test('cover formats preserve artwork and frame size while empty Playlist stays compact', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gameshelf-cover-formats-'));
  try {
    const stub=`<script>fetch=async url=>({ok:true,json:async()=>url==='/api/version'?{version:'test'}:[{id:'sample',name:'Cover Format Test',hasCover:true,sizeBytes:1024,path:'/GameShelf/Test',fileCount:2}]});</script>`;
    const probe=`<script>addEventListener('load',()=>setTimeout(async()=>{try{
      const card=document.querySelector('.gs-card'),frame=card.querySelector('.gs-card-cover'),image=frame.querySelector('img');
      const result={formats:[],surfaces:[]};
      for(const [w,h]of [[600,900],[768,1024],[1024,1024],[1200,900],[1600,900]]){
        const source='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'"><rect width="100%" height="100%" fill="#3b5475"/><text x="50%" y="50%" text-anchor="middle" fill="white" font-size="60">'+w+' × '+h+'</text></svg>');
        const loaded=new Promise(resolve=>image.addEventListener('load',resolve,{once:true}));setCoverImage(image,frame,source,'Format');await loaded;
        result.formats.push({shape:frame.dataset.coverShape,fit:getComputedStyle(image).objectFit,transform:getComputedStyle(image).transform,w:frame.clientWidth,h:frame.clientHeight,backdrop:getComputedStyle(frame,'::before').display});
      }
      const before={width:image.clientWidth,height:image.clientHeight},titles=document.querySelector('#show-game-titles');titles.checked=true;titles.dispatchEvent(new Event('change'));const after={width:image.clientWidth,height:image.clientHeight};
      result.stable=before.width===after.width&&before.height===after.height;result.disabled=document.querySelector('#hover-game-titles').disabled;
      titles.checked=false;titles.dispatchEvent(new Event('change'));card.classList.add('qa-hover');result.tray=getComputedStyle(card.querySelector('.gs-card-hover-title')).transform;
      card.querySelector('.gs-card-info').click();result.details={w:document.querySelector('#game-details-dialog').clientWidth,h:document.querySelector('#game-details-dialog').clientHeight,art:document.querySelector('.gs-details-art-frame').clientWidth,fit:getComputedStyle(document.querySelector('#game-details-image')).objectFit};document.querySelector('#game-details-dialog').close();
      await new Promise(r=>setTimeout(r,200));document.querySelector('#open-cart').click();const cart=document.querySelector('#cart-dialog');result.empty={h:cart.clientHeight,w:cart.clientWidth,text:document.querySelector('#cart-empty-state').textContent,actions:getComputedStyle(document.querySelector('#cart-checkout').parentElement).display};cart.close();await new Promise(r=>setTimeout(r,200));
      document.querySelector('#build-info').click();const settings=document.querySelector('#settings-dialog');settings.dataset.settingsLevel='advanced';document.getAnimations().filter(a=>a.effect?.target===settings).forEach(a=>a.finish());await new Promise(r=>setTimeout(r,0));
      for(const theme of ['classic','light','dark','retro','neon','cartridge','cosmos','ion','rose','midnight','lattice','rain','storm','autumn']){document.documentElement.dataset.theme=theme;const select=document.querySelector('#theme-select');result.surfaces.push({theme,select:getComputedStyle(select).backgroundColor,logs:getComputedStyle(document.querySelector('#view-logs')).backgroundColor,configure:getComputedStyle(document.querySelector('#configure-logs')).backgroundColor});}
      document.documentElement.dataset.theme='retro';const select=document.querySelector('#theme-select');select.value='classic';sizeSettingsSelect(select);const context=document.createElement('canvas').getContext('2d');context.font=getComputedStyle(select).font;result.selectGap=select.clientWidth-context.measureText(select.selectedOptions[0].text).width;
      const expand=document.querySelector('#expand-list-image');expand.value='double';sizeSettingsSelect(expand);context.font=getComputedStyle(expand).font;result.expandGap=expand.clientWidth-context.measureText(expand.selectedOptions[0].text).width;
      for(const value of ['rose','autumn','retro']){select.value=value;select.dispatchEvent(new Event('change'));}result.redrawStarted=document.getAnimations().some(a=>a.id==='gs-theme-redraw');for(let step=0;step<3;step++){document.getAnimations().filter(a=>a.id==='gs-theme-redraw').forEach(a=>a.finish());await new Promise(r=>setTimeout(r,0));}result.theme={current:document.documentElement.dataset.theme,body:getComputedStyle(document.body).opacity,dialog:getComputedStyle(settings).opacity,animations:document.getAnimations().filter(a=>a.id==='gs-theme-redraw'&&a.playState!=='finished').length};
      const speed=document.querySelector('#animation-speed');speed.value=0;speed.dispatchEvent(new Event('change'));select.value='light';select.dispatchEvent(new Event('change'));result.motionOffTheme=document.documentElement.dataset.theme;
      const report=document.createElement('pre');report.id='formats-report';report.textContent=JSON.stringify(result);document.body.append(report);
    }catch(error){const report=document.createElement('pre');report.id='formats-report';report.textContent=JSON.stringify({error:error.stack});document.body.append(report);}},0));</script>`;
    const source=html.replace('<link rel="stylesheet" href="/styles.css">','<style>'+css.replaceAll(':hover',':is(:hover,.qa-hover)')+'*{transition:none!important}</style>').replace('<script src="/app.js"></script>',stub+'<script>'+app+'</script>'+probe);
    const file=path.join(dir,'formats.html');fs.writeFileSync(file,source);
    const run=spawnSync(chrome,['--headless','--disable-gpu','--no-sandbox','--disable-dev-shm-usage','--window-size=1280,900','--virtual-time-budget=3000','--dump-dom',pathToFileURL(file).href],{encoding:'utf8',timeout:15000,maxBuffer:10*1024*1024});
    assert.equal(run.status,0,run.stderr||run.error?.message);const match=run.stdout.match(/<pre id="formats-report">([^<]+)<\/pre>/);assert.ok(match,'Browser did not report formats');const r=JSON.parse(match[1]);assert.equal(r.error,undefined,r.error);
    assert.deepEqual(r.formats.map(f=>f.shape),['poster','portrait','square','landscape','wide']);for(const f of r.formats){assert.equal(f.fit,'contain');assert.equal(f.transform,'none');assert.equal(f.w,r.formats[0].w);assert.equal(f.h,r.formats[0].h);}assert.equal(r.formats[0].backdrop,'none');assert.notEqual(r.formats.at(-1).backdrop,'none');
    assert.equal(r.stable,true);assert.equal(r.disabled,true);assert.equal(r.tray,'none');assert.ok(r.details.w<=720&&r.details.h<=416&&r.details.art>=219&&r.details.art<=220,JSON.stringify(r.details));assert.equal(r.details.fit,'contain');assert.ok(r.empty.h<280&&r.empty.w<=390,JSON.stringify(r.empty));assert.match(r.empty.text,/Your Playlist is empty/);assert.equal(r.empty.actions,'none');for(const s of r.surfaces){assert.equal(s.logs,s.select,s.theme);assert.equal(s.configure,s.select,s.theme);}assert.ok(r.selectGap>=35&&r.selectGap<=45,r.selectGap);assert.ok(r.expandGap>=35&&r.expandGap<=45,r.expandGap);assert.equal(r.redrawStarted,true);assert.deepEqual(r.theme,{current:'retro',body:'1',dialog:'1',animations:0});assert.equal(r.motionOffTheme,'light');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});


test('first-time setup validates choices, browses mounted folders, and opens the library', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gameshelf-first-setup-'));
  try {
    const setup=fs.readFileSync(path.join(root,'web/setup.js'),'utf8');
    function render(required,width){
      const stub=`<script>let needsSetup=`+required+`;let configuration={rootDir:needsSetup?'':'/library',dataDir:'/data',refreshInterval:'168h'};const writes=[];fetch=async(url,options={})=>{let data;
        if(url==='/api/server-settings')data=configuration;
        else if(url==='/api/setup'&&options.method==='POST'){const value=JSON.parse(options.body);writes.push(value);if(value.rootDir==='/etc')return{ok:false,text:async()=> 'Choose a mounted library folder.'};configuration=value;needsSetup=false;data={complete:true};}
        else if(url==='/api/setup')data={required:needsSetup,mounts:['/library','/other'],port:8080,settings:configuration};
        else if(url.startsWith('/api/library-folders'))data=url.includes('path=')?{path:'/library',parent:'',folders:['/library/Collection']}:{path:'',parent:'',folders:['/library','/other']};
        else if(url==='/api/version')data={version:'test',channel:'edge'};
        else data=needsSetup?[]:[{id:'sample',name:'First Game',hasCover:false,sizeBytes:1024}];return{ok:true,json:async()=>data};};</script>`;
      const probe=`<script>addEventListener('load',()=>setTimeout(async()=>{try{const result={required:document.body.classList.contains('gs-needs-setup'),hidden:document.querySelector('#setup-page').hidden,overflow:document.documentElement.scrollWidth>innerWidth};
        if(result.required){const form=document.querySelector('#setup-form'),status=document.querySelector('#setup-status'),input=document.querySelector('#setup-roots');form.dispatchEvent(new Event('submit',{cancelable:true}));result.emptyError=status.textContent;
          input.value='/etc';form.dispatchEvent(new Event('submit',{cancelable:true}));await new Promise(r=>setTimeout(r,0));result.rejected=status.textContent;result.keptSetup=document.body.classList.contains('gs-needs-setup');
          input.value='';document.querySelector('#setup-browse').click();await new Promise(r=>setTimeout(r,0));document.querySelector('#source-browser-folders button').click();await new Promise(r=>setTimeout(r,0));document.querySelector('#source-browser-select').click();await new Promise(r=>setTimeout(r,200));result.folder=input.value;
          document.querySelector('#setup-refresh').value='0';form.dispatchEvent(new Event('submit',{cancelable:true}));await new Promise(r=>setTimeout(r,0));result.saved=writes.at(-1);result.finished=!document.body.classList.contains('gs-needs-setup')&&document.querySelector('#setup-page').hidden;result.games=document.querySelectorAll('.gs-card').length;
          document.querySelector('#build-info').click();document.querySelector('#open-server-settings').click();result.laterPath=document.querySelector('#server-root-path').value;result.laterData=document.querySelector('#server-data-path').value;
        }
        const report=document.createElement('pre');report.id='setup-report';report.textContent=JSON.stringify(result);document.body.append(report);
      }catch(error){const report=document.createElement('pre');report.id='setup-report';report.textContent=JSON.stringify({error:error.stack});document.body.append(report);}},10));</script>`;
      const source=html.replace('<link rel="stylesheet" href="/styles.css">','<style>'+css+'</style>').replace('<script src="/app.js"></script>',stub+'<script>'+app+'</script><script>'+setup+'</script>'+probe);
      const file=path.join(dir,'setup-'+required+'-'+width+'.html');fs.writeFileSync(file,source);const run=spawnSync(chrome,['--headless','--disable-gpu','--no-sandbox','--disable-dev-shm-usage','--window-size='+width+',1000','--virtual-time-budget=3000','--dump-dom',pathToFileURL(file).href],{encoding:'utf8',timeout:15000,maxBuffer:10*1024*1024});assert.equal(run.status,0,run.stderr);const match=run.stdout.match(/<pre id="setup-report">([^<]+)<\/pre>/);assert.ok(match,'Browser did not report setup');const result=JSON.parse(match[1]);assert.equal(result.error,undefined,result.error);return result;
    }
    for(const width of [1280,390]){const r=render(true,width);assert.equal(r.required,true);assert.equal(r.hidden,false);assert.equal(r.overflow,false);assert.match(r.emptyError,/at least one/);assert.match(r.rejected,/mounted library/);assert.equal(r.keptSetup,true);assert.equal(r.folder,'/library');assert.equal(r.saved.refreshInterval,'0');assert.equal(r.finished,true);assert.equal(r.games,1);assert.equal(r.laterPath,'/library');assert.equal(r.laterData,'/data');}
    const configured=render(false,1280);assert.equal(configured.required,false);assert.equal(configured.hidden,true);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
