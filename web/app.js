/* =============================
   Global state
   ============================= */

let gamesCache = [];
const coverVersions = new Map();
let refreshGeneration = 0;

let currentSort = 'az';
let currentSearch = '';

const cardMap = new Map();

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
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function fuzzyMatch(haystack, needle) {
  if (!needle) return true;
  let h = 0, n = 0;
  while (h < haystack.length && n < needle.length) {
    if (haystack[h] === needle[n]) n++;
    h++;
  }
  return n === needle.length;
}

/* =============================
   Card creation
   ============================= */

function createGameCard(game) {
  const card = document.createElement('article');
  card.className = 'gs-card';
  card.dataset.name = game.name.toLowerCase();
  card.dataset.size = game.sizeBytes;

  const img = document.createElement('img');
  img.src = `/covers/${encodeURIComponent(game.id)}`;
  img.alt = `${game.name} cover`;

  const cover = document.createElement('div');
  cover.className = 'gs-card-cover';
  cover.appendChild(img);

  const title = document.createElement('h3');
  title.className = 'gs-card-title';
  title.textContent = game.name;

  const meta = document.createElement('div');
  meta.className = 'gs-card-meta';
  meta.textContent = formatSize(game.sizeBytes);

  const dl = document.createElement('a');
  dl.className = 'gs-icon-button';
  dl.href = `/download/${encodeURIComponent(game.id)}`;
  dl.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 16l4-5h-3V4h-2v7H8l4 5z"/></svg>`;

  const footer = document.createElement('div');
  footer.className = 'gs-card-footer';
  footer.append(meta, dl);

  card.append(cover, title, footer);
  return card;
}

/* =============================
   Sorting
   ============================= */

function applySort() {
  const container = document.getElementById('games-container');
  [...cardMap.values()]
    .sort((a, b) => {
      const nA = a.dataset.name, nB = b.dataset.name;
      const sA = +a.dataset.size, sB = +b.dataset.size;
      return currentSort === 'za' ? nB.localeCompare(nA)
        : currentSort === 'size-desc' ? sB - sA
        : currentSort === 'size-asc' ? sA - sB
        : nA.localeCompare(nB);
    })
    .forEach(card => container.appendChild(card));
}

/* =============================
   Search + result count
   ============================= */

function applySearchFilter() {
  let visible = 0;
  cardMap.forEach(card => {
    const match = fuzzyMatch(card.dataset.name, currentSearch);
    card.style.display = match ? '' : 'none';
    if (match) visible++;
  });

  const status = document.getElementById('search-status');
  if (status) {
    status.textContent = `${visible} result${visible === 1 ? '' : 's'}`;
    status.classList.toggle('hidden', currentSearch.length === 0);
  }

  document.getElementById('empty-state')
    ?.classList.toggle('hidden', visible > 0);
}

function clearSearch() {
  currentSearch = '';
  const input = document.getElementById('search-input');
  if (input) input.value = '';
  document.getElementById('search-status')?.classList.add('hidden');
  cardMap.forEach(card => card.style.display = '');
}

/* =============================
   Load / refresh
   ============================= */

async function loadGames(isRefresh = false) {
  const container = document.getElementById('games-container');
  if (isRefresh) {
    cardMap.clear();
    container.innerHTML = '';
  }

  gamesCache = await fetchGames();
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

  document.addEventListener('keydown', e => {
    const input = document.getElementById('search-input');
    if (e.key === '/') {
      e.preventDefault();
      input?.focus();
      input?.select();
    }
    if (e.key === 'Escape') {
      clearSearch();
      input?.blur();
    }
  });

  document.getElementById('search-input')?.addEventListener('input', e => {
    currentSearch = e.target.value.trim().toLowerCase();
    applySearchFilter();
  });

  document.getElementById('gs-refresh-trigger')
    ?.addEventListener('click', async () => {
      clearSearch();
      await fetch('/api/games?forceRefresh=1');
      await loadGames(true);
    });

  document.querySelectorAll('.gs-sort-menu button').forEach(btn => {
    btn.addEventListener('click', () => {
      currentSort = btn.dataset.sort;
      applySort();
    });
  });
});