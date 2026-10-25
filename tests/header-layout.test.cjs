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
const css = fs.readFileSync(path.join(root, 'web/styles.css'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'web/themes.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8').replace('<body class="gs-booting">', '<body>');
assert.ok(html.includes('<link rel="stylesheet" href="/styles.css">'));
assert.ok(html.includes('<script src="/app.js"></script>'));
const chrome = process.env.CHROME_BIN || (process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'google-chrome');

function readLayoutProbe(file, width, reportId, height = 800) {
  let diagnostic = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const profile = path.join(path.dirname(file), `chrome-${width}-${attempt}`);
    const run = spawnSync(chrome, ['--headless', '--disable-gpu', '--no-sandbox',
      '--disable-dev-shm-usage', '--no-first-run', `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`, '--virtual-time-budget=2000', '--dump-dom',
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
          '#view-toggle', '#view-toggle svg', '#open-cart', '#open-cart svg', '#build-info', '#build-info svg'];
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
    const toolbar = ['#sort-button', '#view-toggle', '#random-game', '#open-cart', '#build-info'];
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
      'search and sort gap differs from the toolbar spacing');
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

test('settings use three aligned columns except on portrait phones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gameshelf-settings-layout-'));
  try {
    const probe = `<script>
      document.querySelector('#settings-dialog').showModal();
      const sections = [...document.querySelectorAll('#settings-dialog .gs-settings-section')].map(el => el.getBoundingClientRect());
      const buttons = ['#export-library-data','#open-library-restore','#open-server-settings'].map(selector => document.querySelector(selector).getBoundingClientRect().width);
      const report = document.createElement('pre'); report.id = 'settings-layout-report';
      report.textContent = JSON.stringify({columns:sections.map(box => Math.round(box.left)), widths:buttons,
        checkboxCursor:getComputedStyle(document.querySelector('#show-list-images')).cursor,
        dialogWidth:document.querySelector('#settings-dialog').getBoundingClientRect().width,
        viewportWidth:document.documentElement.clientWidth});
      document.body.append(report);
    </script>`;
    const source = html.replace('<link rel="stylesheet" href="/styles.css">', `<style>${css}</style>`).replace('<script src="/app.js"></script>', probe);
    const file = path.join(dir, 'settings-layout.html');
    fs.writeFileSync(file, source);
    const desktop = readLayoutProbe(file, 1280, 'settings-layout-report');
    const portrait = readLayoutProbe(file, 390, 'settings-layout-report', 800);
    const landscape = readLayoutProbe(file, 844, 'settings-layout-report', 390);
    assert.equal(new Set(desktop.columns).size, 3);
    assert.equal(new Set(portrait.columns).size, 1);
    assert.equal(new Set(landscape.columns).size, 3);
    assert.equal(new Set(desktop.widths.map(Math.round)).size, 1);
    assert.equal(desktop.checkboxCursor, 'pointer');
    for (const result of [desktop, portrait, landscape]) assert.ok(result.dialogWidth <= result.viewportWidth, JSON.stringify(result));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('back-to-top button stays outside grid and list card edges', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gameshelf-scroll-rail-'));
  try {
    const probe = `<script>
      const grid = document.querySelector('#games-container');
      grid.innerHTML = Array.from({length:8}, (_, i) => '<article class="gs-card" style="height:140px">Game ' + i + '</article>').join('');
      const button = document.querySelector('#scroll-to-top');
      button.hidden = false;
      const buttonLeft = button.getBoundingClientRect().left;
      const edge = () => Math.max(...[...grid.children].map(card => card.getBoundingClientRect().right));
      const gridEdge = edge();
      grid.classList.add('list-view');
      const listEdge = edge();
      const report = document.createElement('pre'); report.id = 'scroll-rail-report';
      report.textContent = JSON.stringify({buttonLeft,gridEdge,listEdge,viewportWidth:document.documentElement.clientWidth});
      document.body.append(report);
    </script>`;
    const source = html.replace('<link rel="stylesheet" href="/styles.css">', `<style>${css}</style>`).replace('<script src="/app.js"></script>', probe);
    const file = path.join(dir, 'scroll-rail.html');
    fs.writeFileSync(file, source);
    for (const width of [420, 844, 1280]) {
      const result = readLayoutProbe(file, width, 'scroll-rail-report');
      assert.ok(result.buttonLeft - result.gridEdge >= 12, JSON.stringify(result));
      assert.ok(result.buttonLeft - result.listEdge >= 12, JSON.stringify(result));
      assert.ok(result.buttonLeft <= result.viewportWidth, JSON.stringify(result));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('settings and game information keep button and file text vertically centered', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gameshelf-dialog-layout-'));
  try {
    const probe = `<script>
      const center = selector => {
        const element = document.querySelector(selector);
        const range = document.createRange();
        range.selectNodeContents(element.querySelector('.gs-control-label') || element);
        const text = range.getBoundingClientRect();
        const box = element.getBoundingClientRect();
        return Math.abs((text.top + text.bottom - box.top - box.bottom) / 2);
      };
      document.querySelector('#settings-dialog').showModal();
      const exportText = center('.gs-settings-backup button');
      document.querySelector('#settings-dialog').close();
      document.querySelector('#game-details-added').textContent = 'Oct 21, 2026';
      document.querySelector('#game-details-download-summary').textContent = '4 files · 207.5 KB ZIP';
      document.querySelector('#game-files-list').innerHTML =
        '<li><span>Extras/patch-notes.txt</span><span>57 B</span><a href="#">↓</a></li>'.repeat(8);
      document.querySelector('#game-details-dialog').showModal();
      const downloadBox = document.querySelector('#game-details-download').getBoundingClientRect();
      const summaryBox = document.querySelector('#game-details-download-summary').getBoundingClientRect();
      const imageFrame = document.querySelector('.gs-details-art-frame');
      const frameBefore = imageFrame.getBoundingClientRect();
      document.querySelector('#game-files-dialog').showModal();
      const frameAfter = imageFrame.getBoundingClientRect();
      document.querySelector('#game-files-dialog').close();
      const result = { exportText, dateText: center('#game-details-added'),
        fileName: center('#game-files-list li span:first-child'),
        fileSize: center('#game-files-list li span:nth-child(2)'),
        fileDownload: center('#game-files-list li a'),
        showFiles: center('#game-details-download-summary'),
        coverAction: center('#edit-game-cover') };
      result.stableArt = Math.abs(frameBefore.width - frameAfter.width) <= 1 &&
        Math.abs(frameBefore.height - frameAfter.height) <= 1;
      result.artFooterVisible = document.querySelector('.gs-details-art-footer').getBoundingClientRect().height >= 72;
      result.summaryBelowDownload = summaryBox.top >= downloadBox.bottom;
      result.detailsBounded = document.querySelector('.gs-details-layout').getBoundingClientRect().height <= 480.5;
      result.titleInputCentered = getComputedStyle(document.querySelector('#game-title-input')).lineHeight === '34px';
      const centerDifference = (inner, outer) => {
        const a = document.querySelector(inner).getBoundingClientRect();
        const b = document.querySelector(outer).getBoundingClientRect();
        return Math.max(Math.abs((a.left + a.right - b.left - b.right) / 2),
          Math.abs((a.top + a.bottom - b.top - b.bottom) / 2));
      };
      result.titleSaveIcon = centerDifference('#save-game-title svg', '#save-game-title');
      const art = document.querySelector('.gs-details-art').getBoundingClientRect();
      result.footerFlush = Math.abs(document.querySelector('.gs-details-art-footer').getBoundingClientRect().bottom - art.bottom) <= 1;
      const content = document.querySelector('.gs-details-content').getBoundingClientRect();
      result.attachedArtGap = Math.abs(content.left - art.right);
      result.artVisible = art.width > 200;
      document.querySelector('#game-details-dialog').close();
      document.querySelector('#cover-editor-dialog').showModal();
      result.editorSave = center('#cover-editor-save');
      result.editorCancel = center('#cover-editor-cancel');
      result.editorReset = center('#cover-editor-reset');
      result.disabledSaveCursor = getComputedStyle(document.querySelector('#cover-editor-save')).cursor;
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
    assert.equal(result.artVisible, true, 'desktop game details should show the cover');
    assert.ok(result.attachedArtGap <= 1, 'cover should attach to the information panel');
    assert.equal(result.stableArt, true, 'file list must not resize the cover');
    assert.equal(result.artFooterVisible, true, 'desktop artwork footer must fill remaining panel space');
    assert.equal(result.footerFlush, true, 'no extra strip should show below the artwork footer');
    assert.equal(result.summaryBelowDownload, true, 'file count should follow Download Game');
    assert.equal(result.detailsBounded, true, 'files dialog should not grow the artwork panel');
    assert.equal(result.titleInputCentered, true, 'title input text should use the centered input line');
    assert.equal(result.disabledSaveCursor, 'not-allowed', 'disabled cover save must not show a loading cursor');
    delete result.artVisible;
    delete result.attachedArtGap;
    delete result.stableArt;
    delete result.artFooterVisible;
    delete result.footerFlush;
    delete result.summaryBelowDownload;
    delete result.detailsBounded;
    delete result.titleInputCentered;
    delete result.disabledSaveCursor;
    for (const [name, difference] of Object.entries(result)) {
      assert.ok(difference <= 1.5, `${name} text is vertically off-center by ${difference}px`);
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
          cart: bounds('#open-cart'),
          card: bounds('.gs-card')
        };
        grid.classList.add('list-view');
        result.listCard = bounds('.gs-card');
        result.listButton = bounds('.gs-icon-button');
        result.listScrollWidth = document.documentElement.scrollWidth;
        document.querySelector('#game-details-dialog').showModal();
        result.mobileDetailArt = getComputedStyle(document.querySelector('.gs-details-art')).display;
        result.mobileFrame = getComputedStyle(document.querySelector('.gs-details-art-frame')).display;
        result.mobileActions = getComputedStyle(document.querySelector('.gs-details-download-row')).display;
        document.querySelector('#game-details-dialog').close();
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
    assert.equal(result.mobileDetailArt, 'flex');
    assert.equal(result.mobileFrame, 'none');
    assert.equal(result.mobileActions, 'flex');
    const within = (box, name) => {
      assert.ok(box.left >= -1 && box.right <= result.viewportWidth + 1,
        `${name} extends past the viewport`);
    };
    for (const name of ['logo', 'search', 'random', 'sort', 'view', 'cart', 'info', 'card', 'listCard', 'listButton']) {
      within(result[name], name);
    }
    assert.ok(result.search.top >= result.logo.bottom,
      'mobile search should sit below the logo');
    const controls = [result.sort, result.view, result.random, result.cart, result.info];
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

test('recent-days input has usable dimensions and playlist actions align in list view', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gameshelf-settings-list-'));
  try {
    const probe = `<script>
      document.querySelector('#recent-settings-dialog').showModal();
      const days = document.querySelector('#recent-days').getBoundingClientRect();
      const option = document.querySelector('#recent-settings-dialog .gs-server-field').getBoundingClientRect();
      document.querySelector('#recent-settings-dialog').close();
      const grid = document.querySelector('#games-container');
      grid.classList.add('list-view');
      grid.innerHTML = '<article class="gs-card" data-favorite="true"><div class="gs-card-cover"><img><div class="gs-card-actions"><a class="gs-icon-button gs-card-download">↓</a><button class="gs-card-cart">+</button><button class="gs-card-info">i</button></div><button class="gs-favorite-star">★</button></div><div class="gs-card-body"><div class="gs-card-content"><h3 class="gs-card-title">Game</h3></div></div></article>';
      document.querySelector('.gs-card-info').focus();
      const box = selector => document.querySelector(selector).getBoundingClientRect();
      const star = box('.gs-card .gs-favorite-star'), info = box('.gs-card-info'), download = box('.gs-card-download'), playlist = box('.gs-card-cart'), card = box('.gs-card');
      const result = { daysWidth: days.width, daysHeight: days.height, daysInside: days.right <= option.right + 1 && days.left >= option.left - 1,
        ordered: star.right < download.left && download.right < playlist.left && playlist.right < info.left,
        equalGaps: Math.max(download.left - star.right, playlist.left - download.right, info.left - playlist.right) - Math.min(download.left - star.right, playlist.left - download.right, info.left - playlist.right),
        aligned: Math.max(Math.abs((star.top + star.bottom - info.top - info.bottom) / 2), Math.abs((info.top + info.bottom - download.top - download.bottom) / 2), Math.abs((playlist.top + playlist.bottom - download.top - download.bottom) / 2)),
        insideCard: star.top >= card.top && info.bottom <= card.bottom };
      const report = document.createElement('pre'); report.id = 'settings-list-report'; report.textContent = JSON.stringify(result); document.body.append(report);
    </script>`;
    const source = html.replace('<link rel="stylesheet" href="/styles.css">', `<style>${css}</style>`).replace('<script src="/app.js"></script>', probe);
    const file = path.join(dir, 'settings-list.html');
    fs.writeFileSync(file, source);
    const result = readLayoutProbe(file, 1280, 'settings-list-report');
    assert.ok(result.daysWidth >= 70 && result.daysHeight >= 36 && result.daysInside, `recent-days input: ${JSON.stringify(result)}`);
    assert.equal(result.ordered, true, 'star, download, playlist, info order');
    assert.ok(result.equalGaps <= 14, `list action gaps differ by ${result.equalGaps}px during slide-in`);
    assert.ok(result.aligned <= 2 && result.insideCard, `list action alignment: ${JSON.stringify(result)}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('no-cover list controls have no background block and reset actions share a height', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gameshelf-list-reset-'));
  try {
    const probe = `<script>
      const grid = document.querySelector('#games-container');
      grid.classList.add('list-view');
      grid.innerHTML = '<article class="gs-card gs-no-cover"><div class="gs-card-cover"><div class="gs-card-actions"><a class="gs-icon-button gs-card-download">↓</a><button class="gs-card-info">i</button></div></div><div class="gs-card-body"><h3>No Cover</h3></div></article>';
      const cover = document.querySelector('.gs-card-cover');
      const background = getComputedStyle(cover).backgroundImage;
      const info = document.querySelector('.gs-card-info').getBoundingClientRect();
      const download = document.querySelector('.gs-card-download').getBoundingClientRect();
      document.querySelector('#reset-metadata-dialog').showModal();
      const resetHeight = document.querySelector('#reset-metadata-next').getBoundingClientRect().height;
      document.querySelector('#reset-metadata-dialog').close();
      document.querySelector('#reset-confirm-dialog').showModal();
      const confirmHeight = document.querySelector('#reset-confirm-save').getBoundingClientRect().height;
      const report = document.createElement('pre'); report.id = 'list-reset-report';
      report.textContent = JSON.stringify({ background, infoHeight: info.height, downloadHeight: download.height, resetHeight, confirmHeight });
      document.body.append(report);
    </script>`;
    const source = html.replace('<link rel="stylesheet" href="/styles.css">', `<style>${css}</style>`).replace('<script src="/app.js"></script>', probe);
    const file = path.join(dir, 'list-reset.html');
    fs.writeFileSync(file, source);
    const result = readLayoutProbe(file, 1280, 'list-reset-report');
    assert.equal(result.background, 'none');
    assert.equal(result.infoHeight, 40);
    assert.equal(result.downloadHeight, 40);
    assert.equal(result.resetHeight, 40);
    assert.equal(result.confirmHeight, 40);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('light list rows have transparent action carriers and optional cover thumbnails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gameshelf-light-list-'));
  try {
    const probe = `<script>
      document.documentElement.dataset.theme = 'light';
      document.body.classList.add('gs-pin-favorite-stars');
      const grid = document.querySelector('#games-container');
      grid.innerHTML = '<article class="gs-card" data-favorite="true"><div class="gs-card-cover"><img><div class="gs-card-actions"><a class="gs-icon-button gs-card-download">↓</a><button class="gs-card-info">i</button></div><button class="gs-favorite-star">★</button></div><div class="gs-card-body"><img class="gs-list-image"><div class="gs-card-content"><h3 class="gs-card-title">Game</h3></div></div></article>';
      const card = grid.querySelector('.gs-card');
      const star = card.querySelector('.gs-favorite-star');
      const info = card.querySelector('.gs-card-info');
      const cover = card.querySelector('.gs-card-cover');
      const image = card.querySelector('.gs-list-image');
      const gridInfo = info.getBoundingClientRect(), gridStar = star.getBoundingClientRect(), gridCard = card.getBoundingClientRect();
      grid.classList.add('list-view');
      const hiddenImage = getComputedStyle(image).display;
      document.body.classList.add('gs-show-list-images');
      const shownImage = image.getBoundingClientRect();
      const result = {
        carrier: getComputedStyle(cover).backgroundImage,
        starColor: getComputedStyle(star).color,
        hiddenImage, shownDisplay: getComputedStyle(image).display,
        shownWidth: shownImage.width, shownHeight: shownImage.height,
        gridInfoSize: [gridInfo.width, gridInfo.height], gridStarSize: [gridStar.width, gridStar.height],
        gridOffsets: [gridInfo.top-gridCard.top, gridCard.right-gridInfo.right, gridStar.top-gridCard.top, gridStar.left-gridCard.left]
      };
      result.icons = ['classic', 'light', 'dark', 'retro'].map(theme => {
        document.documentElement.dataset.theme = theme;
        const download = card.querySelector('.gs-card-download'); download.tabIndex = 0;
        download.style.transition = 'none'; download.blur();
        const dormant = getComputedStyle(download).color;
        const before = download.getBoundingClientRect(); const keyboardFocus = document.createElement('input'); document.body.append(keyboardFocus); keyboardFocus.focus(); download.focus(); keyboardFocus.remove();
        const focused = getComputedStyle(download);
        const after = download.getBoundingClientRect();
        return { theme, dormant, focused: focused.color, active: document.activeElement === download, visible: download.matches(':focus-visible'), focusedState: download.matches(':focus'), background: focused.backgroundColor, border: focused.borderColor, sameTarget: before.width === after.width && before.height === after.height, tray: getComputedStyle(card.querySelector('.gs-card-actions'), '::before').backgroundImage };
      });
      const report = document.createElement('pre'); report.id='light-list-report'; report.textContent=JSON.stringify(result); document.body.append(report);
    </script>`;
    const source = html.replace('<link rel="stylesheet" href="/styles.css">', `<style>${css}</style>`).replace('<script src="/app.js"></script>', probe);
    const file = path.join(dir, 'light-list.html');
    fs.writeFileSync(file, source);
    const result = readLayoutProbe(file, 1280, 'light-list-report');
    assert.equal(result.carrier, 'none');
    for (const icon of result.icons) {
      assert.equal(icon.background, 'rgba(0, 0, 0, 0)', icon.theme);
      assert.equal(icon.border, 'rgba(0, 0, 0, 0)', icon.theme);
      if (icon.focusedState) assert.notEqual(icon.focused, icon.dormant, JSON.stringify(icon));
      assert.equal(icon.sameTarget, true, icon.theme);
      assert.notEqual(icon.tray, 'none', icon.theme);
    }
    assert.equal(result.starColor, 'rgb(249, 178, 52)');
    assert.equal(result.hiddenImage, 'none');
    assert.equal(result.shownDisplay, 'block');
    assert.equal(result.shownWidth, 34);
    assert.equal(result.shownHeight, 48);
    assert.deepEqual(result.gridInfoSize, [40, 40]);
    assert.deepEqual(result.gridStarSize, [36, 36]);
    assert.ok(result.gridOffsets[0] < 0 || Math.abs(result.gridOffsets[0] - result.gridOffsets[2]) <= 8,
      `grid controls should sit in or slide into the top band: ${JSON.stringify(result.gridOffsets)}`);
    assert.ok(Math.abs(result.gridOffsets[2] - result.gridOffsets[3]) <= 2, JSON.stringify(result.gridOffsets));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('very long titles stay within fixed card footers and two detail lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gameshelf-title-clamp-'));
  try {
    const probe = `<script>
      document.body.classList.add('gs-show-game-titles');
      const grid = document.querySelector('#games-container');
      grid.style.gridTemplateColumns = '260px 260px';
      const long = 'Moonlit Valley - Copy (4)' + 'd'.repeat(140);
      grid.innerHTML = ['Short', long].map(name => '<article class="gs-card"><div class="gs-card-cover"></div><div class="gs-card-body"><div class="gs-card-content"><h3 class="gs-card-title">' + name + '</h3></div></div></article>').join('');
      const cards = [...grid.querySelectorAll('.gs-card')];
      const footer = cards[1].querySelector('.gs-card-body').getBoundingClientRect();
      const title = cards[1].querySelector('.gs-card-title').getBoundingClientRect();
      document.querySelector('#game-details-title').textContent = long;
      document.querySelector('#game-details-dialog').showModal();
      const detailTitle = document.querySelector('#game-details-title');
      const heading = detailTitle.getBoundingClientRect();
      const lineHeight = parseFloat(getComputedStyle(detailTitle).lineHeight);
      const close = document.querySelector('#game-details-close').getBoundingClientRect();
      const report = document.createElement('pre'); report.id = 'title-clamp-report';
      report.textContent = JSON.stringify({shortHeight:cards[0].getBoundingClientRect().height,longHeight:cards[1].getBoundingClientRect().height,footerHeight:footer.height,titleBottom:title.bottom,footerBottom:footer.bottom,detailLines:heading.height/lineHeight,closeRight:close.right,dialogRight:document.querySelector('#game-details-dialog').getBoundingClientRect().right});
      document.body.append(report);
    </script>`;
    const source = html.replace('<link rel="stylesheet" href="/styles.css">', `<style>${css}</style>`).replace('<script src="/app.js"></script>', probe);
    const file = path.join(dir, 'title-clamp.html');
    fs.writeFileSync(file, source);
    const result = readLayoutProbe(file, 1280, 'title-clamp-report');
    assert.equal(result.shortHeight, result.longHeight);
    assert.equal(result.footerHeight, 54);
    assert.ok(result.titleBottom <= result.footerBottom - 4, JSON.stringify(result));
    assert.ok(result.detailLines <= 2.05, JSON.stringify(result));
    assert.ok(result.closeRight <= result.dialogRight, JSON.stringify(result));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('themes retain readable palettes and shared controls retain their geometry', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gameshelf-theme-controls-'));
  try {
    const probe=`<script>
      document.querySelector('#settings-dialog').showModal();
      const saves=['save-game-title','cover-editor-save','server-settings-save','refresh-settings-save','recent-settings-save','log-config-save'];
      const result={saves:[],themes:[]};
      document.querySelector('#settings-dialog').close();
      for(const id of saves){const button=document.getElementById(id),dialog=button.closest('dialog');dialog.showModal();
        const b=button.getBoundingClientRect(),s=button.querySelector('svg').getBoundingClientRect();result.saves.push({id,w:b.width,h:b.height,offset:Math.max(Math.abs((s.left+s.right-b.left-b.right)/2),Math.abs((s.top+s.bottom-b.top-b.bottom)/2))});dialog.close();}
      const dialog=document.querySelector('#game-details-dialog');dialog.showModal();dialog.tabIndex=-1;dialog.focus();
      const row=document.querySelector('.gs-details-download-row');
      const center=(nodes)=>{const boxes=nodes.map(n=>n.getBoundingClientRect()),r=row.getBoundingClientRect();return Math.abs((boxes[0].left+boxes.at(-1).right-r.left-r.right)/2)};
      result.rowBoxes=[...row.children].map(n=>({id:n.id,x:n.getBoundingClientRect().x,w:n.getBoundingClientRect().width,display:getComputedStyle(n).display}));result.rowBox={x:row.getBoundingClientRect().x,w:row.getBoundingClientRect().width};result.threeCentered=center([...row.children]);document.body.classList.add('gs-playlist-disabled');result.twoCentered=center([...row.children].filter(n=>getComputedStyle(n).display!=='none'));document.body.classList.remove('gs-playlist-disabled');dialog.close();
      const root=document.documentElement;
      for(const theme of ['classic','light','dark','retro','neon','cartridge','cosmos','ion','rose','midnight','lattice']){root.dataset.theme=theme;const s=getComputedStyle(root);result.themes.push({theme,text:s.getPropertyValue('--text').trim(),bg:s.getPropertyValue('--bg-elevated').trim(),logo:getComputedStyle(document.querySelector('.gs-logo-icon')).filter});}
      const report=document.createElement('pre');report.id='theme-controls-report';report.textContent=JSON.stringify(result);document.body.append(report);
    </script>`;
    const source=html.replace('<link rel="stylesheet" href="/styles.css">',`<style>${css}</style>`).replace('<script src="/app.js"></script>',probe);
    const file=path.join(dir,'themes.html');fs.writeFileSync(file,source);const r=readLayoutProbe(file,1280,'theme-controls-report');
    const mobile=readLayoutProbe(file,390,'theme-controls-report');
    assert.ok(mobile.threeCentered<1 && mobile.twoCentered<1, 'small-screen icon row must remain centered');
    for(const save of r.saves){assert.equal(save.w,38,save.id);assert.equal(save.h,38,save.id);assert.ok(save.offset<1,save.id);}
    assert.ok(r.threeCentered<1,JSON.stringify(r));assert.ok(r.twoCentered<1,JSON.stringify(r));
    const luminance=hex=>{const channels=hex.slice(1).match(/.{2}/g).map(c=>parseInt(c,16)/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4);return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722;};
    for(const theme of r.themes){if(theme.text.length===7&&theme.bg.length===7){const a=luminance(theme.text),b=luminance(theme.bg);assert.ok((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5,theme.theme);}if(!['classic','light','dark'].includes(theme.theme))assert.notEqual(theme.logo,'none',theme.theme);}
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('advanced sliders align and every theme respects row transparency and shared surfaces', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gameshelf-surfaces-'));
  try {
    const probe=`<script>
      const root=document.documentElement, settings=document.querySelector('#settings-dialog');settings.dataset.settingsLevel='advanced';settings.showModal();
      const rect=s=>document.querySelector(s).getBoundingClientRect();
      const speed=rect('#animation-speed'),opacity=rect('#list-opacity');
      const result={sliders:{speedBelow:speed.top>=rect('#animation-speed').top&&speed.top>document.querySelector('#animation-speed').closest('label').querySelector('strong').getBoundingClientRect().bottom,opacityBelow:opacity.top>document.querySelector('#list-opacity').closest('label').querySelector('strong').getBoundingClientRect().bottom,equal:Math.abs(speed.width-opacity.width)<1,aligned:Math.abs(document.querySelector('#animation-speed').closest('label').querySelector('strong').getBoundingClientRect().left-document.querySelector('.gs-theme-option strong').getBoundingClientRect().left)<1,subtitles:document.querySelector('#animation-speed').closest('label').querySelectorAll('small').length+document.querySelector('#list-opacity').closest('label').querySelectorAll('small').length},themes:[]};
      settings.dataset.settingsLevel='basic';result.speedHidden=getComputedStyle(document.querySelector('#animation-speed').closest('label')).display==='none';result.opacityHidden=getComputedStyle(document.querySelector('#list-opacity').closest('label')).display==='none';settings.close();
      const grid=document.querySelector('#games-container');grid.classList.add('list-view');grid.innerHTML='<article class="gs-card qa-hover"><div class="gs-card-body"><div class="gs-card-content">Game</div></div><div class="gs-card-cover"><div class="gs-card-actions"><button class="gs-card-info">i</button></div></div></article>';
      const card=grid.querySelector('.gs-card'),search=document.querySelector('.gs-search'),header=document.querySelector('.gs-header');
      const paint=document.createElement('canvas').getContext('2d');paint.canvas.width=paint.canvas.height=1;
      const alpha=color=>{paint.clearRect(0,0,1,1);paint.fillStyle=color;paint.fillRect(0,0,1,1);return paint.getImageData(0,0,1,1).data[3]/255};
      for(const theme of ['classic','light','dark','retro','neon','cartridge','cosmos','ion','rose','midnight','lattice','rain','storm','autumn']){
        root.dataset.theme=theme;root.style.setProperty('--list-opacity','0%');root.style.setProperty('--list-opacity-factor','0');
        const row=getComputedStyle(card),empty=alpha(row.backgroundColor),backdrop=row.backdropFilter,body=alpha(getComputedStyle(card.querySelector('.gs-card-body')).backgroundColor),tray=+getComputedStyle(card.querySelector('.gs-card-actions'),'::before').opacity;
        root.style.setProperty('--list-opacity','80%');root.style.setProperty('--list-opacity-factor','.8');const middle=alpha(getComputedStyle(card).backgroundColor);
        root.style.setProperty('--list-opacity','100%');root.style.setProperty('--list-opacity-factor','1');const full=alpha(getComputedStyle(card).backgroundColor);
        search.blur();search.classList.remove('is-filtering');const idle=getComputedStyle(header).borderBottomColor===getComputedStyle(search).borderBottomColor;
        search.focus();const focus=getComputedStyle(header).borderBottomColor===getComputedStyle(search).borderBottomColor;
        search.classList.add('is-filtering');const filtering=getComputedStyle(header).borderBottomColor===getComputedStyle(search).borderBottomColor;search.blur();search.classList.remove('is-filtering');
        result.themes.push({theme,empty,middle,full,body,tray,backdrop,idle,focus,filtering,surface:getComputedStyle(document.querySelector('#export-library-data')).backgroundColor,select:getComputedStyle(document.querySelector('#theme-select')).backgroundColor});
      }
      const checkout=document.querySelector('#cart-checkout');checkout.closest('dialog').showModal();checkout.closest('dialog').tabIndex=-1;checkout.closest('dialog').focus();checkout.classList.add('qa-hover');checkout.disabled=false;const enabled=getComputedStyle(checkout).transform;checkout.disabled=true;const disabled=getComputedStyle(checkout).transform;result.checkout={enabled,disabled};
      const report=document.createElement('pre');report.id='surfaces-report';report.textContent=JSON.stringify(result);document.body.append(report);
    </script>`;
    const source=html.replace('<link rel="stylesheet" href="/styles.css">',`<style>${css.replaceAll(':hover',':is(:hover,.qa-hover)')}*{transition:none!important}</style>`).replace('<script src="/app.js"></script>',probe);
    const file=path.join(dir,'surfaces.html');fs.writeFileSync(file,source);const r=readLayoutProbe(file,1280,'surfaces-report');
    const mobile=readLayoutProbe(file,390,'surfaces-report');assert.equal(mobile.sliders.equal,true);assert.equal(mobile.sliders.speedBelow,true);assert.equal(mobile.sliders.opacityBelow,true);
    assert.equal(r.sliders.speedBelow,true);assert.equal(r.sliders.opacityBelow,true);assert.equal(r.sliders.equal,true);assert.equal(r.sliders.aligned,true);assert.equal(r.sliders.subtitles,0);assert.equal(r.speedHidden,true);assert.equal(r.opacityHidden,true);
    for(const theme of r.themes){assert.ok(theme.empty<.01&&theme.full>.99&&Math.abs(theme.middle-.8)<.01,JSON.stringify(theme));assert.equal(theme.backdrop,'none',theme.theme);assert.equal(theme.body,0,theme.theme);assert.equal(theme.tray,0,theme.theme);assert.equal(theme.surface,theme.select,theme.theme);assert.ok(theme.idle&&theme.focus&&theme.filtering,JSON.stringify(theme));}
    assert.notEqual(r.checkout.enabled,'none');assert.equal(r.checkout.disabled,'none');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
