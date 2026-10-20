// Run with Node.js 18+ and Chrome: node --test tests/spotlight-layout.test.cjs
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

test('dice selection shows one centered card and reset restores the library', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gameshelf-spotlight-'));
  try {
    const fetchStub = '<script>window.fetch = function(url) {' +
      'const data = url === "/api/version" ? {version:"v-test",channel:"stable"} :' +
      '[{id:"first",name:"First Game",sizeBytes:1024},' +
      '{id:"second",name:"Second Game",sizeBytes:2048},' +
      '{id:"third",name:"Third Game",sizeBytes:4096}];' +
      'return Promise.resolve({ok:true,json:function(){return Promise.resolve(data);}});' +
      '};</script>';
    const probe = '<script>window.addEventListener("load", function() {' +
      'setTimeout(function() {' +
      'const grid = document.querySelector("#games-container");' +
      'const cards = Array.from(grid.querySelectorAll(".gs-card"));' +
      'const visible = function() { return cards.filter(function(card) {' +
      'return getComputedStyle(card).display !== "none"; }); };' +
      'document.querySelector("#random-game").click();' +
      'const preview = visible()[0];' +
      'const result = {shuffleCount:visible().length,' +
      'shuffleAnimation:getComputedStyle(preview).animationName,' +
      'diceDisabled:document.querySelector("#random-game").disabled};' +
      'setTimeout(function() {' +
      'const selected = visible()[0];' +
      'const gridBox = grid.getBoundingClientRect();' +
      'const cardBox = selected.getBoundingClientRect();' +
      'result.selectedCount = visible().length;' +
      'result.centerDifference = Math.abs((gridBox.left + gridBox.right)/2 - (cardBox.left + cardBox.right)/2);' +
      'result.animationName = getComputedStyle(selected).animationName;' +
      'result.resetVisible = getComputedStyle(document.querySelector("#spotlight-actions")).display !== "none";' +
      'document.querySelector("#show-all-games").click();' +
      'result.restoredCount = visible().length;' +
      'result.resetHidden = getComputedStyle(document.querySelector("#spotlight-actions")).display === "none";' +
      'document.querySelector("#build-info").click();' +
      'result.settingsOpen = document.querySelector("#settings-dialog").open;' +
      'const report = document.createElement("pre");' +
      'report.id = "spotlight-report";' +
      'report.textContent = JSON.stringify(result);' +
      'document.body.append(report);' +
      '}, 600);' +
      '}, 0);' +
      '});</script>';
    const source = html
      .replace('<link rel="stylesheet" href="/styles.css">', '<style>' + css + '</style>')
      .replace('<script src="/app.js"></script>', fetchStub + '<script>' + app + '</script>' + probe);
    const file = path.join(dir, 'spotlight.html');
    fs.writeFileSync(file, source);
    const run = spawnSync(chrome, ['--headless', '--disable-gpu', '--no-sandbox',
      '--disable-dev-shm-usage', '--window-size=1280,800', '--virtual-time-budget=2000',
      '--dump-dom', pathToFileURL(file).href], { encoding: 'utf8', timeout: 15000 });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
    const match = run.stdout.match(/<pre id="spotlight-report">([^<]+)<\/pre>/);
    assert.ok(match, 'Chrome did not report the spotlight layout');
    const result = JSON.parse(match[1]);
    assert.equal(result.shuffleCount, 1);
    assert.match(result.shuffleAnimation, /^gs-card-shuffle/);
    assert.equal(result.diceDisabled, true);
    assert.equal(result.selectedCount, 1);
    assert.ok(result.centerDifference <= 1, 'selected card is not centered');
    assert.equal(result.animationName, 'gs-spotlight-bounce');
    assert.equal(result.resetVisible, true);
    assert.equal(result.restoredCount, 3);
    assert.equal(result.resetHidden, true);
    assert.equal(result.settingsOpen, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
