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
      'const placeholder=document.querySelector("#show-placeholder-images");' +
      'placeholder.checked=true;placeholder.dispatchEvent(new Event("change"));' +
      'result.placeholderImage=getComputedStyle(missingImage).display;' +
      'result.placeholderTitle=getComputedStyle(missingTitle).display;' +
      'result.placeholderOverlay=getComputedStyle(placeholderTitle).display;' +
      'result.placeholderText=placeholderTitle.textContent;' +
      'result.placeholderNoOverlap=missingImage.getBoundingClientRect().bottom<=placeholderTitle.getBoundingClientRect().top+1;' +
      'result.placeholderFooter=getComputedStyle(missing.querySelector(".gs-card-body")).display;' +
      'result.realCoverFooter=getComputedStyle(card.querySelector(".gs-card-body")).display;' +
      'const titles=document.querySelector("#show-game-titles");' +
      'titles.checked=true;titles.dispatchEvent(new Event("change"));' +
      'result.allTitlesFooter=getComputedStyle(card.querySelector(".gs-card-body")).display;' +
      'result.missingCenteredTitle=getComputedStyle(missingTitle).display;' +
      'document.querySelector("#view-toggle").click();' +
      'result.listMissingImage=getComputedStyle(missingImage).display;' +
      'result.listMissingTitle=getComputedStyle(placeholderTitle).display;' +
      'result.listDownloadVisible=getComputedStyle(dl).display!=="none";' +
      'result.listInfoVisible=getComputedStyle(info).display!=="none";' +
      'result.listDownloadInside=inside(dl,card);' +
      'result.listInfoInside=inside(info,card);' +
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
      '},0);},0);});</script>';
    const source = html
      .replace('<link rel="stylesheet" href="/styles.css">', '<style>' + css + '</style>')
      .replace('<script src="/app.js"></script>', fetchStub + '<script>' + app + '</script>' + probe);
    const file = path.join(dir, 'card.html');
    fs.writeFileSync(file, source);
    const run = spawnSync(chrome, ['--headless', '--disable-gpu', '--no-sandbox',
      '--disable-dev-shm-usage', '--window-size=1280,800', '--virtual-time-budget=2000',
      '--dump-dom', pathToFileURL(file).href], { encoding: 'utf8', timeout: 15000 });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
    const match = run.stdout.match(/<pre id="card-layout-report">([^<]+)<\/pre>/);
    assert.ok(match, 'Chrome did not report the rendered card');
    const result = JSON.parse(match[1]);
    assert.equal(result.href, '/download/sample');
    assert.equal(result.label, 'Download A Sample Game');
    assert.equal(result.compact, true);
    assert.equal(result.gridDownloadInside, true);
    assert.equal(result.gridInfoInside, true);
    assert.equal(result.gridActionsOpacity, result.touchLayout ? '1' : '0');
    assert.equal(result.defaultFooter, 'none');
    assert.equal(result.defaultMissingImage, 'none');
    assert.notEqual(result.defaultMissingTitle, 'none');
    assert.notEqual(result.placeholderImage, 'none');
    assert.equal(result.placeholderTitle, 'none');
    assert.notEqual(result.placeholderOverlay, 'none');
    assert.equal(result.placeholderText, 'No Cover');
    assert.equal(result.placeholderNoOverlap, true);
    assert.equal(result.placeholderFooter, 'none');
    assert.equal(result.realCoverFooter, 'none');
    assert.notEqual(result.allTitlesFooter, 'none');
    assert.equal(result.missingCenteredTitle, 'none');
    assert.equal(result.listMissingImage, 'none');
    assert.equal(result.listMissingTitle, 'none');
    assert.equal(result.listDownloadVisible, true);
    assert.equal(result.listInfoVisible, true);
    assert.equal(result.listDownloadInside, true);
    assert.equal(result.listInfoInside, true);
    assert.equal(result.listActionsPointer, result.touchLayout ? 'auto' : 'none');
    assert.equal(result.listFocusedPointer, 'auto');
    assert.equal(result.downloadSuppressed, true);
    assert.equal(result.downloadPointer, result.touchLayout ? 'auto' : 'none');
    assert.equal(result.downloadRestored, true);
    assert.equal(result.suppressed, true);
    assert.equal(result.closedPointer, result.touchLayout ? 'auto' : 'none');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
