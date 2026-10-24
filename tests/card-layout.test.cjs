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
const css = fs.readFileSync(path.join(root, 'web/styles.css'), 'utf8');
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
      'result.placeholderNoOverlap=missingImage.getBoundingClientRect().bottom<=placeholderTitle.getBoundingClientRect().top+1;' +
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
    assert.notEqual(result.placeholderOverlay, 'none');
    assert.notEqual(result.placeholderBackdrop, 'rgba(0, 0, 0, 0)');
    assert.equal(result.placeholderText, 'No Cover');
    assert.equal(result.placeholderNoOverlap, true);
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
    assert.equal(result.downloadSuppressed, true);
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
        const emptyUploadVisible = getComputedStyle(document.querySelector('.gs-cover-preview-upload')).opacity === '1';
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
              emptyUploadVisible,returnedToDetails,gridDuringEdit,zoomReadout,tiltReadout,
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
        document.querySelector('#game-title-input').value = 'Display Name';
        document.querySelector('#save-game-title').click();
        setTimeout(function() {
          const report = document.createElement('pre'); report.id='title-report';
          report.textContent=JSON.stringify({request:window.titleRequest,
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
    assert.deepEqual(result.request, { url: '/api/game-title/sample', body: { title: 'Display Name' } });
    assert.equal(result.cardTitle, 'Display Name');
    assert.equal(result.detailTitle, 'Display Name');
    assert.equal(result.folderPath, '/games/Folder Name');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
