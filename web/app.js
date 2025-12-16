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
        <div class="gs-card-meta">${game.sizeBytes}</div>
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
    .forEach(btn => {
      btn.classList.toggle('active', btn.dataset.sort === currentSort);
    });
}

function applySort() {
  const grid = document.getElementById('games-container');
  [...cardMap.values()]
    .sort((a,b)=>{
      const nA=a.dataset.name,nB=b.dataset.name;
      const sA=+a.dataset.size,sB=+b.dataset.size;
      return currentSort==='za'?nB.localeCompare(nA):
             currentSort==='size-desc'?sB-sA:
             currentSort==='size-asc'?sA-sB:
             nA.localeCompare(nB);
    })
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
  status.textContent = `${visible} result${visible===1?'':'s'}`;
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

  const input = document.getElementById('search-input');

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

  const logo = document.getElementById('gs-logo-text');
  document.getElementById('gs-refresh-trigger')
    .addEventListener('click', async ()=>{
      logo.textContent = 'REFRESHING';
      await fetch('/api/games?forceRefresh=1');
      await loadGames(true);
      logo.textContent = 'REFRESHED';
      logo.classList.add('bounce');
      setTimeout(()=>{
        logo.classList.remove('bounce');
        logo.textContent = 'GAMESHELF';
      }, 900);
    });

  const sortBtn = document.getElementById('sort-button');
  const sortMenu = document.getElementById('sort-menu');

  sortBtn.addEventListener('click', e=>{
    e.stopPropagation();
    sortMenu.classList.toggle('hidden');
  });

  document.addEventListener('click', ()=>sortMenu.classList.add('hidden'));

  sortMenu.querySelectorAll('button').forEach(b=>{
    b.addEventListener('click', ()=>{
      currentSort = b.dataset.sort;
      updateActiveSort();
      sortMenu.classList.add('hidden');
      applySort();
    });
  });
});