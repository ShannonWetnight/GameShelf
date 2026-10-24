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
const css = fs.readFileSync(path.join(root, 'web/styles.css'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'web/themes.css'), 'utf8');
const app = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');
const chrome = process.env.CHROME_BIN || (process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'google-chrome');

test('dice selection shows one centered card and reset restores the library', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gameshelf-spotlight-'));
  try {
    const fetchStub = '<script>window.fetch = function(url) {' +
      'const data = url === "/api/version" ? {version:"v-test",channel:"stable"} :' +
      '[{id:"first",name:"First Game",sizeBytes:2048},' +
      '{id:"second",name:"Second Game",sizeBytes:4096},' +
      '{id:"third",name:"Third Game",sizeBytes:1024}];' +
      'return Promise.resolve({ok:true,json:function(){return Promise.resolve(data);}});' +
      '};</script>';
    const probe = '<script>window.addEventListener("load", function() {' +
      'setTimeout(function() {' +
      'const grid = document.querySelector("#games-container");' +
      'const cards = Array.from(grid.querySelectorAll(".gs-card"));' +
      'const visible = function() { return cards.filter(function(card) {' +
      'return getComputedStyle(card).display !== "none"; }); };' +
      'const sortButton = document.querySelector("#sort-button");' +
      'const sortMenu = document.querySelector("#sort-menu");' +
      'sortButton.click();' +
      'const sortOpen = getComputedStyle(sortMenu).display !== "none";' +
      'sortMenu.querySelector("[data-sort=za]").click();' +
      'const names = function() { return Array.from(grid.querySelectorAll(".gs-card")).map(function(card) {' +
      'return card.querySelector("h3").textContent; }); };' +
      'const sortedNames = names();' +
      'sortButton.click(); sortMenu.querySelector("[data-sort=size-desc]").click();' +
      'const sizeDescNames = names();' +
      'sortButton.click(); sortMenu.querySelector("[data-sort=size-asc]").click();' +
      'const sizeAscNames = names();' +
      'sortButton.click(); sortMenu.querySelector("[data-sort=az]").click();' +
      'const alphaNames = names();' +
      'const viewButton = document.querySelector("#view-toggle");' +
      'viewButton.click();' +
      'const listView = grid.classList.contains("list-view");' +
      'viewButton.click();' +
      'const gear = document.querySelector("#build-info");' +
      'const svg = gear.querySelector("svg");' +
      'const iconBox = svg.querySelector("path").getBBox();' +
      'const svgRect = svg.getBoundingClientRect();' +
      'const buttonRect = gear.getBoundingClientRect();' +
      'const iconCenterX = svgRect.left + (iconBox.x + iconBox.width / 2 - svg.viewBox.baseVal.x) * svgRect.width / svg.viewBox.baseVal.width;' +
      'const iconCenterY = svgRect.top + (iconBox.y + iconBox.height / 2 - svg.viewBox.baseVal.y) * svgRect.height / svg.viewBox.baseVal.height;' +
      'const gearCenterDifference = Math.max(Math.abs(iconCenterX - (buttonRect.left + buttonRect.right) / 2),' +
      'Math.abs(iconCenterY - (buttonRect.top + buttonRect.bottom) / 2));' +
      'document.querySelector("#random-game").click();' +
      'const preview = visible()[0];' +
      'const result = {sortOpen:sortOpen,sortedNames:sortedNames,sizeDescNames:sizeDescNames,' +
      'sizeAscNames:sizeAscNames,alphaNames:alphaNames,listView:listView,' +
      'gearCenterDifference:gearCenterDifference,shuffleCount:visible().length,' +
      'shuffleAnimation:getComputedStyle(grid.querySelector(".gs-shuffle-face")).animationName,' +
      'normalDiceDuration:getComputedStyle(document.querySelector("#random-game svg")).animationDuration,' +
      'normalShuffleDuration:getComputedStyle(grid.querySelector(".gs-shuffle-face")).animationDuration,' +
      'diceDisabled:document.querySelector("#random-game").disabled,' +
      'returnHiddenDuringShuffle:getComputedStyle(document.querySelector("#spotlight-actions")).visibility==="hidden"};' +
      'setTimeout(function() {' +
      'const selected = visible()[0];' +
      'const gridBox = grid.getBoundingClientRect();' +
      'let cardBox = selected.getBoundingClientRect();' +
      'result.selectedCount = visible().length;' +
      'result.centerDifference = Math.abs((gridBox.left + gridBox.right)/2 - (cardBox.left + cardBox.right)/2);' +
      'result.animationName = getComputedStyle(selected).animationName;' +
      'result.selectedFocused = document.activeElement===selected;' +
      'const spotlightActions=document.querySelector("#spotlight-actions");' +
      'result.returnAnimation = getComputedStyle(spotlightActions).animationName;' +
      'selected.style.animation="none"; selected.style.transition="none";' +
      'spotlightActions.style.animation="none";' +
      'cardBox=selected.getBoundingClientRect();' +
      'result.returnBelowCard = document.querySelector("#show-all-games").getBoundingClientRect().top>=cardBox.bottom;' +
      'const returnBox=document.querySelector("#show-all-games").getBoundingClientRect();' +
      'const rerollBox=document.querySelector("#reroll-game").getBoundingClientRect();' +
      'result.buttonGap=rerollBox.left-returnBox.right;' +
      'result.cardButtonGap=spotlightActions.getBoundingClientRect().top-cardBox.bottom;' +
      'result.buttonsCenterDifference=Math.abs((returnBox.left+rerollBox.right)/2-(gridBox.left+gridBox.right)/2);' +
      'result.rerollIconSize=document.querySelector("#reroll-game svg").getBoundingClientRect().height;' +
      'result.topDiceIconSize=document.querySelector("#random-game svg").getBoundingClientRect().height;' +
      'result.rerollText=document.querySelector("#reroll-game").textContent.trim();' +
      'result.rerollAnimated=getComputedStyle(document.querySelector("#reroll-game svg")).animationName;' +
      'result.resetVisible = getComputedStyle(document.querySelector("#spotlight-actions")).display !== "none";' +
      'selected.style.animation=""; selected.style.transition=""; spotlightActions.style.animation="";' +
      'document.querySelector("#show-all-games").click();' +
      'result.restoredCount = visible().length;' +
      'result.resetHidden = getComputedStyle(document.querySelector("#spotlight-actions")).display === "none";' +
      'document.querySelector("#build-info").click();' +
      'result.settingsOpen = document.querySelector("#settings-dialog").open;' +
      'const slow = document.querySelector("#animation-speed");' +
      'result.slowDefault = slow.value;' +
      'slow.value="0.5";slow.dispatchEvent(new Event("change"));' +
      'document.querySelector("#settings-dialog").close();' +
      'document.querySelector("#random-game").click();' +
      'result.returnResetOnReroll=getComputedStyle(document.querySelector("#spotlight-actions")).visibility==="hidden";' +
      'result.slowDiceDuration = getComputedStyle(document.querySelector("#random-game svg")).animationDuration;' +
      'result.slowShuffleDuration = getComputedStyle(grid.querySelector(".gs-shuffle-face")).animationDuration;' +
      'const report = document.createElement("pre");' +
      'report.id = "spotlight-report";' +
      'report.textContent = JSON.stringify(result);' +
      'document.body.append(report);' +
      '}, 2000);' +
      '}, 0);' +
      '});</script>';
    const source = html
      .replace('<link rel="stylesheet" href="/styles.css">', '<style>' + css + '</style>')
      .replace('<script src="/app.js"></script>', fetchStub + '<script>' + app + '</script>' + probe);
    const file = path.join(dir, 'spotlight.html');
    fs.writeFileSync(file, source);
    const run = spawnSync(chrome, ['--headless', '--disable-gpu', '--no-sandbox',
      '--disable-dev-shm-usage', '--window-size=1280,800', '--virtual-time-budget=3000',
      '--dump-dom', pathToFileURL(file).href], { encoding: 'utf8', timeout: 15000 });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
    const match = run.stdout.match(/<pre id="spotlight-report">([^<]+)<\/pre>/);
    assert.ok(match, 'Chrome did not report the spotlight layout');
    const result = JSON.parse(match[1]);
    assert.match(html, /<link rel="icon" type="image\/png" href="\/gameshelf_icon\.png">/);
    assert.equal(result.sortOpen, true);
    assert.deepEqual(result.sortedNames, ['Third Game', 'Second Game', 'First Game']);
    assert.deepEqual(result.sizeDescNames, ['Second Game', 'First Game', 'Third Game']);
    assert.deepEqual(result.sizeAscNames, ['Third Game', 'First Game', 'Second Game']);
    assert.deepEqual(result.alphaNames, ['First Game', 'Second Game', 'Third Game']);
    assert.equal(result.listView, true);
    assert.ok(result.gearCenterDifference <= 1, 'settings icon is not centered');
    assert.equal(result.shuffleCount, 1);
    assert.match(result.shuffleAnimation, /^gs-deck-cut/);
    assert.equal(result.normalDiceDuration, result.normalShuffleDuration);
    assert.equal(result.normalShuffleDuration, '1.091s');
    assert.equal(result.diceDisabled, true);
    assert.equal(result.returnHiddenDuringShuffle, true);
    assert.equal(result.selectedCount, 1);
    assert.ok(result.centerDifference <= 1, 'selected card is not centered');
    assert.match(result.animationName, /^(none|gs-shuffle-confirm)$/);
    assert.equal(result.selectedFocused, false);
    assert.equal(result.returnBelowCard, true);
    assert.ok(Math.abs(result.buttonGap - 8) <= 1, 'spotlight buttons need an 8px gap');
    assert.ok(Math.abs(result.cardButtonGap - 12) <= 1, `selected card outline needs a 12px button offset; got ${result.cardButtonGap}`);
    assert.ok(result.buttonsCenterDifference <= 1, 'spotlight buttons are not centered');
    assert.ok(Math.abs(result.rerollIconSize - result.topDiceIconSize) <= 1, 'reroll dice icon should match the toolbar icon');
    assert.equal(result.rerollText, '');
    assert.equal(result.rerollAnimated, 'none');
    assert.equal(result.returnAnimation, 'gs-return-appear');
    assert.equal(result.resetVisible, true);
    assert.equal(result.restoredCount, 3);
    assert.equal(result.resetHidden, true);
    assert.equal(result.settingsOpen, true);
    assert.equal(result.slowDefault, '1.1');
    assert.equal(result.returnResetOnReroll, true);
    assert.equal(result.slowDiceDuration, '2.4s');
    assert.equal(result.slowShuffleDuration, result.slowDiceDuration);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
