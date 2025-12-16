/* =============================
   Global state
   ============================= */
const coverVersions = new Map();
let refreshGeneration = 0;
let currentSort = 'az';
let currentSearch = '';

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
   Card creation
   ============================= */

function createGameCard(game) {
  const card = document.createElement('article');
  card.className = 'gs-card';

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
   Sorting
   ============================= */

function sortGames(games) {
  switch (currentSort) {
    case 'za':
      return games.sort((a, b) => b.name.localeCompare(a.name));
    case 'size-desc':
      return games.sort((a, b) => b.sizeBytes - a.sizeBytes);
    case 'size-asc':
      return games.sort((a, b) => a.sizeBytes - b.sizeBytes);
    case 'az':
    default:
      return games.sort((a, b) => a.name.localeCompare(b.name));
  }
}

/* =============================
   Rendering
   ============================= */

async function init(isRefresh = false) {
  const games = await fetchGames();
    if (isRefresh) {
      coverVersions.clear();

      games.forEach(game => {
        coverVersions.set(game.id, refreshGeneration);
      });
    }
  
  const container = document.getElementById('games-container');
  const empty = document.getElementById('empty-state');

  container.innerHTML = '';

  if (!games.length) {
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');

  const filtered = games.filter(game =>
    game.name.toLowerCase().includes(currentSearch)
  );

  if (!filtered.length) {
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');

  sortGames(filtered).forEach(game => {
    try {
      container.appendChild(createGameCard(game));
    } catch (e) {
      console.error('Failed to render game card:', game.name, e);
    }
  });
}

/* =============================
   DOM bindings
   ============================= */

document.addEventListener('DOMContentLoaded', () => {
  init();

  /* -------- Global keyboard shortcuts -------- */
document.addEventListener('keydown', e => {
  // Ignore if user is already typing in an input
  if (
    e.target instanceof HTMLInputElement ||
    e.target instanceof HTMLTextAreaElement
  ) {
    return;
  }

  if (e.key === '/') {
    e.preventDefault();
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
      searchInput.focus();
      searchInput.select();
    }
  }
});

  /* -------- Refresh header logic -------- */

  const trigger = document.getElementById('gs-refresh-trigger');
  const logoText = document.getElementById('gs-logo-text');

  const originalText = 'GAMESHELF';
  const hoverText = 'REFRESH';
  const refreshingText = 'REFRESHING';
  const doneText = 'REFRESHED';

  let refreshLock = false;

  const originalWidth = logoText.offsetWidth;
  trigger.style.width = `${originalWidth + 20}px`;

  trigger.addEventListener('mouseenter', () => {
    if (!refreshLock) logoText.textContent = hoverText;
  });

  trigger.addEventListener('mouseleave', () => {
    if (!refreshLock) logoText.textContent = originalText;
  });

  trigger.addEventListener('click', async () => {
    if (refreshLock) return;

    refreshLock = true;
    trigger.classList.add('refreshing');
    logoText.textContent = refreshingText;

    await fetch('/api/games?forceRefresh=1');

    // Increment refresh generation
    refreshGeneration++;

    await init(true); // <-- pass a flag

    logoText.textContent = doneText;
    logoText.classList.add('bounce');

    setTimeout(() => {
      logoText.classList.remove('bounce');
      logoText.textContent = originalText;
      trigger.classList.remove('refreshing');
      refreshLock = false;
    }, 1000);
  });

    /* -------- Sort menu logic -------- */

  const searchInput = document.getElementById('search-input');

  if (searchInput) {
    searchInput.addEventListener('input', e => {
      currentSearch = e.target.value.trim().toLowerCase();
      init();
    });
  }

  const sortButton = document.getElementById('sort-button');
  const sortMenu = document.getElementById('sort-menu');
  const sortButtons = document.querySelectorAll('.gs-sort-menu button');

  if (!sortButton || !sortMenu || !sortButtons.length) return;

  function updateActiveSort() {
    sortButtons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.sort === currentSort);
    });
  }

  // Open menu
  sortButton.addEventListener('click', e => {
    e.stopPropagation();
    updateActiveSort(); // ensure highlight is correct
    sortMenu.classList.toggle('hidden');
  });

  // Close menu when clicking outside
  document.addEventListener('click', e => {
    if (!e.target.closest('.gs-sort')) {
      sortMenu.classList.add('hidden');
    }
  });

  // Handle sort selection
  sortButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      currentSort = btn.dataset.sort;
      updateActiveSort();
      sortMenu.classList.add('hidden');
      init();
    });
  });

  // Initial highlight
  updateActiveSort();

});