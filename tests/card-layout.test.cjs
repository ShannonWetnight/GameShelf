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

test('download action stays inside the card body in grid and list views', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gameshelf-card-layout-'));
  try {
    const fetchStub = '<script>window.fetch = function(url) {' +
      'const data = url === "/api/version" ? {version:"v-test",channel:"stable"} :' +
      '[{id:"sample",name:"A Sample Game",sizeBytes:1024}];' +
      'return Promise.resolve({ok:true,json:function(){return Promise.resolve(data);}});' +
      '};</script>';
    const probe = '<script>window.addEventListener("load", function() {' +
      'setTimeout(function() {' +
      'const box = function(el) { const r = el.getBoundingClientRect();' +
      'return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}; };' +
      'const card = document.querySelector(".gs-card");' +
      'const body = card.querySelector(".gs-card-body");' +
      'const title = card.querySelector(".gs-card-title");' +
      'const meta = card.querySelector(".gs-card-meta");' +
      'const action = card.querySelector(".gs-icon-button");' +
      'const result = {grid:{body:box(body),title:box(title),meta:box(meta),action:box(action)},' +
      'href:action.getAttribute("href"),label:action.getAttribute("aria-label")};' +
      'document.querySelector("#view-toggle").click();' +
      'result.list = {body:box(body),title:box(title),meta:box(meta),action:box(action)};' +
      'const report = document.createElement("pre");' +
      'report.id = "card-layout-report";' +
      'report.textContent = JSON.stringify(result);' +
      'document.body.append(report);' +
      '}, 0);' +
      '});</script>';
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
    const inside = (inner, outer) => inner.left >= outer.left - 1 &&
      inner.right <= outer.right + 1 && inner.top >= outer.top - 1 &&
      inner.bottom <= outer.bottom + 1;
    assert.ok(inside(result.grid.action, result.grid.body), 'grid action escapes card body');
    assert.ok(result.grid.action.top >= result.grid.meta.bottom - 1,
      'grid action overlaps the size text');
    assert.ok(inside(result.list.action, result.list.body), 'list action escapes card body');
    assert.ok(result.list.action.left >= result.list.meta.right - 1,
      'list action overlaps the size text');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
