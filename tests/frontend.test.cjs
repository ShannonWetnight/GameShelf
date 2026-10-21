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
  }
  set innerHTML(value) { this.children = []; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(event, callback) { this.listeners[event] = callback; }
  emit(event, payload = {}) {
    return this.listeners[event]?.({ target: this, currentTarget: this, stopPropagation() {}, preventDefault() {}, ...payload });
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
    elements.set(match[1], new Element(match[0].match(/class="([^"]*)"/)?.[1]));
  }
  const document = new Element();
  document.body = new Element();
  document.getElementById = id => {
    assert.ok(elements.has(id), `Missing HTML element: ${id}`);
    return elements.get(id);
  };
  document.createElement = () => new Element();
  document.querySelectorAll = () => [];
  const requests = [];
  const timers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    document, matchMedia: () => ({ matches: reducedMotion }), localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value)
    },
    console: { error() {} }, AbortController,
    setTimeout(callback, delay) {
      timers.set(++timerId, { callback, delay });
      return timerId;
    },
    clearTimeout: id => timers.delete(id),
    fetch(url, options) {
      if (url === '/api/version') {
        return Promise.resolve(versionInfo ? response(versionInfo) : response({}, 503));
      }
      return new Promise((resolve, reject) => {
        requests.push({ url, resolve, reject });
        options.signal.addEventListener('abort', () => reject(new Error('Aborted')));
      });
    }
  });
  vm.runInContext(source, context);
  return {
    requests, document, storage, element: id => elements.get(id),
    hidden: id => elements.get(id).classList.contains('hidden'),
    cards: () => elements.get('games-container').children,
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
  const details = card.children[0].children[1].children[1];
  assert.equal(body.children[0].children[0].textContent, 'Alpha');
  assert.equal(body.children.length, 1);
  assert.equal(action.href, '/download/alpha');
  assert.equal(action.attributes['aria-label'], 'Download Alpha');
  action.focus();
  action.emit('click');
  assert.equal(action.focused, false);
  assert.equal(card.classList.contains('gs-hover-suppressed'), true);
  card.emit('pointerleave');
  assert.equal(card.classList.contains('gs-hover-suppressed'), false);
  details.emit('click');
  assert.equal(ui.element('game-details-dialog').open, true);
  assert.equal(ui.element('game-details-path').textContent, '/GameShelf/Alpha');
  assert.equal(ui.element('game-details-size').textContent, '1.0 KB');
  assert.equal(ui.element('game-details-files').textContent, '2');
  assert.equal(ui.element('game-details-cover').textContent, 'Available');
  assert.match(ui.element('game-details-added').textContent, /2026/);
  ui.click('game-details-close');
  assert.equal(ui.element('game-details-dialog').open, false);
  assert.equal(card.classList.contains('gs-hover-suppressed'), true);
  assert.notEqual(card.focused, true);
});

test('game information lists only the selected game files on request', async () => {
  const ui = app();
  ui.start();
  ui.requests[0].resolve(response(games));
  await settle();
  const alpha = ui.cards().find(card => card.dataset.id === 'alpha');
  alpha.children[0].children[1].children[1].emit('click');
  assert.equal(ui.requests.length, 1);
  ui.click('toggle-game-files');
  assert.equal(ui.requests[1].url, '/api/game-files/alpha');
  assert.equal(ui.element('toggle-game-files').attributes['aria-expanded'], 'true');
  ui.requests[1].resolve(response({ files: [
    { path: 'data/level.dat', sizeBytes: 2048 },
    { path: 'cover.png', sizeBytes: 1024 }
  ], truncated: false }));
  await settle();
  assert.deepEqual(ui.element('game-files-list').children.map(item => item.children[0].textContent),
    ['data/level.dat', 'cover.png']);
  assert.equal(ui.element('game-files-list').children[0].children[2].href,
    '/api/game-file/alpha?path=data%2Flevel.dat');
  ui.click('toggle-game-files');
  assert.equal(ui.hidden('game-files-panel'), true);
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
  settings.emit('click', { target: settings, clientX: 0, clientY: 0 });
  assert.equal(settings.open, false);
  const info = ui.cards()[0].children[0].children[1].children[1];
  info.emit('click');
  const details = ui.element('game-details-dialog');
  details.emit('click', { target: details, clientX: 0, clientY: 0 });
  assert.equal(details.open, false);
});

test('display preferences default to hints on and persist changes', () => {
  const storage = new Map();
  const ui = app(undefined, storage);
  ui.start();
  assert.equal(ui.element('show-hover-text').checked, true);
  assert.equal(ui.element('show-game-titles').checked, false);
  assert.equal(ui.element('show-placeholder-images').checked, false);
  for (const [id, key, bodyClass, checked] of [
    ['show-hover-text', 'gameshelf:show-hover-text', 'gs-hide-tooltips', false],
    ['show-game-titles', 'gameshelf:show-game-titles', 'gs-show-game-titles', true],
    ['show-placeholder-images', 'gameshelf:show-placeholder-images', 'gs-show-placeholders', true]
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
  assert.equal(ui.cards().filter(card => card.classList.contains('gs-shuffle-preview')).length, 1);
  ui.tick(156);
  ui.tick(375);
  assert.equal(selected().length, 1);
  assert.equal(ui.element('random-game').disabled, false);
  assert.equal(ui.element('games-container').classList.contains('gs-spotlight'), true);
  assert.equal(ui.element('library-stage').classList.contains('gs-spotlight-stage'), true);
  assert.equal(ui.hidden('spotlight-actions'), false);
  assert.equal(ui.cards().filter(card => card.style.display !== 'none').length, 1);
  const firstId = selected()[0].dataset.id;
  assert.equal(selected()[0].focused, undefined);
  assert.equal(ui.element('spotlight-download').href, `/download/${firstId}`);
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
  ui.tick(156);
  ui.tick(375);
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
  ui.tick(156);
  ui.tick(375);
  assert.equal(ui.element('games-container').classList.contains('list-view'), true);
  assert.equal(ui.cards().filter(card => card.style.display !== 'none').length, 2);
  assert.equal(ui.hidden('spotlight-actions'), true);
  assert.equal(ui.element('random-game').focused, true);

  ui.click('random-game');
  ui.document.emit('keydown', { key: 'Escape' });
  ui.tick(156);
  ui.tick(375);
  assert.equal(ui.element('games-container').classList.contains('list-view'), true);
  assert.equal(ui.cards().filter(card => card.style.display !== 'none').length, 2);
});

test('sort and view controls leave dice spotlight before acting', async () => {
  const ui = app();
  ui.start();
  ui.requests[0].resolve(response(games));
  await settle();
  ui.click('random-game');
  ui.tick(156);
  ui.tick(375);
  assert.equal(ui.element('games-container').classList.contains('gs-spotlight'), true);
  ui.click('sort-button');
  assert.equal(ui.element('games-container').classList.contains('gs-spotlight'), false);
  assert.equal(ui.hidden('sort-menu'), false);
  assert.equal(ui.cards().filter(card => card.style.display !== 'none').length, 2);
  ui.click('random-game');
  ui.tick(156);
  ui.tick(375);
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
  ui.tick(156);
  ui.tick(375);
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
  assert.equal(reduced.cards().filter(card => card.classList.contains('gs-shuffle-preview')).length, 0);
  assert.equal(reduced.element('random-game').disabled, false);
});

test('settings dialog defaults off and slows dice and card shuffle together', async () => {
  const storage = new Map();
  const ui = app(undefined, storage);
  ui.start();
  assert.equal(ui.element('slow-animations').checked, false);
  assert.equal(ui.element('random-game').classList.contains('gs-slow-animations'), false);
  ui.click('build-info');
  assert.equal(ui.element('settings-dialog').open, true);
  assert.equal(ui.element('slow-animations').focused, true);
  ui.element('slow-animations').checked = true;
  ui.element('slow-animations').emit('change');
  assert.equal(storage.get('gameshelf:slow-animations'), 'true');
  assert.equal(ui.element('random-game').classList.contains('gs-slow-animations'), true);
  assert.equal(ui.element('games-container').classList.contains('gs-slow-animations'), true);
  ui.click('settings-close');
  assert.equal(ui.element('settings-dialog').open, false);
  assert.equal(ui.element('build-info').focused, true);
  ui.requests[0].resolve(response(games));
  await settle();
  ui.click('random-game');
  assert.ok(ui.timerDelays().includes(250));
  assert.ok(ui.timerDelays().includes(600));
  ui.tick(156);
  assert.equal(ui.cards().filter(card => card.classList.contains('gs-random-selected')).length, 0);
  ui.tick(250);
  ui.tick(600);
  assert.equal(ui.cards().filter(card => card.classList.contains('gs-random-selected')).length, 1);

  const nextVisit = app(undefined, storage);
  nextVisit.start();
  assert.equal(nextVisit.element('slow-animations').checked, true);
  assert.equal(nextVisit.element('random-game').classList.contains('gs-slow-animations'), true);
  assert.equal(nextVisit.element('games-container').classList.contains('gs-slow-animations'), true);
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
