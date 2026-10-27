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
const css = fs.readFileSync(path.join(root, 'web/styles.css'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'web/themes.css'), 'utf8') + '\n:root{--ui-scale:1!important;}';
const app = "localStorage.setItem('gameshelf:ui-scale','1');\n" + fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');
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
          document.querySelector('#cover-rotate-left').click();document.querySelector('#cover-mirror').click();
          const tilt = document.querySelector('#cover-tilt');
          tilt.value = '8'; tilt.dispatchEvent(new Event('input'));
          const zoom = document.querySelector('#cover-zoom');
          zoom.value = '1.25'; zoom.dispatchEvent(new Event('input'));
          const gridDuringEdit = document.querySelector('#cover-preview').classList.contains('is-adjusting');
          const zoomReadout = document.querySelector('#cover-zoom').dataset.tooltip;
          const tiltReadout = document.querySelector('#cover-tilt').dataset.tooltip;
          document.querySelector('#cover-editor-reset').click();
          const resetZoom = document.querySelector('#cover-zoom').dataset.tooltip;
          const resetTilt = document.querySelector('#cover-tilt').dataset.tooltip;
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
    assert.equal(result.zoomReadout, 'Zoom: 125%');
    assert.equal(result.tiltReadout, 'Tilt: 8°');
    assert.equal(result.resetZoom, 'Zoom: 100%');
    assert.equal(result.resetTilt, 'Tilt: 0°');
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
      document.documentElement.dataset.theme='retro';const select=document.querySelector('#theme-select');select.value='classic';sizeSettingsSelect(select);const context=document.createElement('canvas').getContext('2d');context.font=getComputedStyle(select).font;result.selectGap=select.clientWidth-context.measureText(select.selectedOptions[0].text).width;result.themeWidths=[];for(const value of ['classic','retro','storm','neon']){select.value=value;sizeSettingsSelect(select);result.themeWidths.push(select.clientWidth);}
      const expand=document.querySelector('#expand-list-image');expand.value='double';sizeSettingsSelect(expand);context.font=getComputedStyle(expand).font;result.expandGap=expand.clientWidth-context.measureText(expand.selectedOptions[0].text).width;
      for(const value of ['rose','autumn','retro']){select.value=value;select.dispatchEvent(new Event('change'));}result.redrawStarted=document.getAnimations().some(a=>a.id==='gs-theme-redraw');for(let step=0;step<3;step++){document.getAnimations().filter(a=>a.id==='gs-theme-redraw').forEach(a=>a.finish());await new Promise(r=>setTimeout(r,0));}result.theme={current:document.documentElement.dataset.theme,body:getComputedStyle(document.body).opacity,dialog:getComputedStyle(settings).opacity,animations:document.getAnimations().filter(a=>a.id==='gs-theme-redraw'&&a.playState!=='finished').length};
      const speed=document.querySelector('#animation-speed');speed.value=0;speed.dispatchEvent(new Event('change'));select.value='light';select.dispatchEvent(new Event('change'));result.motionOffTheme=document.documentElement.dataset.theme;
      const report=document.createElement('pre');report.id='formats-report';report.textContent=JSON.stringify(result);document.body.append(report);
    }catch(error){const report=document.createElement('pre');report.id='formats-report';report.textContent=JSON.stringify({error:error.stack});document.body.append(report);}},0));</script>`;
    const source=html.replace('<link rel="stylesheet" href="/styles.css">','<style>'+css.replaceAll(':hover',':is(:hover,.qa-hover)')+'*{transition:none!important}</style>').replace('<script src="/app.js"></script>',stub+'<script>'+app+'</script>'+probe);
    const file=path.join(dir,'formats.html');fs.writeFileSync(file,source);
    const run=spawnSync(chrome,['--headless','--disable-gpu','--no-sandbox','--disable-dev-shm-usage','--window-size=1280,900','--virtual-time-budget=3000','--dump-dom',pathToFileURL(file).href],{encoding:'utf8',timeout:15000,maxBuffer:10*1024*1024});
    assert.equal(run.status,0,run.stderr||run.error?.message);const match=run.stdout.match(/<pre id="formats-report">([^<]+)<\/pre>/);assert.ok(match,'Browser did not report formats');const r=JSON.parse(match[1]);assert.equal(r.error,undefined,r.error);
    assert.deepEqual(r.formats.map(f=>f.shape),['poster','portrait','square','landscape','wide']);for(const f of r.formats){assert.equal(f.fit,'contain');assert.equal(f.transform,'none');assert.equal(f.w,r.formats[0].w);assert.equal(f.h,r.formats[0].h);}assert.notEqual(r.formats[0].backdrop,'none');assert.notEqual(r.formats.at(-1).backdrop,'none');
    assert.equal(r.stable,true);assert.equal(r.disabled,true);assert.equal(r.tray,'none');assert.ok(r.details.w<=720&&r.details.h<=416&&r.details.art>=219&&r.details.art<=220,JSON.stringify(r.details));assert.equal(r.details.fit,'contain');assert.ok(r.empty.h<280&&r.empty.w<=390,JSON.stringify(r.empty));assert.match(r.empty.text,/Your Playlist is empty/);assert.equal(r.empty.actions,'none');for(const s of r.surfaces){assert.equal(s.logs,s.select,s.theme);assert.equal(s.configure,s.select,s.theme);}assert.ok(r.selectGap>=35&&r.selectGap<=70,r.selectGap);assert.deepEqual(r.themeWidths,[188,188,188,188]);assert.ok(r.expandGap>=35&&r.expandGap<=45,r.expandGap);assert.equal(r.redrawStarted,true);assert.deepEqual(r.theme,{current:'retro',body:'1',dialog:'1',animations:0});assert.equal(r.motionOffTheme,'light');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});


function sourceUIProbe(probe, {required=true,width=1280,delaySetup=false}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gameshelf-source-ui-'));
  try {
    const setup=fs.readFileSync(path.join(root,'web/setup.js'),'utf8'),tour=fs.readFileSync(path.join(root,'web/tour.js'),'utf8');
    const stub=`<script>localStorage.clear();localStorage.setItem('gameshelf:animation-speed','0');let needsSetup=${required};let configuration={rootDir:needsSetup?'':'/library',dataDir:'/data',refreshInterval:'168h',sources:[]};const requests=[],writes=[];let networkTests=0;window.deferNetwork=false;
      const publicSettings=value=>({...value,sources:(value.sources||[]).map(source=>{const copy={...source,hasPassword:!!(source.password||source.hasPassword)};delete copy.password;delete copy.passwordCipher;return copy;})});
      const response=(data,status=200)=>({ok:status===200,json:async()=>data,text:async()=>typeof data==='string'?data:JSON.stringify(data)});
      const setupResponse=()=>response({required:needsSetup,mounts:['/library','/other'],port:8080,settings:configuration});
      fetch=async(url,options={})=>{requests.push({url,method:options.method||'GET',headers:options.headers});
        if(url==='/api/setup'&&!options.method){if(${delaySetup})return new Promise(resolve=>window.releaseSetup=()=>resolve(setupResponse()));return setupResponse();}
        if(url==='/api/setup?skip=1'){configuration={...configuration,setupCompleted:true};needsSetup=false;return response({complete:true,settings:configuration});}if(url==='/api/setup'&&options.method==='POST'){const value=JSON.parse(options.body);writes.push(value);if(value.rootDir==='/etc')return response('Choose a mounted library folder.',400);configuration=publicSettings(value);needsSetup=false;return response({complete:true,settings:configuration});}
        if(url==='/api/server-settings'&&options.method==='PUT'){const value=JSON.parse(options.body);writes.push(value);configuration=publicSettings(value);return response({restartRequired:false,settings:configuration});}
        if(url==='/api/server-settings')return response(configuration);
        if(url.startsWith('/api/cover-fit/'))return response({coverStretch:JSON.parse(options.body).stretch});if(url==='/api/network-test'){const value=JSON.parse(options.body);networkTests++;const answer=()=>{if(value.url.includes('/bad'))return response('Sign-in failed. Check your password.',400);if(value.protocol==='sftp'&&!value.hostKey)return response({requiresTrust:true,hostKey:'ssh-ed25519 Zml4dHVyZS1rZXk=',fingerprint:'SHA256:fixture-fingerprint'});const source=publicSettings({sources:[{...value,id:value.id||'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',name:value.name||'NAS Games'}]}).sources[0];return response({connected:true,folders:3,source});};if(window.deferNetwork)return new Promise(resolve=>window.releaseNetwork=()=>resolve(answer()));return answer();}
        if(url.startsWith('/api/library-folders')){const path=new URL(url,'http://test').searchParams.get('path')||'';if(path==='/etc')return response('Choose a mounted library folder.',400);return response({path,parent:path==='/library/Collection'?'/library':'',folders:path?path==='/library'?['/library/Collection']:[]:['/library','/other']});}
        if(url==='/api/source-status')return response({busy:false,message:'',sources:configuration.sources.map(source=>({id:source.id,state:'ready',name:source.name}))});
        if(url==='/api/version')return response({version:'test',channel:'edge'});
        return response(needsSetup?[]:[{id:'sample',name:'First Game',hasCover:false,sizeBytes:1024,path:'/library/First Game'}]);};</script>`;
    const runProbe=`<script>addEventListener('load',()=>setTimeout(async()=>{try{const pause=(ms=35)=>new Promise(resolve=>setTimeout(resolve,ms));const result={};${probe};const output=document.createElement('pre');output.id='source-ui-report';output.textContent=JSON.stringify(result);document.body.append(output);}catch(error){const output=document.createElement('pre');output.id='source-ui-report';output.textContent=JSON.stringify({error:error.stack});document.body.append(output);}},10));</script>`;
    const source=html.replace('<link rel="stylesheet" href="/styles.css">','<style>'+css+'</style>').replace('<script src="/app.js"></script>',stub+'<script>'+app+'</script><script>'+setup+'</script><script>'+tour+'</script>'+runProbe);
    const file=path.join(dir,'source-ui.html');fs.writeFileSync(file,source);
    const run=spawnSync(chrome,['--headless','--disable-gpu','--no-sandbox','--disable-dev-shm-usage','--window-size='+width+',1000','--virtual-time-budget=4000','--dump-dom',pathToFileURL(file).href],{encoding:'utf8',timeout:15000,maxBuffer:12*1024*1024});
    assert.equal(run.status,0,run.stderr);const match=run.stdout.match(/<pre id="source-ui-report">([^<]+)<\/pre>/);assert.ok(match,'Browser did not report source UI');const result=JSON.parse(match[1]);assert.equal(result.error,undefined,result.error);return result;
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}

test('boot gate hides the library until setup eligibility is known',()=>{
  for(const required of [true,false]){const r=sourceUIProbe(`result.before={header:getComputedStyle(document.querySelector('.gs-header')).visibility,boot:document.body.classList.contains('gs-booting'),games:requests.filter(r=>r.url.startsWith('/api/games')).length};releaseSetup();await pause();result.after={boot:document.body.classList.contains('gs-booting'),setup:!document.querySelector('#setup-page').hidden,needs:document.body.classList.contains('gs-needs-setup'),games:requests.filter(r=>r.url.startsWith('/api/games')).length};`,{required,delaySetup:true});assert.deepEqual(r.before,{header:'hidden',boot:true,games:0});assert.equal(r.after.boot,false);assert.equal(r.after.setup,required);assert.equal(r.after.needs,required);assert.equal(r.after.games,required?0:1);}
});

test('compact setup supports network-only libraries, saved credentials and later folder additions',()=>{
  for(const width of [1280,390]){
    const r=sourceUIProbe(`
      const form=document.querySelector('#setup-form');form.dispatchEvent(new Event('submit',{cancelable:true}));result.emptyError=document.querySelector('#setup-next').dataset.tooltip;
      document.querySelector('#setup-add-network').click();document.querySelector('#network-url').value='smb://nas/games';document.querySelector('#network-username').value='reader';document.querySelector('#network-password').value='temporary-secret';document.querySelector('#network-test').click();await pause();result.tested=!document.querySelector('#network-use').disabled;document.querySelector('#network-use').click();await pause();result.cards=document.querySelectorAll('#setup-source-list .gs-source-card').length;result.passwordCleared=document.querySelector('#network-password').value==='';
      result.overflow=document.documentElement.scrollWidth>innerWidth;document.querySelector('#setup-next').click();result.finishVisible=!document.querySelector('#setup-finish-panel').hidden;document.querySelector('#setup-tour').checked=false;document.querySelector('#setup-refresh-preset').value='0';document.querySelector('#setup-refresh-preset').dispatchEvent(new Event('change'));form.dispatchEvent(new Event('submit',{cancelable:true}));await pause();
      result.saved=writes[0];result.finished=document.querySelector('#setup-page').hidden&&!document.body.classList.contains('gs-needs-setup');result.games=document.querySelectorAll('.gs-card').length;result.passwordReturned=!!serverSettings.sources[0].password;result.passwordStored=JSON.stringify(localStorage).includes('temporary-secret');
      document.querySelector('#build-info').click();document.querySelector('#settings-advanced').click();document.querySelector('#open-server-settings').click();result.laterCards=document.querySelectorAll('#server-source-list .gs-source-card').length;document.querySelector('#server-source-list .gs-source-icon').click();result.passwordBlank=document.querySelector('#network-password').value==='';result.placeholder=document.querySelector('#network-password').placeholder;document.querySelector('#network-editor-cancel').click();await pause();
      document.querySelector('#server-add-folder').click();document.querySelector('#source-folder-browse').click();await pause();document.querySelector('#source-browser-folders button').click();await pause();document.querySelector('#source-browser-select').click();await pause();document.querySelector('#source-folder-use').click();await pause();result.twoSources=document.querySelectorAll('#server-source-list .gs-source-card').length;
      result.saveSize=[document.querySelector('#server-settings-save').offsetWidth,document.querySelector('#server-settings-save').offsetHeight];document.querySelector('#server-settings-save').click();await pause();result.final=writes.at(-1);
    `,{width});
    assert.match(r.emptyError,/at least one/);assert.equal(r.tested,true);assert.equal(r.cards,1);assert.equal(r.passwordCleared,true);assert.equal(r.overflow,false);assert.equal(r.finishVisible,true);assert.equal(r.saved.rootDir,'');assert.equal(r.saved.sources[0].url,'smb://nas/games');assert.equal(r.saved.sources[0].password,'temporary-secret');assert.equal(r.saved.refreshInterval,'0');assert.equal(r.finished,true);assert.equal(r.games,1);assert.equal(r.passwordReturned,false);assert.equal(r.passwordStored,false);assert.equal(r.laterCards,1);assert.equal(r.passwordBlank,true);assert.match(r.placeholder,/•{8}/);assert.equal(r.twoSources,2);assert.equal(r.final.rootDir,'/library');assert.equal(r.final.sources[0].hasPassword,true);assert.equal(!!r.final.sources[0].password,false);assert.deepEqual(r.saveSize,[38,38]);
  }
});

test('network editor handles failed sign-in, SFTP trust, and cancelled tests without reopening',()=>{
  const r=sourceUIProbe(`
    document.querySelector('#setup-add-network').click();document.querySelector('#network-url').value='smb://nas/bad';document.querySelector('#network-test').click();await pause();result.signinError=document.querySelector('#notification-text').textContent;result.disabled=document.querySelector('#network-use').disabled;
    document.querySelector('#network-protocol').value='sftp';document.querySelector('#network-protocol').dispatchEvent(new Event('change'));document.querySelector('#network-url').value='sftp://nas/games';document.querySelector('#network-test').click();await pause();result.trustOpen=document.querySelector('#network-trust-dialog').open;result.fingerprint=document.querySelector('#network-fingerprint').textContent;document.querySelector('#network-trust-confirm').click();await pause();result.trusted=!document.querySelector('#network-use').disabled;result.last=document.querySelector('#notification-text').textContent;result.testCount=requests.filter(x=>x.url==='/api/network-test').length;document.querySelector('#network-editor-cancel').click();await pause();
    document.querySelector('#setup-add-network').click();window.deferNetwork=true;document.querySelector('#network-url').value='sftp://nas/games';document.querySelector('#network-protocol').value='sftp';document.querySelector('#network-test').click();await pause();document.querySelector('#network-editor-cancel').click();await pause();releaseNetwork();await pause();result.closed=!document.querySelector('#network-editor-dialog').open&&!document.querySelector('#network-trust-dialog').open;result.noneAdded=document.querySelectorAll('#setup-source-list .gs-source-card').length===0;
  `);assert.match(r.signinError,/Sign-in failed/);assert.equal(r.disabled,true);assert.equal(r.trustOpen,true);assert.match(r.fingerprint,/SHA256/);assert.equal(r.trusted,true,JSON.stringify(r));assert.equal(r.closed,true,JSON.stringify(r));assert.equal(r.noneAdded,true,JSON.stringify(r));
});

test('quick tour stays inside the viewport, is skippable, and replays without changing library state',()=>{
  for(const width of [1280,390]){const r=sourceUIProbe(`
    const before={sort:currentSort,view:currentView};window.GameShelfTour.offer();result.offered=document.querySelector('#tour-intro-dialog').open;document.querySelector('#tour-intro-start').click();await pause();result.positions=[];result.titles=[];
    for(let n=0;n<10&&document.querySelector('#tour-dialog').open;n++){const box=document.querySelector('#tour-tooltip').getBoundingClientRect();result.positions.push(box.left>=0&&box.right<=innerWidth&&box.top>=0&&box.bottom<=innerHeight);result.titles.push(document.querySelector('#tour-title').textContent);document.querySelector('#tour-next').click();await pause();}
    result.closed=!document.querySelector('#tour-dialog').open;result.clean=document.querySelectorAll('.gs-tour-show-actions').length===0;result.unchanged=JSON.stringify(before)===JSON.stringify({sort:currentSort,view:currentView});document.querySelector('#build-info').click();document.querySelector('#show-tour').click();await pause();result.replayed=document.querySelector('#tour-dialog').open;document.querySelector('#tour-close').click();await pause();result.cancelAsked=document.querySelector('#tour-cancel-dialog').open;result.keptOpen=document.querySelector('#tour-dialog').open;document.querySelector('#tour-cancel-keep').click();await pause();result.kept=document.querySelector('#tour-dialog').open&&!document.querySelector('#tour-cancel-dialog').open;document.querySelector('#tour-close').click();document.querySelector('#tour-cancel-confirm').click();await pause();result.skipped=!document.querySelector('#tour-dialog').open;
  `,{required:false,width});assert.equal(r.offered,true);assert.ok(r.positions.every(Boolean),JSON.stringify(r));assert.ok(r.titles.includes('Build a Playlist'));assert.ok(r.titles.includes('Everything within reach'));assert.equal(r.closed,true);assert.equal(r.clean,true);assert.equal(r.unchanged,true);assert.equal(r.replayed,true);assert.equal(r.cancelAsked,true);assert.equal(r.keptOpen,true);assert.equal(r.kept,true);assert.equal(r.skipped,true);assert.deepEqual(r.titles.slice(0,2),['Everything within reach','Always a way home']);}
});

test('setup controls, edited locations and removal keep the same layout and require deliberate actions',()=>{
  const r=sourceUIProbe(`
    const $=id=>document.getElementById(id);result.header={home:$('gs-home-trigger').disabled,refresh:$('gs-refresh-trigger').disabled,logo:document.querySelector('.gs-brand').getBoundingClientRect().left,cog:getComputedStyle($('build-info')).display};result.continue={text:$('setup-next').textContent.trim(),width:$('setup-next').offsetWidth,height:$('setup-next').offsetHeight,icons:$('setup-next').querySelectorAll('svg').length};
    $('setup-add-network').click();$('network-url').value='smb://nas/games';$('network-url').dispatchEvent(new Event('input'));$('network-username').value='reader';$('network-password').value='temporary-secret';$('network-use').click();await pause();result.added=$('setup-source-list').children.length;result.tested=networkTests;const card=$('setup-source-list').firstElementChild;result.aligned=Math.abs(card.getBoundingClientRect().right-$('setup-add-network').getBoundingClientRect().right)<2;
    card.querySelector('.gs-source-icon').click();$('network-url').value='smb://nas/newgames';$('network-url').dispatchEvent(new Event('input'));result.canSave=!$('network-use').disabled;result.saveSize=[$('network-use').offsetWidth,$('network-use').offsetHeight];$('network-use').click();await pause();result.edited=$('setup-source-list').textContent.includes('newgames');result.passwordRetained=!$('network-editor-dialog').open;result.retested=networkTests;
    document.querySelector('#setup-source-list .gs-source-remove').click();result.asked=$('source-remove-dialog').open&&$('setup-source-list').children.length===1;$('source-remove-cancel').click();await pause();result.cancelled=$('setup-source-list').children.length===1;document.querySelector('#setup-source-list .gs-source-remove').click();$('source-remove-confirm').click();await pause();result.removed=$('setup-source-list').children.length===0;
    $('setup-add-folder').click();result.browseGap=$('source-folder-browse').getBoundingClientRect().top-$('source-folder-path').getBoundingClientRect().bottom;result.browse=$('source-folder-browse').textContent.trim();result.select=$('source-folder-use').textContent.trim();result.importVisible=!$('setup-import').hidden;
  `);
  assert.equal(r.header.home,true);assert.equal(r.header.refresh,true);assert.ok(r.header.logo<50,JSON.stringify(r.header));assert.notEqual(r.header.cog,'none');assert.deepEqual(r.continue,{text:'Continue',width:112,height:40,icons:0});assert.equal(r.added,1);assert.equal(r.tested,1);assert.equal(r.aligned,true);assert.equal(r.canSave,true);assert.deepEqual(r.saveSize,[38,38]);assert.equal(r.edited,true);assert.equal(r.passwordRetained,true);assert.equal(r.retested,2);assert.equal(r.asked,true);assert.equal(r.cancelled,true);assert.equal(r.removed,true);assert.ok(r.browseGap>=12,r.browseGap);assert.equal(r.browse,'Browse');assert.equal(r.select,'Select');assert.equal(r.importVisible,true);
});

test('setup can import a backup or defer and configure sources later',()=>{
  const r=sourceUIProbe(`
    const $=id=>document.getElementById(id);$('setup-import').click();result.import={open:$('restore-dialog').open,text:$('restore-intro').textContent,title:$('restore-title').textContent};$('restore-cancel').click();await pause();$('build-info').click();result.options=$('setup-options-dialog').open;$('setup-defer').click();await pause();result.deferred={setup:$('setup-page').hidden,header:!$('gs-home-trigger').disabled,saved:configuration.setupCompleted,skip:requests.some(r=>r.url==='/api/setup?skip=1'),settings:!$('setup-options-dialog').open};$('build-info').click();$('settings-advanced').click();$('open-server-settings').click();result.sources=$('server-settings-dialog').open;
  `);assert.equal(r.import.open,true);assert.match(r.import.title,/Import/);assert.match(r.import.text,/bypass|skip|setup/i);assert.match(r.import.text,/password/i);assert.equal(r.options,true);assert.deepEqual(r.deferred,{setup:true,header:true,saved:true,skip:true,settings:true});assert.equal(r.sources,true);
});

test('tour spotlight leads its description and outside clicks or Escape ask before ending',()=>{
  const r=sourceUIProbe(`
    const $=id=>document.getElementById(id);animationSpeed=1.1;disableEffects=false;window.GameShelfTour.start();result.initial={hidden:getComputedStyle($('tour-tooltip')).visibility,spotlight:$('tour-spotlight').offsetWidth>0};await pause(320);result.shown=getComputedStyle($('tour-tooltip')).visibility;result.disclaimer=!$('tour-readonly-info').hidden;$('tour-readonly-info').dispatchEvent(new Event('mouseenter'));result.readonly=!$('tour-readonly-note').hidden&&$('tour-readonly-note').textContent.includes('read-only');$('tour-dialog').dispatchEvent(new PointerEvent('pointerdown',{button:0,clientX:0,clientY:0}));$('tour-dialog').dispatchEvent(new PointerEvent('pointerup',{clientX:0,clientY:0}));$('tour-dialog').dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:0,clientY:0}));result.outsideAsked=$('tour-cancel-dialog').open;$('tour-cancel-keep').click();await pause(220);$('tour-dialog').dispatchEvent(new Event('cancel',{cancelable:true}));result.escapeAsked=$('tour-cancel-dialog').open;result.tourOpen=$('tour-dialog').open;$('tour-cancel-confirm').click();await pause(220);result.ended=!$('tour-dialog').open;
  `,{required:false});assert.deepEqual(r.initial,{hidden:'hidden',spotlight:true});assert.equal(r.shown,'visible');assert.equal(r.disclaimer,true);assert.equal(r.readonly,true);assert.equal(r.outsideAsked,true);assert.equal(r.escapeAsked,true);assert.equal(r.tourOpen,true);assert.equal(r.ended,true);
});


test('dialogs require a complete outside click and retain a drag that starts inside',()=>{
 const r=sourceUIProbe(`
   const $=id=>document.getElementById(id);$('build-info').click();const dialog=$('settings-dialog');const rect=dialog.getBoundingClientRect();
   dialog.dispatchEvent(new PointerEvent('pointerdown',{button:0,clientX:rect.left+40,clientY:rect.top+40}));dialog.dispatchEvent(new PointerEvent('pointerup',{clientX:0,clientY:0}));dialog.dispatchEvent(new MouseEvent('click',{clientX:0,clientY:0}));result.retained=dialog.open;
   dialog.dispatchEvent(new PointerEvent('pointerdown',{button:0,clientX:0,clientY:0}));dialog.dispatchEvent(new PointerEvent('pointerup',{clientX:0,clientY:0}));dialog.dispatchEvent(new MouseEvent('click',{clientX:0,clientY:0}));await pause();result.closed=!dialog.open;
 `,{required:false});assert.equal(r.retained,true);assert.equal(r.closed,true);
});

test('stretch overrides and blurred gap filling agree in grid, details, list and shuffle',()=>{
 const r=sourceUIProbe(`
   const $=id=>document.getElementById(id),game=gamesCache[0],card=cardMap.get(game.id),frame=card.querySelector('.gs-card-cover');game.hasCover=true;card.classList.remove('gs-no-cover');
   const source='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="1000"><rect width="100%" height="100%" fill="#31496b"/></svg>');
   const image=frame.querySelector('img');await new Promise(resolve=>{image.addEventListener('load',resolve,{once:true});setCoverImage(image,frame,source,game.name);});result.gap={shape:frame.dataset.coverShape,backdrop:getComputedStyle(frame,'::before').display};
   $('build-info').click();$('settings-advanced').click();const stretch=$('stretch-covers');stretch.checked=true;stretch.dispatchEvent(new Event('change'));result.global=getComputedStyle(image).objectFit;result.backup=capturePreferences()['stretch-covers'];$('settings-close').click();await pause();
   card.querySelector('.gs-card-info').click();result.details=getComputedStyle($('game-details-image')).objectFit;result.action=$('game-cover-stretch').title;$('game-cover-stretch').click();await pause();result.override=game.coverStretch;result.grid=getComputedStyle(image).objectFit;result.detailsOverride=getComputedStyle($('game-details-image')).objectFit;result.reversedAction=$('game-cover-stretch').title;$('game-details-close').click();await pause();$('view-toggle').click();result.list=getComputedStyle(card.querySelector('.gs-list-image')).objectFit;
   const second={...game,id:'second',coverStretch:true};gamesCache.push(second);const another=createGameCard(second);cardMap.set(second.id,another);$('games-container').appendChild(another);another.querySelector('.gs-cover-image').src=source;animationSpeed=1.1;disableEffects=false;suggestRandomGame();await pause(60);result.shuffle=[...document.querySelectorAll('.gs-shuffle-face')].map(face=>({expected:face.dataset.coverFit==='stretch'?'fill':'contain',actual:getComputedStyle(face.querySelector('img')).objectFit}));
 `,{required:false});assert.equal(r.gap.shape,'poster');assert.equal(r.gap.backdrop,'block');assert.equal(r.global,'fill');assert.equal(r.backup,'true');assert.equal(r.details,'fill');assert.match(r.action,/Disable/);assert.equal(r.override,false);assert.equal(r.grid,'contain');assert.equal(r.detailsOverride,'contain');assert.match(r.reversedAction,/Enable/);assert.equal(r.list,'contain');assert.equal(r.shuffle.length,3);for(const face of r.shuffle)assert.equal(face.actual,face.expected);
});

test('selectors retain size, Randomize stays stable for a visit, and setup resume is restricted',()=>{
 const r=sourceUIProbe(`
   const $=id=>document.getElementById(id);$('build-info').click();$('settings-advanced').click();const select=$('expand-list-image');result.widths=[];for(const value of ['single','double','disabled']){select.value=value;select.dispatchEvent(new Event('change'));result.widths.push(select.offsetWidth);}result.heights=[$('theme-select').offsetHeight,select.offsetHeight,$('view-logs').offsetHeight];
   const theme=$('theme-select');theme.value='random';theme.dispatchEvent(new Event('change'));const first=document.documentElement.dataset.theme;theme.dispatchEvent(new Event('change'));result.random={first,second:document.documentElement.dataset.theme,saved:localStorage.getItem('gameshelf:theme')};
   configuration.setupStatus='skipped';await loadServerSettings();result.skipped=!$('resume-setup-option').hidden;configuration.setupStatus='complete';await loadServerSettings();result.completed=$('resume-setup-option').hidden;result.legacyMessage=!!$('library-backup-status');
 `,{required:false});assert.equal(new Set(r.widths).size,1);assert.equal(new Set(r.heights).size,1,JSON.stringify(r.heights));assert.notEqual(r.random.first,'random');assert.equal(r.random.first,r.random.second);assert.equal(r.random.saved,'random');assert.equal(r.skipped,true);assert.equal(r.completed,true);assert.equal(r.legacyMessage,false);
});

test('connection tests keep readable busy text, green success feedback, and no stale state when reopened',()=>{
 const r=sourceUIProbe(`
   const $=id=>document.getElementById(id);$('setup-add-network').click();$('network-url').value='smb://nas/games';$('network-url').dispatchEvent(new Event('input'));window.deferNetwork=true;const button=$('network-test'),dialog=$('network-editor-dialog');const height=dialog.offsetHeight;button.click();result.busy={disabled:button.disabled,state:button.getAttribute('aria-busy'),text:button.textContent.trim()};releaseNetwork();await pause();result.ready={message:$('notification-text').textContent,feedback:button.classList.contains('is-saved'),height:dialog.offsetHeight,previous:height};$('network-editor-cancel').click();await pause();$('setup-add-network').click();result.clean=!button.classList.contains('is-saved')&&!button.hasAttribute('aria-busy');
 `);assert.deepEqual(r.busy,{disabled:true,state:'true',text:'Test Connection'});assert.match(r.ready.message,/Connected/);assert.equal(r.ready.feedback,true);assert.equal(r.ready.height,r.ready.previous);assert.equal(r.clean,true);
});
