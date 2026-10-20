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
let slowRoll = localStorage.getItem('gameshelf:slow-roll') === 'true';
let currentView = localStorage.getItem('gameshelf:view') || 'grid';

const cardMap = new Map(); // game.id -> card element

/* =============================
   Data Fetching
   ============================= */
async function loadVersion() {
  const label = document.getElementById('version-label');
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
  document.getElementById('settings-version').textContent = label.textContent;
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

  const isList = currentView === 'list' && !suggestedGameId;

  container.classList.toggle('list-view', isList);
  toggle.classList.toggle('gs-control-active', isList);
}

/* =============================
   Card Creation
   ============================= */
function createGameCard(game) {
  const card = document.createElement('article');
  card.className = 'gs-card';
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

  const body = document.createElement('div');
  body.className = 'gs-card-body';

  const content = document.createElement('div');
  content.className = 'gs-card-content';

  const title = document.createElement('h3');
  title.className = 'gs-card-title';
  title.textContent = game.name;

  const meta = document.createElement('div');
  meta.className = 'gs-card-meta';
  meta.textContent = formatSize(game.sizeBytes);

  const actions = document.createElement('div');
  actions.className = 'gs-card-actions';

  const dl = document.createElement('a');
  dl.className = 'gs-icon-button';
  dl.href = `/download/${encodeURIComponent(game.id)}`;
  dl.setAttribute('aria-label', `Download ${game.name}`);
  dl.innerHTML = `
    <svg viewBox="0 0 24 24">
      <path d="M12 16l4-5h-3V4h-2v7H8l4 5zm-7 2v2h14v-2H5z"/>
    </svg>
  `;

  actions.appendChild(dl);
  content.appendChild(title);
  body.appendChild(content);
  body.appendChild(meta);
  body.appendChild(actions);

  card.appendChild(cover);
  card.appendChild(body);

  return card;
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
    const match = suggestedGameId
      ? card.dataset.id === suggestedGameId
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
  if (!suggestedGameId) return;
  const selected = cardMap.get(suggestedGameId);
  selected?.classList.remove('gs-random-selected');
  selected?.classList.remove('gs-spotlight-enter');
  suggestedGameId = null;
  document.getElementById('games-container').classList.remove('gs-spotlight');
  document.getElementById('spotlight-actions').classList.add('hidden');
  document.getElementById('suggestion-status').textContent = '';
  applyViewMode();
  applySearchFilter();
}

function suggestRandomGame() {
  if (isLoading || gamesCache.length === 0) return;
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
  suggestedGameId = game.id;
  card.classList.add('gs-random-selected');
  card.classList.add('gs-spotlight-enter');
  card.addEventListener('animationend', () => card.classList.remove('gs-spotlight-enter'), { once: true });
  card.setAttribute('tabindex', '-1');
  document.getElementById('games-container').classList.add('gs-spotlight');
  document.getElementById('spotlight-actions').classList.remove('hidden');
  applyViewMode();
  applySearchFilter();
  card.scrollIntoView?.({ block: 'center' });
  card.focus({ preventScroll: true });
  document.getElementById('suggestion-status').textContent =
    `Showing only ${game.name}. Use Show all games to return to the library.`;
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

  isLoading = true;
  randomButton.disabled = true;
  randomButton.title = 'Loading games…';
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
    randomButton.title = gamesCache.length === 0
      ? 'Add games to enable random suggestions' : 'Suggest a random game';
    container.setAttribute('aria-busy', 'false');
    applySearchFilter();
  }
}

/* =============================
   DOM bindings
   ============================= */
document.addEventListener('DOMContentLoaded', () => {
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
  const hoverText = 'REFRESH';
  const refreshingText = 'REFRESHING';
  const doneText = 'REFRESHED';

  let refreshLock = false;
  let refreshFeedbackTimer;

  trigger.addEventListener('mouseenter', () => {
    if (!refreshLock) logoText.textContent = hoverText;
  });

  trigger.addEventListener('mouseleave', () => {
    if (!refreshLock) logoText.textContent = originalText;
  });

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
  randomButton.addEventListener('animationend', () => randomButton.classList.remove('is-rolling'));
  document.getElementById('show-all-games').addEventListener('click', () => {
    clearSuggestion();
    randomButton.focus();
  });

  /* -------- Settings -------- */
  const settingsButton = document.getElementById('build-info');
  const settingsDialog = document.getElementById('settings-dialog');
  const slowRollInput = document.getElementById('slow-roll');
  slowRollInput.checked = slowRoll;
  randomButton.classList.toggle('gs-slow-roll', slowRoll);

  settingsButton.addEventListener('click', () => {
    settingsDialog.showModal();
    slowRollInput.focus();
  });
  document.getElementById('settings-close').addEventListener('click', () => settingsDialog.close());
  settingsDialog.addEventListener('close', () => settingsButton.focus());
  slowRollInput.addEventListener('change', () => {
    slowRoll = slowRollInput.checked;
    localStorage.setItem('gameshelf:slow-roll', String(slowRoll));
    randomButton.classList.toggle('gs-slow-roll', slowRoll);
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
    if (settingsDialog.open) return;
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
      if (suggestedGameId) {
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
