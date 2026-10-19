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
          '#clear-search svg', '#sort-button', '#sort-button svg',
          '#view-toggle', '#view-toggle svg', '#build-info', '#build-info svg'];
        const result = Object.fromEntries(selectors.map(selector => [selector, box(selector)]));
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
    const run = spawnSync(chrome, ['--headless', '--disable-gpu', '--no-sandbox',
      '--disable-dev-shm-usage', '--window-size=1280,800', '--dump-dom',
      pathToFileURL(file).href], { encoding: 'utf8', timeout: 15000 });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
    const match = run.stdout.match(/<pre id="layout-report">([^<]+)<\/pre>/);
    assert.ok(match, 'Chrome did not report the header layout');
    const boxes = JSON.parse(match[1]);
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
    centered('#sort-button svg', '#sort-button');
    centered('#view-toggle svg', '#view-toggle');
    centered('#build-info svg', '#build-info');
    const toolbar = ['#sort-button', '#view-toggle', '#build-info'];
    for (const button of toolbar) {
      assert.ok(Math.abs(boxes[button].cy - boxes['#search-input'].cy) <= 1,
        `${button} is not aligned with the search field`);
      assert.equal(boxes[button].height, 40);
    }
    for (let i = 1; i < toolbar.length; i++) {
      assert.ok(boxes[toolbar[i]].x >= boxes[toolbar[i - 1]].x + boxes[toolbar[i - 1]].width,
        'toolbar buttons overlap');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

