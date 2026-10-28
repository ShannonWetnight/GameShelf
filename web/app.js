const preferenceKeys = ['dynamic-scale','ui-scale','theme','stretch-covers','favorite-stars-only','favorites-first','list-image-click','animation-speed','list-opacity','card-depth','animate-tiles','playlist-enabled','show-hover-text','show-game-titles','hover-game-titles','show-placeholder-images','show-list-images','recent-days','recent-days-v2','view','settings-level'];
const hasSavedPreferences = preferenceKeys.some(key=>localStorage.getItem('gameshelf:'+key)!==null);
function capturePreferences(){
  const values = {'dynamic-scale':dynamicScale,'ui-scale':uiScale,theme:themePreference,'stretch-covers':stretchCovers,'favorite-stars-only':favoriteStarsOnly,'favorites-first':favoritesFirst,'list-image-click':listImageClick,'animation-speed':animationSpeed,'list-opacity':listOpacity,'card-depth':cardDepth,'animate-tiles':animateTiles,'playlist-enabled':playlistEnabled,'show-hover-text':showHoverText,'show-game-titles':showGameTitles,'hover-game-titles':hoverGameTitles,'show-placeholder-images':showPlaceholderImages,'show-list-images':showListImages,'recent-days':recentDays,'recent-days-v2':true,view:currentView,'settings-level':settingsLevel};
  return Object.fromEntries(Object.entries(values).map(([key,value])=>[key,String(value)]));
}
function importPreferences(values){for(const key of preferenceKeys)if(typeof values?.[key]==='string')localStorage.setItem('gameshelf:'+key,values[key]);}
/* =============================
   Global State
   ============================= */
function detectedUIScale(){
 const display=globalThis.screen;const width=Number(display?.width),height=Number(display?.height),ratio=Number(globalThis.devicePixelRatio)||1;
 if(!Number.isFinite(width)||!Number.isFinite(height)||width<1||height<1)return 1;
 const short=Math.min(width,height)*ratio,long=Math.max(width,height)*ratio;
 return short>=2100&&long>=3700?1.5:short>=1400&&long>=2500?1.25:1;
}
let dynamicScale=localStorage.getItem('gameshelf:dynamic-scale')!=='false';
const savedUIScale=Number(localStorage.getItem('gameshelf:ui-scale'));
let uiScale=dynamicScale?detectedUIScale():Number.isFinite(savedUIScale)&&savedUIScale>=.75&&savedUIScale<=1.5?savedUIScale:1;
function applyUIScale(){document.documentElement?.style?.setProperty('--ui-scale',String(uiScale));window.GameShelfMotion?.reset();window.GameShelfSetup?.center?.();}
applyUIScale();
let manualRefreshUntil=0;
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
let themePreference = localStorage.getItem('gameshelf:theme') || 'classic';
let stretchCovers = localStorage.getItem('gameshelf:stretch-covers') === 'true';
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
let shuffleDeck = null;
const storedAnimationSpeed = localStorage.getItem('gameshelf:animation-speed');
let animationSpeed = storedAnimationSpeed !== null && Number.isFinite(Number(storedAnimationSpeed)) && Number(storedAnimationSpeed) >= 0 && Number(storedAnimationSpeed) <= 3 ? Number(storedAnimationSpeed) : localStorage.getItem('gameshelf:disable-effects') === 'true' ? 0 : localStorage.getItem('gameshelf:slow-animations') === 'true' ? .5 : 1.1;
let disableEffects = animationSpeed === 0;
const storedListOpacity = localStorage.getItem('gameshelf:list-opacity');
let listOpacity = storedListOpacity !== null && Number.isFinite(Number(storedListOpacity)) ? Math.max(0, Math.min(100, Number(storedListOpacity))) : 80;
let cardDepth = localStorage.getItem('gameshelf:card-depth') !== 'false';
let animateTiles = localStorage.getItem('gameshelf:animate-tiles') !== 'false';
let settingsLevel = localStorage.getItem('gameshelf:settings-level') === 'advanced' ? 'advanced' : 'basic';
let playlistEnabled = localStorage.getItem('gameshelf:playlist-enabled') !== 'false';
const cartGameIds = new Set();
try { for (const id of JSON.parse(localStorage.getItem('gameshelf:cart') || '[]')) if (typeof id === 'string') cartGameIds.add(id); } catch { /* ignore stale cart */ }
let showHoverText = localStorage.getItem('gameshelf:show-hover-text') !== 'false';
let showGameTitles = localStorage.getItem('gameshelf:show-game-titles') === 'true';
let hoverGameTitles = localStorage.getItem('gameshelf:hover-game-titles') !== 'false';
let showPlaceholderImages = localStorage.getItem('gameshelf:show-placeholder-images') !== 'false';
let showListImages = localStorage.getItem('gameshelf:show-list-images') !== 'false';
let currentView = localStorage.getItem('gameshelf:view') || 'grid';
let detailsGameId = null;
let fileListController = null;

let editorGame = null;
let editorImage = null;
let editorInitialImage = null;
let editorRotation = 0;
let editorMirrored = false;
let editorPan = { x: 0, y: 0 };
let editorLoadVersion = 0;
let editorOpenVersion = 0;
let editorGridTimer;
let editorSnap=true;

const cardMap = new Map(); // game.id -> card element
const openDialogs = new Set();
const observedDialogs = new WeakSet();
const saveFeedbackTimers = new WeakMap();
let notificationTimer;
let notificationHideTimer;
let notificationMotion;

let modalScrollPosition = null;
const motionDuration = duration => Math.round(duration / (animationSpeed || 1));
function applyMotionSpeed() {
  document.body.classList.toggle('gs-no-animations', disableEffects);
  window.GameShelfRain?.refreshBackground?.();
  window.GameShelfAmbience?.refresh();
  for (const animation of document.getAnimations?.() || []) {
    // Shuffle and dialog timers use their own matching duration.
    const target = animation.effect?.target;
    if (animation.id === 'gs-theme-redraw' || animation.id === 'gs-dropdown' || animation.id === 'gs-notification' || animation.id === 'gs-window-resize' || animation.id === 'gs-details-resize' || target?.closest?.('.gs-shuffle-deck, .gs-random') || target?.tagName === 'DIALOG') continue;
    animation.updatePlaybackRate?.(animationSpeed || 1);
  }
}
function openModal(dialog) {
  if (!openDialogs.size) modalScrollPosition = { top: window.scrollY || 0, left: window.scrollX || 0 };
  if (!observedDialogs.has(dialog)) {
    dialog.addEventListener('close', () => {
      openDialogs.delete(dialog);
      const parent = [...openDialogs].filter(item => item.open && !item.dataset.closing).at(-1);
      if (parent) parent.focus?.({ preventScroll: true });
      else document.activeElement?.blur?.();
      if (openDialogs.size === 0) {
        document.body.classList.remove('gs-modal-open');
        document.documentElement?.classList.remove('gs-modal-open');
        if (modalScrollPosition) window.scrollTo?.({ ...modalScrollPosition, behavior: 'instant' });
        modalScrollPosition = null;
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
      motion = dialog.animate([{ opacity: 1, transform: 'translateY(0) scale(1)' }, { opacity: 0, transform: 'translateY(10px) scale(.97)' }], { duration: motionDuration(160), easing: 'ease-in', fill: 'forwards' });
      closeTimer = setTimeout(() => { nativeClose(value); motion.cancel(); closing = false; delete dialog.dataset.closing; }, motionDuration(160));
    };
    dialog.addEventListener('cancel', event => { if (event.target !== dialog || event.defaultPrevented) return; event.preventDefault(); dialog.close(); });
    dialog._cancelMotion = () => { clearTimeout(closeTimer); motion?.cancel(); dialog._openingMotion?.cancel(); closing = false; delete dialog.dataset.closing; };
    observedDialogs.add(dialog);
  }
  dialog._cancelMotion?.();
  dialog.tabIndex = -1;
  dialog.showModal();
  dialog.focus?.({ preventScroll: true });
  if (!disableEffects && !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) dialog._openingMotion = dialog.animate?.(
    [{ opacity: 0, transform: 'translateY(10px) scale(.97)' }, { opacity: 1, transform: 'translateY(0) scale(1)' }],
    { duration: motionDuration(180), easing: 'cubic-bezier(.2,.7,.2,1)' });
  openDialogs.add(dialog);
  document.body.classList.add('gs-modal-open');
  document.documentElement?.classList.add('gs-modal-open');
  if (modalScrollPosition) window.scrollTo?.({ ...modalScrollPosition, behavior: 'instant' });
}

function showNotification(message, variant = 'success') {
  const banner = document.getElementById('notification-banner');
  banner.classList.toggle('gs-notification-warning',variant==='warning');banner.classList.toggle('gs-notification-error',variant==='error');banner.setAttribute('role',variant==='error'||variant==='warning'?'alert':'status');const mark=banner.querySelector?.('.gs-notification-check');if(mark)mark.innerHTML=variant==='error'?'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8m0-8-8 8"/></svg>':variant==='warning'?'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v7m0 4h.01"/></svg>':'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 10 3 3 7-7"/></svg>';
  const visibleDialog = [...openDialogs].filter(dialog => dialog.open && !dialog.dataset.closing).at(-1);
  (visibleDialog || document.body).appendChild(banner);
  document.getElementById('notification-text').textContent = message;
  clearTimeout(notificationTimer);clearTimeout(notificationHideTimer);notificationMotion?.cancel();
  banner.hidden=false;if(banner.showPopover&&!banner.matches(':popover-open'))banner.showPopover();
  banner.classList.remove('gs-notification-leaving');banner.classList.add('gs-notification-visible');
  const animate=(frames,duration)=>{const motion=disableEffects?null:banner.animate?.(frames,{duration:motionDuration(duration),easing:'ease',fill:'both'});if(motion)motion.id='gs-notification';return motion;};
  notificationMotion=animate([{opacity:0,transform:'translate(-50%, -8px)'},{opacity:1,transform:'translate(-50%, 0)'}],200);
  notificationTimer=setTimeout(()=>{notificationMotion?.cancel();banner.classList.remove('gs-notification-visible');banner.classList.add('gs-notification-leaving');
    notificationMotion=animate([{opacity:1,transform:'translate(-50%, 0)'},{opacity:0,transform:'translate(-50%, -8px)'}],180);
    const hide=()=>{if(banner.hidePopover&&banner.matches(':popover-open'))banner.hidePopover();banner.hidden=true;banner.classList.remove('gs-notification-leaving');notificationMotion?.cancel();document.body.appendChild(banner);};
    notificationHideTimer=setTimeout(hide,disableEffects?0:motionDuration(190));
  },3500);
}

function showSaveFeedback(button) {
  clearTimeout(saveFeedbackTimers.get(button));
  button.classList.add('is-saved');
  saveFeedbackTimers.set(button, setTimeout(() => button.classList.remove('is-saved'), 1100));
}

function showDownloadStarted(event) {
  if (event?.currentTarget?.dataset.unavailable === 'true') {
    event.preventDefault();
    showNotification('This library is offline. Reconnect and refresh before downloading.');
    return;
  }
  showNotification('Download started.');
}

function setDownloadAvailability(link, unavailable) {
  link.dataset.unavailable = String(Boolean(unavailable));
  link.setAttribute('aria-disabled', String(Boolean(unavailable)));
  if (unavailable) {
    link.removeAttribute('href');
    link.title = 'Offline: reconnect and refresh before downloading';
  } else {
    link.title = 'Download';
  }
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
    serverSettings = await response.json();syncSetupResume();return true;
  } catch {
    document.getElementById('settings-save-status').textContent = 'Could not load server settings.';return false;
  }
}

async function saveServerSettings(settings) {
  const response = await fetch('/api/server-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
  if (!response.ok) throw new Error((await response.text()).trim() || `HTTP ${response.status}`);
  const result = await response.json();
  serverSettings = result.settings || settings;
  window.GameShelfSetup?.savedSettings(serverSettings);
  return result;
}

async function exportLibraryData() {
  const button = document.getElementById('export-confirm');
  const status = document.getElementById('export-status');
  const dialog = document.getElementById('export-dialog');
  if (button.disabled) return;
  const checked = [...document.querySelectorAll('#export-options input:checked')];
  const includeProfiles=!document.getElementById('export-profile-options').hidden&&document.getElementById('export-profiles').checked;
  if (!checked.length&&!includeProfiles) { showNotification('Select at least one item.','error'); return; }
  const backupKey=includeProfiles?profileBackupKey('export-profile-key'):'';if(includeProfiles&&backupKey===null)return;if(includeProfiles&&!backupKey&&!document.getElementById('export-unprotected-ack').checked){showNotification('Acknowledge the unencrypted backup warning, or enter a passphrase.','error');return;}
  const params = new URLSearchParams({ select: '1' });if(includeProfiles){params.set('profiles','1');if(!backupKey)params.set('unprotected','1');}
  for (const input of checked) {
    if (input.dataset.kind === 'state') params.set('state', '1');
    else if (input.dataset.kind === 'logs') params.set('logs', '1');
    else if (input.dataset.kind === 'settings') params.set('settings', '1');
    else if(input.dataset.kind==='health')params.set('health','1');
    else params.append('cover', input.value);
  }
  button.disabled = true;
  status.textContent = 'Preparing library backup…';
  let downloadURL;
  try {
    const res = await fetch(`/api/library-backup?${params}`, { cache: 'no-store', headers: {'X-GameShelf-Preferences': JSON.stringify(capturePreferences()),...(backupKey?{'X-GameShelf-Backup-Key':backupKey}:{})} });
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
    if(res.status===429){const seconds=Math.max(1,Math.min(60,Number(res.headers.get('Retry-After'))||10));manualRefreshUntil=Date.now()+seconds*1000;showNotification('Please wait '+seconds+' seconds before refreshing again.','warning');document.getElementById('gs-refresh-trigger').classList.add('gs-refresh-limited');setTimeout(()=>document.getElementById('gs-refresh-trigger').classList.remove('gs-refresh-limited'),700);return null;}
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
      button.textContent = added ? '✓' : '+';
    }
  }
  const detailButton = document.getElementById('game-details-cart');
  detailButton.classList.toggle('is-added', cartGameIds.has(detailsGameId));
  detailButton.textContent = cartGameIds.has(detailsGameId) ? '✓' : '+';
  detailButton.setAttribute('aria-label', cartGameIds.has(detailsGameId) ? 'Remove from Playlist' : 'Add to Playlist');
  detailButton.dataset.tooltip = cartGameIds.has(detailsGameId) ? 'Remove from Playlist' : 'Add to Playlist';
  const spotlightButton = document.getElementById('spotlight-cart');
  spotlightButton.classList.toggle('is-added', cartGameIds.has(suggestedGameId));
  spotlightButton.textContent = cartGameIds.has(suggestedGameId) ? '✓' : '+';
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
  if (gamesCache.find(game => game.id === id)?.unavailable) { showNotification('This library is offline. Reconnect and refresh before adding downloads.'); return; }
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
    label.textContent = `${game.name} · ${formatSize(game.sizeBytes)}${game.unavailable ? ' · Offline' : ''}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';remove.className='gs-detail-action';
    remove.setAttribute('aria-label', `Remove ${game.name} from Playlist`);
    remove.addEventListener('click', () => toggleCart(game.id));
    row.append(label, remove);
    list.appendChild(row);
  }
  document.getElementById('cart-total').textContent = selected.length
    ? `${selected.length} game${selected.length === 1 ? '' : 's'} · ${formatSize(selected.reduce((total, game) => total + game.sizeBytes, 0))} estimated before ZIP packaging`
    : 'Your download Playlist is empty.';
  document.getElementById('cart-dialog').classList.toggle('gs-playlist-empty', selected.length === 0);
  document.getElementById('cart-empty-state').hidden = selected.length !== 0;
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
  window.GameShelfRain?.stopAll();
  window.GameShelfAmbience?.stopCovers();
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

const fittedImages = new WeakSet();
function setCoverImage(image, frame, source, label) {
  frame.dataset.coverLabel = label;
  const fit = () => {
    const width = image.naturalWidth, height = image.naturalHeight;
    if (!width || !height) return;
    const ratio = width / height;
    const formats = [['poster', 2/3], ['portrait', 3/4], ['square', 1], ['landscape', 4/3], ['wide', 16/9]];
    const closest = formats.reduce((a,b) => Math.abs(Math.log(ratio/a[1])) < Math.abs(Math.log(ratio/b[1])) ? a : b);
    frame.dataset.coverShape = closest[0];
 const frameRatio=frame.clientWidth/frame.clientHeight || 2/3;
 frame.dataset.coverBackdrop=String(Math.abs(Math.log(ratio/frameRatio)) > .001);
    frame.classList.remove('gs-cover-unavailable');
    frame.style.setProperty?.('--cover-image', 'url(' + JSON.stringify(image.currentSrc || image.src) + ')');
  };
  if (!fittedImages.has(image)) {
    image.addEventListener('load', fit);
    image.addEventListener('error', () => { frame.classList.add('gs-cover-unavailable'); frame.style.removeProperty?.('--cover-image'); });
    fittedImages.add(image);
  }
  image.src = source;
  if (image.complete) fit();
}
function sizeSettingsSelect(select) {
  if (typeof getComputedStyle !== 'function' || !select) return;
  const option = select.options?.[select.selectedIndex];
  const context = document.createElement('canvas').getContext?.('2d');
  if (!option || !context) return;
  context.font = getComputedStyle(select).font;
  select.style.width = (select.id === 'theme-select' ? 190 : Math.ceil(context.measureText('Double-click').width + 40)) + 'px';
  select.style.flexBasis = 'auto';
}

/* =============================
   Card Creation
   ============================= */
function createGameCard(game) {
  const card = document.createElement('article');
  card.className = 'gs-card';
  card.classList.toggle('gs-no-cover', game.hasCover === false);
  let rainEffect = null;
  let rainTheme = null;
  let sparkleEffect = null;
  let sparkleTheme = null;
  card.addEventListener('pointerleave', () => { card.classList.remove('gs-hover-suppressed'); rainEffect?.stop(); rainEffect = null; sparkleEffect?.stop(); sparkleEffect = null; });
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
 setCoverStretch(cover,game);

  const img = document.createElement('img');
  const version = coverVersions.get(game.id);
  const suffix = version ? `?v=${version}` : '';
  img.className = 'gs-cover-image';
  setCoverImage(img, cover, `/covers/${encodeURIComponent(game.id)}${suffix}`, game.name);
  img.alt = `${game.name} cover`;

  cover.appendChild(img);
  const ambience = document.createElement('div');
  ambience.className = 'gs-card-ambience';
  ambience.setAttribute('aria-hidden', 'true');
  const reveal = document.createElement('img');
  reveal.className = 'gs-card-reveal';
  reveal.alt = '';
  ambience.appendChild(reveal);

  card.addEventListener('pointermove', event => {
    const theme = document.body.dataset.theme;
    if (['rain', 'storm', 'autumn'].includes(theme) && !document.getElementById('games-container').classList.contains('list-view')) {
      if (rainTheme !== theme || rainEffect?.stopped) { rainEffect?.stop(); rainEffect = null; }
      rainTheme = theme;
      rainEffect ||= window.GameShelfRain?.start(ambience, theme, () => animationSpeed);
      const bounds = cover.getBoundingClientRect();
      rainEffect?.move(event.clientX - bounds.left, event.clientY - bounds.top);
    } else { rainEffect?.stop(); rainEffect = null; }
    if (['retro', 'rose'].includes(theme) && !document.getElementById('games-container').classList.contains('list-view')) {
      if (sparkleTheme !== theme || sparkleEffect?.stopped) { sparkleEffect?.stop(); sparkleEffect = null; }
      sparkleTheme = theme;
      sparkleEffect ||= window.GameShelfAmbience?.startCover(ambience, theme, () => animationSpeed);
      const bounds = cover.getBoundingClientRect();
      sparkleEffect?.move(event.clientX - bounds.left, event.clientY - bounds.top);
    } else { sparkleEffect?.stop(); sparkleEffect = null; }
    if (!['retro', 'rose', 'midnight', 'lattice'].includes(theme) || document.getElementById('games-container').classList.contains('list-view')) return;
    const bounds = cover.getBoundingClientRect();
    cover.style.setProperty?.('--pointer-x', ((event.clientX - bounds.left) / bounds.width * 100) + '%');
    cover.style.setProperty?.('--pointer-y', ((event.clientY - bounds.top) / bounds.height * 100) + '%');
    if (theme === 'midnight' && reveal.src !== img.src) reveal.src = img.src;
  });
  const star = document.createElement('button');
  star.className = 'gs-favorite-star';
  star.type = 'button';
  star.textContent = game.favorite ? '★' : '☆';
  star.setAttribute('aria-label', game.favorite ? `Remove ${game.name} from favorites` : `Add ${game.name} to favorites`);
  star.title = game.favorite ? 'Remove from favorites' : 'Add to favorites';
  star.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); star.blur(); openFavoriteConfirm(game); });

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
  setDownloadAvailability(dl, game.unavailable);
  dl.addEventListener('click', event => {
    showDownloadStarted(event);
    dl.blur();
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
  cart.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); animateControl(cart); toggleCart(game.id); cart.blur(); });
  actions.appendChild(dl);
  actions.appendChild(cart);
  actions.appendChild(details);
  cover.appendChild(actions);
  cover.appendChild(star);
  cover.appendChild(ambience);
  const hoverTitle = document.createElement('span');
  hoverTitle.className = 'gs-card-hover-title';
  hoverTitle.setAttribute('aria-hidden','true');
  const hoverTitleText = document.createElement('span');
  hoverTitleText.className = 'gs-card-hover-title-text';
  hoverTitleText.textContent = game.name;
  hoverTitle.appendChild(hoverTitleText);
  cover.appendChild(hoverTitle);

  const body = document.createElement('div');
  body.className = 'gs-card-body';

  const listImage = document.createElement('img');
  listImage.className = 'gs-list-image';
  const listFrame=document.createElement('span');listFrame.className='gs-list-cover';setCoverStretch(listFrame,game);
 setCoverImage(listImage,listFrame,game.hasCover === false ? '/placeholder.png' : img.src,game.name);
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
  listFrame.appendChild(listImage);body.appendChild(listFrame);

  const content = document.createElement('div');
  content.className = 'gs-card-content';

  const title = document.createElement('h3');
  title.className = 'gs-card-title';
  title.textContent = game.name;

  content.appendChild(title);
  if (game.unavailable) {
    const offline = document.createElement('small');
    offline.className = 'gs-offline-label';
    offline.textContent = 'Offline · last known files';
    content.appendChild(offline);
  }
  body.appendChild(content);

  card.appendChild(cover);
  card.appendChild(body);

  return card;
}

function openGameDetails(game, trigger, card) {
 game=gamesCache.find(item=>item.id===game.id)||game;
  const dialog = document.getElementById('game-details-dialog');
  fileListController?.abort();
  fileListController = null;
  detailsGameId = game.id;
  document.getElementById('game-details-cart').classList.toggle('is-added', cartGameIds.has(game.id));
  document.getElementById('game-details-cart').textContent = cartGameIds.has(game.id) ? '✓' : '+';
  document.getElementById('game-details-title').textContent = game.name;
  const detailArt = document.getElementById('game-details-art');
  detailArt.classList.toggle('gs-no-cover', game.hasCover === false);
  const imageVersion = coverVersions.get(game.id);
  setCoverImage(document.getElementById('game-details-image'), document.querySelector?.('.gs-details-art-frame') || document.getElementById('game-details-art'), `/covers/${encodeURIComponent(game.id)}${imageVersion ? `?v=${imageVersion}` : ''}`, game.name);
  setCoverStretch(document.querySelector?.('.gs-details-art-frame'),game);syncCoverStretchControl(game);
  document.getElementById('game-details-image-title').textContent = game.name;
  document.getElementById('game-title-input').value = game.name;
  document.getElementById('game-details-path').textContent = game.location || game.path || '';document.getElementById('game-details-path').dataset.tooltip=game.location||game.path||'';
  document.getElementById('game-details-size').textContent = formatSize(game.sizeBytes);
  document.getElementById('game-details-download').href = `/download/${encodeURIComponent(game.id)}`;
  setDownloadAvailability(document.getElementById('game-details-download'), game.unavailable);
  const fileSummary = Number.isInteger(game.fileCount) ? `${game.fileCount} ${game.fileCount === 1 ? 'file' : 'files'} · ` : '';
  document.getElementById('game-details-download-summary').textContent = game.unavailable ? `Offline · last known: ${fileSummary}${formatSize(game.sizeBytes)}` : `${fileSummary}${formatSize(game.sizeBytes)} ZIP`;
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

  dialog.addEventListener('close', () => {
    if (dialog.open) return;
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
      setDownloadAvailability(download, result.unavailable);
      download.addEventListener('click', showDownloadStarted);
      item.appendChild(name);
      item.appendChild(size);
      item.appendChild(download);
      list.appendChild(item);
    }
    status.textContent = result.unavailable ? 'Offline: showing the last known file list. Reconnect and refresh to download.' : result.truncated
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
  context.scale(editorMirrored ? -scale : scale, scale);
  context.drawImage(editorImage, -editorImage.width / 2, -editorImage.height / 2);
  context.restore();
}

function openCoverEditor(game) {
  const save = document.getElementById('cover-editor-save');
  clearTimeout(saveFeedbackTimers.get(save));
  save.classList.remove('is-saved');
  editorGame = game;syncCoverStretchControl(game);
  editorImage = null;
  editorInitialImage = null;
  editorLoadVersion++;
  const openVersion = ++editorOpenVersion;
  editorRotation = 0;editorMirrored=false;
  editorPan = { x: 0, y: 0 };
  document.getElementById('cover-editor-title').textContent = game.name;
  document.getElementById('cover-editor-file').value = '';
  document.getElementById('cover-zoom').value = '1';
  document.getElementById('cover-tilt').value = '0';
  updateCoverReadouts();
  document.getElementById('cover-editor-status').textContent = '';
  document.getElementById('cover-editor-save').disabled = true;
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
  document.getElementById('cover-zoom').dataset.tooltip = 'Zoom: '+ `${Math.round(Number(document.getElementById('cover-zoom').value) * 100)}%`;
  document.getElementById('cover-tilt').dataset.tooltip = 'Tilt: '+ `${Number(document.getElementById('cover-tilt').value)}°`;
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
      editorRotation = 0;editorMirrored=false;
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
  document.getElementById('cover-editor-cancel').addEventListener('click', () => dialog.close());
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
    editorRotation = 0;editorMirrored=false;
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
  document.getElementById('cover-editor-file').addEventListener('cancel', event => event.stopPropagation());
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
      editorRotation = 0;editorMirrored=false;
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
  document.getElementById('cover-rotate-left').addEventListener('click', () => { editorRotation -= 90;animateControl(document.getElementById('cover-rotate-left')); updateCoverReadouts(); showCoverGrid(); drawCoverEditor(); });
  document.getElementById('cover-mirror').addEventListener('click',()=>{editorMirrored=!editorMirrored;animateControl(document.getElementById('cover-mirror'));showCoverGrid();drawCoverEditor();});
  for (const id of ['cover-zoom', 'cover-tilt']) document.getElementById(id).addEventListener('input', () => { updateCoverReadouts(); showCoverGrid(); drawCoverEditor(); });
  const snapButton=document.getElementById('cover-snap');
  snapButton.addEventListener('click',()=>{editorSnap=!editorSnap;snapButton.setAttribute('aria-pressed',String(editorSnap));snapButton.dataset.tooltip=editorSnap?'Disable edge snapping':'Enable edge snapping';snapButton.setAttribute('aria-label',snapButton.dataset.tooltip);animateControl(snapButton);});
  let pointer = null;
  canvas.addEventListener('pointerdown', event => {
    if (!editorImage) return;
    pointer = { x:event.clientX,y:event.clientY,panX:editorPan.x,panY:editorPan.y };
    showCoverGrid();
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => {
    if (!pointer) return;
    editorPan.x = pointer.panX + (event.clientX - pointer.x) * canvas.width / canvas.getBoundingClientRect().width;
    editorPan.y = pointer.panY + (event.clientY - pointer.y) * canvas.height / canvas.getBoundingClientRect().height;
    if(editorSnap){
      const angle=(editorRotation+Number(document.getElementById('cover-tilt').value))*Math.PI/180,c=Math.abs(Math.cos(angle)),n=Math.abs(Math.sin(angle));
      const scale=Math.max((canvas.width*c+canvas.height*n)/editorImage.width,(canvas.width*n+canvas.height*c)/editorImage.height)*Number(document.getElementById('cover-zoom').value);
      const width=(editorImage.width*c+editorImage.height*n)*scale,height=(editorImage.width*n+editorImage.height*c)*scale;
      const threshold=8*canvas.width/canvas.getBoundingClientRect().width;
      const snap=(value,extent,bounds)=>{const points=[0,(extent-bounds)/2,(bounds-extent)/2];const nearest=points.reduce((a,b)=>Math.abs(b-value)<Math.abs(a-value)?b:a);return Math.abs(nearest-value)<threshold?nearest:value;};
      editorPan.x=snap(editorPan.x,width,canvas.width);editorPan.y=snap(editorPan.y,height,canvas.height);
    }
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
        if (document.getElementById('game-details-dialog').open && detailsGameId === game.id) {
          document.getElementById('game-details-image').src = '/covers/' + encodeURIComponent(game.id) + '?v=' + coverVersions.get(game.id);
          document.getElementById('game-details-art').classList.remove('gs-no-cover');
          document.getElementById('game-details-cover').textContent = 'Uploaded';
          document.getElementById('edit-game-cover').textContent = 'Edit Cover';
        }
        showNotification('Cover art saved.');
      }, 850);
    } catch (error) {
      if (!isCurrentSession()) return;
      status.textContent = 'Could not save cover. Please try again.';
      save.disabled = false;
    }
  });
}

function closeOnBackdropClick(dialog, close = () => dialog.close(), region = dialog) {
  let startedOutside=false,endedOutside=false;
  const outside=event=>{const rect=region.getBoundingClientRect();return event.target===dialog&&(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom);};
  dialog.addEventListener('pointerdown',event=>{startedOutside=event.button===0&&outside(event);endedOutside=false;});
  dialog.addEventListener('pointerup',event=>{endedOutside=outside(event);});
  dialog.addEventListener('pointercancel',()=>{startedOutside=endedOutside=false;});
  dialog.addEventListener('click',event=>{const dismiss=startedOutside&&endedOutside&&outside(event);startedOutside=endedOutside=false;if(dismiss)close();});
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
  shuffleDeck?.remove();
  shuffleDeck = null;
  for (const card of cardMap.values()) card.classList.remove('gs-shuffle-anchor');
  document.getElementById('random-game').classList.remove('is-rolling');
  cardMap.get(suggestedGameId)?.classList.remove('gs-random-selected', 'gs-spotlight-enter', 'gs-shuffle-confirm');
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

  clearSuggestion();
  if (currentSearch) clearSearch();
  document.getElementById('games-container').classList.add('gs-spotlight');
  document.getElementById('library-stage').classList.add('gs-spotlight-stage');

  let deckWasShown=false;
  function showFinalGame() {
    shuffleTimers = [];
    shuffleDeck?.remove();
    shuffleDeck = null;
    card.classList.remove('gs-shuffle-anchor');
    diceButton.classList.remove('is-rolling');
    shuffleGameId = null;
    isShuffling = false;
    suggestedGameId = game.id;
    card.classList.add('gs-random-selected');
    // The deck's final movement now supplies the settle; the real card keeps its geometry.
    card.classList.remove('gs-shuffle-confirm','gs-tile-fill');
    diceButton.disabled = false;
    diceButton.dataset.tooltip = 'Suggest a random game';
    applyViewMode();
    applySearchFilter();

    if(!deckWasShown)card.scrollIntoView?.({ block: 'center',behavior:'instant' });
    const returnActions = document.getElementById('spotlight-actions');
    const spotlightDownload = document.getElementById('spotlight-download');
    spotlightDownload.href = `/download/${encodeURIComponent(game.id)}`;
    spotlightDownload.setAttribute('aria-label', `Download ${game.name}`);
    setDownloadAvailability(spotlightDownload, game.unavailable);
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

  isShuffling = true;deckWasShown=true;
  shuffleGameId = game.id;
  diceButton.disabled = true;
  diceButton.dataset.tooltip = 'Choosing a game…';
  const duration = motionDuration(1200);
  diceButton.style.setProperty?.('--dice-roll-duration', duration + 'ms');
  const container = document.getElementById('games-container');
  container.style.setProperty?.('--shuffle-duration', duration + 'ms');
  applyViewMode();
  applySearchFilter();
  card.classList.add('gs-shuffle-anchor');
  const deck = document.createElement('div');
  deck.className = 'gs-shuffle-deck';
  deck.setAttribute('aria-hidden', 'true');
  const firstPreview = alternatives[Math.floor(Math.random() * alternatives.length)];
  const previews = [firstPreview, alternatives.find(candidate => candidate.id !== firstPreview.id) || firstPreview, game];
  for (const preview of previews) {
    const face = document.createElement('div');face.className = 'gs-shuffle-face';setCoverStretch(face,preview);
 const resultFrame=card.querySelector('.gs-card-cover');if(resultFrame.clientWidth&&resultFrame.clientHeight){face.style.width=resultFrame.clientWidth+'px';face.style.height=resultFrame.clientHeight+'px';face.style.top=(resultFrame.offsetTop||0)+'px';}
 const previewImage=document.createElement('img');previewImage.alt='';setCoverImage(previewImage,face,cardMap.get(preview.id).querySelector('.gs-card-cover').querySelector('img').src,preview.name);face.appendChild(previewImage);
    deck.appendChild(face);
  }
  container.appendChild(deck);
  shuffleDeck = deck;
  void diceButton.offsetWidth;
  diceButton.classList.add('is-rolling');
  shuffleTimers.push(setTimeout(showFinalGame, duration));
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
    if(games===null)return null;

    // Commit the new library only after the request and response validation succeed.
    if (isRefresh) {
      coverVersions.clear();
      refreshGeneration++;
      games.forEach(game => coverVersions.set(game.id, refreshGeneration));
    }

    const refreshingExisting = isRefresh && cardMap.size > 0;
    if(refreshingExisting && !disableEffects && !matchMedia('(prefers-reduced-motion: reduce)').matches) await container.animate?.([{opacity:1},{opacity:.35}],{duration:motionDuration(140),easing:'ease-out'})?.finished?.catch(()=>{});
    if(isRefresh)clearSearch();
    clearSuggestion();
    gamesCache = games;
    cardMap.clear();
    container.innerHTML = '';
    gamesCache.forEach((game, index) => {
      const card = createGameCard(game);
      if (animateTiles && !disableEffects && !refreshingExisting) {
        card.classList.add('gs-tile-fill');
        card.style.animationDelay = `${Math.min(index * 18, 180)}ms`;
      }
      cardMap.set(game.id, card);
      container.appendChild(card);
    });
    if(refreshingExisting && !disableEffects && !matchMedia('(prefers-reduced-motion: reduce)').matches) container.animate?.([{opacity:.35},{opacity:1}],{duration:motionDuration(220),easing:'ease-out'});
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
  if (!['random', 'system', 'classic', 'light', 'dark', 'retro', 'neon', 'cartridge', 'cosmos', 'ion', 'rose', 'midnight', 'lattice', 'rain', 'storm', 'autumn'].includes(themePreference)) themePreference = 'classic';
  const randomThemes=[...themeSelect.options].map(option=>option.value).filter(value=>!['system','random'].includes(value));
  const sessionTheme=randomThemes[Math.floor(Math.random()*randomThemes.length)];
  function applyTheme(preference = themePreference) {
    const theme = preference === 'random' ? sessionTheme : preference === 'system' ? (themeMedia.matches ? 'dark' : 'light') : preference;
    if (document.documentElement) document.documentElement.dataset.theme = theme;
    window.GameShelfRain?.stopAll();
    document.body.dataset.theme = theme;
    window.GameShelfRain?.setTheme?.(theme, () => animationSpeed);
    window.GameShelfAmbience?.setTheme(theme, () => animationSpeed);
    themeSelect.value = themePreference;
    sizeSettingsSelect(themeSelect);
  }
  applyTheme();
  themeMedia.addEventListener?.('change', () => { if (themePreference === 'system') applyTheme(); });
  let themeRedrawVersion = 0, themeMotions = [];
  async function redrawTheme(preference) {
    const resolved=preference==='random'?sessionTheme:preference==='system'?(themeMedia.matches?'dark':'light'):preference;
    if(document.documentElement?.dataset.theme===resolved&&!themeMotions.length)return;
    const version=++themeRedrawVersion;themeMotions.forEach(motion=>motion.cancel());
    const surfaces=[document.body,...[...openDialogs].filter(dialog=>dialog.open)];
    const animate=(surface,frames,duration)=>{const motion=surface.animate(frames,{duration:motionDuration(duration),easing:'ease',fill:'forwards'});motion.id='gs-theme-redraw';return motion;};
    const reduced=disableEffects||globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches||!document.body.animate;
    if(!reduced){themeMotions=surfaces.map(surface=>animate(surface,[{opacity:1},{opacity:.4}],90));await Promise.all(themeMotions.map(m=>m.finished.catch(()=>{})));}
    if(version!==themeRedrawVersion)return;
    document.body.classList.add('gs-theme-committing');applyTheme(preference);void document.body.offsetWidth;
    if(!reduced){if(version!==themeRedrawVersion)return;themeMotions.forEach(m=>m.cancel());themeMotions=surfaces.map(surface=>animate(surface,[{opacity:.4},{opacity:1}],180));await Promise.all(themeMotions.map(m=>m.finished.catch(()=>{})));}
    if(version===themeRedrawVersion){themeMotions.forEach(m=>m.cancel());themeMotions=[];document.body.classList.remove('gs-theme-committing');}
  }
  themeSelect.addEventListener('change',()=>{themePreference=themeSelect.value;localStorage.setItem('gameshelf:theme',themePreference);redrawTheme(themePreference);});
  window.GameShelfTheme={preview:redrawTheme,restore:()=>redrawTheme(themePreference)};
  document.body.classList.toggle('gs-pin-favorite-stars', favoriteStarsOnly);
  document.body.classList.toggle('gs-hide-tooltips', !showHoverText);
  document.body.classList.toggle('gs-show-game-titles', showGameTitles);
  document.body.classList.toggle('gs-show-placeholders', showPlaceholderImages);
  document.body.classList.toggle('gs-show-list-images', showListImages);
  document.body.classList.toggle('gs-no-animations', disableEffects);
  loadVersion();
  const begin=async()=>{if(window.GameShelfProfiles&&!await window.GameShelfProfiles.initialize())return;if(window.GameShelfSetup)window.GameShelfSetup.boot();else{document.body.classList.remove('gs-booting');loadServerSettings();loadGames();}};
  if(window.GameShelfAccess)window.GameShelfAccess.initialize().then(begin).catch(()=>{document.getElementById('boot-message').textContent='Could not load family controls. Reload to try again.';document.getElementById('boot-retry').hidden=false;});else begin();

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
    if(isRefresh&&Date.now()<manualRefreshUntil){
      clearTimeout(refreshFeedbackTimer);refreshFeedbackTimer=null;logoText.textContent='REFRESH';logoText.classList.remove('bounce');trigger.classList.remove('gs-refresh-limited');void trigger.offsetWidth;trigger.classList.add('gs-refresh-limited');setTimeout(()=>trigger.classList.remove('gs-refresh-limited'),700);
      showNotification('Please wait '+Math.ceil((manualRefreshUntil-Date.now())/1000)+' seconds before refreshing again.','warning');return;
    }
    trigger.classList.remove('gs-refresh-limited');
    if (refreshLock || isLoading) return;

    clearTimeout(refreshFeedbackTimer);
    refreshFeedbackTimer = null;
    refreshLock = true;
    logoText.textContent = originalText;
    const stage = document.getElementById('library-stage');
    if (!disableEffects) stage.classList.add('gs-refreshing');

    const succeeded = await loadGames(isRefresh);
    if(isRefresh&&succeeded===true)manualRefreshUntil=Date.now()+10000;
    stage.classList.remove('gs-refreshing');
    if(succeeded===null){refreshLock=false;logoText.textContent=refreshHovered?'REFRESH':originalText;return;}
    if (succeeded && !isRefresh) {
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
      localStorage.setItem('gameshelf:view', currentView);recordSettingChange({view:currentView});
      document.getElementById('sort-heading').classList.add('hidden');
      document.getElementById('sort-menu').classList.add('hidden');
      document.getElementById('sort-button').classList.remove('gs-control-active');
      document.body.classList.remove('gs-sort-open');
      updateSortIcon('all');
      applySort();
      applyViewMode();
      applySearchFilter();
    };
    if (document.startViewTransition && !disableEffects && !uiWindow.matchMedia('(prefers-reduced-motion: reduce)').matches) document.startViewTransition(resetHome);
    else {
      resetHome();
      const stage = document.getElementById('library-stage');
      stage.classList.remove('gs-home-enter');
      void stage.offsetWidth;
      stage.classList.add('gs-home-enter');
    }
    uiWindow.scrollTo({ top: 0, behavior: disableEffects || uiWindow.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
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
    if (gamesCache.some(game => cartGameIds.has(game.id) && game.unavailable)) { showNotification('A Playlist library is offline. Remove those games or reconnect and refresh.'); return; }
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
    if (event.currentTarget.dataset.unavailable === 'true') { showDownloadStarted(event); return; }
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
  document.getElementById('restore-browse').addEventListener('click',()=>document.getElementById('restore-file').click());
  document.getElementById('restore-file').addEventListener('change',event=>{document.getElementById('restore-file-name').textContent=event.target.files?.[0]?.name||'No file chosen';});
  const settingsButton = document.getElementById('build-info');
  const settingsDialog = document.getElementById('settings-dialog');
  const detailsDialog = document.getElementById('game-details-dialog');
  const scaleInput=document.getElementById('ui-scale'),dynamicInput=document.getElementById('dynamic-scale');
  function syncUIScale(){scaleInput.value=String(uiScale);scaleInput.disabled=dynamicScale;dynamicInput.checked=dynamicScale;document.getElementById('ui-scale-value').textContent=Math.round(uiScale*100)+'%';}
  let scaleTransition=0,scaleMotions=[];
  async function transitionScale(value){
    const generation=++scaleTransition;scaleMotions.forEach(m=>m.cancel());
    const surfaces=[document.body,...[...openDialogs].filter(dialog=>dialog.open)],reduced=disableEffects||globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const fade=(from,to)=>surfaces.map(surface=>surface.animate?.([{opacity:from},{opacity:to}],{duration:motionDuration(110),easing:'ease',fill:'forwards'})).filter(Boolean);
    let motions=[];if(!reduced){motions=fade(1,.35);scaleMotions=motions;await Promise.all(motions.map(m=>m.finished.catch(()=>{})));}if(generation!==scaleTransition)return;
    uiScale=value;localStorage.setItem('gameshelf:ui-scale',String(uiScale));applyUIScale();syncUIScale();
    motions.forEach(m=>m.cancel());if(!reduced){motions=fade(.35,1);scaleMotions=motions;await Promise.all(motions.map(m=>m.finished.catch(()=>{})));motions.forEach(m=>m.cancel());}
  }
  syncUIScale();
  scaleInput.addEventListener('input',()=>{document.getElementById('ui-scale-value').textContent=Math.round(Number(scaleInput.value)*100)+'%';});
  scaleInput.addEventListener('change',async()=>{if(dynamicScale)return;await transitionScale(Math.max(.75,Math.min(1.5,Number(scaleInput.value))));recordSettingChange({'ui-scale':String(uiScale)});showNotification('UI Scale saved.');});
  dynamicInput.addEventListener('change',async()=>{dynamicScale=dynamicInput.checked;localStorage.setItem('gameshelf:dynamic-scale',String(dynamicScale));await transitionScale(dynamicScale?detectedUIScale():uiScale);recordSettingChange({'dynamic-scale':String(dynamicScale)});showNotification('Dynamic resolution scaling saved.');});
  let displayResize;globalThis.addEventListener?.('resize',()=>{clearTimeout(displayResize);if(dynamicScale)displayResize=setTimeout(()=>{const next=detectedUIScale();if(next!==uiScale)transitionScale(next);},150);});
  document.addEventListener('wheel',event=>{if(event.ctrlKey||event.metaKey)event.preventDefault();},{passive:false});
  document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&['+','=','-','0'].includes(event.key))event.preventDefault();});
  const speedInput = document.getElementById('animation-speed');
  const hoverTextInput = document.getElementById('show-hover-text');
  const gameTitlesInput = document.getElementById('show-game-titles');
  const hoverTitlesInput = document.getElementById('hover-game-titles');
  function syncHoverTitles() {
    hoverTitlesInput.checked = hoverGameTitles; hoverTitlesInput.disabled = showGameTitles;
    document.getElementById('hover-game-titles-option').classList.toggle('gs-disabled', showGameTitles);
    document.body.classList.toggle('gs-hover-game-titles', hoverGameTitles && !showGameTitles);
  }
  syncHoverTitles();
  hoverTitlesInput.addEventListener('change', () => { hoverGameTitles = hoverTitlesInput.checked; localStorage.setItem('gameshelf:hover-game-titles', String(hoverGameTitles)); syncHoverTitles(); });
  const placeholderInput = document.getElementById('show-placeholder-images');
  const listImagesInput = document.getElementById('show-list-images');
  const instantPreferences = {
    'theme-select': 'Theme', 'animation-speed': 'Animation speed', 'list-opacity': 'List tile opacity', 'card-depth': 'Card depth',
    'animate-tiles': 'Loaded game tile animation', 'show-hover-text': 'Button hints', 'show-game-titles': 'Game titles',
    'show-placeholder-images': 'Placeholder images', 'hover-game-titles': 'Hover game titles', 'favorites-first': 'Favorites order', 'show-list-images': 'List images',
    'stretch-covers':'Cover stretching', 'enable-playlist': 'Playlist downloads', 'favorite-stars-only': 'Favorite stars', 'expand-list-image': 'List image expansion'
  };
  // Schedule after the saving listeners have applied each preference.
  for (const [id, label] of Object.entries(instantPreferences)) document.getElementById(id).addEventListener('change', () => {
    Promise.resolve().then(() => {showNotification(label + ' saved.');const keys={'theme-select':'theme','expand-list-image':'list-image-click','enable-playlist':'playlist-enabled'};const key=keys[id]||id;recordSettingChange({[key]:capturePreferences()[key]});});
  });
  const stretchInput=document.getElementById('stretch-covers');stretchInput.checked=stretchCovers;
  stretchInput.addEventListener('change',()=>{stretchCovers=stretchInput.checked;localStorage.setItem('gameshelf:stretch-covers',String(stretchCovers));for(const game of gamesCache)refreshCoverFit(game);});
  document.getElementById('game-cover-stretch').addEventListener('click',saveCoverStretch);
  document.getElementById('resume-setup').addEventListener('click',async()=>{try{const response=await fetch('/api/setup/restart',{method:'POST'});if(!response.ok)throw new Error((await response.text()).trim());window.location.reload();}catch(error){showNotification(error.message);}});
  const playlistInput = document.getElementById('enable-playlist');
  const animateTilesInput = document.getElementById('animate-tiles');
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

  });
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
    if(level==='advanced'&&window.GameShelfAccess&&!await window.GameShelfAccess.enter('advanced'))return;
    changingSettingsLevel = true;
    const before = settingsDialog.getBoundingClientRect?.().height;
    if (level === 'basic' && !disableEffects && !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      const exits = Array.from(settingsDialog.querySelectorAll('[data-setting-level="advanced"]')).map(node =>
        node.animate?.([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-5px)' }],
          { duration: motionDuration(220), easing: 'ease-in', fill: 'forwards' }));
      await Promise.all(exits.map(animation => animation?.finished?.catch(() => {})));
      exits.forEach(animation => animation?.cancel());
    }
    settingsLevel = level;
    localStorage.setItem('gameshelf:settings-level', level);recordSettingChange({'settings-level':level});
    applySettingsLevel();
    const after = settingsDialog.getBoundingClientRect?.().height;
    if (!window.GameShelfMotion && !disableEffects && before && after && before !== after) settingsDialog.animate?.(
      [{ height: `${before}px`, overflow: 'hidden' }, { height: `${after}px`, overflow: 'hidden' }],
      { duration: motionDuration(240), easing: 'cubic-bezier(.22,.7,.2,1)' }
    );
    changingSettingsLevel = false;
  });

  animateTilesInput.addEventListener('change', () => {
    animateTiles = animateTilesInput.checked;
    localStorage.setItem('gameshelf:animate-tiles', String(animateTiles));
  });


  settingsButton.addEventListener('click', async () => {
    animateControl(settingsButton);
    if (document.body.classList.contains('gs-needs-setup')) {window.GameShelfSetup?.openOptions();return;}
    if(window.GameShelfAccess&&!await window.GameShelfAccess.enter('settings'))return;
    if(window.GameShelfAccess&&!window.GameShelfAccess.canUse('advanced')){settingsLevel='basic';applySettingsLevel();}
    openModal(settingsDialog);

  });
  const exportDialog = document.getElementById('export-dialog');
  const exportOptions = document.getElementById('export-options');
  const exportAll = document.getElementById('export-all');
  function syncExportSelection(){const options=[...exportOptions.querySelectorAll('input')].filter(input=>!input.disabled);if(!document.getElementById('export-profile-options').hidden)options.push(document.getElementById('export-profiles'));exportAll.checked=options.length>0&&options.every(input=>input.checked);exportAll.indeterminate=!exportAll.checked&&options.some(input=>input.checked);}
  document.getElementById('export-library-data').addEventListener('click', async () => {
    exportOptions.replaceChildren();
    const groups = [
      { title: 'GameShelf data', items: [{ id: 'state', kind: 'state', name: 'Library state (JSON)' }, { id: 'settings', kind: 'settings', name: 'Server settings (JSON)' }, { id: 'logs', kind: 'logs', name: 'Recent logs (TXT)' },{id:'health',kind:'health',name:'Library health history (JSON)'}] },
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
        const action=item.kind==='logs'?'logs':item.kind==='health'?'healthView':null;if(action&&window.GameShelfAccess?.mode(action)==='disable'){input.checked=false;input.disabled=true;}
        input.addEventListener('change', syncExportSelection);
        label.append(input, document.createTextNode(item.name));
        section.appendChild(label);
      }
      exportOptions.appendChild(section);
    }
    exportAll.checked = true; exportAll.indeterminate = false;
    document.getElementById('export-status').textContent = '';
    document.getElementById('export-credentials-note').hidden = !(serverSettings?.sources || []).some(source => source.protocol !== 'nfs' && (source.hasPassword || source.username));
    document.getElementById('export-profile-key').value='';document.getElementById('export-profile-key').type='password';if(typeof Event==='function')document.getElementById('export-profile-key').dispatchEvent(new Event('input'));document.getElementById('export-unprotected-ack').checked=false;document.getElementById('export-unprotected-option').hidden=false;document.getElementById('export-profile-options').hidden=true;document.getElementById('export-profiles').checked=false;
    if(window.GameShelfProfiles){try{const available=await GameShelfProfiles.hasProfiles();document.getElementById('export-profile-options').hidden=!available;document.getElementById('export-profiles').checked=available;document.getElementById('export-profile-key-field').hidden=!available;}catch{/* A normal export remains available. */}}
    openModal(exportDialog);
  });
  exportAll.addEventListener('change', () => { exportOptions.querySelectorAll('input').forEach(input => { if(!input.disabled)input.checked = exportAll.checked; }); exportAll.indeterminate = false;if(!document.getElementById('export-profile-options').hidden){document.getElementById('export-profiles').checked=exportAll.checked;document.getElementById('export-profile-key-field').hidden=!exportAll.checked;} });
  document.getElementById('export-profiles').addEventListener('change',()=>{document.getElementById('export-profile-key-field').hidden=!document.getElementById('export-profiles').checked;syncExportSelection();});
  exportDialog.addEventListener('close',()=>document.getElementById('export-profile-key').value='');
  document.getElementById('export-confirm').addEventListener('click', exportLibraryData);
  for (const id of ['export-close', 'export-cancel']) document.getElementById(id).addEventListener('click', () => exportDialog.close());
  closeOnBackdropClick(exportDialog);
  const restoreDialog = document.getElementById('restore-dialog');
  const restoreFile = document.getElementById('restore-file');
  const restoreApply = document.getElementById('restore-apply');
  const restoreStatus = document.getElementById('restore-status');
  const restorePreviewPanel = document.getElementById('restore-preview');
  const restoreChoices = ['restore-state', 'restore-covers', 'restore-settings','restore-health','restore-profiles'].map(id => document.getElementById(id));
  let restorePreview = null;
  let restoreVersion = 0;
  const updateRestoreButton = () => {
    restoreApply.disabled = !restorePreview || !document.getElementById('restore-ack').checked || !restoreChoices.some(input => input.checked);
  };
  document.getElementById('open-library-restore').addEventListener('click', () => {
    restoreVersion++;
    restorePreview = null;
    restoreFile.value = '';document.getElementById('restore-file-name').textContent='No file chosen';document.getElementById('restore-profile-key').value='';document.getElementById('restore-profile-option').hidden=true;document.getElementById('restore-profile-key-field').hidden=true;
    restorePreviewPanel.hidden = true;
    restoreStatus.textContent = '';
    document.getElementById('restore-ack').checked = false;
    updateRestoreButton();
    const setupMode=document.body.classList.contains('gs-needs-setup');
    restoreDialog.dataset.setupImport=String(setupMode);
    document.getElementById('restore-title').textContent=setupMode?'Import GameShelf Data':'Restore Library Data';
    document.getElementById('restore-intro').textContent=setupMode?'Import a GameShelf backup ZIP to restore your library data, server settings, and appearance choices, then open your shelf without completing setup. Your games stay in their original locations. Share passwords are never included and must be entered again.':'Choose a GameShelf backup ZIP to preview. Restoring replaces selected app data; game folders remain read-only.';
    document.getElementById('restore-credentials-note').hidden=true;document.getElementById('restore-family-note').hidden=true;
    openModal(restoreDialog);
  });
  for (const id of ['restore-close', 'restore-cancel']) document.getElementById(id).addEventListener('click', () => restoreDialog.close());
  closeOnBackdropClick(restoreDialog);
  restoreDialog.addEventListener('close', () => { restoreVersion++; restorePreview = null;document.getElementById('restore-profile-key').value=''; });
  for (const input of [...restoreChoices, document.getElementById('restore-ack')]) input.addEventListener('change', ()=>{updateRestoreButton();document.getElementById('restore-profile-key-field').hidden=!restoreChoices[4].checked;});
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
      document.getElementById('restore-credentials-note').hidden=!preview.requiresLogin;
      const available = [preview.state, preview.covers > 0, preview.settings,preview.health===true,preview.profiles===true];
      document.getElementById('restore-family-note').hidden=!preview.requiresPIN;
      restoreChoices.forEach((input, index) => { input.checked = available[index]; input.disabled = !available[index]; });document.getElementById('restore-profile-option').hidden=!preview.profiles;document.getElementById('restore-profile-key-field').hidden=!preview.profiles;
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
    const backupKey=restoreChoices[4].checked?profileBackupKey('restore-profile-key'):'';if(restoreChoices[4].checked&&!backupKey)return;
    restoreApply.disabled = true;
    restoreStatus.textContent = 'Restoring selected data…';
    const selected = new URLSearchParams({ apply: '1' });
    for (const [index, key] of ['state', 'covers', 'settings','health','profiles'].entries()) if (restoreChoices[index].checked) selected.set(key, '1');
    try {
      const response = await fetch(`/api/library-restore?${selected}`, { method: 'POST', headers: { 'Content-Type': 'application/zip', 'X-Preview-SHA256': restorePreview.sha256,...(backupKey?{'X-GameShelf-Backup-Key':backupKey}:{}) }, body: restoreFile.files[0] });
      if (!response.ok) throw new Error((await response.text()).trim());
      const result = await response.json();
      restoreDialog.close();
      if (restoreChoices[2].checked) importPreferences(result.preferences || restorePreview?.preferences);
      const message=result.restartRequired?'Library data restored. Restart the container to apply the data location.':result.requiresLogin?'Data restored. Enter share passwords in Advanced Settings → Library Manager → Library Sources.':result.scanWarning||'Library data restored.';
      if(restoreChoices[4].checked||result.setupComplete || (restoreChoices[2].checked && result.preferences && Object.keys(result.preferences).length)) {
        localStorage.setItem('gameshelf:restore-notice',message);window.location.reload();return;
      }
      showNotification(message);loadServerSettings();loadGames();window.GameShelfSetup?.watchScan();
    } catch (error) { restoreStatus.textContent = `Could not restore backup: ${error.message}`; updateRestoreButton(); }
  });
  const favoriteDialog = document.getElementById('favorite-dialog');
  document.getElementById('game-details-favorite').addEventListener('click', () => { const game = gamesCache.find(item => item.id === detailsGameId); if (game) openFavoriteConfirm(game); });
  document.getElementById('game-details-favorite-mobile').addEventListener('click', () => { const game = gamesCache.find(item => item.id === detailsGameId); if (game) openFavoriteConfirm(game); });
  document.getElementById('favorite-confirm').addEventListener('click', saveFavorite);
  for (const id of ['favorite-close', 'favorite-cancel']) document.getElementById(id).addEventListener('click', () => favoriteDialog.close());
  closeOnBackdropClick(favoriteDialog);
  favoriteDialog.addEventListener('close', () => {
    const card = favoritePending && cardMap.get(favoritePending.id);
    card?.querySelector('.gs-favorite-star')?.blur();
  });
  const favoritesFirstInput = document.getElementById('favorites-first');
  favoritesFirstInput.checked = favoritesFirst;
  favoritesFirstInput.addEventListener('change', () => {
    favoritesFirst = favoritesFirstInput.checked;
    localStorage.setItem('gameshelf:favorites-first', String(favoritesFirst));
    applySort();
  });
  const starsOnlyInput = document.getElementById('favorite-stars-only');
  function syncStarSettings() {
    starsOnlyInput.checked = favoriteStarsOnly;
    document.body.classList.toggle('gs-pin-favorite-stars', favoriteStarsOnly);
  }
  syncStarSettings();
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
    showSaveFeedback(document.getElementById('recent-settings-save'));
    applySearchFilter(); recentDialog.close(); recordSettingChange({'recent-days':String(recentDays)});showNotification('Recently Added range saved.');
  });
  const expandInput = document.getElementById('expand-list-image');
  expandInput.value = listImageClick;
  sizeSettingsSelect(expandInput);
  document.body.classList.toggle('gs-expand-list-image', listImageClick !== 'disabled');
  expandInput.addEventListener('change', () => { listImageClick = expandInput.value; sizeSettingsSelect(expandInput); localStorage.setItem('gameshelf:list-image-click', listImageClick); document.body.classList.toggle('gs-expand-list-image', listImageClick !== 'disabled'); });
  const listImageDialog = document.getElementById('list-image-dialog');
  let previewPress=null;
  listImageDialog.addEventListener('pointerdown',event=>{previewPress={x:event.clientX,y:event.clientY};});
  listImageDialog.addEventListener('pointercancel',()=>{previewPress=null;});
  listImageDialog.addEventListener('click',event=>{const still=!previewPress||Math.hypot(event.clientX-previewPress.x,event.clientY-previewPress.y)<8;previewPress=null;if(still)listImageDialog.close();});
  const resetSettingsDialog = document.getElementById('reset-settings-dialog');
  document.getElementById('open-reset-settings').addEventListener('click', async () => {if(window.GameShelfAccess&&!await GameShelfAccess.enter('wipe'))return; document.getElementById('reset-settings-status').textContent = '';document.getElementById('wipe-backup-ack').checked=false;document.getElementById('wipe-continue').disabled=true; openModal(resetSettingsDialog); });
  for (const id of ['reset-settings-close', 'reset-settings-cancel']) document.getElementById(id).addEventListener('click', () => resetSettingsDialog.close());
  closeOnBackdropClick(resetSettingsDialog);
  document.getElementById('wipe-export-data').addEventListener('click',()=>document.getElementById('export-library-data').click());
  document.getElementById('wipe-continue').addEventListener('click',async()=>{
    if(!document.getElementById('wipe-backup-ack').checked)return;

    document.getElementById('wipe-confirm-text').value='';document.getElementById('reset-settings-confirm').disabled=true;openModal(document.getElementById('wipe-final-dialog'));
  });
  document.getElementById('wipe-confirm-text').addEventListener('input',event=>document.getElementById('reset-settings-confirm').disabled=event.target.value!=='Game Over');
  for(const id of ['wipe-final-close','wipe-final-cancel'])document.getElementById(id).addEventListener('click',()=>document.getElementById('wipe-final-dialog').close());
  closeOnBackdropClick(document.getElementById('wipe-final-dialog'));
  document.getElementById('wipe-backup-ack').addEventListener('change',event=>document.getElementById('wipe-continue').disabled=!event.target.checked);
  document.getElementById('reset-settings-confirm').addEventListener('click',async()=>{
    const button=document.getElementById('reset-settings-confirm');if(button.disabled)return;button.disabled=true;
    try{
      const response=await fetch('/api/server-settings/reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:'Game Over',acknowledgeBackup:true})});if(!response.ok)throw new Error((await response.text()).trim()||'Could not wipe GameShelf.');
      for(const storage of [localStorage,sessionStorage])for(const key of Object.keys(storage))if(key.startsWith('gameshelf:'))storage.removeItem(key);
      showNotification('GameShelf data wiped. Returning to setup…');setTimeout(()=>window.location.reload(),800);
    }catch(error){showNotification(error.message,'error');}finally{button.disabled=false;}
  });
  const serverDialog = document.getElementById('server-settings-dialog');
  document.getElementById('open-server-settings').addEventListener('click', () => {
    if (!serverSettings) { document.getElementById('settings-save-status').textContent = 'Server settings are unavailable. Try refreshing.'; return; }
    document.getElementById('server-root-path').value = (serverSettings.rootDirs?.length ? serverSettings.rootDirs : [serverSettings.rootDir]).join('\n');
    document.getElementById('server-data-path').value = serverSettings.dataDir;
    window.GameShelfSetup?.prepareSettings(serverSettings);
    document.getElementById('server-settings-status').textContent = '';
    openModal(serverDialog);
  });
  for (const id of ['server-settings-close', 'server-settings-cancel']) document.getElementById(id).addEventListener('click', () => serverDialog.close());
  closeOnBackdropClick(serverDialog);
  document.getElementById('server-settings-save').addEventListener('click', async () => {
    const button = document.getElementById('server-settings-save');
    if (!serverSettings || button.disabled) return;
    const roots = document.getElementById('server-root-path').value.split(/\r?\n/).map(path => path.trim()).filter(Boolean);
    const next = { ...serverSettings, rootDir: roots[0] || '', rootDirs: roots, dataDir: document.getElementById('server-data-path').value.trim(), sources: window.GameShelfSetup?.settingsSources().sources || serverSettings.sources };
    button.disabled = true;
    document.getElementById('server-settings-status').textContent = 'Saving your library…';
    const stopProgress = window.GameShelfSetup?.beginSaveProgress();
    try {
      const result = await saveServerSettings(next);
      document.getElementById('server-settings-status').textContent = '';
      document.getElementById('settings-save-status').textContent = '';
      showSaveFeedback(button);
      serverDialog.close();
      showNotification(result.restartRequired ? 'Library settings saved. Restart the container to apply the data location.' : 'Library settings saved.');
      if (!result.restartRequired) { loadGames(); window.GameShelfSetup?.watchScan(); }
    } catch (error) { document.getElementById('server-settings-status').textContent = `Could not save settings: ${error.message}`; }
    finally { stopProgress?.(); button.disabled = false; }
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
      showSaveFeedback(button);
      refreshDialog.close();
      showNotification('Refresh interval saved.');
    } catch (error) { document.getElementById('refresh-settings-status').textContent = `Could not save interval: ${error.message}`; }
    finally { button.disabled = false; }
  });
  const logConfigDialog = document.getElementById('log-config-dialog');
  const logVerbose = document.getElementById('log-verbose');
  const logKinds = ['system', 'library', 'errors', 'requests', 'scans', 'downloads', 'health','profile'];
  const logTypeInputs = logKinds.map(kind => document.getElementById(`log-${kind}`));
  const logDaysOverride = document.getElementById('log-override-days');
  const logSizeOverride = document.getElementById('log-override-size');
  const logDays = document.getElementById('log-days');
  const logSize = document.getElementById('log-size');
  function syncLogConfigInputs() {
    logTypeInputs.forEach(input => { input.disabled = !logVerbose.checked; });
    logDays.disabled = !logDaysOverride.checked;if(logDaysOverride.checked && !logDays.value)logDays.value='7';
    logSize.disabled = !logSizeOverride.checked;
  }
  for (const input of [logVerbose, logDaysOverride, logSizeOverride]) input.addEventListener('change', syncLogConfigInputs);
  document.getElementById('configure-logs').addEventListener('click', () => {
    if (!serverSettings) { document.getElementById('settings-save-status').textContent = 'Server settings are unavailable. Try refreshing.'; return; }
    const options = serverSettings.logOptions || { system:true, library:true, errors:true, requests:false, scans:false, downloads:false, sizeMB:10, days:0 };
    logVerbose.checked = Boolean(serverSettings.verbose);
    for (const input of logTypeInputs) input.checked = options[input.id.slice(4)] !== false;
    logDaysOverride.checked = Boolean(options.overrideDays);
    logSizeOverride.checked = Boolean(options.overrideSize);
    logDays.value = options.overrideDays ? String(options.days || 7) : '';logDays.placeholder='∞';
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
      requests:logTypeInputs[3].checked, scans:logTypeInputs[4].checked, downloads:logTypeInputs[5].checked, health:logTypeInputs[6].checked, healthConfigured:true,profile:logTypeInputs[7].checked,profileConfigured:true,
      overrideDays:logDaysOverride.checked, days:logDaysOverride.checked?Number(logDays.value):0, overrideSize:logSizeOverride.checked, sizeMB:Number(logSize.value)
    };
    if (!Number.isInteger(options.days) || options.days < 0 || options.days > 3650 || (options.overrideDays && options.days < 1) || !Number.isInteger(options.sizeMB) || options.sizeMB < 1 || options.sizeMB > 100) {
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
      const type = (line.match(/\[(system|library|errors|request|scan|download|health|profile)\]/) || [,'system'])[1];
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
  logsDownload.addEventListener('click', async () => {
    if(!logsContent.textContent||logsDownload.disabled)return;logsDownload.disabled=true;
    try{const response=await fetch('/api/logs?export=1',{cache:'no-store'});if(!response.ok)throw new Error('Could not export logs.');const snapshot=await response.text();const all=snapshot.trimEnd().split('\n'),exportEntry=all.pop();const included=new Set(logFilters.filter(input=>input.checked).map(input=>input.value));const selected=all.filter(line=>included.has((line.match(/\[(system|library|errors|request|scan|download|health|profile)\]/)||[,'system'])[1]));selected.push(exportEntry);const url=URL.createObjectURL(new Blob([selected.join('\n')+'\n'],{type:'text/plain'}));const link=document.createElement('a');link.href=url;link.download='gameshelf-logs.txt';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);animateControl(logsDownload);}
    catch{showNotification('Could not export logs. Try again.');}finally{logsDownload.disabled=false;}
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
      if(resetSelection.cover)delete game.coverStretch;
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
      refreshCoverFit(game);applySort(); applySearchFilter();
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
  const syncSpeed = () => {
    const next = Number(speedInput.value);
    animationSpeed = Number.isFinite(next) ? Math.max(0, Math.min(3, next)) : 1.1;
    disableEffects = animationSpeed === 0;
    document.getElementById('animation-speed-value').textContent = animationSpeed === 0 ? 'Off' : animationSpeed.toFixed(2) + '×';
    localStorage.setItem('gameshelf:animation-speed', String(animationSpeed));
    applyMotionSpeed();
    if (isShuffling) clearSuggestion();
  };
  speedInput.value = String(animationSpeed); syncSpeed();
  speedInput.addEventListener('input', syncSpeed);
  speedInput.addEventListener('change', syncSpeed);
  document.addEventListener('animationstart', applyMotionSpeed);
  document.addEventListener('transitionrun', applyMotionSpeed);
  const opacityInput = document.getElementById('list-opacity');
  const syncOpacity = () => {
    listOpacity = Math.max(0, Math.min(100, Number(opacityInput.value) || 0));
    document.documentElement?.style.setProperty?.('--list-opacity', listOpacity + '%');
    document.documentElement?.style.setProperty?.('--list-opacity-factor', String(listOpacity / 100));
    document.getElementById('list-opacity-value').textContent = listOpacity + '%';
    localStorage.setItem('gameshelf:list-opacity', String(listOpacity));
  };
  opacityInput.value = String(listOpacity); syncOpacity();
  opacityInput.addEventListener('input', syncOpacity);
  opacityInput.addEventListener('change', syncOpacity);
  const depthInput = document.getElementById('card-depth');
  depthInput.checked = cardDepth;
  document.body.classList.toggle('gs-card-depth', cardDepth);
  depthInput.addEventListener('change', () => { cardDepth = depthInput.checked; localStorage.setItem('gameshelf:card-depth', String(cardDepth)); document.body.classList.toggle('gs-card-depth', cardDepth); });
  hoverTextInput.addEventListener('change', () => {
    showHoverText = hoverTextInput.checked;
    localStorage.setItem('gameshelf:show-hover-text', String(showHoverText));
    document.body.classList.toggle('gs-hide-tooltips', !showHoverText);
  });
  gameTitlesInput.addEventListener('change', () => {
    showGameTitles = gameTitlesInput.checked;
    localStorage.setItem('gameshelf:show-game-titles', String(showGameTitles));
    document.body.classList.toggle('gs-show-game-titles', showGameTitles);
    syncHoverTitles();
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
    updateActiveSort();

    const isOpening = sortMenu.classList.toggle('hidden') === false;
    sortButton.classList.toggle('gs-control-active', isOpening);
    document.body.classList.toggle('gs-sort-open', isOpening);if(isOpening)followSortMenu();
  });

  let sortFrame;
  function followSortMenu(){
    globalThis.cancelAnimationFrame?.(sortFrame);if(sortMenu.classList.contains('hidden'))return;
    if(sortButton.getBoundingClientRect&&sortMenu.getBoundingClientRect){const rect=sortButton.getBoundingClientRect(),scale=typeof uiScale==='number'?uiScale:1,width=sortMenu.getBoundingClientRect().width||220*scale;
      sortMenu.style.position='fixed';sortMenu.style.right='auto';sortMenu.style.left=Math.max(8,Math.min(innerWidth-width-8,rect.right-width))/scale+'px';sortMenu.style.top=(rect.bottom+8)/scale+'px';sortMenu.style.maxHeight=Math.max(80,(innerHeight-rect.bottom-20)/scale)+'px';}
    if(globalThis.requestAnimationFrame)sortFrame=requestAnimationFrame(followSortMenu);
  }
    let sortPressOutside=true;
  document.addEventListener('pointerdown',e=>{sortPressOutside=!e.target.closest('#sort-button')&&!e.target.closest('#sort-menu');});
  document.addEventListener('click', e => {
    const clickedSortButton = e.target.closest('#sort-button');
    const clickedSortMenu = e.target.closest('#sort-menu');

    if (!clickedSortButton && !clickedSortMenu && (sortPressOutside || e.detail===0)) {
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
      (suggestedGameId||isShuffling?change=>change():transitionLibrary)(() => {
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
      localStorage.setItem('gameshelf:view', currentView);recordSettingChange({view:currentView});
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


function recordSettingChange(preferences){
 const safe=Object.fromEntries(Object.entries(preferences).filter(([key,value])=>preferenceKeys.includes(key)&&typeof value==='string'));
 if(Object.keys(safe).length)fetch('/api/settings-events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(safe)}).catch(()=>{});
}
function effectiveCoverStretch(game){return typeof game.coverStretch==='boolean'?game.coverStretch:stretchCovers;}
function setCoverStretch(frame,game){if(frame)frame.dataset.coverFit=effectiveCoverStretch(game)?'stretch':'fit';}
function syncCoverStretchControl(game){
 const button=document.getElementById('game-cover-stretch');if(!button)return;
 const enabled=effectiveCoverStretch(game);button.setAttribute('aria-pressed',String(enabled));button.title=enabled?'Disable stretch for this game':'Enable stretch for this game';button.setAttribute('aria-label',button.title);button.dataset.tooltip=button.title;
 button.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5m6 0h5v5m0 6v5h-5M9 20H4v-5M4 4l5 5m11-5-5 5m5 11-5-5M4 20l5-5"/>'+(enabled?'':'<path class="gs-stretch-slash" d="M3 3l18 18"/>')+'</svg>';
}
function refreshCoverFit(game){
 const card=cardMap.get(game.id);for(const frame of card?.querySelectorAll('.gs-card-cover,.gs-list-cover')||[])setCoverStretch(frame,game);
 if(detailsGameId===game.id){setCoverStretch(document.querySelector?.('.gs-details-art-frame'),game);syncCoverStretchControl(game);}if(editorGame?.id===game.id)syncCoverStretchControl(game);
}
async function saveCoverStretch(){
 const game=editorGame||gamesCache.find(item=>item.id===detailsGameId),button=document.getElementById('game-cover-stretch');if(!game||button.disabled)return;
 const stretch=!effectiveCoverStretch(game);button.disabled=true;
 try{const response=await fetch('/api/cover-fit/'+encodeURIComponent(game.id),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({stretch})});if(!response.ok)throw new Error('Could not save cover fit.');const result=await response.json();game.coverStretch=result.coverStretch;refreshCoverFit(game);animateControl(button);showNotification(stretch?'Cover stretch enabled for this game.':'Cover stretch disabled for this game.');}
 catch(error){showNotification(error.message);}finally{button.disabled=false;}
}
function syncSetupResume(){
 const value=serverSettings;if(!value)return;const hasLibrary=value.rootDir||value.rootDirs?.length||value.sources?.length;
 const unfinished=!value.setupCompleted&&(value.setupStatus==='skipped'||value.setupStatus==='pending'||!value.setupStatus);document.getElementById('resume-setup-option').hidden=!unfinished;document.getElementById('resume-setup-option').classList.toggle('gs-setup-pending',unfinished);document.body.classList.toggle('gs-setup-unfinished',unfinished);
}

function backupPassphraseChecks(value){return {length:[...value].length>=8,upper:/\p{Lu}/u.test(value),lower:/\p{Ll}/u.test(value),number:/\p{Nd}/u.test(value),symbol:/[\p{P}\p{S}]/u.test(value)};}
function profileBackupKey(id){const value=document.getElementById(id).value;if(!value)return '';const strong=id!=='export-profile-key'||Object.values(backupPassphraseChecks(value)).every(Boolean);if(!strong||[...value].length<8||new TextEncoder().encode(value).length>1024){showNotification(id==='export-profile-key'?'Use at least 8 characters, including uppercase, lowercase, a number, and a symbol.':'Use the Backup Passphrase from your export.','error');return null;}return btoa(String.fromCharCode(...new TextEncoder().encode(value)));}

document.addEventListener('DOMContentLoaded',()=>{
 const $=id=>document.getElementById(id),field=$('export-profile-key');
 function syncKey(){const checks=backupPassphraseChecks(field.value);for(const item of $('backup-key-requirements').children)item.classList.toggle('is-met',checks[item.dataset.check]);$('export-unprotected-option').hidden=!!field.value;const show=$('backup-key-show'),visible=field.type==='text';show.dataset.tooltip=visible?'Hide passphrase':'Show passphrase';show.setAttribute('aria-label',show.dataset.tooltip);show.setAttribute('aria-pressed',String(visible));show.innerHTML=visible?'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10 5.2A12 12 0 0 1 12 5c6 0 10 7 10 7a20 20 0 0 1-4.2 4.7M6.2 6.2A21 21 0 0 0 2 12s4 7 10 7a12 12 0 0 0 4.1-.7M10 10a3 3 0 0 0 4 4"/></svg>':'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';}
 field.addEventListener('input',syncKey);$('export-dialog').addEventListener('close',()=>{field.type='password';syncKey();});syncKey();
 $('backup-key-generate').addEventListener('click',()=>{const bytes=crypto.getRandomValues(new Uint8Array(20)),alphabet='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_$!';const generated=['A','a','7','!',...[...bytes].map(b=>alphabet[b%alphabet.length])];for(let i=generated.length-1;i>0;i--){const j=crypto.getRandomValues(new Uint32Array(1))[0]%(i+1);[generated[i],generated[j]]=[generated[j],generated[i]];}field.value=generated.join('');field.dispatchEvent(new Event('input'));showNotification('Backup passphrase generated. Copy it somewhere safe.');animateControl($('backup-key-generate'));});
 $('backup-key-copy').addEventListener('click',async()=>{if(!field.value){showNotification('Enter or generate a passphrase first.','error');return;}try{await navigator.clipboard.writeText(field.value);showNotification('Backup passphrase copied.');animateControl($('backup-key-copy'));}catch{showNotification('Clipboard is unavailable. Select and copy the passphrase.','error');}});
 $('backup-key-show').addEventListener('click',()=>{field.type=field.type==='password'?'text':'password';syncKey();animateControl($('backup-key-show'));});
});
