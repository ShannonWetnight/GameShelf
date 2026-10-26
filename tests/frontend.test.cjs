// Run with Node.js 18+: node --test tests/frontend.test.cjs
// No browser or application dependencies are required.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
const games = [
  { id: 'beta', name: 'Beta', sizeBytes: 2048 },
  { id: 'alpha', name: 'Alpha', sizeBytes: 1024 }
];
const response = (data, status = 200) => ({
  ok: status >= 200 && status < 300, status, json: async () => data
});
const settle = () => new Promise(resolve => setImmediate(resolve));

// Minimal DOM surface used by app.js; exercise the actual application and bindings.
class Element {
  constructor(classes = '') {
    const tokens = new Set(classes.split(/\s+/).filter(Boolean));
    this.classList = {
      add: (...items) => items.forEach(token => tokens.add(token)),
      remove: (...items) => items.forEach(token => tokens.delete(token)),
      contains: token => tokens.has(token),
      toggle(token, force = !tokens.has(token)) {
        force ? tokens.add(token) : tokens.delete(token);
        return force;
      }
    };
    Object.defineProperty(this, 'className', {
      get: () => [...tokens].join(' '),
      set: value => { tokens.clear(); String(value).split(/\s+/).filter(Boolean).forEach(token => tokens.add(token)); }
    });
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.listeners = {};
    this.value = '';
    this.textContent = '';
  }
  appendChild(child) {
    this.children = this.children.filter(item => item !== child);
    this.children.push(child);
    child.parentElement = this;
  }
  insertBefore(child, before) {
    child.parentElement?.children.splice(child.parentElement.children.indexOf(child), 1);
    const index = before ? this.children.indexOf(before) : this.children.length;
    this.children.splice(index, 0, child);
    child.parentElement = this;
  }
  get nextSibling() {
    const siblings = this.parentElement?.children || [];
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  replaceWith(next) {
    const index = this.parentElement?.children.indexOf(this) ?? -1;
    if (index >= 0) { this.parentElement.children[index] = next; next.parentElement = this.parentElement; }
  }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  querySelectorAll(selector) { return selector === 'input' ? this.children.flatMap(child => [child, ...child.querySelectorAll('input')]).filter(item => item.tagName === 'INPUT') : []; }
  querySelector(selector) {
    if (selector === 'img') return this.children.find(child => child.tagName === 'IMG') || null;
    if (selector === 'input:checked') return this.querySelectorAll('input').find(input => input.checked) || null;
    const name = selector.startsWith('.') ? selector.slice(1) : '';
    return this.children.find(child => child.classList.contains(name)) ||
      this.children.map(child => child.querySelector(selector)).find(Boolean) || null;
  }
  set innerHTML(value) { this.children = []; this.htmlWrites = (this.htmlWrites || 0) + 1; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(event, callback) { (this.listeners[event] ||= []).push(callback); }
  emit(event, payload = {}) {
    const result = { target: this, currentTarget: this, stopPropagation() {}, preventDefault() {}, ...payload };
    return this.listeners[event]?.map(callback => callback(result)).at(-1);
  }
  blur() { this.focused = false; }
  contains(other) { return this === other || this.children.some(child => child.contains(other)); }
  focus() { this.focused = true; }
  getBoundingClientRect() { return { left: 100, top: 100, right: 500, bottom: 500 }; }
  showModal() { this.open = true; }
  close() { this.open = false; this.emit('close'); }
}

function app(
  versionInfo = { version: 'edge-20261019-16.1-abc123def456', channel: 'edge' },
  storage = new Map(),
  reducedMotion = false
) {
  const elements = new Map();
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const element = new Element(match[0].match(/class="([^"]*)"/)?.[1]);
    element.id = match[1];
    if (match[0].includes(' checked')) element.checked = true;
    if (match[0].includes('value="')) element.value = match[0].match(/value="([^"]*)"/)[1];
    elements.set(match[1], element);
  }
  for(const match of html.matchAll(/<select[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)){elements.get(match[1]).options=[...match[2].matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)].map(option=>({value:option[1],text:option[2]}));}
  for (const match of html.matchAll(/<button data-sort="([^"]+)">([^<]+)<\/button>/g)) {
    const button = new Element();
    button.dataset.sort = match[1];
    button.textContent = match[2];
    elements.get('sort-menu').appendChild(button);
  }
  const document = new Element();
  document.body = new Element();
  document.getElementById = id => {
    assert.ok(elements.has(id), `Missing HTML element: ${id}`);
    return elements.get(id);
  };
  document.createElement = tag => {
    const element = new Element();
    element.tagName = tag.toUpperCase();
    element.click = () => { element.clicked = true; };
    element.remove = () => { element.removed = true; if (element.parentElement && element.classList.contains('gs-shuffle-deck')) element.parentElement.children = element.parentElement.children.filter(child => child !== element); };
    return element;
  };
  document.createTextNode = text => { const node = new Element(); node.textContent = text; return node; };
  document.querySelectorAll = selector => {
    if (selector === '#logs-filters input') return ['system', 'library', 'errors', 'request', 'scan', 'download','health'].map(type => elements.get(`logs-filter-${type}`));
    if (selector === '.gs-sort-menu button') return elements.get('sort-menu').children;
    if (selector === '#export-options input:checked') return elements.get('export-options').querySelectorAll('input').filter(input => input.checked);
    if (selector === '#reset-metadata-options input' || selector === '#reset-metadata-options input:checked') {
      const options = elements.get('reset-metadata-options').querySelectorAll('input');
      return selector.endsWith(':checked') ? options.filter(input => input.checked) : options;
    }
    return [];
  };
  const images = [];
  const requests = [];
  const timers = new Map();
  let timerId = 0;
  const downloads = [];
  const revoked = [];
  const copied = [];
  const context = vm.createContext({
    window: { scrollY: 0, scrollTo() {}, matchMedia: () => ({ matches: reducedMotion }) },
    URL: { createObjectURL: blob => { downloads.push(blob); return "blob:backup"; }, revokeObjectURL: url => revoked.push(url) }, URLSearchParams,
    document, Blob, navigator: { clipboard: { writeText: async value => copied.push(value) } },
    matchMedia: () => ({ matches: reducedMotion }), localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value)
    },
    Image: class { constructor() { this.width = 600; this.height = 900; images.push(this); } },
    console: { error() {} }, AbortController,
    setTimeout(callback, delay) {
      timers.set(++timerId, { callback, delay });
      return timerId;
    },
    clearTimeout: id => timers.delete(id),
    fetch(url, options) {
      if(url==='/api/settings-events')return Promise.resolve(response({},204));
      if (url === '/api/version') {
        return Promise.resolve(versionInfo ? response(versionInfo) : response({}, 503));
      }
      if (url === '/api/server-settings' && !options?.method) {
        return Promise.resolve(response({ rootDir: '/games', dataDir: '/data', refreshInterval: '12h', verbose: false }));
      }
      return new Promise((resolve, reject) => {
        requests.push({ url, resolve, reject });
        options?.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
      });
    }
  });
  vm.runInContext(source, context);
  return {
    requests, document, storage, downloads, revoked, copied, images, element: id => elements.get(id),
    hidden: id => elements.get(id).classList.contains('hidden'),
    cards: () => elements.get('games-container').children.filter(child => child.classList.contains('gs-card')),
    start: () => document.emit('DOMContentLoaded'),
    click: id => elements.get(id).emit('click'),
    search(value) {
      elements.get('search-input').value = value;
      elements.get('search-input').emit('input');
    },
    timerDelays: () => [...timers.values()].map(timer => timer.delay),
    tick(delay) {
      for (const [id, timer] of timers) {
        if (timer.delay === delay) { timers.delete(id); timer.callback(); }
      }
    }
  };
}

test('build information shows the exact Edge tag, stable tag, or an unavailable state', async () => {
  for (const [info, expected] of [
    [{ version: 'edge-20261019-16.1-abc123def456', channel: 'edge' }, 'Edge: edge-20261019-16.1-abc123def456'],
    [{ version: 'v2.1.3', channel: 'stable' }, 'v2.1.3'],
    [null, 'Version unavailable']
  ]) {
    const ui = app(info);
    ui.start();
    await settle();
    assert.equal(ui.element('settings-version').textContent, expected);
  }
});

test('loading cannot be mistaken for an empty library; overlapping refresh is ignored', async () => {
  const ui = app();
  ui.start();
  assert.equal(ui.hidden('loading-state'), false);
  assert.equal(ui.hidden('empty-state'), true);
  assert.equal(ui.element('games-container').attributes['aria-busy'], 'true');
  ui.search('anything');
  ui.click('gs-refresh-trigger');
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.hidden('empty-state'), true);
  ui.requests[0].resolve(response([]));
  await settle();
  assert.equal(ui.hidden('loading-state'), true);
  assert.equal(ui.element('games-container').attributes['aria-busy'], 'false');
  assert.equal(ui.hidden('empty-state'), false);
  assert.equal(ui.hidden('empty-hint'), false);
  assert.equal(ui.hidden('search-hint'), true);
});

test('cover actions download the game and open read-only details', async () => {
  const ui = app();
  ui.start();
  ui.requests[0].resolve(response([{ ...games[1], path: '/GameShelf/Alpha', fileCount: 2, hasCover: true, addedAt: '2026-10-21T12:00:00Z' }]));
  await settle();

  const card = ui.cards().find(item => item.dataset.id === 'alpha');
  const body = card.children[1];
  const action = card.children[0].children[1].children[0];
  const details = card.children[0].children[1].children[2];
  assert.equal(body.children[0].querySelector('img').tagName, 'IMG');
  assert.equal(body.children[1].children[0].textContent, 'Alpha');
  assert.equal(body.children.length, 2);
  assert.equal(action.href, '/download/alpha');
  assert.equal(action.attributes['aria-label'], 'Download Alpha');
  action.focus();
  action.emit('click');
  assert.equal(ui.element('notification-text').textContent, 'Download started.');
  assert.equal(action.focused, false);
  assert.equal(card.classList.contains('gs-hover-suppressed'), false);
  card.emit('pointerleave');
  assert.equal(card.classList.contains('gs-hover-suppressed'), false);
  details.emit('click');
  assert.equal(ui.element('game-details-dialog').open, true);
  assert.equal(ui.element('game-details-path').textContent, '/GameShelf/Alpha');
  assert.equal(ui.element('game-details-size').textContent, '1.0 KB');
  assert.equal(ui.element('game-details-download').href, '/download/alpha');
  ui.click('game-details-download');
  assert.equal(ui.element('notification-text').textContent, 'Download started.');
  assert.match(ui.element('game-details-download-summary').textContent, /2 files/);
  assert.equal(ui.element('game-details-cover').textContent, 'Available');
  assert.match(ui.element('game-details-added').textContent, /2026/);
  ui.click('game-details-close');
  assert.equal(ui.element('game-details-dialog').open, false);
  assert.equal(card.classList.contains('gs-hover-suppressed'), false);
  assert.notEqual(card.focused, true);
});

test('game information lists only the selected game files on request', async () => {
  const ui = app();
  ui.start();
  ui.requests[0].resolve(response(games));
  await settle();
  const alpha = ui.cards().find(card => card.dataset.id === 'alpha');
  alpha.children[0].children[1].children[2].emit('click');
  assert.equal(ui.requests.length, 1);
  ui.click('game-details-download-summary');
  assert.equal(ui.requests[1].url, '/api/game-files/alpha');
  assert.equal(ui.element('game-files-dialog').open, true);
  ui.requests[1].resolve(response({ files: [
    { path: 'data/level.dat', sizeBytes: 2048 },
    { path: 'cover.png', sizeBytes: 1024 }
  ], truncated: false }));
  await settle();
  assert.deepEqual(ui.element('game-files-list').children.map(item => item.children[0].textContent),
    ['data/level.dat', 'cover.png']);
  assert.equal(ui.element('game-files-list').children[0].children[2].href,
    '/api/game-file/alpha?path=data%2Flevel.dat');
  ui.element('game-files-list').children[0].children[2].emit('click');
  assert.equal(ui.element('notification-text').textContent, 'Download started.');
  ui.click('game-files-close');
  assert.equal(ui.element('game-files-dialog').open, false);
  ui.click('game-details-close');
  assert.equal(ui.element('game-details-dialog').open, false);
});

test('both dialogs close on backdrop clicks, while inside clicks stay open', async () => {
  const ui = app();
  ui.start();
  ui.requests[0].resolve(response(games));
  await settle();
  const settings = ui.element('settings-dialog');
  ui.click('build-info');
  settings.emit('click', { target: settings, clientX: 150, clientY: 150 });
  assert.equal(settings.open, true);
  settings.emit('pointerdown', { target: settings,button:0,clientX:0,clientY:0 });settings.emit('pointerup', { target: settings,clientX:0,clientY:0 });settings.emit('click', { target: settings, clientX: 0, clientY: 0 });
  assert.equal(settings.open, false);
  const info = ui.cards()[0].children[0].children[1].children[2];
  info.emit('click');
  const details = ui.element('game-details-dialog');
  details.emit('pointerdown', { target: details,button:0,clientX:0,clientY:0 });details.emit('pointerup', { target: details,clientX:0,clientY:0 });details.emit('click', { target: details, clientX: 0, clientY: 0 });
  assert.equal(details.open, false);
});

test('display preferences default to hints on and persist changes', () => {
  const storage = new Map();
  const ui = app(undefined, storage);
  ui.start();
  assert.equal(ui.element('show-hover-text').checked, true);
  assert.equal(ui.element('show-game-titles').checked, false);
  assert.equal(ui.element('show-placeholder-images').checked, true);
  assert.equal(ui.element('expand-list-image').value, 'single');
  assert.equal(ui.element('show-list-images').checked, true);
  for (const [id, key, bodyClass, checked] of [
    ['show-hover-text', 'gameshelf:show-hover-text', 'gs-hide-tooltips', false],
    ['show-game-titles', 'gameshelf:show-game-titles', 'gs-show-game-titles', true],
    ['show-placeholder-images', 'gameshelf:show-placeholder-images', 'gs-show-placeholders', true],
    ['show-list-images', 'gameshelf:show-list-images', 'gs-show-list-images', true]
  ]) {
    const input = ui.element(id);
    input.checked = checked;
    input.emit('change');
    assert.equal(storage.get(key), String(checked));
    assert.equal(ui.document.body.classList.contains(bodyClass), true);
  }
  const revisit = app(undefined, storage);
  revisit.start();
  assert.equal(revisit.element('show-hover-text').checked, false);
  assert.equal(revisit.element('show-game-titles').checked, true);
  assert.equal(revisit.element('show-placeholder-images').checked, true);
  assert.equal(revisit.element('show-list-images').checked, true);
  revisit.element('show-list-images').checked = false;
  revisit.element('show-list-images').emit('change');
  assert.equal(storage.get('gameshelf:show-list-images'), 'false');
  assert.equal(revisit.document.body.classList.contains('gs-show-list-images'), false);
});

test('populated library, search miss, clear search, sort and view still work', async () => {
  const ui = app();
  ui.start();
  ui.requests[0].resolve(response(games));
  await settle();
  assert.deepEqual(ui.cards().map(card => card.dataset.id), ['alpha', 'beta']);
  assert.equal(ui.hidden('empty-state'), true);
  ui.click('view-toggle');
  assert.equal(ui.element('games-container').classList.contains('list-view'), true);
  ui.search('zzz');
  assert.equal(ui.hidden('empty-state'), false);
  assert.equal(ui.hidden('clear-search'), false);
  assert.equal(ui.element('empty-title').textContent, 'No matching games!');
  assert.equal(ui.hidden('empty-hint'), true);
  assert.equal(ui.hidden('search-hint'), false);
  ui.click('clear-search');
  assert.equal(ui.element('search-input').value, '');
  assert.equal(ui.element('search-input').focused, true);
  assert.equal(ui.hidden('clear-search'), true);
  assert.equal(ui.hidden('empty-state'), true);
  ui.search('zzz');
  ui.document.emit('keydown', { key: 'Escape' });
  assert.equal(ui.hidden('empty-state'), true);
  assert.ok(ui.cards().every(card => card.style.display === ''));
});

test('random suggestion explains why it is disabled for an empty library', async () => {
  const ui = app();
  ui.start();
  ui.requests[0].resolve(response([]));
  await settle();
  assert.equal(ui.element('random-game').disabled, true);
  assert.equal(ui.element('random-game').dataset.tooltip, 'Add games to enable random suggestions');
});

test('random suggestion highlights a game without downloading and avoids immediate repeats', async () => {
  const ui = app();
  ui.start();
  assert.equal(ui.element('random-game').disabled, true);
  assert.equal(ui.element('random-game').dataset.tooltip, 'Loading games…');
  ui.requests[0].resolve(response(games));
  await settle();
  assert.equal(ui.element('random-game').disabled, false);
  assert.equal(ui.element('random-game').dataset.tooltip, 'Suggest a random game');

  ui.search('Alpha');
  ui.click('random-game');
  assert.equal(ui.element('random-game').classList.contains('is-rolling'), true);
  ui.element('random-game').emit('animationend');
  assert.equal(ui.element('random-game').classList.contains('is-rolling'), false);
  const selected = () => ui.cards().filter(card => card.classList.contains('gs-random-selected'));
  assert.equal(selected().length, 0);
  assert.equal(ui.element('random-game').disabled, true);
  assert.equal(ui.cards().filter(card => card.classList.contains('gs-shuffle-anchor')).length, 1);
  const stableCard = ui.cards().find(card => card.style.display !== 'none');
  assert.equal(ui.element('games-container').children.filter(child => child.classList.contains('gs-shuffle-deck')).length, 1);
  ui.tick(400);
  assert.equal(ui.cards().find(card => card.style.display !== 'none'), stableCard);
  ui.tick(1091);
  ui.tick(1091);
  assert.equal(selected().length, 1);
  assert.equal(ui.element('random-game').disabled, false);
  assert.equal(ui.element('games-container').classList.contains('gs-spotlight'), true);
  assert.equal(ui.element('library-stage').classList.contains('gs-spotlight-stage'), true);
  assert.equal(ui.hidden('spotlight-actions'), false);
  assert.equal(ui.cards().filter(card => card.style.display !== 'none').length, 1);
  assert.equal(selected()[0], stableCard);
  assert.equal(selected()[0].classList.contains('gs-shuffle-confirm'), false);
  selected()[0].emit('animationend');
  assert.equal(selected()[0].classList.contains('gs-shuffle-confirm'), false);
  assert.equal(ui.element('games-container').children.filter(child => child.classList.contains('gs-shuffle-deck')).length, 0);
  assert.equal(ui.element('random-game').classList.contains('is-rolling'), false);
  const firstId = selected()[0].dataset.id;
  assert.equal(selected()[0].focused, undefined);
  assert.equal(ui.element('spotlight-download').href, `/download/${firstId}`);
  ui.click('spotlight-download');
  assert.equal(ui.element('notification-text').textContent, 'Download started.');
  ui.click('spotlight-info');
  assert.equal(ui.element('game-details-dialog').open, true);
  assert.equal(ui.element('game-details-title').textContent, games.find(game => game.id === firstId).name);
  ui.element('game-details-dialog').close();
  assert.equal(ui.element('search-input').value, '');
  assert.equal(ui.element('suggestion-status').textContent,
    `Showing only ${games.find(game => game.id === firstId).name}. Use Return to go back to the library or Reroll to choose again.`);

  ui.click('random-game');
  assert.equal(ui.element('random-game').classList.contains('is-rolling'), true);
  assert.equal(selected().length, 0);
  ui.tick(1091);
  ui.tick(1091);
  assert.equal(selected().length, 1);
  assert.notEqual(selected()[0].dataset.id, firstId);
  assert.equal(ui.cards().filter(card => card.style.display !== 'none').length, 1);
  ui.search('Beta');
  assert.equal(selected().length, 0);
  assert.equal(ui.hidden('spotlight-actions'), true);
  assert.equal(ui.element('spotlight-download').attributes.href, undefined);
  assert.equal(ui.element('games-container').classList.contains('gs-spotlight'), false);
  assert.equal(ui.element('suggestion-status').textContent, '');
});

test('spotlight resets through Return to all games or Escape and restores list view', async () => {
  const ui = app();
  ui.start();
  ui.requests[0].resolve(response(games));
  await settle();
  ui.click('view-toggle');
  assert.equal(ui.element('games-container').classList.contains('list-view'), true);

  ui.click('random-game');
  assert.equal(ui.element('games-container').classList.contains('list-view'), false);
  assert.equal(ui.cards().filter(card => card.style.display !== 'none').length, 1);
  ui.click('show-all-games');
  ui.tick(1091);
  ui.tick(1091);
  assert.equal(ui.element('games-container').classList.contains('list-view'), true);
  assert.equal(ui.cards().filter(card => card.style.display !== 'none').length, 2);
  assert.equal(ui.hidden('spotlight-actions'), true);
  assert.equal(ui.element('random-game').focused, true);

  ui.click('random-game');
  ui.document.emit('keydown', { key: 'Escape' });
  ui.tick(1091);
  ui.tick(1091);
  assert.equal(ui.element('games-container').classList.contains('list-view'), true);
  assert.equal(ui.cards().filter(card => card.style.display !== 'none').length, 2);
});

test('sort and view controls leave dice spotlight before acting', async () => {
  const ui = app();
  ui.start();
  ui.requests[0].resolve(response(games));
  await settle();
  ui.click('random-game');
  ui.tick(1091);
  ui.tick(1091);
  assert.equal(ui.element('games-container').classList.contains('gs-spotlight'), true);
  ui.click('sort-button');
  assert.equal(ui.element('games-container').classList.contains('gs-spotlight'), false);
  assert.equal(ui.hidden('sort-menu'), false);
  assert.equal(ui.cards().filter(card => card.style.display !== 'none').length, 2);
  ui.click('random-game');
  ui.tick(1091);
  ui.tick(1091);
  ui.click('view-toggle');
  assert.equal(ui.element('games-container').classList.contains('gs-spotlight'), false);
  assert.equal(ui.element('games-container').classList.contains('list-view'), true);
  assert.equal(ui.cards().filter(card => card.style.display !== 'none').length, 2);
});

test('search cancels a pending shuffle and reduced motion skips it', async () => {
  const ui = app();
  ui.start();
  ui.requests[0].resolve(response(games));
  await settle();
  ui.click('random-game');
  ui.search('Alpha');
  ui.tick(1091);
  ui.tick(1091);
  assert.equal(ui.element('games-container').classList.contains('gs-spotlight'), false);
  assert.equal(ui.hidden('spotlight-actions'), true);
  assert.equal(ui.cards().filter(card => card.style.display !== 'none').length, 1);
  assert.equal(ui.cards().find(card => card.style.display !== 'none').dataset.id, 'alpha');

  const reduced = app(undefined, new Map(), true);
  reduced.start();
  reduced.requests[0].resolve(response(games));
  await settle();
  reduced.click('random-game');
  assert.equal(reduced.cards().filter(card => card.classList.contains('gs-random-selected')).length, 1);
  assert.equal(reduced.cards().filter(card => card.classList.contains('gs-shuffle-anchor')).length, 0);
  assert.equal(reduced.element('random-game').disabled, false);
});

test('animation speed defaults to 1.10x, persists and controls the shuffle', async () => {
  const storage=new Map();const ui=app(undefined,storage);ui.start();
  assert.equal(ui.element('animation-speed').value,'1.1');
  assert.equal(ui.element('slow-animations'),undefined);assert.equal(ui.element('disable-effects'),undefined);
  ui.click('build-info');assert.equal(ui.element('settings-dialog').focused,true);
  const speed=ui.element('animation-speed');speed.value='0.5';speed.emit('change');
  assert.equal(storage.get('gameshelf:animation-speed'),'0.5');
  ui.requests[0].resolve(response(games));await settle();ui.click('random-game');
  assert.ok(ui.timerDelays().includes(2400));ui.tick(2400);
  assert.equal(ui.cards().filter(card=>card.classList.contains('gs-random-selected')).length,1);
  const revisit=app(undefined,storage);revisit.start();assert.equal(revisit.element('animation-speed').value,'0.5');
  speed.value='0';speed.emit('change');assert.equal(ui.document.body.classList.contains('gs-no-animations'),true);
  ui.click('random-game');assert.equal(ui.cards().filter(card=>card.classList.contains('gs-random-selected')).length,1);
  speed.value='3';speed.emit('change');ui.click('random-game');assert.ok(ui.timerDelays().includes(400));ui.tick(400);
  assert.equal(ui.cards().filter(card=>card.classList.contains('gs-random-selected')).length,1);
});

for (const failure of ['network', 'http', 'json', 'shape', 'game', 'timeout']) {
  test(`${failure} failure shows an error, stays an error while searching, and can retry`, async () => {
    const ui = app();
    ui.start();
    const request = ui.requests[0];
    if (failure === 'network') request.reject(new Error('Offline'));
    if (failure === 'http') request.resolve(response([], 503));
    if (failure === 'json') request.resolve({ ok: true, json: async () => { throw new SyntaxError(); } });
    if (failure === 'shape') request.resolve(response({ games: [] }));
    if (failure === 'game') request.resolve(response([{ id: 'bad', name: null, sizeBytes: 0 }]));
    if (failure === 'timeout') ui.tick(30000);
    await settle();
    assert.equal(ui.hidden('error-state'), false);
    assert.equal(ui.hidden('empty-state'), true);
    assert.equal(ui.hidden('loading-state'), true);
    assert.equal(ui.element('retry-button').disabled, false);
    ui.search('test');
    ui.search('');
    assert.equal(ui.hidden('empty-state'), true);
    ui.click('retry-button');
    assert.equal(ui.requests[1].url, '/api/games');
    ui.requests[1].resolve(response(games));
    await settle();
    assert.equal(ui.hidden('error-state'), true);
    assert.equal(ui.cards().length, 2);
  });
}

for (const failure of ['network', 'http', 'json', 'shape', 'timeout']) {
  test(`refresh ${failure} preserves cards, covers and search; retry uses forced response`, async () => {
    const ui = app();
    ui.start();
    ui.requests[0].resolve(response(games));
    await settle();
    ui.search('alpha');
    const oldCards = [...ui.cards()];
    const oldCover = oldCards[0].children[0].children[0].src;
    ui.click('gs-refresh-trigger');
    ui.click('gs-refresh-trigger');
    assert.equal(ui.requests.length, 2);
    assert.equal(ui.requests[1].url, '/api/games?forceRefresh=1');
    assert.deepEqual(ui.cards(), oldCards);
    const request = ui.requests[1];
    if (failure === 'network') request.reject(new Error('Offline'));
    if (failure === 'http') request.resolve(response([], 500));
    if (failure === 'json') request.resolve({ ok: true, json: async () => { throw new SyntaxError(); } });
    if (failure === 'shape') request.resolve(response(null));
    if (failure === 'timeout') ui.tick(30000);
    await settle();
    assert.equal(ui.element('gs-logo-text').textContent, 'FAILED');
    assert.equal(ui.element('gs-logo-text').classList.contains('bounce'), false);
    assert.equal(ui.hidden('error-state'), false);
    assert.match(ui.element('error-message').textContent, /last loaded library/);
    assert.deepEqual(ui.cards(), oldCards);
    assert.equal(ui.cards()[0].children[0].children[0].src, oldCover);
    assert.equal(ui.element('search-input').value, 'alpha');
    assert.equal(ui.cards()[1].style.display, 'none');
    // Retry is available immediately, even while the FAILED feedback is displayed.
    ui.click('retry-button');
    assert.equal(ui.requests[2].url, '/api/games?forceRefresh=1');
    ui.requests[2].resolve(response([{ id: 'new', name: 'New', sizeBytes: 0 }]));
    await settle();
    assert.equal(ui.requests.length, 3); // No second GET after forced refresh.
    assert.equal(ui.element('gs-logo-text').textContent, 'REFRESHED');
    assert.equal(ui.hidden('error-state'), true);
    assert.equal(ui.element('search-input').value, '');
    assert.deepEqual(ui.cards().map(card => card.dataset.id), ['new']);
    assert.match(ui.cards()[0].children[0].children[0].src, /\?v=1$/);
  });
}

test('successful refresh to an empty library removes stale cards and shows setup guidance', async () => {
  const ui = app();
  ui.start();
  ui.requests[0].resolve(response(games));
  await settle();
  ui.search('zzz');
  ui.click('gs-refresh-trigger');
  ui.requests[1].resolve(response([]));
  await settle();
  assert.equal(ui.cards().length, 0);
  assert.equal(ui.hidden('empty-state'), false);
  assert.equal(ui.hidden('empty-hint'), false);
  assert.equal(ui.hidden('search-hint'), true);
  assert.equal(ui.element('gs-logo-text').textContent, 'REFRESHED');
});

test('adding favorites saves directly and removing asks for confirmation', async () => {
  const ui = app();
  ui.start();
  ui.requests[0].resolve(response(games));
  await settle();
  const alpha = ui.cards().find(card => card.dataset.id === 'alpha');
  alpha.children[0].children[2].emit('click');
  assert.notEqual(ui.element('favorite-dialog').open, true);
  const request = ui.requests.find(item => item.url === '/api/favorite/alpha');
  assert.equal(request !== undefined, true);
  request.resolve(response({ favorite: true }));
  await settle();
  assert.equal(ui.cards().find(card => card.dataset.id === 'alpha').dataset.favorite, 'true');
  assert.equal(ui.element('notification-text').textContent, 'Added to favorites.');
  alpha.children[0].children[2].emit('click');
  assert.equal(ui.element('favorite-dialog').open, true);
  ui.click('favorite-confirm');
  ui.requests.at(-1).resolve(response({ favorite: false }));
  await settle();
  assert.equal(alpha.dataset.favorite, 'false');
  assert.equal(alpha.classList.contains('gs-hover-suppressed'), false);
  assert.equal(alpha.classList.contains('gs-random-selected'), false);
  assert.equal(alpha.querySelector('.gs-favorite-star').focused, false);
});

test('favorites-first defaults on and groups favorites within every sort', async () => {
  const storage = new Map();
  const ui = app(undefined, storage);
  ui.start();
  ui.requests[0].resolve(response([{ ...games[0], favorite: true }, { ...games[1], favorite: false }]));
  await settle();
  assert.equal(ui.element('favorites-first').checked, true);
  assert.deepEqual(ui.cards().map(card => card.dataset.id), ['beta', 'alpha']);
  ui.element('sort-menu').children.find(button => button.dataset.sort === 'size-asc').emit('click');
  assert.deepEqual(ui.cards().map(card => card.dataset.id), ['beta', 'alpha']);
  ui.element('favorites-first').checked = false;
  ui.element('favorites-first').emit('change');
  assert.equal(storage.get('gameshelf:favorites-first'), 'false');
  assert.deepEqual(ui.cards().map(card => card.dataset.id), ['alpha', 'beta']);
});

test('dice spotlight keeps the chosen view control unchanged', async () => {
  const ui = app();
  ui.start();
  ui.requests[0].resolve(response(games));
  await settle();
  ui.click('view-toggle');
  const toggle = ui.element('view-toggle');
  const writes = toggle.htmlWrites;
  assert.equal(toggle.dataset.viewMode, 'list');
  ui.click('random-game');
  ui.tick(375);
  ui.tick(687);
  assert.equal(toggle.dataset.viewMode, 'list');
  assert.equal(toggle.htmlWrites, writes);
});

test('notifications fade out before being hidden', async () => {
  const ui = app();
  ui.start();
  ui.requests[0].resolve(response(games));
  await settle();
  ui.click('game-details-download');
  const banner = ui.element('notification-banner');
  assert.equal(banner.hidden, false);
  ui.tick(3500);
  assert.equal(banner.classList.contains('gs-notification-leaving'), true);
  assert.equal(banner.hidden, false);
  ui.tick(250);
  assert.equal(banner.hidden, true);
});

test('application logs are always available, configurable, filterable, and exportable', async () => {
  const ui = app();
  ui.start();
  await settle();
  assert.equal(ui.hidden('logs-setting'), false);
  ui.click('configure-logs');
  assert.equal(ui.element('log-config-dialog').open, true);
  assert.equal(ui.element('log-requests').disabled, true);
  ui.element('log-verbose').checked = true;
  ui.element('log-verbose').emit('change');
  assert.equal(ui.element('log-requests').disabled, false);
  ui.element('log-override-days').checked = true;
  ui.element('log-override-days').emit('change');
  assert.equal(ui.element('log-days').disabled, false);
  const saving = ui.click('log-config-save');
  ui.requests.find(item => item.url === '/api/server-settings').resolve(response({ restartRequired: false }));
  await saving;
  assert.equal(ui.element('log-config-dialog').open, false);
  const opening = ui.click('view-logs');
  assert.equal(ui.element('logs-dialog').open, true);
  ui.requests.find(item => item.url === '/api/logs').resolve({ ok: true, text: async () => 'Scan complete\n[request] GET /api/games\n' });
  await opening;
  assert.equal(ui.element('logs-content').textContent, 'Scan complete\n[request] GET /api/games\n');
  ui.element('logs-filter-request').checked = false;
  ui.element('logs-filter-request').emit('change');
  assert.equal(ui.element('logs-content').textContent, 'Scan complete\n');
  ui.click('logs-clear-filters');
  assert.equal(ui.element('logs-content').textContent, 'Scan complete\n[request] GET /api/games\n');
  await ui.click('logs-copy');
  assert.deepEqual(ui.copied, ['Scan complete\n[request] GET /api/games\n']);
  const before=ui.element('logs-content').textContent;const downloading=ui.click('logs-download');
  ui.requests.find(item=>item.url==='/api/logs?export=1').resolve({ok:true,text:async()=>before+'[system] Application logs exported\n'});await downloading;
  assert.equal(ui.downloads.length,1);
  assert.equal(ui.element('logs-content').textContent,before,'export must not resize or append to the open log view');
  ui.click('logs-close');
  assert.equal(ui.element('logs-dialog').open, false);
});

test('download playlist reviews games and starts one combined ZIP', async () => {
  const storage = new Map();
  const ui = app(undefined, storage);
  ui.start();
  ui.requests[0].resolve(response(games));
  await settle();
  const findCart = element => element.className === 'gs-card-cart' ? element : element.children.map(findCart).find(Boolean);
  findCart(ui.cards()[0]).emit('click');
  assert.equal(ui.element('cart-count').textContent, '1');
  assert.equal(ui.element('cart-count').hidden, false);
  ui.click('open-cart');
  assert.equal(ui.element('cart-dialog').open, true);
  assert.equal(ui.element('cart-items').children.length, 1);
  assert.match(ui.element('cart-total').textContent, /1 game/);
  ui.click('cart-checkout');
  assert.equal(ui.element('cart-dialog').open, false);
  const link = ui.document.body.children.find(child => child.href?.startsWith('/download-playlist?'));
  assert.ok(link?.href.includes('game=alpha'));
  assert.equal(link.clicked, true);
  assert.equal(ui.element('notification-text').textContent, 'Playlist download started.');
  assert.equal(storage.get('gameshelf:cart'), '["alpha"]');
});

test('saving library paths returns to settings and confirms in the banner', async () => {
  const ui = app();
  ui.start();
  await settle();
  ui.click('build-info');
  ui.click('open-server-settings');
  assert.equal(ui.element('server-settings-dialog').open, true);
  const pending = ui.click('server-settings-save');
  const request = ui.requests.find(item => item.url === '/api/server-settings');
  assert.ok(request);
  request.resolve(response({ restartRequired: true }));
  await pending;
  assert.equal(ui.element('server-settings-dialog').open, false);
  assert.equal(ui.element('settings-dialog').open, true);
  assert.equal(ui.element('server-settings-status').textContent, '');
  assert.equal(ui.element('settings-save-status').textContent, '');
  assert.match(ui.element('notification-text').textContent, /Restart the container/);
  assert.equal(ui.element('notification-banner').parentElement, ui.element('settings-dialog'));
});

test('pinned favorite stars default on independently, and All clears filtering', async () => {
  const storage = new Map();
  const ui = app(undefined, storage);
  ui.start();
  ui.requests[0].resolve(response(games));
  await settle();
  assert.equal(ui.element('show-favorite-stars'), undefined);
  assert.equal(ui.element('favorite-stars-only').checked, true);
  assert.notEqual(ui.element('favorite-stars-only').disabled, true);
  assert.equal(ui.document.body.classList.contains('gs-pin-favorite-stars'), true);
  ui.element('favorite-stars-only').checked = false;
  ui.element('favorite-stars-only').emit('change');
  assert.equal(ui.document.body.classList.contains('gs-pin-favorite-stars'), false);
  assert.equal(storage.get('gameshelf:favorite-stars-only'), 'false');
  ui.click('sort-button');
  ui.element('sort-menu').children.find(button => button.dataset.sort === 'favorites').emit('click');
  assert.equal(ui.hidden('sort-heading'), false);
  ui.click('sort-button');
  ui.element('sort-menu').children.find(button => button.dataset.sort === 'all').emit('click');
  assert.equal(ui.hidden('sort-heading'), true);
  ui.element('search-input').value = 'alpha';
  ui.element('search-input').emit('input');
  ui.click('view-toggle');
  ui.click('gs-home-trigger');
  assert.equal(ui.element('games-container').classList.contains('list-view'), false);
  assert.equal(ui.element('search-input').value, '');
  assert.equal(ui.hidden('sort-heading'), true);
});

test('empty Favorites view explains the filter and refresh text responds to hover', async () => {
  const ui = app();
  ui.start();
  ui.requests[0].resolve(response(games));
  await settle();
  ui.click('sort-button');
  ui.element('sort-menu').children.find(button => button.dataset.sort === 'favorites').emit('click');
  assert.equal(ui.element('empty-title').textContent, 'No favorites yet');
  assert.equal(ui.hidden('filter-hint'), false);
  assert.equal(ui.hidden('search-hint'), true);
  ui.search('absent');
  assert.equal(ui.element('empty-title').textContent, 'No matching games!');
  assert.equal(ui.hidden('search-hint'), false);
  ui.element('gs-refresh-trigger').emit('pointerenter');
  assert.equal(ui.element('gs-logo-text').textContent, 'REFRESH');
  ui.element('gs-refresh-trigger').emit('pointerleave');
  assert.equal(ui.element('gs-logo-text').textContent, 'GAMESHELF');
});

test('metadata reset reviews selected fields and refreshes the card after saving', async () => {
  const ui = app();
  ui.start();
  ui.requests[0].resolve(response([{ ...games[1], name: 'Custom Alpha', fileCount: 1, favorite: true, hasCover: true }]));
  await settle();
  const card = ui.cards()[0];
  card.children[0].children[1].children[2].emit('click');
  const label = ui.document.createElement('label');
  const input = ui.document.createElement('input');
  input.value = 'title';
  label.appendChild(input);
  ui.element('reset-metadata-options').appendChild(label);
  ui.click('reset-game-metadata');
  input.checked = true;
  ui.click('reset-metadata-next');
  assert.equal(ui.element('reset-confirm-dialog').open, true);
  assert.match(ui.element('reset-confirm-question').textContent, /Custom Alpha.*title/i);
  const pending = ui.click('reset-confirm-save');
  const request = ui.requests.find(item => item.url === '/api/metadata-reset/alpha');
  assert.ok(request);
  request.resolve(response({ name: 'Alpha', favorite: true, hasCover: true }));
  await pending;
  assert.equal(ui.element('reset-confirm-dialog').open, false);
  assert.equal(ui.element('game-details-title').textContent, 'Alpha');
  assert.equal(ui.cards()[0].dataset.name, 'alpha');
  assert.equal(ui.element('notification-banner').hidden, false);
  assert.equal(ui.element('notification-text').textContent, 'Metadata reset successfully.');
});

test('theme and recent range persist, including migration of the old 3650-day setting', () => {
  const storage = new Map([['gameshelf:recent-days', '3650']]);
  const ui = app(undefined, storage);
  ui.start();
  assert.equal(ui.element('recent-days').value, '7');
  assert.equal(storage.get('gameshelf:recent-days'), '7');
  assert.equal(ui.element('theme-select').value, 'classic');
  assert.equal(ui.document.body.dataset.theme, 'classic');
  ui.element('theme-select').value = 'dark';
  ui.element('theme-select').emit('change');
  assert.equal(storage.get('gameshelf:theme'), 'dark');
  assert.equal(ui.document.body.dataset.theme, 'dark');
  ui.click('open-recent-settings');
  ui.element('recent-days').value = '3650';
  ui.click('recent-settings-save');
  const next = app(undefined, storage);
  next.start();
  assert.equal(next.element('recent-days').value, '3650');
  assert.equal(next.element('theme-select').value, 'dark');
});

test('open dialogs lock page scrolling until the final menu closes', () => {
  const ui = app();
  ui.start();
  ui.click('build-info');
  assert.equal(ui.document.body.classList.contains('gs-modal-open'), true);
  ui.click('export-library-data');
  ui.click('export-close');
  assert.equal(ui.document.body.classList.contains('gs-modal-open'), true);
  ui.click('settings-close');
  assert.equal(ui.document.body.classList.contains('gs-modal-open'), false);
});

test('export groups GameShelf data separately from cover images', async () => {
  const ui = app();
  ui.start();
  ui.requests[0].resolve(response([{ ...games[0], hasCover: true }]));
  await settle();
  ui.click('export-library-data');
  const groups = ui.element('export-options').children;
  assert.equal(groups.length, 2);
  assert.equal(groups[0].children[0].textContent, 'GameShelf data');
  assert.equal(groups[1].children[0].textContent, 'Cover image archive');
  assert.equal(groups[0].querySelectorAll('input').length, 4);
  assert.equal(groups[1].querySelectorAll('input').length, 1);
});

test('restore previews a backup and requires acknowledgment before applying', async () => {
  const ui = app();
  ui.start();
  ui.click('build-info');
  ui.click('open-library-restore');
  assert.equal(ui.element('restore-dialog').open, true);
  ui.element('restore-file').files = [{ size: 100 }];
  const previewing = ui.element('restore-file').emit('change');
  const previewRequest = ui.requests.find(item => item.url === '/api/library-restore');
  assert.ok(previewRequest);
  previewRequest.resolve(response({ sha256: 'abc', state: true, settings: false, covers: 2, folderCoversSkipped: 1, logsSkipped: true }));
  await previewing;
  assert.equal(ui.element('restore-preview').hidden, false);
  assert.equal(ui.element('restore-state').checked, true);
  assert.equal(ui.element('restore-settings').disabled, true);
  assert.equal(ui.element('restore-apply').disabled, true);
  ui.element('restore-ack').checked = true;
  ui.element('restore-ack').emit('change');
  assert.equal(ui.element('restore-apply').disabled, false);
  const applying = ui.click('restore-apply');
  const applyRequest = ui.requests.find(item => item.url === '/api/library-restore?apply=1&state=1&covers=1');
  assert.ok(applyRequest);
  applyRequest.resolve(response({ restored: true, restartRequired: false }));
  await applying;
  assert.equal(ui.element('restore-dialog').open, false);
  assert.equal(ui.element('settings-dialog').open, true);
  assert.equal(ui.element('notification-text').textContent, 'Library data restored.');
});

test('refresh feedback returns to the brand when the pointer has left', async () => {
  const ui = app();
  ui.start();
  ui.requests[0].resolve(response(games));
  await settle();
  ui.element('gs-refresh-trigger').emit('pointerenter');
  ui.click('gs-refresh-trigger');
  ui.element('gs-refresh-trigger').emit('pointerleave');
  ui.requests[1].resolve(response(games));
  await settle();
  assert.equal(ui.element('gs-logo-text').textContent, 'REFRESHED');
  assert.equal(ui.element('library-stage').classList.contains('gs-home-enter'), false);
  ui.tick(1000);
  assert.equal(ui.element('gs-logo-text').textContent, 'GAMESHELF');
});



test('backup export waits for the complete response, prevents duplicate requests and releases its URL', async () => {
  const ui = app();
  ui.start();
  ui.click('export-library-data');
  const pending = ui.click('export-confirm');
  assert.equal(ui.element('export-confirm').disabled, true);
  assert.match(ui.element('export-status').textContent, /Preparing/);
  ui.click('export-confirm');
  assert.equal(ui.requests.filter(request => request.url === '/api/library-backup?select=1&state=1&settings=1&logs=1&health=1').length, 1);
  let finish;
  ui.requests.find(request => request.url === '/api/library-backup?select=1&state=1&settings=1&logs=1&health=1').resolve({
    ok: true,
    headers: { get: name => name === 'Content-Type' ? 'application/zip' : '123' },
    blob: () => new Promise(resolve => { finish = resolve; })
  });
  await settle();
  assert.equal(ui.downloads.length, 0);
  const blob = { size: 123 };
  finish(blob);
  await pending;
  assert.deepEqual(ui.downloads, [blob]);
  assert.equal(ui.element('export-confirm').disabled, false);
  assert.equal(ui.element('export-status').textContent, '');
  assert.equal(ui.element('notification-text').textContent, 'Library backup download started.');
  const link = ui.document.body.children.find(child => child.download === 'gameshelf-library-backup.zip');
  assert.equal(link.download, 'gameshelf-library-backup.zip');
  assert.equal(link.clicked, true);
  assert.equal(link.removed, true);
  ui.tick(60000);
  assert.deepEqual(ui.revoked, ['blob:backup']);
});

for (const failure of ['http', 'network', 'body', 'truncated', 'wrong-type']) {
  test(`backup ${failure} failure shows a retryable error without downloading`, async () => {
    const ui = app();
    ui.start();
    ui.click('export-library-data');
    const pending = ui.click('export-confirm');
    const request = ui.requests.find(request => request.url === '/api/library-backup?select=1&state=1&settings=1&logs=1&health=1');
    if (failure === 'network') request.reject(new Error('offline'));
    else request.resolve({
      ok: failure !== 'http', status: 503,
      headers: { get: name => name === 'Content-Type' ? (failure === 'wrong-type' ? 'text/plain' : 'application/zip') : '123' },
      blob: async () => { if (failure === 'body') throw new Error('interrupted'); return { size: 12 }; }
    });
    await pending;
    assert.equal(ui.downloads.length, 0);
    assert.equal(ui.element('export-confirm').disabled, false);
    assert.match(ui.element('export-status').textContent, /backup failed.*No backup was downloaded.*try again/i);
    ui.click('export-confirm');
    assert.equal(ui.requests.filter(request => request.url === '/api/library-backup?select=1&state=1&settings=1&logs=1&health=1').length, 2);
  });
}


async function coverEditor() {
  const ui = app();
  ui.start();
  ui.requests[0].resolve(response(games.map(game => ({ ...game, hasCover: true }))));
  await settle();
  const canvas = ui.element('cover-editor-canvas');
  canvas.getContext = () => ({ fillRect() {}, save() {}, translate() {}, rotate() {}, scale() {}, drawImage() {}, restore() {} });
  canvas.toBlob = callback => callback({ size: 123 });
  ui.openCover = id => {
    ui.cards().find(card => card.dataset.id === id).children[0].children[1].children[2].emit('click');
    ui.click('edit-game-cover');
    ui.images.at(-1).onload();
  };
  ui.openCover('alpha');
  return ui;
}

for (const next of ['cancel', 'same game', 'another game']) {
  test(`cover save delay cannot dismiss a new session after ${next}`, async () => {
    const ui = await coverEditor();
    const pending = ui.click('cover-editor-save');
    await settle();
    ui.requests.find(request => request.url === '/api/covers/alpha').resolve(response({}));
    await pending;
    assert.equal(ui.element('cover-editor-dialog').open, true);
    assert.equal(ui.element('cover-editor-save').classList.contains('is-saved'), true);
    ui.click('cover-editor-cancel');
    assert.equal(ui.element('game-details-dialog').open, true);
    if (next !== 'cancel') {
      if (next === 'same game') {
        ui.click('edit-game-cover');
        ui.images.at(-1).onload();
      } else {
        ui.click('game-details-close');
        ui.openCover('beta');
      }
    }
    ui.tick(850);
    assert.equal(ui.element('cover-editor-dialog').open, next !== 'cancel');
    if (next === 'cancel') assert.equal(ui.element('game-details-dialog').open, true);
    else {
      assert.equal(ui.element('cover-editor-title').textContent, `${next === 'same game' ? 'Alpha' : 'Beta'}`);
      assert.equal(ui.element('cover-editor-save').disabled, false);
    }
  });
}

test('cover save keeps confirmation visible until its normal delayed close', async () => {
  const ui = await coverEditor();
  const pending = ui.click('cover-editor-save');
  await settle();
  ui.requests.find(request => request.url === '/api/covers/alpha').resolve(response({}));
  await pending;
  assert.equal(ui.element('cover-editor-dialog').open, true);
  assert.equal(ui.element('cover-editor-status').textContent, '');
  assert.equal(ui.element('cover-editor-save').classList.contains('is-saved'), true);
  ui.tick(850);
  assert.equal(ui.element('cover-editor-dialog').open, false);
  assert.equal(ui.element('game-details-dialog').open, true);
  assert.equal(ui.element('notification-text').textContent, 'Cover art saved.');
});

for (const status of [200, 500]) {
  test(`late cover upload response (${status}) cannot change a reopened editor`, async () => {
    const ui = await coverEditor();
    const pending = ui.click('cover-editor-save');
    await settle();
    const upload = ui.requests.find(request => request.url === '/api/covers/alpha');
    ui.click('cover-editor-cancel');
    ui.click('game-details-close');
    ui.openCover('beta');
    upload.resolve(response({}, status));
    await pending;
    assert.equal(ui.element('cover-editor-status').textContent, '');
    assert.equal(ui.element('cover-editor-save').classList.contains('is-saved'), false);
    assert.equal(ui.element('cover-editor-save').disabled, false);
    ui.tick(850);
    assert.equal(ui.element('cover-editor-dialog').open, true);
  });
}

test('list cover expansion supports single, double and disabled preferences', async () => {
  const storage = new Map();
  const ui = app(undefined, storage); ui.start(); ui.requests[0].resolve(response(games)); await settle();
  ui.click('view-toggle');
  const image = ui.cards()[0].querySelector('.gs-list-image');
  const dialog = ui.element('list-image-dialog');
  image.emit('click', {type:'click'}); assert.equal(dialog.open, true); dialog.close();
  const preference = ui.element('expand-list-image');
  preference.value = 'double'; preference.emit('change');
  image.emit('click', {type:'click'}); assert.equal(dialog.open, false);
  image.emit('dblclick', {type:'dblclick'}); assert.equal(dialog.open, true); dialog.close();
  preference.value = 'disabled'; preference.emit('change');
  image.emit('click', {type:'click'}); image.emit('dblclick', {type:'dblclick'}); assert.equal(dialog.open, false);
  assert.equal(storage.get('gameshelf:list-image-click'), 'disabled');
  preference.value = 'single'; preference.emit('change');
  ui.element('show-list-images').checked = false; ui.element('show-list-images').emit('change');
  image.emit('click', {type:'click'}); assert.equal(dialog.open, false);
});

test('menu dismissal animates and reopening cancels a pending close', () => {
  const ui = app(); ui.start(); const dialog = ui.element('settings-dialog');
  const motions = [];
  dialog.animate = (frames, options) => { motions.push(options.duration); return {cancel(){}}; };
  ui.click('build-info'); assert.equal(dialog.open, true); assert.ok(motions.includes(164));
  ui.click('settings-close'); assert.equal(dialog.open, true);
  ui.click('build-info'); ui.tick(145); assert.equal(dialog.open, true);
  let prevented = false; dialog.emit('cancel', {preventDefault(){prevented=true;}});
  assert.equal(prevented, true); assert.equal(dialog.open, true);
  ui.tick(145); assert.equal(dialog.open, false);
  assert.equal(ui.document.body.classList.contains('gs-modal-open'), false);
});

for (const theme of ['neon','cartridge','cosmos','ion','rose','midnight','lattice','rain','storm','autumn']) test(`theme ${theme} is saved and restored with confirmation`, async () => {
  const storage = new Map(); const ui=app(undefined,storage);ui.start();
  ui.element('theme-select').value=theme;ui.element('theme-select').emit('change');await settle();
  assert.equal(storage.get('gameshelf:theme'),theme);
  assert.equal(ui.document.body.dataset.theme,theme);
  assert.equal(ui.element('notification-text').textContent,'Theme saved.');
  const revisit=app(undefined,storage);revisit.start();assert.equal(revisit.element('theme-select').value,theme);
});

test('each instant preference confirms its saved change', async () => {
  const ui=app();ui.start();
  for(const id of ['animation-speed','list-opacity','card-depth','animate-tiles','show-hover-text','show-game-titles','show-placeholder-images','favorites-first','show-list-images','enable-playlist','favorite-stars-only','expand-list-image']){
    const field=ui.element(id);if(id==='expand-list-image')field.value='double';else if(id==='animation-speed')field.value='2';else if(id==='list-opacity')field.value='60';else field.checked=!field.checked;
    field.emit('change');await settle();assert.match(ui.element('notification-text').textContent,/saved\.$/,id);
  }
});

test('new controls migrate old motion preferences and persist opacity endpoints and depth', () => {
  for(const [storage,expected] of [[new Map([['gameshelf:disable-effects','true']]),'0'],[new Map([['gameshelf:slow-animations','true']]),'0.5'],[new Map([['gameshelf:slow-animations','true'],['gameshelf:animation-speed','3']]),'3']]){
    const ui=app(undefined,storage);ui.start();assert.equal(ui.element('animation-speed').value,expected);
  }
  const storage=new Map(),ui=app(undefined,storage);ui.start();
  assert.equal(ui.element('list-opacity').value,'80');assert.equal(ui.element('card-depth').checked,true);
  ui.element('list-opacity').value='0';ui.element('list-opacity').emit('input');assert.equal(storage.get('gameshelf:list-opacity'),'0');
  ui.element('card-depth').checked=false;ui.element('card-depth').emit('change');
  const revisit=app(undefined,storage);revisit.start();assert.equal(revisit.element('list-opacity').value,'0');assert.equal(revisit.element('card-depth').checked,false);
  ui.element('list-opacity').value='100';ui.element('list-opacity').emit('input');assert.equal(storage.get('gameshelf:list-opacity'),'100');
});

test('hover titles default on and static titles temporarily disable their setting', () => {
  const storage=new Map();const ui=app(undefined,storage);ui.start();
  assert.equal(ui.element('hover-game-titles').checked,true);assert.equal(ui.element('hover-game-titles').disabled,false);
  assert.equal(ui.document.body.classList.contains('gs-hover-game-titles'),true);
  const staticTitles=ui.element('show-game-titles');staticTitles.checked=true;staticTitles.emit('change');
  assert.equal(ui.element('hover-game-titles').disabled,true);assert.equal(ui.document.body.classList.contains('gs-hover-game-titles'),false);
  staticTitles.checked=false;staticTitles.emit('change');assert.equal(ui.element('hover-game-titles').disabled,false);assert.equal(ui.document.body.classList.contains('gs-hover-game-titles'),true);
  ui.element('hover-game-titles').checked=false;ui.element('hover-game-titles').emit('change');
  const revisit=app(undefined,storage);revisit.start();assert.equal(revisit.element('hover-game-titles').checked,false);
});


test('sparkle stars twinkle independently, pause with motion off, and clean up on theme changes', () => {
  let frames=new Map(),next=0,arcs=[],random=1,rate=1;const listeners=new Set(),variables={};
  const host={isConnected:true,children:[],getBoundingClientRect:()=>({width:300,height:450}),appendChild(canvas){this.children.push(canvas);canvas.parent=this;}};
  const context={scale(){},clearRect(){arcs=[];},beginPath(){},arc(x,y,r){arcs.push([x,y,r,this.globalAlpha]);},fill(){},moveTo(){},lineTo(){},stroke(){}};
  const media={matches:false,addEventListener(type,listener){listeners.add(listener);},removeEventListener(type,listener){listeners.delete(listener);}};
  const math=Object.create(Math);math.random=()=>{random=(random*16807)%2147483647;return random/2147483647;};
  const window={addEventListener(){},removeEventListener(){}};
  const sandbox={window,document:{body:host,documentElement:{style:{setProperty(k,v){variables[k]=v;}}},createElement(){return {setAttribute(){},getContext:()=>context,remove(){this.parent.children=this.parent.children.filter(c=>c!==this);}};}},Math:math,devicePixelRatio:1,innerWidth:1280,innerHeight:800,matchMedia:()=>media,performance:{now:()=>0},requestAnimationFrame(fn){const id=++next;frames.set(id,fn);return id;},cancelAnimationFrame(id){frames.delete(id);}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../web/ambience.js'),'utf8'),sandbox);
  const api=window.GameShelfAmbience;const effect=api.startCover(host,'retro',()=>rate);const first=arcs.map(a=>a.slice());
  for(let time=40;time<=800;time+=40){const queued=[...frames.values()];frames.clear();queued.forEach(fn=>fn(time));}
  assert.ok(first.some((a,i)=>Math.abs(a[2]-arcs[i][2])>.01),'stars should change size without pointer motion');
  assert.ok(first.some((a,i)=>Math.abs(a[3]-arcs[i][3])>.05),'individual stars should change brightness');
  rate=0;const queued=[...frames.values()];frames.clear();queued.forEach(fn=>fn(840));assert.equal(frames.size,0);
  effect.stop();assert.equal(host.children.length,0);assert.equal(listeners.size,0);
  rate=1;api.setTheme('cosmos',()=>rate);const background=host.children[0],positions=arcs.map(a=>a[0]);const nebula=variables['--nebula-x'];api.setTheme('cosmos',()=>rate);
  assert.notEqual(host.children[0],background);assert.notDeepEqual(arcs.map(a=>a[0]),positions);assert.notEqual(variables['--nebula-x'],nebula);assert.equal(host.children.length,1);assert.equal(listeners.size,1);
  api.setTheme('classic',()=>rate);assert.equal(host.children.length,0);assert.equal(frames.size,0);assert.equal(listeners.size,0);
});

test('offline games label cached metadata and block download actions', async () => {
  const ui = app();
  ui.start();
  ui.requests[0].resolve(response([{ id:'offline', name:'Cached game', sizeBytes:42, fileCount:1, unavailable:true }]));
  await settle();
  const card = ui.cards()[0];
  assert.match(card.querySelector('.gs-offline-label').textContent, /Offline/);
  const download = card.querySelector('.gs-card-download');
  assert.equal(download.attributes['aria-disabled'], 'true');
  let prevented = false;
  download.emit('click', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.match(ui.element('notification-text').textContent, /offline/);
  card.querySelector('.gs-card-cart').emit('click');
  assert.notEqual(ui.element('cart-count').textContent, '1');
  card.querySelector('.gs-card-info').emit('click');
  assert.match(ui.element('game-details-download-summary').textContent, /Offline.*last known/);
  assert.equal(ui.element('game-details-download').attributes['aria-disabled'], 'true');
  ui.click('game-details-download-summary');
  ui.requests[1].resolve(response({ files:[{path:'game.bin',sizeBytes:42}], truncated:false, unavailable:true }));
  await settle();
  assert.match(ui.element('game-files-status').textContent, /last known file list/);
  const file = ui.element('game-files-list').children[0].children[2];
  assert.equal(file.attributes['aria-disabled'], 'true');
  file.emit('click');
  assert.match(ui.element('notification-text').textContent, /offline/);
});

test('manual refresh cooldown preserves the current catalog without a failed-refresh state',async()=>{
 const ui=app();ui.start();ui.requests[0].resolve(response(games));await settle();ui.search('alpha');const before=[...ui.cards()];ui.click('gs-refresh-trigger');ui.requests[1].resolve({ok:false,status:429,headers:{get:()=> '9'}});await settle();assert.deepEqual(ui.cards(),before);assert.equal(ui.hidden('error-state'),true);assert.notEqual(ui.element('gs-logo-text').textContent,'FAILED');assert.match(ui.element('notification-text').textContent,/wait 9 seconds/);
});
