/* =============================
   Global state
   ============================= */

let gamesCache = [];
const coverVersions = new Map();
let refreshGeneration = 0;

let currentSort = 'az';
let currentSearch = '';

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

/* =============================
   Card creation (ONE TIME)
   ============================= */

function createGameCard(game) {
  const card = document.createElement('article');
  card.className = 'gs-card';
  card.dataset.id = game.id;
  card.dataset.name = game.name.toLowerCase();

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
   Initial render / refresh
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

  applySearchFilter();
}

/* =============================
   Search (NO DOM DESTRUCTION)
   ============================= */

function applySearchFilter() {
  const empty = document.getElementById('empty-state');
  let visibleCount = 0;

  cardMap.forEach(card => {
    if (card.dataset.name.includes(currentSearch)) {
      card.style.display = '';
      visibleCount++;
    } else {
      card.style.display = 'none';
    }
  });

  empty.classList.toggle('hidden', visibleCount > 0);
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
});
