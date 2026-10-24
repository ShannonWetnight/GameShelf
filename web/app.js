/* =============================
   Global State
   ============================= */
let gamesCache = [];
const coverVersions = new Map();
let refreshGeneration = 0;
let isLoading = false;
let hasLoadedGames = false;
let loadError = false;
let retryRefresh = false;

let currentSort = 'all';
const storedRecentDays = Number(localStorage.getItem('gameshelf:recent-days'));
const legacyRecentRange = storedRecentDays === 3650 && !localStorage.getItem('gameshelf:recent-days-v2');
let recentDays = !legacyRecentRange && Number.isInteger(storedRecentDays) && storedRecentDays >= 1 && storedRecentDays <= 3650 ? storedRecentDays : 7;
if (legacyRecentRange) localStorage.setItem('gameshelf:recent-days', '7');
localStorage.setItem('gameshelf:recent-days-v2', 'true');
let themePreference = localStorage.getItem('gameshelf:theme') || 'system';
let showFavoriteStars = localStorage.getItem('gameshelf:favorite-stars') === 'true';
let favoriteStarsOnly = localStorage.getItem('gameshelf:favorite-stars-only') !== 'false';
const storedImageClick = localStorage.getItem('gameshelf:list-image-click');
let listImageClick = ['single', 'double', 'disabled'].includes(storedImageClick) ? storedImageClick : localStorage.getItem('gameshelf:expand-list-image') === 'false' ? 'disabled' : 'single';
let favoritesFirst = localStorage.getItem('gameshelf:favorites-first') !== 'false';
let favoritePending = null;
let serverSettings = null;
let currentSearch = '';
let suggestedGameId = null;
let shuffleGameId = null;
let isShuffling = false;
let shuffleTimers = [];
let slowAnimations = localStorage.getItem('gameshelf:slow-animations') === 'true';
let disableEffects = localStorage.getItem('gameshelf:disable-effects') === 'true';
let animateTiles = localStorage.getItem('gameshelf:animate-tiles') !== 'false';
let settingsLevel = localStorage.getItem('gameshelf:settings-level') === 'advanced' ? 'advanced' : 'basic';
let playlistEnabled = localStorage.getItem('gameshelf:playlist-enabled') !== 'false';
const cartGameIds = new Set();
try { for (const id of JSON.parse(localStorage.getItem('gameshelf:cart') || '[]')) if (typeof id === 'string') cartGameIds.add(id); } catch { /* ignore stale cart */ }
let showHoverText = localStorage.getItem('gameshelf:show-hover-text') !== 'false';
let showGameTitles = localStorage.getItem('gameshelf:show-game-titles') === 'true';
let showPlaceholderImages = localStorage.getItem('gameshelf:show-placeholder-images') !== 'false';
let showListImages = localStorage.getItem('gameshelf:show-list-images') !== 'false';
let currentView = localStorage.getItem('gameshelf:view') || 'grid';
let detailsGameId = null;
let fileListController = null;
let openingCoverEditor = false;
let editorGame = null;
let editorImage = null;
let editorInitialImage = null;
let editorRotation = 0;
let editorPan = { x: 0, y: 0 };
let editorLoadVersion = 0;
let editorOpenVersion = 0;
let editorReturnGame = null;
let editorGridTimer;

const cardMap = new Map(); // game.id -> card element
const openDialogs = new Set();
const observedDialogs = new WeakSet();
const saveFeedbackTimers = new WeakMap();
let notificationTimer;
let notificationHideTimer;

function openModal(dialog) {
  if (!observedDialogs.has(dialog)) {
    dialog.addEventListener('close', () => {
      openDialogs.delete(dialog);
      if (openDialogs.size === 0) {
        document.body.classList.remove('gs-modal-open');
        document.documentElement?.classList.remove('gs-modal-open');
      }
    });
    const nativeClose = dialog.close.bind(dialog);
    let motion;
    let closing = false;
    let closeTimer;
    dialog.close = (value) => {
      if (!dialog.open || closing) return;
      motion?.cancel();
      dialog._openingMotion?.cancel();
      if (disableEffects || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches || !dialog.animate) { nativeClose(value); return; }
      closing = true;
      dialog.dataset.closing = "true";
      motion = dialog.animate([{ opacity: 1, transform: 'translateY(0) scale(1)' }, { opacity: 0, transform: 'translateY(10px) scale(.97)' }], { duration: 160, easing: 'ease-in', fill: 'forwards' });
      closeTimer = setTimeout(() => { nativeClose(value); motion.cancel(); closing = false; delete dialog.dataset.closing; }, 160);
    };
    dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close(); });
    dialog._cancelMotion = () => { clearTimeout(closeTimer); motion?.cancel(); dialog._openingMotion?.cancel(); closing = false; delete dialog.dataset.closing; };
    observedDialogs.add(dialog);
  }
  dialog._cancelMotion?.();
  dialog.showModal();
  if (!disableEffects && !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) dialog._openingMotion = dialog.animate?.(
    [{ opacity: 0, transform: 'translateY(10px) scale(.97)' }, { opacity: 1, transform: 'translateY(0) scale(1)' }],
    { duration: 180, easing: 'cubic-bezier(.2,.7,.2,1)' });
  openDialogs.add(dialog);
  document.body.classList.add('gs-modal-open');
  document.documentElement?.classList.add('gs-modal-open');
}

function showNotification(message) {
  const banner = document.getElementById('notification-banner');
  const visibleDialog = [...openDialogs].filter(dialog => dialog.open && !dialog.dataset.closing).at(-1);
  (visibleDialog || document.body).appendChild(banner);
  document.getElementById('notification-text').textContent = message;
  clearTimeout(notificationTimer);
  clearTimeout(notificationHideTimer);
  banner.hidden = false;
  if (banner.showPopover && !banner.matches(':popover-open')) banner.showPopover();
  banner.classList.remove('gs-notification-visible', 'gs-notification-leaving');
  void banner.offsetWidth;
  banner.classList.add('gs-notification-visible');
  notificationTimer = setTimeout(() => {
    banner.classList.remove('gs-notification-visible');
    banner.classList.add('gs-notification-leaving');
    notificationHideTimer = setTimeout(() => {
      if (banner.hidePopover && banner.matches(':popover-open')) banner.hidePopover();
      banner.hidden = true;
      banner.classList.remove('gs-notification-leaving');
      document.body.appendChild(banner);
    }, 250);
  }, 3500);
}

function showSaveFeedback(button) {
  clearTimeout(saveFeedbackTimers.get(button));
  button.classList.add('is-saved');
  saveFeedbackTimers.set(button, setTimeout(() => button.classList.remove('is-saved'), 1100));
}

function showDownloadStarted() {
  showNotification('Download started.');
}

/* =============================
   Data Fetching
   ============================= */
async function loadVersion() {
  const label = document.getElementById('settings-version');
  try {
    const res = await fetch('/api/version');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = await res.json();
    if (!info || typeof info.version !== 'string' || typeof info.channel !== 'string') {
      throw new Error('Invalid version response');
    }
    label.textContent = info.channel === 'edge' ? `Edge: ${info.version}` : info.version;
  } catch {
    label.textContent = 'Version unavailable';
  }
}

async function loadServerSettings() {
  try {
    const response = await fetch('/api/server-settings', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    serverSettings = await response.json();
  } catch {
    document.getElementById('settings-save-status').textContent = 'Could not load server settings.';
  }
}

async function saveServerSettings(settings) {
  const response = await fetch('/api/server-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
  if (!response.ok) throw new Error((await response.text()).trim() || `HTTP ${response.status}`);
  const result = await response.json();
  serverSettings = settings;
  return result;
}

async function exportLibraryData() {
  const button = document.getElementById('export-confirm');
  const status = document.getElementById('library-backup-status');
  const dialog = document.getElementById('export-dialog');
  if (button.disabled) return;
  const checked = [...document.querySelectorAll('#export-options input:checked')];
  if (!checked.length) { document.getElementById('export-status').textContent = 'Select at least one item.'; return; }
  const params = new URLSearchParams({ select: '1' });
  for (const input of checked) {
    if (input.dataset.kind === 'state') params.set('state', '1');
    else if (input.dataset.kind === 'logs') params.set('logs', '1');
    else if (input.dataset.kind === 'settings') params.set('settings', '1');
    else params.append('cover', input.value);
  }
  button.disabled = true;
  status.textContent = 'Preparing library backup…';
  let downloadURL;
  try {
    const res = await fetch(`/api/library-backup?${params}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (res.headers.get('Content-Type') !== 'application/zip') throw new Error('Invalid backup response');
    const backup = await res.blob();
    const expectedSize = Number(res.headers.get('Content-Length'));
    if (!backup.size || !Number.isSafeInteger(expectedSize) || expectedSize !== backup.size) {
      throw new Error('Incomplete backup response');
    }
    downloadURL = URL.createObjectURL(backup);
    const link = document.createElement('a');
    link.href = downloadURL;
    link.download = 'gameshelf-library-backup.zip';
    document.body.appendChild(link);
    link.click();
    link.remove();
    status.textContent = '';
    dialog.close();
    showNotification('Library backup download started.');
  } catch (err) {
    console.error('Library backup failed', err);
    status.textContent = 'Library backup failed. No backup was downloaded. Check the container logs and try again.';
  } finally {
    // Give the browser time to start consuming the object URL before releasing it.
    if (downloadURL) setTimeout(() => URL.revokeObjectURL(downloadURL), 60000);
    button.disabled = false;
  }
}

function openFavoriteConfirm(game) {
  if (!game.favorite) { favoritePending = game; void saveFavorite(); return; }
  favoritePending = game;
  document.getElementById('favorite-question').textContent = 'Remove this game from favorites?';
  document.getElementById('favorite-confirm').textContent = 'Remove';
  document.getElementById('favorite-status').textContent = '';
  openModal(document.getElementById('favorite-dialog'));
}

async function saveFavorite() {
  const game = favoritePending;
  if (!game) return;
  const button = document.getElementById('favorite-confirm');
  button.disabled = true;
  try {
    const response = await fetch(`/api/favorite/${encodeURIComponent(game.id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ favorite: !game.favorite }) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    game.favorite = !game.favorite;
    const card = cardMap.get(game.id);
    card.dataset.favorite = String(game.favorite);
    const star = card.querySelector('.gs-favorite-star');
    if (star) {
      star.textContent = game.favorite ? '★' : '☆';
      star.setAttribute('aria-label', game.favorite ? `Remove ${game.name} from favorites` : `Add ${game.name} to favorites`);
      star.title = game.favorite ? 'Remove from favorites' : 'Add to favorites';
      star.blur();
    }
    document.getElementById('game-details-favorite').textContent = game.favorite ? '★' : '☆';
    document.getElementById('game-details-favorite-mobile').textContent = game.favorite ? '★' : '☆';
    document.getElementById('game-details-favorite').classList.toggle('is-favorite', game.favorite);
    document.getElementById('game-details-favorite-mobile').classList.toggle('is-favorite', game.favorite);
    applySort();
    applySearchFilter();
    if (document.getElementById('favorite-dialog').open) document.getElementById('favorite-dialog').close();
    showNotification(game.favorite ? 'Added to favorites.' : 'Removed from favorites.');
  } catch { if (document.getElementById('favorite-dialog').open) document.getElementById('favorite-status').textContent = 'Could not save favorite. Try again.'; else showNotification('Could not save favorite. Try again.'); }
  finally { button.disabled = false; }
}

async function fetchGames(isRefresh = false) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const url = isRefresh ? '/api/games?forceRefresh=1' : '/api/games';
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const games = await res.json();
    if (!Array.isArray(games) || games.some(game =>
      !game || typeof game.id !== 'string' || typeof game.name !== 'string' ||
      !Number.isFinite(game.sizeBytes) || game.sizeBytes < 0
    )) {
      throw new Error('Invalid games response');
    }
    return games;
  } finally {
    clearTimeout(timeout);
  }
}

/* =============================
   Helpers
   ============================= */
function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(1)} ${units[i]}`;
}

function formatAddedDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}

function syncCart() {
  const available = new Set(gamesCache.map(game => game.id));
  for (const id of cartGameIds) if (!available.has(id)) cartGameIds.delete(id);
  localStorage.setItem('gameshelf:cart', JSON.stringify([...cartGameIds]));
  const count = document.getElementById('cart-count');
  count.textContent = String(cartGameIds.size);
  count.hidden = cartGameIds.size === 0;
  document.body.classList.toggle('gs-playlist-disabled', !playlistEnabled);
  for (const card of cardMap.values()) {
    const added = cartGameIds.has(card.dataset.id);
    card.querySelector('.gs-card-cart')?.classList.toggle('is-added', added);
    const button = card.querySelector('.gs-card-cart');
    if (button) {
      button.setAttribute('aria-label', added ? 'Remove from Playlist' : 'Add to Playlist');
      button.dataset.tooltip = added ? 'Remove from Playlist' : 'Add to Playlist';
      button.title = button.dataset.tooltip;
    }
  }
  const detailButton = document.getElementById('game-details-cart');
  detailButton.classList.toggle('is-added', cartGameIds.has(detailsGameId));
  detailButton.setAttribute('aria-label', cartGameIds.has(detailsGameId) ? 'Remove from Playlist' : 'Add to Playlist');
  detailButton.dataset.tooltip = cartGameIds.has(detailsGameId) ? 'Remove from Playlist' : 'Add to Playlist';
  const spotlightButton = document.getElementById('spotlight-cart');
  spotlightButton.classList.toggle('is-added', cartGameIds.has(suggestedGameId));
  spotlightButton.dataset.tooltip = cartGameIds.has(suggestedGameId) ? 'Remove from Playlist' : 'Add to Playlist';
  renderCart();
}

let playlistPending = null;
function confirmPlaylistChange(action, id = null) {
  const game = id ? gamesCache.find(item => item.id === id) : null;
  playlistPending = { action, id };
  document.getElementById('playlist-confirm-title').textContent = action === 'clear' ? 'Clear Playlist?' : 'Remove from Playlist?';
  document.getElementById('playlist-confirm-question').textContent = action === 'clear'
    ? 'Remove all games from your download Playlist?'
    : `Remove ${game?.name || 'this game'} from your download Playlist?`;
  document.getElementById('playlist-confirm-accept').textContent = action === 'clear' ? 'Clear Playlist' : 'Remove';
  openModal(document.getElementById('playlist-confirm-dialog'));
}

function toggleCart(id) {
  if (!playlistEnabled) return;
  if (cartGameIds.has(id)) { confirmPlaylistChange('remove', id); return; }
  if (cartGameIds.size >= 50) { showNotification('The Playlist can hold up to 50 games.'); return; }
  cartGameIds.add(id);
  syncCart();
  showNotification('Added to Playlist.');
}

function renderCart() {
  const list = document.getElementById('cart-items');
  list.replaceChildren();
  const selected = gamesCache.filter(game => cartGameIds.has(game.id));
  for (const game of selected) {
    const row = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${game.name} · ${formatSize(game.sizeBytes)}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove ${game.name} from Playlist`);
    remove.addEventListener('click', () => toggleCart(game.id));
    row.append(label, remove);
    list.appendChild(row);
  }
  document.getElementById('cart-total').textContent = selected.length
    ? `${selected.length} game${selected.length === 1 ? '' : 's'} · ${formatSize(selected.reduce((total, game) => total + game.sizeBytes, 0))} estimated before ZIP packaging`
    : 'Your download Playlist is empty.';
  document.getElementById('cart-checkout').disabled = selected.length === 0;
  document.getElementById('cart-clear').disabled = selected.length === 0;
}

function animateControl(button) {
  button.classList.remove('gs-control-feedback');
  void button.offsetWidth;
  button.classList.add('gs-control-feedback');
}

function transitionLibrary(update) {
  update();
  if (disableEffects || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const stage = document.getElementById('library-stage');
  stage.classList.remove('gs-home-enter');
  void stage.offsetWidth;
  stage.classList.add('gs-home-enter');
}

const sortIconPaths = {
  all: '<path d="M3 6h14v2H3V6zm0 5h10v2H3v-2zm0 5h6v2H3v-2zm16-9 4 4-4 4V7z"/>',
  az: '<path d="m2.5 10 4-8 4 8M4 7h5M2.5 14h8l-8 8h8M18 3v18m-4-4 4 4 4-4"/>',
  za: '<path d="M2.5 2h8l-8 8h8m-8 12 4-8 4 8M4 19h5M18 21V3m-4 4 4-4 4 4"/>',
  'size-desc': '<path d="M3 5h11M3 10h8M3 15h5M18 3v18m-4-4 4 4 4-4"/>',
  'size-asc': '<path d="M3 5h5M3 10h8M3 15h11M18 21V3m-4 4 4-4 4 4"/>',
  favorites: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z"/>',
  recent: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>'
};

function updateSortIcon(sort) {
  const button = document.getElementById('sort-button');
  const symbol = sortIconPaths[sort] || sortIconPaths.all;
  button.innerHTML = `<svg class="${sort === 'all' || sort === 'favorites' ? '' : 'gs-sort-symbol'}" viewBox="0 0 24 24" aria-hidden="true">${symbol}</svg>`;
  animateControl(button);
}

function fuzzyMatch(haystack, needle) {
  if (!needle) return true;

  haystack = haystack.toLowerCase();
  needle = needle.toLowerCase();

  let h = 0;
  let n = 0;

  while (h < haystack.length && n < needle.length) {
    if (haystack[h] === needle[n]) {
      n++;
    }
    h++;
  }

  return n === needle.length;
}

function applyViewMode() {
  const container = document.getElementById('games-container');
  const toggle = document.getElementById('view-toggle');

  if (!container || !toggle) return;

  const isList = currentView === 'list';
  const showList = isList && !suggestedGameId && !isShuffling;

  container.classList.toggle('list-view', showList);
  if (toggle.dataset.viewMode === currentView) return;
  toggle.dataset.viewMode = currentView;
  toggle.classList.remove('gs-control-active');
  toggle.setAttribute('aria-label', isList ? 'Switch to grid view' : 'Switch to list view');
  toggle.dataset.tooltip = isList ? 'Switch to grid view' : 'Switch to list view';
  toggle.innerHTML = isList ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16v2H4V6zm0 5h16v2H4v-2zm0 5h16v2H4v-2z"/></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h4v8H3zM10 3h4v8h-4zM17 3h4v8h-4zM3 13h4v8H3zM10 13h4v8h-4zM17 13h4v8h-4z"/></svg>';
  toggle.classList.remove('gs-view-morph');
  void toggle.offsetWidth;
  toggle.classList.add('gs-view-morph');
}

/* =============================
   Card Creation
   ============================= */
function createGameCard(game) {
  const card = document.createElement('article');
  card.className = 'gs-card';
  card.classList.toggle('gs-no-cover', game.hasCover === false);
  card.addEventListener('pointerleave', () => card.classList.remove('gs-hover-suppressed'));
  card.addEventListener('focusout', event => {
    if (!card.contains(event.relatedTarget)) card.classList.remove('gs-hover-suppressed');
  });
  card.dataset.id = game.id;
  card.dataset.name = game.name.toLowerCase();
  card.dataset.size = game.sizeBytes;
  card.dataset.favorite = String(Boolean(game.favorite));
  card.dataset.added = game.addedAt || '';

  const cover = document.createElement('div');
  cover.className = 'gs-card-cover';

  const img = document.createElement('img');
  const version = coverVersions.get(game.id);
  const suffix = version ? `?v=${version}` : '';
  img.src = `/covers/${encodeURIComponent(game.id)}${suffix}`;
  img.alt = `${game.name} cover`;

  cover.appendChild(img);
  const star = document.createElement('button');
  star.className = 'gs-favorite-star';
  star.type = 'button';
  star.textContent = game.favorite ? '★' : '☆';
  star.setAttribute('aria-label', game.favorite ? `Remove ${game.name} from favorites` : `Add ${game.name} to favorites`);
  star.title = game.favorite ? 'Remove from favorites' : 'Add to favorites';
  star.addEventListener('click', event => { event.stopPropagation(); openFavoriteConfirm(game); });

  if (game.hasCover === false) {
    const coverTitle = document.createElement('span');
    coverTitle.className = 'gs-cover-title';
    coverTitle.textContent = game.name;
    cover.appendChild(coverTitle);

    const placeholderTitle = document.createElement('span');
    placeholderTitle.className = 'gs-placeholder-title';
    const placeholderText = document.createElement('span');
    placeholderText.textContent = game.name;
    placeholderTitle.appendChild(placeholderText);
    cover.appendChild(placeholderTitle);
  }

  const actions = document.createElement('div');
  actions.className = 'gs-card-actions';

  const dl = document.createElement('a');
  dl.className = 'gs-icon-button gs-card-download';
  dl.href = `/download/${encodeURIComponent(game.id)}`;
  dl.setAttribute('aria-label', `Download ${game.name}`);
  dl.title = `Download ${game.name}`;
  dl.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3.5v11m0 0 4-4m-4 4-4-4M5 17.5v2h14v-2"/>
    </svg>
  `;
  dl.addEventListener('click', () => {
    showDownloadStarted();
    dl.blur();
    card.classList.add('gs-hover-suppressed');
  });

  const details = document.createElement('button');
  details.className = 'gs-card-info';
  details.type = 'button';
  details.setAttribute('aria-label', `Information about ${game.name}`);
  details.title = `Information about ${game.name}`;
  details.textContent = 'i';
  details.addEventListener('click', () => openGameDetails(game, details, card));
  const cart = document.createElement('button');
  cart.className = 'gs-card-cart';
  cart.type = 'button';
  cart.textContent = '+';
  cart.setAttribute('aria-label', `Add ${game.name} to Playlist`);
  cart.title = 'Add to Playlist';
  cart.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); animateControl(cart); toggleCart(game.id); cart.blur(); card.classList.add('gs-hover-suppressed'); });
  actions.appendChild(dl);
  actions.appendChild(cart);
  actions.appendChild(details);
  cover.appendChild(actions);
  cover.appendChild(star);

  const body = document.createElement('div');
  body.className = 'gs-card-body';

  const listImage = document.createElement('img');
  listImage.className = 'gs-list-image';
  listImage.src = game.hasCover === false ? '/placeholder.png' : img.src;
  const expandImage = event => {
    if (event.type !== (listImageClick === 'double' ? 'dblclick' : 'click')) return;
    if (listImageClick === 'disabled' || !showListImages || !document.getElementById('games-container').classList.contains('list-view')) return;
    event.preventDefault(); event.stopPropagation();
    const expanded = document.getElementById('list-image-expanded');
    expanded.src = listImage.src;
    expanded.alt = `${game.name} cover`;
    openModal(document.getElementById('list-image-dialog'));
  };
  listImage.addEventListener('click', expandImage);
  listImage.addEventListener('dblclick', expandImage);
  listImage.alt = '';
  listImage.loading = 'lazy';
  body.appendChild(listImage);

  const content = document.createElement('div');
  content.className = 'gs-card-content';

  const title = document.createElement('h3');
  title.className = 'gs-card-title';
  title.textContent = game.name;

  content.appendChild(title);
  body.appendChild(content);

  card.appendChild(cover);
  card.appendChild(body);

  return card;
}

function openGameDetails(game, trigger, card) {
  const dialog = document.getElementById('game-details-dialog');
  fileListController?.abort();
  fileListController = null;
  detailsGameId = game.id;
  document.getElementById('game-details-cart').classList.toggle('is-added', cartGameIds.has(game.id));
  document.getElementById('game-details-title').textContent = game.name;
  const detailArt = document.getElementById('game-details-art');
  detailArt.classList.toggle('gs-no-cover', game.hasCover === false);
  const imageVersion = coverVersions.get(game.id);
  document.getElementById('game-details-image').src = `/covers/${encodeURIComponent(game.id)}${imageVersion ? `?v=${imageVersion}` : ''}`;
  document.getElementById('game-details-image-title').textContent = game.name;
  document.getElementById('game-title-input').value = game.name;
  document.getElementById('game-details-path').textContent = game.path || '';
  document.getElementById('game-details-size').textContent = formatSize(game.sizeBytes);
  document.getElementById('game-details-download').href = `/download/${encodeURIComponent(game.id)}`;
  const fileSummary = Number.isInteger(game.fileCount) ? `${game.fileCount} ${game.fileCount === 1 ? 'file' : 'files'} · ` : '';
  document.getElementById('game-details-download-summary').textContent = `${fileSummary}${formatSize(game.sizeBytes)} ZIP`;
  document.getElementById('game-details-files-mobile').textContent = `${game.fileCount ?? 0} ${game.fileCount === 1 ? 'file' : 'files'} · Show Files`;
  document.getElementById('game-details-cover').textContent = game.coverSource === 'uploaded'
    ? 'Uploaded' : game.hasCover ? 'Available' : 'Missing';
  document.getElementById('edit-game-cover').textContent = game.hasCover ? 'Edit Cover' : 'Add Cover';
  document.getElementById('game-details-added').textContent = formatAddedDate(game.addedAt);
  const favorite = document.getElementById('game-details-favorite');
  favorite.textContent = game.favorite ? '★' : '☆';
  document.getElementById('game-details-favorite-mobile').textContent = favorite.textContent;
  favorite.classList.toggle('is-favorite', game.favorite);
  document.getElementById('game-details-favorite-mobile').classList.toggle('is-favorite', game.favorite);
  favorite.setAttribute('aria-label', game.favorite ? 'Remove from favorites' : 'Add to favorites');
  favorite.title = game.favorite ? 'Remove from favorites' : 'Add to favorites';
  document.getElementById('game-details-favorite-mobile').title = favorite.title;
  document.getElementById('game-details-cart').dataset.tooltip = cartGameIds.has(game.id) ? 'Remove from Playlist' : 'Add to Playlist';
  openModal(dialog);
  document.getElementById('game-details-close').focus();
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    if (openingCoverEditor) { openingCoverEditor = false; return; }
    trigger.blur();
    card.classList.remove('gs-hover-suppressed');
  }, { once: true });
}

async function toggleGameFiles() {
  const dialog = document.getElementById('game-files-dialog');
  const status = document.getElementById('game-files-status');
  const list = document.getElementById('game-files-list');
  if (!detailsGameId) return;
  const game = gamesCache.find(item => item.id === detailsGameId);
  document.getElementById('game-files-title').textContent = `Files: ${game?.name || 'Game'}`;
  openModal(dialog);

  fileListController?.abort();
  const controller = new AbortController();
  fileListController = controller;
  status.textContent = 'Loading files…';
  list.innerHTML = '';
  try {
    const response = await fetch(`/api/game-files/${encodeURIComponent(detailsGameId)}`, {
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    if (!result || !Array.isArray(result.files)) throw new Error('Invalid file list');
    if (fileListController !== controller || !dialog.open) return;
    for (const file of result.files) {
      if (typeof file.path !== 'string' || !Number.isFinite(file.sizeBytes)) continue;
      const item = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = file.path;
      const size = document.createElement('span');
      size.textContent = formatSize(file.sizeBytes);
      const download = document.createElement('a');
      download.href = `/api/game-file/${encodeURIComponent(detailsGameId)}?path=${encodeURIComponent(file.path)}`;
      download.download = file.path.split('/').pop();
      download.setAttribute('aria-label', `Download ${file.path}`);
      download.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5v11m0 0 4-4m-4 4-4-4M5 17.5v2h14v-2"/></svg>';
      download.addEventListener('click', showDownloadStarted);
      item.appendChild(name);
      item.appendChild(size);
      item.appendChild(download);
      list.appendChild(item);
    }
    status.textContent = result.truncated
      ? `Showing the first ${list.children.length} files.`
      : list.children.length === 0 ? 'No files found.' : '';
  } catch (error) {
    if (fileListController === controller && !controller.signal.aborted) {
      status.textContent = 'Could not load this game’s files. Try again.';
    }
  }
}

function drawCoverEditor() {
  const canvas = document.getElementById('cover-editor-canvas');
  document.getElementById('cover-preview').classList.toggle('is-empty', !editorImage);
  const context = canvas.getContext('2d');
  context.fillStyle = '#0a1324';
  context.fillRect(0, 0, canvas.width, canvas.height);
  if (!editorImage) return;
  const angle = (editorRotation + Number(document.getElementById('cover-tilt').value)) * Math.PI / 180;
  const cosine = Math.abs(Math.cos(angle));
  const sine = Math.abs(Math.sin(angle));
  const scale = Math.max(
    (canvas.width * cosine + canvas.height * sine) / editorImage.width,
    (canvas.width * sine + canvas.height * cosine) / editorImage.height
  ) * Number(document.getElementById('cover-zoom').value);
  context.save();
  context.translate(canvas.width / 2 + editorPan.x, canvas.height / 2 + editorPan.y);
  context.rotate(angle);
  context.scale(scale, scale);
  context.drawImage(editorImage, -editorImage.width / 2, -editorImage.height / 2);
  context.restore();
}

function openCoverEditor(game) {
  const save = document.getElementById('cover-editor-save');
  clearTimeout(saveFeedbackTimers.get(save));
  save.classList.remove('is-saved');
  editorReturnGame = game;
  editorGame = game;
  editorImage = null;
  editorInitialImage = null;
  editorLoadVersion++;
  const openVersion = ++editorOpenVersion;
  editorRotation = 0;
  editorPan = { x: 0, y: 0 };
  document.getElementById('cover-editor-title').textContent = `Cover Art: ${game.name}`;
  document.getElementById('cover-editor-file').value = '';
  document.getElementById('cover-zoom').value = '1';
  document.getElementById('cover-tilt').value = '0';
  updateCoverReadouts();
  document.getElementById('cover-editor-status').textContent = '';
  document.getElementById('cover-editor-save').disabled = true;
  openingCoverEditor = true;
  document.getElementById('game-details-dialog').close();
  openModal(document.getElementById('cover-editor-dialog'));
  drawCoverEditor();
  if (game.hasCover) {
    const image = new Image();
    image.onload = () => {
      if (editorOpenVersion !== openVersion || !document.getElementById('cover-editor-dialog').open) return;
      editorInitialImage = image;
      if (!editorImage) {
        editorImage = image;
        document.getElementById('cover-editor-save').disabled = false;
        drawCoverEditor();
      }
    };
    image.onerror = () => {
      document.getElementById('cover-editor-status').textContent = 'Could not load the current cover. Choose an image.';
    };
    image.src = `/covers/${encodeURIComponent(game.id)}?edit=${Date.now()}`;
  }
}

function updateCoverReadouts() {
  document.getElementById('cover-zoom-value').textContent = `${Math.round(Number(document.getElementById('cover-zoom').value) * 100)}%`;
  document.getElementById('cover-tilt-value').textContent = `${Number(document.getElementById('cover-tilt').value)}°`;
}

function showCoverGrid() {
  const preview = document.getElementById('cover-preview');
  preview.classList.add('is-adjusting');
  clearTimeout(editorGridTimer);
  editorGridTimer = setTimeout(() => preview.classList.remove('is-adjusting'), 750);
}

function bindCoverEditor() {
  const dialog = document.getElementById('cover-editor-dialog');
  const folderDialog = document.getElementById('cover-folder-dialog');
  const folderList = document.getElementById('cover-folder-list');
  const folderStatus = document.getElementById('cover-folder-status');
  const folderSave = document.getElementById('cover-folder-save');
  const canvas = document.getElementById('cover-editor-canvas');
  const status = document.getElementById('cover-editor-status');
  const save = document.getElementById('cover-editor-save');
  document.getElementById('edit-game-cover').addEventListener('click', () => {
    const game = gamesCache.find(candidate => candidate.id === detailsGameId);
    if (game) openCoverEditor(game);
  });
  document.getElementById('cover-editor-close').addEventListener('click', () => dialog.close());
  let folderLoad = 0;
  document.getElementById('cover-editor-folder').addEventListener('click', async () => {
    if (!editorGame) return;
    const gameId = editorGame.id;
    const request = ++folderLoad;
    folderList.replaceChildren();
    folderSave.disabled = true;
    folderStatus.textContent = 'Looking for images…';
    openModal(folderDialog);
    try {
      const response = await fetch(`/api/game-files/${encodeURIComponent(gameId)}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      if (request !== folderLoad || !folderDialog.open || editorGame?.id !== gameId) return;
      const images = (result.files || []).filter(file => /\.(png|jpe?g|gif|webp)$/i.test(file.path) && file.sizeBytes <= 20 * 1024 * 1024);
      for (const file of images) {
        const row = document.createElement('li');
        const label = document.createElement('label');
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'cover-folder-image';
        radio.value = file.path;
        radio.addEventListener('change', () => { folderSave.disabled = false; });
        const name = document.createElement('span');
        name.textContent = file.path;
        label.append(radio, name);
        row.appendChild(label);
        folderList.appendChild(row);
      }
      folderStatus.textContent = images.length ? 'Choose an image to use in the cover editor.' : 'No supported image file was detected in this game folder.';
      if (result.truncated) folderStatus.textContent += ' The file list was limited to the first 2,000 files.';
    } catch {
      if (request === folderLoad && folderDialog.open) folderStatus.textContent = 'Could not check this game folder. Try again.';
    }
  });
  document.getElementById('cover-folder-close').addEventListener('click', () => folderDialog.close());
  closeOnBackdropClick(folderDialog);
  folderDialog.addEventListener('close', () => { folderLoad++; });
  folderSave.addEventListener('click', () => {
    const selected = folderList.querySelector('input:checked');
    if (!selected || !editorGame || !dialog.open) return;
    const gameId = editorGame.id;
    const loadVersion = ++editorLoadVersion;
    folderSave.disabled = true;
    folderStatus.textContent = 'Loading image…';
    const image = new Image();
    image.onload = () => {
      if (!folderDialog.open || !dialog.open || editorGame?.id !== gameId || loadVersion !== editorLoadVersion) return;
      if (image.width > 8192 || image.height > 8192) { folderStatus.textContent = 'Image dimensions must be 8192 pixels or smaller.'; folderSave.disabled = false; return; }
      editorImage = image;
      editorRotation = 0;
      editorPan = { x: 0, y: 0 };
      document.getElementById('cover-zoom').value = '1';
      document.getElementById('cover-tilt').value = '0';
      updateCoverReadouts();
      save.disabled = false;
      drawCoverEditor();
      folderDialog.close();
      showNotification('Image selected. Save the cover to apply it.');
    };
    image.onerror = () => { if (folderDialog.open) { folderStatus.textContent = 'Could not read that image.'; folderSave.disabled = false; } };
    image.src = `/api/cover-source/${encodeURIComponent(gameId)}?path=${encodeURIComponent(selected.value)}`;
  });
  document.getElementById('cover-editor-cancel').addEventListener('click', () => {
    const game = editorReturnGame;
    dialog.close();
    if (game) {
      const card = cardMap.get(game.id);
      openGameDetails(game, card?.querySelector('.gs-card-info') || document.getElementById('spotlight-info'), card);
    }
  });
  closeOnBackdropClick(dialog);
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    editorGame = null;
    editorImage = null;
    editorInitialImage = null;
    editorLoadVersion++;
    editorOpenVersion++;
    document.getElementById('cover-preview').classList.remove('is-adjusting');
  });
  document.getElementById('cover-editor-reset').addEventListener('click', () => {
    editorLoadVersion++;
    editorImage = editorInitialImage;
    editorRotation = 0;
    editorPan = { x: 0, y: 0 };
    document.getElementById('cover-editor-file').value = '';
    document.getElementById('cover-zoom').value = '1';
    document.getElementById('cover-tilt').value = '0';
    save.disabled = !editorImage;
    status.textContent = '';
    document.getElementById('cover-preview').classList.remove('is-adjusting');
    updateCoverReadouts();
    drawCoverEditor();
  });
  document.getElementById('cover-editor-file').addEventListener('change', event => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/') || file.size > 20 * 1024 * 1024) {
      status.textContent = 'Choose an image smaller than 20 MB.';
      return;
    }
    const url = URL.createObjectURL(file);
    const loadVersion = ++editorLoadVersion;
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      if (!dialog.open || loadVersion !== editorLoadVersion) return;
      if (image.width > 8192 || image.height > 8192) {
        status.textContent = 'Image dimensions must be 8192 pixels or smaller.';
        return;
      }
      editorImage = image;
      editorRotation = 0;
      editorPan = { x: 0, y: 0 };
      document.getElementById('cover-zoom').value = '1';
      document.getElementById('cover-tilt').value = '0';
      updateCoverReadouts();
      save.disabled = false;
      status.textContent = '';
      drawCoverEditor();
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      status.textContent = 'Could not read that image.';
    };
    image.src = url;
  });
  document.getElementById('cover-rotate-left').addEventListener('click', () => { editorRotation -= 90; updateCoverReadouts(); showCoverGrid(); drawCoverEditor(); });
  document.getElementById('cover-rotate-right').addEventListener('click', () => { editorRotation += 90; updateCoverReadouts(); showCoverGrid(); drawCoverEditor(); });
  for (const id of ['cover-zoom', 'cover-tilt']) document.getElementById(id).addEventListener('input', () => { updateCoverReadouts(); showCoverGrid(); drawCoverEditor(); });
  let pointer = null;
  canvas.addEventListener('pointerdown', event => {
    if (!editorImage) return;
    pointer = { x: event.clientX, y: event.clientY };
    showCoverGrid();
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => {
    if (!pointer) return;
    editorPan.x += (event.clientX - pointer.x) * canvas.width / canvas.clientWidth;
    editorPan.y += (event.clientY - pointer.y) * canvas.height / canvas.clientHeight;
    pointer = { x: event.clientX, y: event.clientY };
    showCoverGrid();
    drawCoverEditor();
  });
  for (const eventName of ['pointerup', 'pointercancel']) {
    canvas.addEventListener(eventName, () => { pointer = null; });
  }
  save.addEventListener('click', async () => {
    if (!editorGame || !editorImage || save.disabled) return;
    const game = editorGame;
    const openVersion = editorOpenVersion;
    const isCurrentSession = () => dialog.open && editorOpenVersion === openVersion;
    save.disabled = true;
    status.textContent = '';
    try {
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('Could not render cover');
      const response = await fetch(`/api/covers/${encodeURIComponent(game.id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: blob
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      game.hasCover = true;
      game.coverSource = 'uploaded';
      coverVersions.set(game.id, Date.now());
      const oldCard = cardMap.get(game.id);
      const newCard = createGameCard(game);
      if (suggestedGameId === game.id) newCard.classList.add('gs-random-selected');
      oldCard.replaceWith(newCard);
      cardMap.set(game.id, newCard);
      applySearchFilter();
      if (!isCurrentSession()) return;
      status.textContent = '';
      showSaveFeedback(save);
      setTimeout(() => {
        if (!isCurrentSession()) return;
        dialog.close();
        const card = cardMap.get(game.id);
        openGameDetails(game, card?.querySelector('.gs-card-info') || document.getElementById('spotlight-info'), card);
        showNotification('Cover art saved.');
      }, 850);
    } catch (error) {
      if (!isCurrentSession()) return;
      status.textContent = 'Could not save cover. Please try again.';
      save.disabled = false;
    }
  });
}

function closeOnBackdropClick(dialog) {
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top || event.clientY > rect.bottom) {
      dialog.close();
    }
  });
}

/* =============================
   Sorting (DOM reordering only)
   ============================= */
function applySort() {
  const container = document.getElementById('games-container');
  const cards = Array.from(cardMap.values());

  cards.sort((a, b) => {
    if (favoritesFirst && a.dataset.favorite !== b.dataset.favorite) return a.dataset.favorite === 'true' ? -1 : 1;
    const nameA = a.dataset.name;
    const nameB = b.dataset.name;
    const sizeA = Number(a.dataset.size);
    const sizeB = Number(b.dataset.size);

    switch (currentSort) {
      case 'za':
        return nameB.localeCompare(nameA);
      case 'size-desc':
        return sizeB - sizeA;
      case 'size-asc':
        return sizeA - sizeB;
      case 'recent':
        return (Date.parse(b.dataset.added) || 0) - (Date.parse(a.dataset.added) || 0) || nameA.localeCompare(nameB);
      case 'favorites':
        return nameA.localeCompare(nameB);
      case 'az':
      default:
        return nameA.localeCompare(nameB);
    }
  });

  let next = null;
  for (let index = cards.length - 1; index >= 0; index--) {
    const card = cards[index];
    if (card.nextSibling !== next) container.insertBefore(card, next);
    next = card;
  }
}

/* =============================
   Search Function
   ============================= */
function applySearchFilter() {
  const empty = document.getElementById('empty-state');
  const hint = document.getElementById('empty-hint');
  const title = document.getElementById('empty-title');
  const searchHint = document.getElementById('search-hint');
  const filterHint = document.getElementById('filter-hint');

  let visibleCount = 0;

  cardMap.forEach(card => {
    const spotlightId = shuffleGameId || suggestedGameId;
    const match = spotlightId
      ? card.dataset.id === spotlightId
      : fuzzyMatch(card.dataset.name, currentSearch) &&
        (currentSort !== 'favorites' || card.dataset.favorite === 'true') &&
        (currentSort !== 'recent' || (Date.parse(card.dataset.added) || 0) >= Date.now() - recentDays * 86400000);

    if (match) {
      card.style.display = '';
      visibleCount++;
    } else {
      card.style.display = 'none';
    }
  });

  const emptyLibrary = gamesCache.length === 0;
  const hasSearch = currentSearch.length > 0;
  title.textContent = emptyLibrary ? 'No games found!' : hasSearch ? 'No matching games!' : currentSort === 'favorites' ? 'No favorites yet' : currentSort === 'recent' ? 'No recently added games' : 'No games in this view';
  hint.classList.toggle('hidden', !emptyLibrary);
  searchHint.classList.toggle('hidden', emptyLibrary || !hasSearch);
  filterHint.classList.toggle('hidden', emptyLibrary || hasSearch);
  filterHint.textContent = currentSort === 'favorites' ? 'Add a game to favorites to see it here.' : currentSort === 'recent' ? 'Try a longer Recently Added range in Settings.' : '';
  empty.classList.toggle('hidden', isLoading || loadError || !hasLoadedGames || visibleCount > 0);
  document.getElementById('clear-search').classList.toggle('hidden', currentSearch.length === 0);
}

function clearSuggestion() {
  if (!suggestedGameId && !isShuffling) return;
  shuffleTimers.forEach(clearTimeout);
  shuffleTimers = [];
  cardMap.get(suggestedGameId)?.classList.remove('gs-random-selected', 'gs-spotlight-enter');
  cardMap.get(shuffleGameId)?.classList.remove('gs-shuffle-preview', 'gs-shuffle-reverse');
  suggestedGameId = null;
  shuffleGameId = null;
  isShuffling = false;
  const diceButton = document.getElementById('random-game');
  diceButton.disabled = isLoading || gamesCache.length === 0;
  diceButton.dataset.tooltip = 'Suggest a random game';
  document.getElementById('games-container').classList.remove('gs-spotlight');
  document.getElementById('library-stage').classList.remove('gs-spotlight-stage');
  const returnActions = document.getElementById('spotlight-actions');
  returnActions.classList.add('hidden');
  returnActions.classList.remove('gs-return-visible');
  document.getElementById('spotlight-download').removeAttribute('href');
  document.getElementById('suggestion-status').textContent = '';
  applyViewMode();
  applySearchFilter();
}

function suggestRandomGame() {
  for (const card of cardMap.values()) card.classList.remove('gs-tile-fill');
  if (isLoading || isShuffling || gamesCache.length === 0) return;
  const choices = gamesCache.length > 1
    ? gamesCache.filter(game => game.id !== suggestedGameId)
    : gamesCache;
  const game = choices[Math.floor(Math.random() * choices.length)];
  const card = cardMap.get(game.id);
  if (!card) return;

  const diceButton = document.getElementById('random-game');
  diceButton.classList.remove('is-rolling');
  void diceButton.offsetWidth;
  diceButton.classList.add('is-rolling');

  clearSuggestion();
  if (currentSearch) clearSearch();
  document.getElementById('games-container').classList.add('gs-spotlight');
  document.getElementById('library-stage').classList.add('gs-spotlight-stage');

  function showFinalGame() {
    shuffleTimers = [];
    cardMap.get(shuffleGameId)?.classList.remove('gs-shuffle-preview', 'gs-shuffle-reverse');
    shuffleGameId = null;
    isShuffling = false;
    suggestedGameId = game.id;
    card.classList.add('gs-random-selected');
    diceButton.disabled = false;
    diceButton.dataset.tooltip = 'Suggest a random game';
    applyViewMode();
    applySearchFilter();
    if (!disableEffects) {
      card.classList.add('gs-spotlight-enter');
      card.addEventListener('animationend', () => card.classList.remove('gs-spotlight-enter'), { once: true });
    }
    card.scrollIntoView?.({ block: 'center' });
    const returnActions = document.getElementById('spotlight-actions');
    const spotlightDownload = document.getElementById('spotlight-download');
    spotlightDownload.href = `/download/${encodeURIComponent(game.id)}`;
    spotlightDownload.setAttribute('aria-label', `Download ${game.name}`);
    document.getElementById('spotlight-info').setAttribute('aria-label', `Information about ${game.name}`);
    returnActions.classList.remove('hidden');
    void returnActions.offsetWidth;
    returnActions.classList.add('gs-return-visible');
    document.getElementById('suggestion-status').textContent =
      `Showing only ${game.name}. Use Return to go back to the library or Reroll to choose again.`;
  }

  const alternatives = gamesCache.filter(candidate => candidate.id !== game.id);
  if (disableEffects || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches || alternatives.length === 0) {
    showFinalGame();
    return;
  }

  isShuffling = true;
  diceButton.disabled = true;
  diceButton.dataset.tooltip = 'Choosing a game…';
  applyViewMode();
  const frames = Math.min(4, alternatives.length * 2);
  const frameDelay = slowAnimations ? 640 : 400;
  let lastId = null;
  for (let step = 0; step < frames; step++) {
    const options = alternatives.filter(candidate => candidate.id !== lastId);
    const preview = (options.length ? options : alternatives)[
      Math.floor(Math.random() * (options.length || alternatives.length))
    ];
    lastId = preview.id;
    const showPreview = () => {
      cardMap.get(shuffleGameId)?.classList.remove('gs-shuffle-preview', 'gs-shuffle-reverse');
      shuffleGameId = preview.id;
      const previewCard = cardMap.get(preview.id);
      if (!previewCard) return;
      previewCard.classList.add('gs-shuffle-preview');
      applySearchFilter();
    };
    if (step === 0) showPreview();
    else shuffleTimers.push(setTimeout(showPreview, step * frameDelay));
  }
  shuffleTimers.push(setTimeout(showFinalGame, frames * frameDelay));
}

function clearSearch() {
  const input = document.getElementById('search-input');
  input.value = '';
  currentSearch = '';
  input.classList.remove('is-filtering');
  applySearchFilter();
}

/* =============================
   Initial Load/Refresh
   ============================= */
async function loadGames(isRefresh = false) {
  if (isLoading) return false;
  const container = document.getElementById('games-container');
  const loading = document.getElementById('loading-state');
  const error = document.getElementById('error-state');
  const retry = document.getElementById('retry-button');
  const randomButton = document.getElementById('random-game');

  if (isShuffling) clearSuggestion();
  isLoading = true;
  randomButton.disabled = true;
  randomButton.dataset.tooltip = 'Loading games…';
  loadError = false;
  retryRefresh = isRefresh;
  loading.textContent = isRefresh ? '' : 'Loading library';
  loading.classList.toggle('hidden', isRefresh);
  error.classList.add('hidden');
  retry.disabled = true;
  container.setAttribute('aria-busy', 'true');
  applySearchFilter();

  try {
    const games = await fetchGames(isRefresh);

    // Commit the new library only after the request and response validation succeed.
    if (isRefresh) {
      coverVersions.clear();
      refreshGeneration++;
      games.forEach(game => coverVersions.set(game.id, refreshGeneration));
      clearSearch();
    }

    clearSuggestion();
    gamesCache = games;
    cardMap.clear();
    container.innerHTML = '';
    gamesCache.forEach((game, index) => {
      const card = createGameCard(game);
      if (animateTiles && !disableEffects) {
        card.classList.add('gs-tile-fill');
        card.style.animationDelay = `${Math.min(index * 18, 180)}ms`;
      }
      cardMap.set(game.id, card);
      container.appendChild(card);
    });
    hasLoadedGames = true;
    applySort();
    syncCart();
    return true;
  } catch (err) {
    console.error('Failed to load games:', err);
    loadError = true;
    document.getElementById('error-title').textContent = isRefresh
      ? 'Could not refresh games.' : 'Could not load games.';
    document.getElementById('error-message').textContent =
      'GameShelf could not get the game library. Check that the server is running and reachable, then retry.' +
      (hasLoadedGames ? ' The last loaded library is still shown.' : '');
    error.classList.remove('hidden');
    return false;
  } finally {
    isLoading = false;
    loading.classList.add('hidden');
    retry.disabled = false;
    randomButton.disabled = gamesCache.length === 0;
    randomButton.dataset.tooltip = gamesCache.length === 0
      ? 'Add games to enable random suggestions' : 'Suggest a random game';
    container.setAttribute('aria-busy', 'false');
    applySearchFilter();
  }
}

/* =============================
   DOM bindings
   ============================= */
document.addEventListener('DOMContentLoaded', () => {
  const uiWindow = typeof window === 'undefined' ? { scrollY: 0, matchMedia: () => ({ matches: false }), scrollTo: () => {} } : window;
  const themeMedia = uiWindow.matchMedia('(prefers-color-scheme: dark)');
  const themeSelect = document.getElementById('theme-select');
  if (!['system', 'classic', 'light', 'dark', 'retro'].includes(themePreference)) themePreference = 'system';
  function applyTheme() {
    const theme = themePreference === 'system' ? (themeMedia.matches ? 'classic' : 'light') : themePreference;
    if (document.documentElement) document.documentElement.dataset.theme = theme;
    document.body.dataset.theme = theme;
    themeSelect.value = themePreference;
  }
  applyTheme();
  themeMedia.addEventListener?.('change', () => { if (themePreference === 'system') applyTheme(); });
  themeSelect.addEventListener('change', () => { themePreference = themeSelect.value; localStorage.setItem('gameshelf:theme', themePreference); applyTheme(); });
  document.body.classList.toggle('gs-hide-favorite-stars', !showFavoriteStars);
  document.body.classList.toggle('gs-favorite-stars-only', favoriteStarsOnly);
  document.body.classList.toggle('gs-hide-tooltips', !showHoverText);
  document.body.classList.toggle('gs-show-game-titles', showGameTitles);
  document.body.classList.toggle('gs-show-placeholders', showPlaceholderImages);
  document.body.classList.toggle('gs-show-list-images', showListImages);
  document.body.classList.toggle('gs-no-animations', disableEffects);
  loadVersion();
  loadServerSettings();
  loadGames();

  /* -------- Search -------- */
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.addEventListener('input', e => {
      clearSuggestion();
      currentSearch = e.target.value.trim().toLowerCase();
      searchInput.classList.toggle('is-filtering', currentSearch.length > 0);
      applySearchFilter();
    });
  }
  document.getElementById('clear-search').addEventListener('click', () => {
    clearSearch();
    searchInput.focus();
  });

  /* -------- Refresh -------- */
  const trigger = document.getElementById('gs-refresh-trigger');
  const logoText = document.getElementById('gs-logo-text');

  const originalText = 'GAMESHELF';
  const doneText = 'REFRESHED';

  let refreshLock = false;
  let refreshFeedbackTimer;
  let refreshHovered = false;

  trigger.addEventListener('pointerenter', () => { refreshHovered = true; if (!refreshLock && !refreshFeedbackTimer) logoText.textContent = 'REFRESH'; });
  trigger.addEventListener('pointerleave', () => { refreshHovered = false; if (!refreshLock && !refreshFeedbackTimer) logoText.textContent = originalText; });
  trigger.addEventListener('focus', () => { if (!refreshLock && !refreshFeedbackTimer) logoText.textContent = 'REFRESH'; });
  trigger.addEventListener('blur', () => { if (!refreshLock && !refreshFeedbackTimer) logoText.textContent = originalText; });

  async function runRefresh(isRefresh = true) {
    if (refreshLock || isLoading) return;

    clearTimeout(refreshFeedbackTimer);
    refreshFeedbackTimer = null;
    refreshLock = true;
    logoText.textContent = originalText;
    const stage = document.getElementById('library-stage');
    if (!disableEffects) stage.classList.add('gs-refreshing');

    const succeeded = await loadGames(isRefresh);
    stage.classList.remove('gs-refreshing');
    if (succeeded) {
      stage.classList.remove('gs-home-enter');
      void stage.offsetWidth;
      stage.classList.add('gs-home-enter');
    }
    logoText.textContent = succeeded ? doneText : 'FAILED';
    logoText.classList.toggle('bounce', succeeded);
    refreshLock = false;

    refreshFeedbackTimer = setTimeout(() => {
      logoText.classList.remove('bounce');
      refreshFeedbackTimer = null;
      logoText.textContent = refreshHovered ? 'REFRESH' : originalText;
    }, 1000);
  }

  trigger.addEventListener('click', () => runRefresh());
  document.getElementById('gs-home-trigger').addEventListener('click', () => {
    const resetHome = () => {
      clearSuggestion();
      clearSearch();
      currentSort = 'all';
      currentView = 'grid';
      localStorage.setItem('gameshelf:view', currentView);
      document.getElementById('sort-heading').classList.add('hidden');
      document.getElementById('sort-menu').classList.add('hidden');
      document.getElementById('sort-button').classList.remove('gs-control-active');
      document.body.classList.remove('gs-sort-open');
      updateSortIcon('all');
      applySort();
      applyViewMode();
      applySearchFilter();
    };
    if (document.startViewTransition && !uiWindow.matchMedia('(prefers-reduced-motion: reduce)').matches) document.startViewTransition(resetHome);
    else {
      resetHome();
      const stage = document.getElementById('library-stage');
      stage.classList.remove('gs-home-enter');
      void stage.offsetWidth;
      stage.classList.add('gs-home-enter');
    }
    uiWindow.scrollTo({ top: 0, behavior: uiWindow.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  });
  const scrollTopButton = document.getElementById('scroll-to-top');
  const syncScrollTop = () => { scrollTopButton.hidden = uiWindow.scrollY < 420; };
  uiWindow.addEventListener?.('scroll', syncScrollTop, { passive: true });
  syncScrollTop();
  scrollTopButton.addEventListener('click', () => uiWindow.scrollTo({ top: 0, behavior: uiWindow.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }));
  document.getElementById('retry-button').addEventListener('click', () => runRefresh(retryRefresh));

  const randomButton = document.getElementById('random-game');
  randomButton.addEventListener('click', suggestRandomGame);
  document.getElementById('reroll-game').addEventListener('click', suggestRandomGame);
  const cartDialog = document.getElementById('cart-dialog');
  document.getElementById('open-cart').addEventListener('click', event => { animateControl(event.currentTarget); renderCart(); openModal(cartDialog); });
  document.getElementById('cart-close').addEventListener('click', () => cartDialog.close());
  document.getElementById('cart-clear').addEventListener('click', () => { if (cartGameIds.size) confirmPlaylistChange('clear'); });
  const playlistConfirm = document.getElementById('playlist-confirm-dialog');
  for (const id of ['playlist-confirm-close', 'playlist-confirm-cancel']) document.getElementById(id).addEventListener('click', () => playlistConfirm.close());
  document.getElementById('playlist-confirm-accept').addEventListener('click', () => {
    if (!playlistPending) return;
    if (playlistPending.action === 'clear') cartGameIds.clear();
    else cartGameIds.delete(playlistPending.id);
    const message = playlistPending.action === 'clear' ? 'Playlist cleared.' : 'Removed from Playlist.';
    playlistPending = null;
    playlistConfirm.close();
    syncCart();
    showNotification(message);
  });
  closeOnBackdropClick(playlistConfirm);
  document.getElementById('cart-checkout').addEventListener('click', () => {
    if (cartGameIds.size === 0) return;
    const query = new URLSearchParams();
    for (const id of cartGameIds) query.append('game', id);
    const link = document.createElement('a');
    link.href = `/download-playlist?${query}`;
    link.download = 'gameshelf-playlist.zip';
    document.body.appendChild(link);
    link.click();
    link.remove();
    cartDialog.close();
    showNotification('Playlist download started.');
  });
  closeOnBackdropClick(cartDialog);
  document.getElementById('game-details-cart').addEventListener('click', event => { if (detailsGameId) { animateControl(event.currentTarget); toggleCart(detailsGameId); } });
  document.getElementById('spotlight-cart').addEventListener('click', event => { if (suggestedGameId) { animateControl(event.currentTarget); toggleCart(suggestedGameId); } });
  randomButton.addEventListener('animationend', () => randomButton.classList.remove('is-rolling'));
  document.getElementById('show-all-games').addEventListener('click', () => {
    clearSuggestion();
    randomButton.focus();
  });
  document.getElementById('spotlight-download').addEventListener('click', event => {
    if (!suggestedGameId) event.preventDefault();
    else showDownloadStarted();
    event.currentTarget.blur();
  });
  document.getElementById('game-details-download').addEventListener('click', showDownloadStarted);
  document.getElementById('spotlight-info').addEventListener('click', event => {
    const game = gamesCache.find(candidate => candidate.id === suggestedGameId);
    const card = cardMap.get(suggestedGameId);
    if (game && card) openGameDetails(game, event.currentTarget, card);
  });

  /* -------- Settings -------- */
  const settingsButton = document.getElementById('build-info');
  const settingsDialog = document.getElementById('settings-dialog');
  const detailsDialog = document.getElementById('game-details-dialog');
  const slowAnimationsInput = document.getElementById('slow-animations');
  const hoverTextInput = document.getElementById('show-hover-text');
  const gameTitlesInput = document.getElementById('show-game-titles');
  const placeholderInput = document.getElementById('show-placeholder-images');
  const listImagesInput = document.getElementById('show-list-images');
  const playlistInput = document.getElementById('enable-playlist');
  const disableEffectsInput = document.getElementById('disable-effects');
  const animateTilesInput = document.getElementById('animate-tiles');
  slowAnimationsInput.checked = slowAnimations;
  hoverTextInput.checked = showHoverText;
  gameTitlesInput.checked = showGameTitles;
  placeholderInput.checked = showPlaceholderImages;
  listImagesInput.checked = showListImages;
  playlistInput.checked = playlistEnabled;
  document.body.classList.toggle('gs-playlist-disabled', !playlistEnabled);
  playlistInput.addEventListener('change', () => {
    playlistEnabled = playlistInput.checked;
    localStorage.setItem('gameshelf:playlist-enabled', String(playlistEnabled));
    document.body.classList.toggle('gs-playlist-disabled', !playlistEnabled);
    showNotification(playlistEnabled ? 'Download Playlist enabled.' : 'Download Playlist disabled.');
  });
  disableEffectsInput.checked = disableEffects;
  animateTilesInput.checked = animateTiles;
  function applySettingsLevel() {
    settingsDialog.dataset.settingsLevel = settingsLevel;
    document.getElementById('settings-basic').setAttribute('aria-pressed', String(settingsLevel === 'basic'));
    document.getElementById('settings-advanced').setAttribute('aria-pressed', String(settingsLevel === 'advanced'));
  }
  applySettingsLevel();
  let changingSettingsLevel = false;
  for (const level of ['basic', 'advanced']) document.getElementById(`settings-${level}`).addEventListener('click', async () => {
    if (changingSettingsLevel || settingsLevel === level) return;
    changingSettingsLevel = true;
    const before = settingsDialog.getBoundingClientRect?.().height;
    if (level === 'basic' && !disableEffects && !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      const exits = Array.from(settingsDialog.querySelectorAll('[data-setting-level="advanced"]')).map(node =>
        node.animate?.([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-5px)' }],
          { duration: 220, easing: 'ease-in', fill: 'forwards' }));
      await Promise.all(exits.map(animation => animation?.finished?.catch(() => {})));
      exits.forEach(animation => animation?.cancel());
    }
    settingsLevel = level;
    localStorage.setItem('gameshelf:settings-level', level);
    applySettingsLevel();
    const after = settingsDialog.getBoundingClientRect?.().height;
    if (!disableEffects && before && after && before !== after) settingsDialog.animate?.(
      [{ height: `${before}px`, overflow: 'hidden' }, { height: `${after}px`, overflow: 'hidden' }],
      { duration: 240, easing: 'cubic-bezier(.22,.7,.2,1)' }
    );
    changingSettingsLevel = false;
  });
  disableEffectsInput.addEventListener('change', () => {
    disableEffects = disableEffectsInput.checked;
    localStorage.setItem('gameshelf:disable-effects', String(disableEffects));
    document.body.classList.toggle('gs-no-animations', disableEffects);
  });
  animateTilesInput.addEventListener('change', () => {
    animateTiles = animateTilesInput.checked;
    localStorage.setItem('gameshelf:animate-tiles', String(animateTiles));
  });
  randomButton.classList.toggle('gs-slow-animations', slowAnimations);
  document.getElementById('games-container').classList.toggle('gs-slow-animations', slowAnimations);

  settingsButton.addEventListener('click', () => {
    animateControl(settingsButton);
    openModal(settingsDialog);
    document.getElementById(`settings-${settingsLevel}`).focus();
  });
  const exportDialog = document.getElementById('export-dialog');
  const exportOptions = document.getElementById('export-options');
  const exportAll = document.getElementById('export-all');
  document.getElementById('export-library-data').addEventListener('click', () => {
    exportOptions.replaceChildren();
    const groups = [
      { title: 'GameShelf data', items: [{ id: 'state', kind: 'state', name: 'Library state (JSON)' }, { id: 'settings', kind: 'settings', name: 'Server settings (JSON)' }, { id: 'logs', kind: 'logs', name: 'Recent logs (TXT)' }] },
      { title: 'Cover image archive', items: gamesCache.filter(game => game.hasCover).sort((a, b) => a.name.localeCompare(b.name)).map(game => ({ id: game.id, kind: 'cover', name: game.name })) }
    ];
    for (const group of groups) {
      const section = document.createElement('section');
      section.className = 'gs-export-section';
      const heading = document.createElement('h3');
      heading.textContent = group.title;
      section.appendChild(heading);
      if (!group.items.length) {
        const emptyMessage = document.createElement('p');
        emptyMessage.className = 'gs-export-empty';
        emptyMessage.textContent = 'No cover images are available.';
        section.appendChild(emptyMessage);
      }
      for (const item of group.items) {
        const label = document.createElement('label');
        label.className = 'gs-settings-option';
        const input = document.createElement('input');
        input.type = 'checkbox'; input.value = item.id; input.dataset.kind = item.kind; input.checked = true;
        input.addEventListener('change', () => { const options = [...exportOptions.querySelectorAll('input')]; exportAll.checked = options.every(option => option.checked); exportAll.indeterminate = !exportAll.checked && options.some(option => option.checked); });
        label.append(input, document.createTextNode(item.name));
        section.appendChild(label);
      }
      exportOptions.appendChild(section);
    }
    exportAll.checked = true; exportAll.indeterminate = false;
    document.getElementById('export-status').textContent = '';
    openModal(exportDialog);
  });
  exportAll.addEventListener('change', () => { exportOptions.querySelectorAll('input').forEach(input => { input.checked = exportAll.checked; }); exportAll.indeterminate = false; });
  document.getElementById('export-confirm').addEventListener('click', exportLibraryData);
  for (const id of ['export-close', 'export-cancel']) document.getElementById(id).addEventListener('click', () => exportDialog.close());
  closeOnBackdropClick(exportDialog);
  const restoreDialog = document.getElementById('restore-dialog');
  const restoreFile = document.getElementById('restore-file');
  const restoreApply = document.getElementById('restore-apply');
  const restoreStatus = document.getElementById('restore-status');
  const restorePreviewPanel = document.getElementById('restore-preview');
  const restoreChoices = ['restore-state', 'restore-covers', 'restore-settings'].map(id => document.getElementById(id));
  let restorePreview = null;
  let restoreVersion = 0;
  const updateRestoreButton = () => {
    restoreApply.disabled = !restorePreview || !document.getElementById('restore-ack').checked || !restoreChoices.some(input => input.checked);
  };
  document.getElementById('open-library-restore').addEventListener('click', () => {
    restoreVersion++;
    restorePreview = null;
    restoreFile.value = '';
    restorePreviewPanel.hidden = true;
    restoreStatus.textContent = '';
    document.getElementById('restore-ack').checked = false;
    updateRestoreButton();
    openModal(restoreDialog);
  });
  for (const id of ['restore-close', 'restore-cancel']) document.getElementById(id).addEventListener('click', () => restoreDialog.close());
  closeOnBackdropClick(restoreDialog);
  restoreDialog.addEventListener('close', () => { restoreVersion++; restorePreview = null; });
  for (const input of [...restoreChoices, document.getElementById('restore-ack')]) input.addEventListener('change', updateRestoreButton);
  restoreFile.addEventListener('change', async () => {
    const file = restoreFile.files?.[0];
    const version = ++restoreVersion;
    restorePreview = null;
    restorePreviewPanel.hidden = true;
    restoreStatus.textContent = '';
    updateRestoreButton();
    if (!file) return;
    if (file.size > 64 * 1024 * 1024) { restoreStatus.textContent = 'Choose a backup ZIP smaller than 64 MiB.'; return; }
    restoreStatus.textContent = 'Validating backup…';
    try {
      const response = await fetch('/api/library-restore', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file });
      if (!response.ok) throw new Error((await response.text()).trim());
      const preview = await response.json();
      if (version !== restoreVersion || !restoreDialog.open) return;
      restorePreview = preview;
      const available = [preview.state, preview.covers > 0, preview.settings];
      restoreChoices.forEach((input, index) => { input.checked = available[index]; input.disabled = !available[index]; });
      document.getElementById('restore-cover-count').textContent = `${preview.covers} uploaded cover${preview.covers === 1 ? '' : 's'} will be replaced or added.`;
      document.getElementById('restore-skipped').textContent = `${preview.folderCoversSkipped} game-folder cover copies and ${preview.logsSkipped ? 'the log snapshot' : 'no log snapshot'} will be skipped; mounted game folders are never changed.`;
      document.getElementById('restore-ack').checked = false;
      restorePreviewPanel.hidden = false;
      restoreStatus.textContent = 'Review the selection, then confirm the restore.';
      updateRestoreButton();
    } catch (error) { if (version === restoreVersion) restoreStatus.textContent = `Could not preview backup: ${error.message}`; }
  });
  restoreApply.addEventListener('click', async () => {
    if (restoreApply.disabled || !restorePreview || !restoreFile.files?.[0]) return;
    restoreApply.disabled = true;
    restoreStatus.textContent = 'Restoring selected data…';
    const selected = new URLSearchParams({ apply: '1' });
    for (const [index, key] of ['state', 'covers', 'settings'].entries()) if (restoreChoices[index].checked) selected.set(key, '1');
    try {
      const response = await fetch(`/api/library-restore?${selected}`, { method: 'POST', headers: { 'Content-Type': 'application/zip', 'X-Preview-SHA256': restorePreview.sha256 }, body: restoreFile.files[0] });
      if (!response.ok) throw new Error((await response.text()).trim());
      const result = await response.json();
      restoreDialog.close();
      showNotification(result.restartRequired ? 'Library data restored. Restart the container to apply server settings.' : 'Library data restored.');
      loadServerSettings();
      loadGames(true);
    } catch (error) { restoreStatus.textContent = `Could not restore backup: ${error.message}`; updateRestoreButton(); }
  });
  const favoriteDialog = document.getElementById('favorite-dialog');
  document.getElementById('game-details-favorite').addEventListener('click', () => { const game = gamesCache.find(item => item.id === detailsGameId); if (game) openFavoriteConfirm(game); });
  document.getElementById('game-details-favorite-mobile').addEventListener('click', () => { const game = gamesCache.find(item => item.id === detailsGameId); if (game) openFavoriteConfirm(game); });
  document.getElementById('favorite-confirm').addEventListener('click', saveFavorite);
  for (const id of ['favorite-close', 'favorite-cancel']) document.getElementById(id).addEventListener('click', () => favoriteDialog.close());
  closeOnBackdropClick(favoriteDialog);
  const starsInput = document.getElementById('show-favorite-stars');
  const favoritesFirstInput = document.getElementById('favorites-first');
  favoritesFirstInput.checked = favoritesFirst;
  favoritesFirstInput.addEventListener('change', () => {
    favoritesFirst = favoritesFirstInput.checked;
    localStorage.setItem('gameshelf:favorites-first', String(favoritesFirst));
    applySort();
  });
  const starsOnlyInput = document.getElementById('favorite-stars-only');
  function syncStarSettings() {
    starsInput.checked = showFavoriteStars;
    starsOnlyInput.checked = favoriteStarsOnly;
    starsOnlyInput.disabled = !showFavoriteStars;
    document.getElementById('favorite-only-option').classList.toggle('gs-disabled', !showFavoriteStars);
    document.body.classList.toggle('gs-hide-favorite-stars', !showFavoriteStars);
    document.body.classList.toggle('gs-favorite-stars-only', favoriteStarsOnly);
  }
  syncStarSettings();
  starsInput.addEventListener('change', event => { showFavoriteStars = event.target.checked; localStorage.setItem('gameshelf:favorite-stars', String(showFavoriteStars)); syncStarSettings(); });
  starsOnlyInput.addEventListener('change', event => { favoriteStarsOnly = event.target.checked; localStorage.setItem('gameshelf:favorite-stars-only', String(favoriteStarsOnly)); syncStarSettings(); });
  const daysInput = document.getElementById('recent-days');
  daysInput.value = String(recentDays);
  const recentDialog = document.getElementById('recent-settings-dialog');
  document.getElementById('open-recent-settings').addEventListener('click', () => { daysInput.value = String(recentDays); openModal(recentDialog); });
  for (const id of ['recent-settings-close', 'recent-settings-cancel']) document.getElementById(id).addEventListener('click', () => recentDialog.close());
  closeOnBackdropClick(recentDialog);
  document.getElementById('recent-settings-save').addEventListener('click', () => {
    recentDays = Math.max(1, Math.min(3650, Number(daysInput.value) || 7));
    daysInput.value = String(recentDays);
    localStorage.setItem('gameshelf:recent-days', String(recentDays));
    applySearchFilter(); recentDialog.close(); showNotification('Recently Added range saved.');
  });
  const expandInput = document.getElementById('expand-list-image');
  expandInput.value = listImageClick;
  document.body.classList.toggle('gs-expand-list-image', listImageClick !== 'disabled');
  expandInput.addEventListener('change', () => { listImageClick = expandInput.value; localStorage.setItem('gameshelf:list-image-click', listImageClick); document.body.classList.toggle('gs-expand-list-image', listImageClick !== 'disabled'); });
  const listImageDialog = document.getElementById('list-image-dialog');
  listImageDialog.addEventListener('click', () => listImageDialog.close());
  const resetSettingsDialog = document.getElementById('reset-settings-dialog');
  document.getElementById('open-reset-settings').addEventListener('click', () => { document.getElementById('reset-settings-status').textContent = ''; openModal(resetSettingsDialog); });
  for (const id of ['reset-settings-close', 'reset-settings-cancel']) document.getElementById(id).addEventListener('click', () => resetSettingsDialog.close());
  closeOnBackdropClick(resetSettingsDialog);
  document.getElementById('reset-settings-confirm').addEventListener('click', async () => {
    const button = document.getElementById('reset-settings-confirm');
    if (button.disabled) return;
    button.disabled = true;
    try {
      const response = await fetch('/api/server-settings/reset', { method: 'POST' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      for (const key of Object.keys(localStorage)) if (key.startsWith('gameshelf:')) localStorage.removeItem(key);
      resetSettingsDialog.close();
      showNotification('All settings reset. Reloading GameShelf…');
      setTimeout(() => window.location.reload(), 900);
    } catch (error) {
      document.getElementById('reset-settings-status').textContent = `Could not reset settings: ${error.message}`;
      button.disabled = false;
    }
  });
  const serverDialog = document.getElementById('server-settings-dialog');
  document.getElementById('open-server-settings').addEventListener('click', () => {
    if (!serverSettings) { document.getElementById('settings-save-status').textContent = 'Server settings are unavailable. Try refreshing.'; return; }
    document.getElementById('server-root-path').value = (serverSettings.rootDirs?.length ? serverSettings.rootDirs : [serverSettings.rootDir]).join('\n');
    document.getElementById('server-data-path').value = serverSettings.dataDir;
    document.getElementById('server-settings-status').textContent = '';
    openModal(serverDialog);
  });
  for (const id of ['server-settings-close', 'server-settings-cancel']) document.getElementById(id).addEventListener('click', () => serverDialog.close());
  closeOnBackdropClick(serverDialog);
  document.getElementById('server-settings-save').addEventListener('click', async () => {
    const button = document.getElementById('server-settings-save');
    if (!serverSettings || button.disabled) return;
    const roots = document.getElementById('server-root-path').value.split(/\r?\n/).map(path => path.trim()).filter(Boolean);
    const next = { ...serverSettings, rootDir: roots[0] || '', rootDirs: roots, dataDir: document.getElementById('server-data-path').value.trim() };
    button.disabled = true;
    try {
      const result = await saveServerSettings(next);
      document.getElementById('server-settings-status').textContent = '';
      document.getElementById('settings-save-status').textContent = '';
      serverDialog.close();
      showNotification(result.restartRequired ? 'Library settings saved. Restart the container to apply changes.' : 'Library settings saved.');
    } catch (error) { document.getElementById('server-settings-status').textContent = `Could not save settings: ${error.message}`; }
    finally { button.disabled = false; }
  });
  const refreshDialog = document.getElementById('refresh-settings-dialog');
  document.getElementById('open-refresh-settings').addEventListener('click', () => {
    if (!serverSettings) return;
    const interval = serverSettings.refreshInterval;
    const legacyMinutes = /^([0-9]+)m$/.exec(interval);
    document.getElementById('server-refresh-interval').value = interval === '0' ? '0' : String(legacyMinutes ? Math.ceil(Number(legacyMinutes[1]) / 60) : (Number.parseInt(interval, 10) || 168));
    document.getElementById('refresh-settings-status').textContent = '';
    openModal(refreshDialog);
  });
  for (const id of ['refresh-settings-close', 'refresh-settings-cancel']) document.getElementById(id).addEventListener('click', () => refreshDialog.close());
  closeOnBackdropClick(refreshDialog);
  document.getElementById('refresh-settings-save').addEventListener('click', async () => {
    if (!serverSettings) return;
    const button = document.getElementById('refresh-settings-save');
    button.disabled = true;
    try {
      const hours = Number(document.getElementById('server-refresh-interval').value);
      if (!Number.isInteger(hours) || hours < 0 || hours > 8760) throw new Error('Choose 0–8760 whole hours.');
      await saveServerSettings({ ...serverSettings, refreshInterval:hours === 0 ? '0' : `${hours}h` });
      refreshDialog.close();
      showNotification('Refresh interval saved.');
    } catch (error) { document.getElementById('refresh-settings-status').textContent = `Could not save interval: ${error.message}`; }
    finally { button.disabled = false; }
  });
  const logConfigDialog = document.getElementById('log-config-dialog');
  const logVerbose = document.getElementById('log-verbose');
  const logKinds = ['system', 'library', 'errors', 'requests', 'scans', 'downloads'];
  const logTypeInputs = logKinds.map(kind => document.getElementById(`log-${kind}`));
  const logDaysOverride = document.getElementById('log-override-days');
  const logSizeOverride = document.getElementById('log-override-size');
  const logDays = document.getElementById('log-days');
  const logSize = document.getElementById('log-size');
  function syncLogConfigInputs() {
    logTypeInputs.forEach(input => { input.disabled = !logVerbose.checked; });
    logDays.disabled = !logDaysOverride.checked;
    logSize.disabled = !logSizeOverride.checked;
  }
  for (const input of [logVerbose, logDaysOverride, logSizeOverride]) input.addEventListener('change', syncLogConfigInputs);
  document.getElementById('configure-logs').addEventListener('click', () => {
    if (!serverSettings) { document.getElementById('settings-save-status').textContent = 'Server settings are unavailable. Try refreshing.'; return; }
    const options = serverSettings.logOptions || { system:true, library:true, errors:true, requests:true, scans:true, downloads:true, sizeMB:10, days:7 };
    logVerbose.checked = Boolean(serverSettings.verbose);
    for (const input of logTypeInputs) input.checked = options[input.id.slice(4)] !== false;
    logDaysOverride.checked = Boolean(options.overrideDays);
    logSizeOverride.checked = Boolean(options.overrideSize);
    logDays.value = String(options.days || 7);
    logSize.value = String(options.sizeMB || 10);
    syncLogConfigInputs();
    document.getElementById('log-config-status').textContent = '';
    openModal(logConfigDialog);
  });
  for (const id of ['log-config-close', 'log-config-cancel']) document.getElementById(id).addEventListener('click', () => logConfigDialog.close());
  closeOnBackdropClick(logConfigDialog);
  document.getElementById('log-config-save').addEventListener('click', async () => {
    if (!serverSettings) return;
    const button = document.getElementById('log-config-save');
    const options = {
      baseConfigured:true, system:logTypeInputs[0].checked, library:logTypeInputs[1].checked, errors:logTypeInputs[2].checked,
      requests:logTypeInputs[3].checked, scans:logTypeInputs[4].checked, downloads:logTypeInputs[5].checked,
      overrideDays:logDaysOverride.checked, days:Number(logDays.value), overrideSize:logSizeOverride.checked, sizeMB:Number(logSize.value)
    };
    if (!Number.isInteger(options.days) || options.days < 1 || options.days > 3650 || !Number.isInteger(options.sizeMB) || options.sizeMB < 1 || options.sizeMB > 100) {
      document.getElementById('log-config-status').textContent = 'Use 1–3650 days and 1–100 MB.'; return;
    }
    button.disabled = true;
    try {
      await saveServerSettings({ ...serverSettings, verbose:logVerbose.checked, logOptions:options });
      showSaveFeedback(button);
      logConfigDialog.close();
      showNotification('Log settings saved.');
    } catch { document.getElementById('log-config-status').textContent = 'Could not save log settings.'; }
    finally { button.disabled = false; }
  });
  const logsDialog = document.getElementById('logs-dialog');
  const logsContent = document.getElementById('logs-content');
  const logsStatus = document.getElementById('logs-status');
  const logsCopy = document.getElementById('logs-copy');
  const logsDownload = document.getElementById('logs-download');
  const logFilters = [...document.querySelectorAll('#logs-filters input')];
  const clearLogFilters = document.getElementById('logs-clear-filters');
  let rawLogs = '';
  function showFilteredLogs() {
    const included = new Set(logFilters.filter(input => input.checked).map(input => input.value));
    const lines = rawLogs.split('\n').filter(line => {
      const type = (line.match(/\[(system|library|errors|request|scan|download)\]/) || [,'system'])[1];
      return included.has(type);
    });
    logsContent.textContent = lines.join('\n');
    clearLogFilters.hidden = logFilters.some(input => !input.checked) === false;
    logsContent.scrollTop = logsContent.scrollHeight;
    logsCopy.disabled = !logsContent.textContent;
    logsDownload.disabled = !logsContent.textContent;
  }
  logFilters.forEach(input => input.addEventListener('change', showFilteredLogs));
  clearLogFilters.addEventListener('click', () => { logFilters.forEach(input => { input.checked = true; }); showFilteredLogs(); });
  let logsRequestVersion = 0;
  document.getElementById('view-logs').addEventListener('click', async () => {
    const requestVersion = ++logsRequestVersion;
    logsContent.textContent = '';
    logsStatus.textContent = 'Loading logs…';
    logsCopy.disabled = true;
    logsDownload.disabled = true;
    openModal(logsDialog);
    try {
      const response = await fetch('/api/logs', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contents = await response.text();
      if (!logsDialog.open || requestVersion !== logsRequestVersion) return;
      rawLogs = contents;
      showFilteredLogs();
      logsStatus.textContent = contents ? '' : 'No application logs yet.';
    } catch {
      if (logsDialog.open && requestVersion === logsRequestVersion) logsStatus.textContent = 'Could not load logs. Close and try again.';
    }
  });
  logsCopy.addEventListener('click', async () => {
    if (!logsContent.textContent) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(logsContent.textContent);
      else {
        const field = document.createElement('textarea');
        field.value = logsContent.textContent;
        field.style.position = 'fixed';
        field.style.opacity = '0';
        logsDialog.appendChild(field);
        field.select();
        const copied = document.execCommand('copy');
        field.remove();
        if (!copied) throw new Error('Copy unavailable');
      }
      showNotification('Logs copied.');
    }
    catch { logsStatus.textContent = 'Could not copy logs.'; }
  });
  logsDownload.addEventListener('click', () => {
    if (!logsContent.textContent) return;
    const url = URL.createObjectURL(new Blob([logsContent.textContent], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'gameshelf-logs.txt';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showNotification('Log download started.');
  });
  document.getElementById('logs-close').addEventListener('click', () => logsDialog.close());
  logsDialog.addEventListener('close', () => { logsRequestVersion++; });
  closeOnBackdropClick(logsDialog);
  document.getElementById('settings-close').addEventListener('click', () => settingsDialog.close());
  document.getElementById('game-details-close').addEventListener('click', () => detailsDialog.close());
  document.getElementById('game-details-download-summary').addEventListener('click', toggleGameFiles);
  document.getElementById('game-details-files-mobile').addEventListener('click', toggleGameFiles);
  document.getElementById('game-files-close').addEventListener('click', () => document.getElementById('game-files-dialog').close());
  closeOnBackdropClick(document.getElementById('game-files-dialog'));
  document.getElementById('game-files-dialog').addEventListener('close', () => { fileListController?.abort(); fileListController = null; });
  const resetDialog = document.getElementById('reset-metadata-dialog');
  const resetConfirm = document.getElementById('reset-confirm-dialog');
  let resetSelection = null;
  document.getElementById('reset-game-metadata').addEventListener('click', () => {
    document.querySelectorAll('#reset-metadata-options input').forEach(input => { input.checked = false; });
    document.getElementById('reset-metadata-status').textContent = '';
    openModal(resetDialog);
  });
  document.getElementById('reset-metadata-next').addEventListener('click', () => {
    const inputs = [...document.querySelectorAll('#reset-metadata-options input:checked')];
    if (!inputs.length) { document.getElementById('reset-metadata-status').textContent = 'Select at least one item.'; return; }
    resetSelection = Object.fromEntries(inputs.map(input => [input.value, true]));
    const game = gamesCache.find(item => item.id === detailsGameId);
    document.getElementById('reset-confirm-question').textContent = `The following items for “${game?.name || 'this game'}” will be reset: ${inputs.map(input => input.parentElement?.textContent?.trim() || input.value).join(', ')}. Are you sure?`;
    document.getElementById('reset-confirm-status').textContent = '';
    resetDialog.close();
    openModal(resetConfirm);
  });
  document.getElementById('reset-confirm-save').addEventListener('click', async () => {
    const game = gamesCache.find(item => item.id === detailsGameId);
    const button = document.getElementById('reset-confirm-save');
    if (!game || !resetSelection || button.disabled) return;
    button.disabled = true;
    try {
      const response = await fetch(`/api/metadata-reset/${encodeURIComponent(game.id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(resetSelection) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const updated = await response.json();
      Object.assign(game, updated);
      if (resetSelection.cover) coverVersions.set(game.id, Date.now());
      const oldCard = cardMap.get(game.id);
      const newCard = createGameCard(game);
      oldCard.replaceWith(newCard);
      cardMap.set(game.id, newCard);
      document.getElementById('game-details-title').textContent = game.name;
      document.getElementById('game-details-image-title').textContent = game.name;
      document.getElementById('game-title-input').value = game.name;
      document.getElementById('game-details-cover').textContent = game.hasCover ? 'Available' : 'Missing';
      document.getElementById('edit-game-cover').textContent = game.hasCover ? 'Edit Cover' : 'Add Cover';
      document.getElementById('game-details-image').src = `/covers/${encodeURIComponent(game.id)}?v=${coverVersions.get(game.id) || 0}`;
      document.getElementById('game-details-art').classList.toggle('gs-no-cover', !game.hasCover);
      document.getElementById('game-details-favorite').textContent = game.favorite ? '★' : '☆';
      document.getElementById('game-details-favorite-mobile').textContent = game.favorite ? '★' : '☆';
      document.getElementById('game-details-favorite').classList.toggle('is-favorite', game.favorite);
      document.getElementById('game-details-favorite-mobile').classList.toggle('is-favorite', game.favorite);
      applySort(); applySearchFilter();
      resetConfirm.close();
      showNotification('Metadata reset successfully.');
    } catch { document.getElementById('reset-confirm-status').textContent = 'Could not reset metadata. Try again.'; }
    finally { button.disabled = false; }
  });
  document.getElementById('reset-metadata-close').addEventListener('click', () => resetDialog.close());
  document.getElementById('reset-confirm-close').addEventListener('click', () => resetConfirm.close());
  closeOnBackdropClick(resetDialog); closeOnBackdropClick(resetConfirm);
  const titleInput = document.getElementById('game-title-input');
  const titleSave = document.getElementById('save-game-title');
  titleSave.addEventListener('click', async () => {
    const game = gamesCache.find(candidate => candidate.id === detailsGameId);
    if (!game) return;
    const title = titleInput.value.trim();
    if (title.length > 120 || /[\r\n]/.test(title)) { titleInput.setCustomValidity('Use up to 120 characters on one line.'); titleInput.reportValidity(); return; }
    titleInput.setCustomValidity('');
    titleSave.disabled = true;
    try {
      const response = await fetch(`/api/game-title/${encodeURIComponent(game.id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title })
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      game.name = result.name;
      document.getElementById('game-details-title').textContent = game.name;
      document.getElementById('game-details-image-title').textContent = game.name;
      titleInput.value = game.name;
      const oldCard = cardMap.get(game.id);
      const newCard = createGameCard(game);
      if (suggestedGameId === game.id) newCard.classList.add('gs-random-selected');
      oldCard.replaceWith(newCard);
      cardMap.set(game.id, newCard);
      applySort();
      applySearchFilter();
      showSaveFeedback(titleSave);
      showNotification('GameShelf title saved.');
    } catch {
      titleInput.setCustomValidity('Could not save this title. Try again.');
      titleInput.reportValidity();
    } finally { titleSave.disabled = false; }
  });
  titleInput.addEventListener('input', () => titleInput.setCustomValidity(''));
  bindCoverEditor();
  closeOnBackdropClick(settingsDialog);
  closeOnBackdropClick(detailsDialog);
  detailsDialog.addEventListener('close', () => {
    if (detailsDialog.open) return;
    fileListController?.abort();
    fileListController = null;
    detailsGameId = null;
  });
  settingsDialog.addEventListener('close', () => settingsButton.focus());
  slowAnimationsInput.addEventListener('change', () => {
    slowAnimations = slowAnimationsInput.checked;
    localStorage.setItem('gameshelf:slow-animations', String(slowAnimations));
    randomButton.classList.toggle('gs-slow-animations', slowAnimations);
    document.getElementById('games-container').classList.toggle('gs-slow-animations', slowAnimations);
  });
  hoverTextInput.addEventListener('change', () => {
    showHoverText = hoverTextInput.checked;
    localStorage.setItem('gameshelf:show-hover-text', String(showHoverText));
    document.body.classList.toggle('gs-hide-tooltips', !showHoverText);
  });
  gameTitlesInput.addEventListener('change', () => {
    showGameTitles = gameTitlesInput.checked;
    localStorage.setItem('gameshelf:show-game-titles', String(showGameTitles));
    document.body.classList.toggle('gs-show-game-titles', showGameTitles);
  });
  placeholderInput.addEventListener('change', () => {
    showPlaceholderImages = placeholderInput.checked;
    localStorage.setItem('gameshelf:show-placeholder-images', String(showPlaceholderImages));
    document.body.classList.toggle('gs-show-placeholders', showPlaceholderImages);
  });
  listImagesInput.addEventListener('change', () => {
    showListImages = listImagesInput.checked;
    localStorage.setItem('gameshelf:show-list-images', String(showListImages));
    document.body.classList.toggle('gs-show-list-images', showListImages);
  });

  /* -------- Sort menu -------- */
  const sortButton = document.getElementById('sort-button');
  const sortMenu = document.getElementById('sort-menu');
  const viewToggle = document.getElementById('view-toggle');
  const sortButtons = document.querySelectorAll('.gs-sort-menu button');

  function updateActiveSort() {
    sortButtons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.sort === currentSort);
    });
  }

  sortButton.addEventListener('click', e => {
    e.stopPropagation();
    animateControl(sortButton);
    if (suggestedGameId || isShuffling) clearSuggestion();
    updateActiveSort();

    const isOpening = sortMenu.classList.toggle('hidden') === false;
    sortButton.classList.toggle('gs-control-active', isOpening);
    document.body.classList.toggle('gs-sort-open', isOpening);
  });

  document.addEventListener('click', e => {
    const clickedSortButton = e.target.closest('#sort-button');
    const clickedSortMenu = e.target.closest('#sort-menu');

    if (!clickedSortButton && !clickedSortMenu) {
      sortMenu.classList.add('hidden');
      sortButton.classList.remove('gs-control-active');
      document.body.classList.remove('gs-sort-open');
    }
  });

  sortButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      currentSort = btn.dataset.sort;
      updateSortIcon(currentSort);
      updateActiveSort();
      sortMenu.classList.add('hidden');
      sortButton.classList.remove('gs-control-active');
      document.body.classList.remove('gs-sort-open');
      transitionLibrary(() => {
        applySort();
        applySearchFilter();
        const heading = document.getElementById('sort-heading');
        heading.classList.toggle('hidden', currentSort === 'all');
        heading.textContent = currentSort === 'all' ? '' : `${currentSort === 'favorites' || currentSort === 'recent' ? 'Showing' : 'Sorted by'}: ${btn.textContent.trim()}`;
      });
    });
  });

  /* -------- View toggle -------- */

  if (viewToggle) {
    viewToggle.addEventListener('click', () => {
      clearSuggestion();
      currentView = currentView === 'grid' ? 'list' : 'grid';
      localStorage.setItem('gameshelf:view', currentView);
      transitionLibrary(applyViewMode);

    // Close sort menu if open
    sortMenu.classList.add('hidden');
    sortButton.classList.remove('gs-control-active');
    document.body.classList.remove('gs-sort-open');
    });
  }

  /* -------- Keyboard Shortcuts -------- */
  document.addEventListener('keydown', e => {
    if (settingsDialog.open || detailsDialog.open) return;
    const searchInput = document.getElementById('search-input');
    if (!searchInput) return;

    const activeTag = document.activeElement?.tagName;

    /* "/" always focus search (unless already typing an input) */
    if (e.key === '/' && activeTag !== 'INPUT' && activeTag !== 'TEXTAREA') {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
      return;
    }

    /* "Escape" clears search or the random spotlight and closes sort menu */
    if (e.key === 'Escape') {
      const sortMenu = document.getElementById('sort-menu');
      if (sortMenu) {
        sortMenu.classList.add('hidden');
      }

      if (searchInput.value !== '') {
        clearSearch();
      }
      if (suggestedGameId || isShuffling) {
        clearSuggestion();
        randomButton.focus();
      } else {
        searchInput.blur();
      }
    }
  });

  updateActiveSort();
  applyViewMode();
});

