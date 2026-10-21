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

let currentSort = 'az';
let currentSearch = '';
let suggestedGameId = null;
let shuffleGameId = null;
let isShuffling = false;
let shuffleTimers = [];
let slowAnimations = localStorage.getItem('gameshelf:slow-animations') === 'true';
let showHoverText = localStorage.getItem('gameshelf:show-hover-text') !== 'false';
let showGameTitles = localStorage.getItem('gameshelf:show-game-titles') === 'true';
let showPlaceholderImages = localStorage.getItem('gameshelf:show-placeholder-images') === 'true';
let currentView = localStorage.getItem('gameshelf:view') || 'grid';
let detailsGameId = null;
let fileListController = null;
let openingCoverEditor = false;
let editorGame = null;
let editorImage = null;
let editorRotation = 0;
let editorPan = { x: 0, y: 0 };
let editorLoadVersion = 0;
let editorReturnGame = null;
let editorGridTimer;

const cardMap = new Map(); // game.id -> card element

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

  const isList = currentView === 'list' && !suggestedGameId && !isShuffling;

  container.classList.toggle('list-view', isList);
  toggle.classList.toggle('gs-control-active', isList);
}

/* =============================
   Card Creation
   ============================= */
function createGameCard(game) {
  const card = document.createElement('article');
  card.className = 'gs-card';
  card.classList.toggle('gs-no-cover', game.hasCover === false);
  card.addEventListener('click', event => {
    if (!event.target.closest('a, button')) {
      document.activeElement?.blur();
      card.classList.add('gs-hover-suppressed');
    }
  });
  card.addEventListener('pointerleave', () => card.classList.remove('gs-hover-suppressed'));
  card.addEventListener('focusout', event => {
    if (!card.contains(event.relatedTarget)) card.classList.remove('gs-hover-suppressed');
  });
  card.dataset.id = game.id;
  card.dataset.name = game.name.toLowerCase();
  card.dataset.size = game.sizeBytes;

  const cover = document.createElement('div');
  cover.className = 'gs-card-cover';

  const img = document.createElement('img');
  const version = coverVersions.get(game.id);
  const suffix = version ? `?v=${version}` : '';
  img.src = `/covers/${encodeURIComponent(game.id)}${suffix}`;
  img.alt = `${game.name} cover`;

  cover.appendChild(img);

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
  dl.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3.5v11m0 0 4-4m-4 4-4-4M5 17.5v2h14v-2"/>
    </svg>
  `;
  dl.addEventListener('click', () => {
    dl.blur();
    card.classList.add('gs-hover-suppressed');
  });

  const details = document.createElement('button');
  details.className = 'gs-card-info';
  details.type = 'button';
  details.setAttribute('aria-label', `Information about ${game.name}`);
  details.textContent = 'i';
  details.addEventListener('click', () => openGameDetails(game, details, card));
  actions.appendChild(dl);
  actions.appendChild(details);
  cover.appendChild(actions);

  const body = document.createElement('div');
  body.className = 'gs-card-body';

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
  const fileToggle = document.getElementById('toggle-game-files');
  fileToggle.textContent = 'Show files';
  fileToggle.setAttribute('aria-expanded', 'false');
  document.getElementById('game-files-panel').classList.add('hidden');
  document.getElementById('game-files-status').textContent = '';
  document.getElementById('game-files-list').innerHTML = '';
  document.getElementById('game-details-title').textContent = game.name;
  document.getElementById('game-title-input').value = game.name;
  document.getElementById('game-details-path').textContent = game.path || '';
  document.getElementById('game-details-size').textContent = formatSize(game.sizeBytes);
  document.getElementById('game-details-files').textContent = Number.isInteger(game.fileCount) ? String(game.fileCount) : '';
  document.getElementById('game-details-cover').textContent = game.coverSource === 'uploaded'
    ? 'Uploaded' : game.hasCover ? 'Available' : 'Missing';
  document.getElementById('edit-game-cover').textContent = game.hasCover ? 'Edit cover' : 'Add cover';
  document.getElementById('game-details-added').textContent = formatAddedDate(game.addedAt);
  dialog.showModal();
  document.getElementById('game-details-close').focus();
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    if (openingCoverEditor) { openingCoverEditor = false; return; }
    trigger.blur();
    card.classList.add('gs-hover-suppressed');
  }, { once: true });
}

async function toggleGameFiles() {
  const panel = document.getElementById('game-files-panel');
  const toggle = document.getElementById('toggle-game-files');
  const status = document.getElementById('game-files-status');
  const list = document.getElementById('game-files-list');
  const opening = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !opening);
  toggle.textContent = opening ? 'Hide files' : 'Show files';
  toggle.setAttribute('aria-expanded', String(opening));
  if (!opening) {
    fileListController?.abort();
    fileListController = null;
    return;
  }
  if (!detailsGameId) return;

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
    if (fileListController !== controller || panel.classList.contains('hidden')) return;
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
  editorReturnGame = game;
  editorGame = game;
  editorImage = null;
  editorLoadVersion++;
  editorRotation = 0;
  editorPan = { x: 0, y: 0 };
  document.getElementById('cover-editor-title').textContent = `Cover art: ${game.name}`;
  document.getElementById('cover-editor-file').value = '';
  document.getElementById('cover-zoom').value = '1';
  document.getElementById('cover-tilt').value = '0';
  updateCoverReadouts();
  document.getElementById('cover-editor-status').textContent = '';
  document.getElementById('cover-editor-save').disabled = true;
  openingCoverEditor = true;
  document.getElementById('game-details-dialog').close();
  document.getElementById('cover-editor-dialog').showModal();
  drawCoverEditor();
  if (game.hasCover) {
    const loadVersion = editorLoadVersion;
    const image = new Image();
    image.onload = () => {
      if (editorGame?.id !== game.id || loadVersion !== editorLoadVersion) return;
      editorImage = image;
      document.getElementById('cover-editor-save').disabled = false;
      drawCoverEditor();
    };
    image.onerror = () => {
      document.getElementById('cover-editor-status').textContent = 'Could not load the current cover. Choose an image.';
    };
    image.src = `/covers/${encodeURIComponent(game.id)}?edit=${Date.now()}`;
  }
}

function updateCoverReadouts() {
  const tilt = Number(document.getElementById('cover-tilt').value);
  document.getElementById('cover-zoom-value').textContent = `${Math.round(Number(document.getElementById('cover-zoom').value) * 100)}%`;
  document.getElementById('cover-tilt-value').textContent = `${tilt}°`;
  document.getElementById('cover-rotation-value').textContent = `${editorRotation + tilt}°`;
}

function showCoverGrid() {
  const preview = document.getElementById('cover-preview');
  preview.classList.add('is-adjusting');
  clearTimeout(editorGridTimer);
  editorGridTimer = setTimeout(() => preview.classList.remove('is-adjusting'), 750);
}

function bindCoverEditor() {
  const dialog = document.getElementById('cover-editor-dialog');
  const canvas = document.getElementById('cover-editor-canvas');
  const status = document.getElementById('cover-editor-status');
  const save = document.getElementById('cover-editor-save');
  document.getElementById('edit-game-cover').addEventListener('click', () => {
    const game = gamesCache.find(candidate => candidate.id === detailsGameId);
    if (game) openCoverEditor(game);
  });
  document.getElementById('cover-editor-close').addEventListener('click', () => dialog.close());
  document.getElementById('cover-editor-back').addEventListener('click', () => {
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
    editorLoadVersion++;
    document.getElementById('cover-preview').classList.remove('is-adjusting');
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
    save.disabled = true;
    status.textContent = 'Saving cover…';
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
      status.textContent = 'Cover saved.';
      dialog.close();
    } catch (error) {
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
      case 'az':
      default:
        return nameA.localeCompare(nameB);
    }
  });

  cards.forEach(card => container.appendChild(card));
}

/* =============================
   Search Function
   ============================= */
function applySearchFilter() {
  const empty = document.getElementById('empty-state');
  const hint = document.getElementById('empty-hint');
  const title = document.getElementById('empty-title');
  const searchHint = document.getElementById('search-hint');

  let visibleCount = 0;

  cardMap.forEach(card => {
    const spotlightId = shuffleGameId || suggestedGameId;
    const match = spotlightId
      ? card.dataset.id === spotlightId
      : fuzzyMatch(card.dataset.name, currentSearch);

    if (match) {
      card.style.display = '';
      visibleCount++;
    } else {
      card.style.display = 'none';
    }
  });

  const emptyLibrary = gamesCache.length === 0;
  title.textContent = emptyLibrary ? 'No games found!' : 'No matching games!';
  hint.classList.toggle('hidden', !emptyLibrary);
  searchHint.classList.toggle('hidden', emptyLibrary);
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
    card.classList.add('gs-random-selected', 'gs-spotlight-enter');
    card.addEventListener('animationend', () => card.classList.remove('gs-spotlight-enter'), { once: true });
    diceButton.disabled = false;
    diceButton.dataset.tooltip = 'Suggest a random game';
    applyViewMode();
    applySearchFilter();
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
  if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches || alternatives.length === 0) {
    showFinalGame();
    return;
  }

  isShuffling = true;
  diceButton.disabled = true;
  diceButton.dataset.tooltip = 'Choosing a game…';
  applyViewMode();
  const frames = Math.min(4, alternatives.length * 2);
  const frameDelay = slowAnimations ? 250 : 156;
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
      void previewCard.offsetWidth;
      previewCard.classList.add('gs-shuffle-preview');
      previewCard.classList.toggle('gs-shuffle-reverse', step % 2 === 1);
      applySearchFilter();
    };
    if (step === 0) showPreview();
    else shuffleTimers.push(setTimeout(showPreview, step * frameDelay));
  }
  shuffleTimers.push(setTimeout(showFinalGame, frames * frameDelay + (slowAnimations ? 100 : 63)));
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
  loading.textContent = isRefresh ? 'Refreshing games…' : 'Loading games…';
  loading.classList.remove('hidden');
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
    gamesCache.forEach(game => {
      const card = createGameCard(game);
      cardMap.set(game.id, card);
      container.appendChild(card);
    });
    hasLoadedGames = true;
    applySort();
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
  document.body.classList.toggle('gs-hide-tooltips', !showHoverText);
  document.body.classList.toggle('gs-show-game-titles', showGameTitles);
  document.body.classList.toggle('gs-show-placeholders', showPlaceholderImages);
  loadVersion();
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
  const refreshingText = 'REFRESHING';
  const doneText = 'REFRESHED';

  let refreshLock = false;
  let refreshFeedbackTimer;

  async function runRefresh(isRefresh = true) {
    if (refreshLock || isLoading) return;

    clearTimeout(refreshFeedbackTimer);
    refreshLock = true;
    logoText.textContent = refreshingText;

    const succeeded = await loadGames(isRefresh);
    logoText.textContent = succeeded ? doneText : 'FAILED';
    logoText.classList.toggle('bounce', succeeded);
    refreshLock = false;

    refreshFeedbackTimer = setTimeout(() => {
      logoText.classList.remove('bounce');
      logoText.textContent = originalText;
    }, 1000);
  }

  trigger.addEventListener('click', () => runRefresh());
  document.getElementById('retry-button').addEventListener('click', () => runRefresh(retryRefresh));

  const randomButton = document.getElementById('random-game');
  randomButton.addEventListener('click', suggestRandomGame);
  document.getElementById('reroll-game').addEventListener('click', suggestRandomGame);
  randomButton.addEventListener('animationend', () => randomButton.classList.remove('is-rolling'));
  document.getElementById('show-all-games').addEventListener('click', () => {
    clearSuggestion();
    randomButton.focus();
  });
  document.getElementById('spotlight-download').addEventListener('click', event => {
    if (!suggestedGameId) event.preventDefault();
    event.currentTarget.blur();
  });
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
  slowAnimationsInput.checked = slowAnimations;
  hoverTextInput.checked = showHoverText;
  gameTitlesInput.checked = showGameTitles;
  placeholderInput.checked = showPlaceholderImages;
  randomButton.classList.toggle('gs-slow-animations', slowAnimations);
  document.getElementById('games-container').classList.toggle('gs-slow-animations', slowAnimations);

  settingsButton.addEventListener('click', () => {
    settingsDialog.showModal();
    slowAnimationsInput.focus();
  });
  document.getElementById('settings-close').addEventListener('click', () => settingsDialog.close());
  document.getElementById('game-details-close').addEventListener('click', () => detailsDialog.close());
  document.getElementById('toggle-game-files').addEventListener('click', toggleGameFiles);
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
      titleInput.value = game.name;
      const oldCard = cardMap.get(game.id);
      const newCard = createGameCard(game);
      if (suggestedGameId === game.id) newCard.classList.add('gs-random-selected');
      oldCard.replaceWith(newCard);
      cardMap.set(game.id, newCard);
      applySort();
      applySearchFilter();
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

  /* -------- Sort menu -------- */
  const sortButton = document.getElementById('sort-button');
  const sortMenu = document.getElementById('sort-menu');
  const sortButtons = document.querySelectorAll('.gs-sort-menu button');

  function updateActiveSort() {
    sortButtons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.sort === currentSort);
    });
  }

  sortButton.addEventListener('click', e => {
    e.stopPropagation();
    if (suggestedGameId || isShuffling) clearSuggestion();
    updateActiveSort();

    const isOpening = sortMenu.classList.toggle('hidden') === false;
    sortButton.classList.toggle('gs-control-active', isOpening);
  });

  document.addEventListener('click', e => {
    const clickedSortButton = e.target.closest('#sort-button');
    const clickedSortMenu = e.target.closest('#sort-menu');

    if (!clickedSortButton && !clickedSortMenu) {
      sortMenu.classList.add('hidden');
      sortButton.classList.remove('gs-control-active');
    }
  });

  sortButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      currentSort = btn.dataset.sort;
      updateActiveSort();
      sortMenu.classList.add('hidden');
      sortButton.classList.remove('gs-control-active');
      applySort();
    });
  });

  /* -------- View toggle -------- */
  const viewToggle = document.getElementById('view-toggle');

  if (viewToggle) {
    viewToggle.addEventListener('click', () => {
      clearSuggestion();
      currentView = currentView === 'grid' ? 'list' : 'grid';
      localStorage.setItem('gameshelf:view', currentView);
      applyViewMode();

    // Close sort menu if open
    sortMenu.classList.add('hidden');
    sortButton.classList.remove('gs-control-active');
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
