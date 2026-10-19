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
      add: token => tokens.add(token),
      remove: token => tokens.delete(token),
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
  addEventListener(event, callback) { this.listeners[event] = callback; }
  emit(event, payload = {}) {
    return this.listeners[event]?.({ target: this, ...payload });
  }
  blur() {}
  focus() { this.focused = true; }
}

function app(versionInfo = { version: 'edge-20261019-16.1-abc123def456', channel: 'edge' }) {
  const elements = new Map();
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    elements.set(match[1], new Element(match[0].match(/class="([^"]*)"/)?.[1]));
  }
  const document = new Element();
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
    document, localStorage: { getItem: () => null, setItem() {} },
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
    requests, document, element: id => elements.get(id),
    hidden: id => elements.get(id).classList.contains('hidden'),
    cards: () => elements.get('games-container').children,
    start: () => document.emit('DOMContentLoaded'),
    click: id => elements.get(id).emit('click'),
    search(value) {
      elements.get('search-input').value = value;
      elements.get('search-input').emit('input');
    },
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
    assert.equal(ui.element('version-label').textContent, expected);
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

test('download link stays inside the card body and names its game', async () => {
  const ui = app();
  ui.start();
  ui.requests[0].resolve(response(games));
  await settle();

  const card = ui.cards().find(item => item.dataset.id === 'alpha');
  const body = card.children[1];
  const action = body.children[2].children[0];
  assert.equal(body.children[0].children[0].textContent, 'Alpha');
  assert.equal(body.children[1].textContent, '1.0 KB');
  assert.equal(action.href, '/download/alpha');
  assert.equal(action.attributes['aria-label'], 'Download Alpha');
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
