let currentSort = 'az';
let currentSearch = '';
const cardMap = new Map();

/* =============================
   Fetch
   ============================= */

async function fetchGames() {
  const res = await fetch('/api/games');
  return res.ok ? res.json() : [];
}

/* =============================
   Helpers
   ============================= */

function fuzzyMatch(h, n) {
  if (!n) return true;
  let i = 0, j = 0;
  while (i < h.length && j < n.length) {
    if (h[i] === n[j]) j++;
    i++;
  }
  return j === n.length;
}

/* =============================
   Cards
   ============================= */

function createGameCard(game) {
  const card = document.createElement('article');
  card.className = 'gs-card';
  card.dataset.name = game.name.toLowerCase();
  card.dataset.size = game.sizeBytes;

  card.innerHTML = `
    <div class="gs-card-cover">
      <img src="/covers/${encodeURIComponent(game.id)}">
    </div>
    <div class="gs-card-body">
      <div class="gs-card-content">
        <h3 class="gs-card-title">${game.name}</h3>
      </div>
      <div class="gs-card-footer">
        <div class="gs-card-actions">
          <a class="gs-icon-button" href="/download/${encodeURIComponent(game.id)}">+</a>
        </div>
      </div>
    </div>
  `;
  return card;
}

/* =============================
   Sort / Search
   ============================= */

function updateActiveSort() {
  document.querySelectorAll('#sort-menu button')
    .forEach(b => b.classList.toggle('active', b.dataset.sort === currentSort));
}

function applySort() {
  const grid = document.getElementById('games-container');
  [...cardMap.values()]
    .sort((a,b)=>a.dataset.name.localeCompare(b.dataset.name))
    .forEach(c=>grid.appendChild(c));
}

function applySearch() {
  let visible = 0;
  cardMap.forEach(c=>{
    const ok = fuzzyMatch(c.dataset.name, currentSearch);
    c.style.display = ok ? '' : 'none';
    if (ok) visible++;
  });

  const status = document.getElementById('search-status');
  status.textContent = `${visible} result${visible === 1 ? '' : 's'}`;
  status.classList.toggle('hidden', !currentSearch);
}

/* =============================
   Load
   ============================= */

async function loadGames(refresh=false) {
  const grid = document.getElementById('games-container');
  if (refresh) {
    cardMap.clear();
    grid.innerHTML = '';
  }

  const games = await fetchGames();
  games.forEach(g=>{
    if (!cardMap.has(g.id)) {
      const c = createGameCard(g);
      cardMap.set(g.id, c);
      grid.appendChild(c);
    }
  });

  applySort();
  applySearch();
  updateActiveSort();
}

/* =============================
   DOM
   ============================= */

document.addEventListener('DOMContentLoaded',()=>{
  loadGames();

  const logo = document.getElementById('gs-logo-text');
  const trigger = document.getElementById('gs-refresh-trigger');
  const input = document.getElementById('search-input');

  const ORIGINAL = 'GAMESHELF';
  const HOVER = 'REFRESH';
  const LOADING = 'REFRESHING';
  const DONE = 'REFRESHED';

  trigger.addEventListener('mouseenter', ()=>logo.textContent = HOVER);
  trigger.addEventListener('mouseleave', ()=>logo.textContent = ORIGINAL);

  trigger.addEventListener('click', async ()=>{
    logo.textContent = LOADING;
    await fetch('/api/games?forceRefresh=1');
    await loadGames(true);
    logo.textContent = DONE;
    logo.classList.add('bounce');
    setTimeout(()=>{
      logo.classList.remove('bounce');
      logo.textContent = ORIGINAL;
    }, 700);
  });

  input.addEventListener('input', e=>{
    currentSearch = e.target.value.toLowerCase().trim();
    applySearch();
  });

  document.addEventListener('keydown', e=>{
    if (e.key === '/') {
      e.preventDefault();
      input.focus();
      input.select();
    }
    if (e.key === 'Escape') {
      input.value = '';
      currentSearch = '';
      applySearch();
      input.blur();
    }
  });
});