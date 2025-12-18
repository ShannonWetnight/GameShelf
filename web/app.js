/* =============================
   Global state
   ============================= */

let gamesCache = [];
const coverVersions = new Map();
let refreshGeneration = 0;

let currentSort = 'az';
let currentSearch = '';
let currentView = localStorage.getItem('gameshelf:view') || 'grid';

const cardMap = new Map(); // game.id -> card element

/* =============================
   Data fetching
   ============================= */

async function fetchGames() {
  try {
    const res = await fetch('/api/games');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error('Failed to load games:', err);
    return [];
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

  const isList = currentView === 'list';

  container.classList.toggle('list-view', isList);
  toggle.classList.toggle('gs-control-active', isList);
}

/* =============================
   Card creation (ONE TIME)
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

  const footer = document.createElement('div');
  footer.className = 'gs-card-footer';

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
  dl.innerHTML = `
    <svg viewBox="0 0 24 24">
      <path d="M12 16l4-5h-3V4h-2v7H8l4 5zm-7 2v2h14v-2H5z"/>
    </svg>
  `;

  actions.appendChild(dl);
  content.appendChild(title);
  footer.appendChild(meta);
  footer.appendChild(actions);

  body.appendChild(content);
  body.appendChild(footer);

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
   Search
   ============================= */

function applySearchFilter() {
  const empty = document.getElementById('empty-state');
  let visibleCount = 0;

  cardMap.forEach(card => {
    const match = fuzzyMatch(card.dataset.name, currentSearch);

    if (match) {
      card.style.display = '';
      visibleCount++;
    } else {
      card.style.display = 'none';
    }
  });

  empty.classList.toggle('hidden', visibleCount > 0);
}

/* =============================
   Initial load / refresh
   ============================= */

async function loadGames(isRefresh = false) {
  const container = document.getElementById('games-container');
  const empty = document.getElementById('empty-state');

  gamesCache = await fetchGames();

  if (isRefresh) {
    coverVersions.clear();
    refreshGeneration++;
    cardMap.clear();
    container.innerHTML = '';

    gamesCache.forEach(game => {
      coverVersions.set(game.id, refreshGeneration);
    });
  }

  if (!gamesCache.length) {
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');

  gamesCache.forEach(game => {
    if (!cardMap.has(game.id)) {
      const card = createGameCard(game);
      cardMap.set(game.id, card);
      container.appendChild(card);
    }
  });

  applySort();
  applySearchFilter();
}

/* =============================
   DOM bindings
   ============================= */

document.addEventListener('DOMContentLoaded', () => {
  loadGames();

  /* -------- Search -------- */

  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.addEventListener('input', e => {
      currentSearch = e.target.value.trim().toLowerCase();
      searchInput.classList.toggle('is-filtering', currentSearch.length > 0);
      applySearchFilter();
    });
  }

  /* -------- Refresh -------- */

  const trigger = document.getElementById('gs-refresh-trigger');
  const logoText = document.getElementById('gs-logo-text');

  const originalText = 'GAMESHELF';
  const hoverText = 'REFRESH';
  const refreshingText = 'REFRESHING';
  const doneText = 'REFRESHED';

  let refreshLock = false;

  trigger.addEventListener('mouseenter', () => {
    if (!refreshLock) logoText.textContent = hoverText;
  });

  trigger.addEventListener('mouseleave', () => {
    if (!refreshLock) logoText.textContent = originalText;
  });

  trigger.addEventListener('click', async () => {
    if (refreshLock) return;

    refreshLock = true;
    logoText.textContent = refreshingText;

    // --- RESET SEARCH STATE ---
    const searchInput = document.getElementById('search-input');
    currentSearch = '';

    if (searchInput) {
      searchInput.value = '';
      searchInput.classList.remove('is-filtering');
    }

    // Ensure all cards are visible immediately
    cardMap.forEach(card => {
      card.style.display = '';
    });

    // --- PERFORM REFRESH ---
    await fetch('/api/games?forceRefresh=1');
    await loadGames(true);

    logoText.textContent = doneText;
    logoText.classList.add('bounce');

    setTimeout(() => {
      logoText.classList.remove('bounce');
      logoText.textContent = originalText;
      refreshLock = false;
    }, 1000);
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
    sortMenu.classList.toggle('hidden');
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.gs-sort')) {
      sortMenu.classList.add('hidden');
    }
  });

  sortButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      currentSort = btn.dataset.sort;
      updateActiveSort();
      sortMenu.classList.add('hidden');
      applySort();
    });
  });

  /* -------- View toggle -------- */

  const viewToggle = document.getElementById('view-toggle');

  if (viewToggle) {
    viewToggle.addEventListener('click', () => {
      currentView = currentView === 'grid' ? 'list' : 'grid';
      localStorage.setItem('gameshelf:view', currentView);
      applyViewMode();
    });
  }

  /* -------- Keyboard shortcuts -------- */

  document.addEventListener('keydown', e => {
    const searchInput = document.getElementById('search-input');
    if (!searchInput) return;

    const activeTag = document.activeElement?.tagName;

    /* "/" always focuses search (unless already typing in an input) */
    if (e.key === '/' && activeTag !== 'INPUT' && activeTag !== 'TEXTAREA') {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
      return;
    }

    /* "Escape" clears search and closes sort menu */
    if (e.key === 'Escape') {
      const sortMenu = document.getElementById('sort-menu');
      if (sortMenu) {
        sortMenu.classList.add('hidden');
      }

      if (searchInput.value !== '') {
        searchInput.value = '';
        currentSearch = '';
        searchInput.classList.remove('is-filtering');

        // Show all cards immediately
        cardMap.forEach(card => {
          card.style.display = '';
        });

        applySearchFilter();
      }

      searchInput.blur();
    }
  });

  updateActiveSort();
  applyViewMode();
});