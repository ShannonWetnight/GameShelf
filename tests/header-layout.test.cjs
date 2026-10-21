// Run with Node.js 18+ and Chrome: node --test tests/header-layout.test.cjs
// Measures the actual HTML and CSS in a browser; DOM mocks cannot catch layout drift.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'web/styles.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
assert.ok(html.includes('<link rel="stylesheet" href="/styles.css">'));
assert.ok(html.includes('<script src="/app.js"></script>'));
const chrome = process.env.CHROME_BIN || (process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'google-chrome');

function readLayoutProbe(file, width, reportId) {
  let diagnostic = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const profile = path.join(path.dirname(file), `chrome-${width}-${attempt}`);
    const run = spawnSync(chrome, ['--headless', '--disable-gpu', '--no-sandbox',
      '--disable-dev-shm-usage', '--no-first-run', `--user-data-dir=${profile}`,
      `--window-size=${width},800`, '--virtual-time-budget=2000', '--dump-dom',
      pathToFileURL(file).href], { encoding: 'utf8', timeout: 30000 });
    const match = run.stdout?.match(new RegExp(`<pre id="${reportId}">([^<]+)<\\/pre>`));
    if (run.status === 0 && match) return JSON.parse(match[1]);
    diagnostic = `Chrome attempt ${attempt + 1}: ${run.error?.message || `exit ${run.status}`}; ` +
      `stderr: ${(run.stderr || '').slice(-500)}; stdout: ${(run.stdout || '').slice(-500)}`;
  }
  assert.fail(`${reportId} was not reported. ${diagnostic}`);
}

test('header icons remain centered and toolbar buttons share one row', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gameshelf-layout-'));
  try {
    const probe = `
      <script>
        const search = document.querySelector('#search-input');
        search.value = 'Test';
        document.querySelector('#clear-search').classList.remove('hidden');
        const box = selector => {
          const r = document.querySelector(selector).getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height,
            cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
        };
        const selectors = ['#search-input', '.gs-search-icon', '#clear-search',
          '#clear-search svg', '#random-game', '#random-game svg', '#sort-button', '#sort-button svg',
          '#view-toggle', '#view-toggle svg', '#build-info', '#build-info svg'];
        const result = Object.fromEntries(selectors.map(selector => [selector, box(selector)]));
        const dice = document.querySelector('#random-game svg');
        const diceBounds = dice.getBBox();
        const diceViewport = dice.viewBox.baseVal;
        result.diceArtwork = {
          cx: diceBounds.x + diceBounds.width / 2,
          cy: diceBounds.y + diceBounds.height / 2,
          viewportCx: diceViewport.x + diceViewport.width / 2,
          viewportCy: diceViewport.y + diceViewport.height / 2
        };
        const gear = document.querySelector('#build-info svg');
        const artwork = gear.querySelector('path').getBBox();
        const viewport = gear.viewBox.baseVal;
        result.gearArtwork = {
          cx: artwork.x + artwork.width / 2,
          cy: artwork.y + artwork.height / 2,
          viewportCx: viewport.x + viewport.width / 2,
          viewportCy: viewport.y + viewport.height / 2
        };
        const report = document.createElement('pre');
        report.id = 'layout-report';
        report.textContent = JSON.stringify(result);
        document.body.append(report);
      </script>`;
    const source = html
      .replace('<link rel="stylesheet" href="/styles.css">', `<style>${css}</style>`)
      .replace('<script src="/app.js"></script>', probe);
    assert.notEqual(source, html, 'layout probe must use real page markup and styles');
    const file = path.join(dir, 'header.html');
    fs.writeFileSync(file, source);
    const boxes = readLayoutProbe(file, 1280, 'layout-report');
    const centered = (inner, outer) => {
      assert.ok(Math.abs(boxes[inner].cx - boxes[outer].cx) <= 1,
        `${inner} is horizontally off-center in ${outer}`);
      assert.ok(Math.abs(boxes[inner].cy - boxes[outer].cy) <= 1,
        `${inner} is vertically off-center in ${outer}`);
    };
    assert.ok(Math.abs(boxes['.gs-search-icon'].cy - boxes['#search-input'].cy) <= 1,
      'search icon is not vertically centered');
    assert.ok(boxes['.gs-search-icon'].x > boxes['#search-input'].x,
      'search icon must stay inside the field');
    assert.ok(Math.abs(boxes['#clear-search'].cy - boxes['#search-input'].cy) <= 1,
      'clear button is not vertically centered');
    centered('#clear-search svg', '#clear-search');
    centered('#random-game svg', '#random-game');
    centered('#sort-button svg', '#sort-button');
    centered('#view-toggle svg', '#view-toggle');
    centered('#build-info svg', '#build-info');
    assert.ok(Math.abs(boxes.diceArtwork.cx - boxes.diceArtwork.viewportCx) <= 1,
      'dice artwork is horizontally off-center within its SVG');
    assert.ok(Math.abs(boxes.diceArtwork.cy - boxes.diceArtwork.viewportCy) <= 1,
      'dice artwork is vertically off-center within its SVG');
    assert.ok(Math.abs(boxes.gearArtwork.cx - boxes.gearArtwork.viewportCx) <= 0.5,
      'gear artwork is horizontally off-center within its SVG');
    assert.ok(Math.abs(boxes.gearArtwork.cy - boxes.gearArtwork.viewportCy) <= 0.5,
      'gear artwork is vertically off-center within its SVG');
    const toolbar = ['#random-game', '#sort-button', '#view-toggle', '#build-info'];
    for (const button of toolbar) {
      assert.ok(Math.abs(boxes[button].cy - boxes['#search-input'].cy) <= 1,
        `${button} is not aligned with the search field`);
      assert.equal(boxes[button].height, 40);
      assert.equal(boxes[button].width, 40);
    }
    const controlGap = 8;
    const firstGap = boxes[toolbar[0]].x -
      (boxes['#search-input'].x + boxes['#search-input'].width);
    assert.ok(Math.abs(firstGap - controlGap) <= 1,
      'search and dice gap differs from the toolbar spacing');
    for (let i = 1; i < toolbar.length; i++) {
      const gap = boxes[toolbar[i]].x -
        (boxes[toolbar[i - 1]].x + boxes[toolbar[i - 1]].width);
      assert.ok(Math.abs(gap - controlGap) <= 1,
        `${toolbar[i - 1]} and ${toolbar[i]} have inconsistent spacing`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('settings and game information keep button and file text vertically centered', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gameshelf-dialog-layout-'));
  try {
    const probe = `<script>
      const center = selector => {
        const element = document.querySelector(selector);
        const range = document.createRange();
        range.selectNodeContents(element);
        const text = range.getBoundingClientRect();
        const box = element.getBoundingClientRect();
        return Math.abs((text.top + text.bottom - box.top - box.bottom) / 2);
      };
      document.querySelector('#settings-dialog').showModal();
      const exportText = center('.gs-settings-backup a');
      document.querySelector('#settings-dialog').close();
      document.querySelector('#game-details-added').textContent = 'Oct 21, 2026';
      document.querySelector('#game-files-list').innerHTML =
        '<li><span>Extras/patch-notes.txt</span><span>57 B</span><a href="#">↓</a></li>';
      document.querySelector('#game-files-panel').classList.remove('hidden');
      document.querySelector('#game-details-dialog').showModal();
      const result = { exportText, dateText: center('#game-details-added'),
        fileName: center('#game-files-list li span:first-child'),
        fileSize: center('#game-files-list li span:nth-child(2)'),
        fileDownload: center('#game-files-list li a'),
        showFiles: center('#toggle-game-files'),
        coverAction: center('#edit-game-cover'),
        titleSave: center('#save-game-title') };
      document.querySelector('#game-details-dialog').close();
      document.querySelector('#cover-editor-dialog').showModal();
      result.editorSave = center('#cover-editor-save');
      result.editorBack = center('#cover-editor-back');
      const report = document.createElement('pre');
      report.id = 'dialog-layout-report';
      report.textContent = JSON.stringify(result);
      document.body.append(report);
    </script>`;
    const source = html
      .replace('<link rel="stylesheet" href="/styles.css">', `<style>${css}</style>`)
      .replace('<script src="/app.js"></script>', probe);
    const file = path.join(dir, 'dialogs.html');
    fs.writeFileSync(file, source);
    const result = readLayoutProbe(file, 1280, 'dialog-layout-report');
    for (const [name, difference] of Object.entries(result)) {
      assert.ok(difference <= 1, `${name} text is vertically off-center by ${difference}px`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('narrow screens keep controls and game cards within the viewport', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gameshelf-mobile-'));
  try {
    const probe = `
      <script>
        const grid = document.querySelector('#games-container');
        grid.innerHTML = '<article class="gs-card"><div class="gs-card-cover"></div><div class="gs-card-body"><div class="gs-card-content"><h3 class="gs-card-title">A long game title for mobile layout</h3></div><div class="gs-card-footer"><div class="gs-card-meta">12 GB</div><div class="gs-card-actions"><a class="gs-icon-button" href="#">Download</a></div></div></div></article>';
        const bounds = selector => {
          const r = document.querySelector(selector).getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        };
        const result = {
          viewportWidth: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          logo: bounds('.gs-refresh'),
          search: bounds('#search-input'),
          random: bounds('#random-game'),
          sort: bounds('#sort-button'),
          view: bounds('#view-toggle'),
          info: bounds('#build-info'),
          card: bounds('.gs-card')
        };
        grid.classList.add('list-view');
        result.listCard = bounds('.gs-card');
        result.listButton = bounds('.gs-icon-button');
        result.listScrollWidth = document.documentElement.scrollWidth;
        const report = document.createElement('pre');
        report.id = 'mobile-report';
        report.textContent = JSON.stringify(result);
        document.body.append(report);
      </script>`;
    const source = html
      .replace('<link rel="stylesheet" href="/styles.css">', `<style>${css}</style>`)
      .replace('<script src="/app.js"></script>', probe);
    const file = path.join(dir, 'mobile.html');
    fs.writeFileSync(file, source);
    const result = readLayoutProbe(file, 390, 'mobile-report');
    assert.ok(result.viewportWidth <= 680, 'mobile breakpoint was not exercised');
    assert.ok(result.scrollWidth <= result.viewportWidth, 'grid view overflows horizontally');
    assert.ok(result.listScrollWidth <= result.viewportWidth, 'list view overflows horizontally');
    const within = (box, name) => {
      assert.ok(box.left >= -1 && box.right <= result.viewportWidth + 1,
        `${name} extends past the viewport`);
    };
    for (const name of ['logo', 'search', 'random', 'sort', 'view', 'info', 'card', 'listCard', 'listButton']) {
      within(result[name], name);
    }
    assert.ok(result.search.top >= result.logo.bottom,
      'mobile search should sit below the logo');
    const controls = [result.random, result.sort, result.view, result.info];
    assert.ok(controls.every(box => box.top >= result.search.bottom),
      'mobile buttons should sit below the full-width search field');
    assert.ok(controls.every(box => Math.abs(box.top - controls[0].top) <= 1),
      'mobile buttons should share one row');
    const gaps = controls.slice(1).map((box, index) => box.left - controls[index].right);
    assert.ok(gaps.every(gap => gap >= 8 && Math.abs(gap - gaps[0]) <= 1),
      'mobile buttons should have consistent spacing');
    assert.ok(controls.every(box => box.bottom - box.top >= 44),
      'mobile buttons should have touch-sized targets');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
