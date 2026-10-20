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
      '[{id:"sample",name:"A Sample Game",sizeBytes:1024,path:"/GameShelf/A Sample Game",fileCount:2,hasCover:true,addedAt:""}];' +
      'return Promise.resolve({ok:true,json:function(){return Promise.resolve(data);}});' +
      '};</script>';
    const probe = '<script>window.addEventListener("load", function() {' +
      'setTimeout(function() {' +
      'const card = document.querySelector(".gs-card");' +
      'const cover = card.querySelector(".gs-card-cover");' +
      'const actions = card.querySelector(".gs-card-actions");' +
      'const dl = card.querySelector(".gs-card-download");' +
      'const info = card.querySelector(".gs-card-info");' +
      'const inside = function(a,b) {const x=a.getBoundingClientRect(),y=b.getBoundingClientRect();' +
      'return x.left>=y.left-1&&x.right<=y.right+1&&x.top>=y.top-1&&x.bottom<=y.bottom+1;};' +
      'const result = {compact:card.getBoundingClientRect().height<500,' +
      'gridDownloadInside:inside(dl,cover),gridInfoInside:inside(info,cover),' +
      'gridActionsOpacity:getComputedStyle(actions).opacity,' +
      'href:dl.getAttribute("href"),label:dl.getAttribute("aria-label")};' +
      'document.querySelector("#view-toggle").click();' +
      'result.listDownloadVisible=getComputedStyle(dl).display!=="none";' +
      'result.listInfoVisible=getComputedStyle(info).display!=="none";' +
      'result.listDownloadInside=inside(dl,card);' +
      'result.listInfoInside=inside(info,card);' +
      'const report=document.createElement("pre");report.id="card-layout-report";' +
      'report.textContent=JSON.stringify(result);document.body.append(report);' +
      '},0);});</script>';
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
    assert.equal(result.gridActionsOpacity, '0');
    assert.equal(result.listDownloadVisible, true);
    assert.equal(result.listInfoVisible, true);
    assert.equal(result.listDownloadInside, true);
    assert.equal(result.listInfoInside, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
