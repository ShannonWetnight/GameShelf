/* =============================
   Global state
   ============================= */

let gamesCache = [];
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

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const u = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(bytes)/Math.log(1024));
  return `${(bytes/1024**i).toFixed(1)} ${u[i]}`;
}

/* =============================
   Card creation (MATCHES CSS)
   ============================= */

function createGameCard(game) {
  const card = document.createElement('article');
  card.className = 'gs-card';
  card.dataset.name = game.name.toLowerCase();
  card.dataset.size = game.sizeBytes;

  const cover = document.createElement('div');
  cover.className = 'gs-card-cover';

  const img = document.createElement('img');
  img.src = `/covers/${encodeURIComponent(game.id)}`;
  cover.appendChild(img);

  const body = document.createElement('div');
  body.className = 'gs-card-body';

  const content = document.createElement('div');
  content.className = 'gs-card-content';

  const title = document.createElement('h3');
  title.className = 'gs-card-title';
  title.textContent = game.name;

  const footer = document.createElement('div');
  footer.className = 'gs-card-footer';

  const meta = document.createElement('div');
  meta.className = 'gs-card-meta';
  meta.textContent = formatSize(game.sizeBytes);

  const actions = document.createElement('div');
  actions.className = 'gs-card-actions';

  const dl = document.createElement('a');
  dl.className = 'gs-icon-button';
  dl.href = `/download/${encodeURIComponent(game.id)}`;
  dl.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 16l4-5h-3V4h-2v7H8l4 5z"/></svg>`;

  actions.appendChild(dl);
  content.appendChild(title);
  footer.append(meta, actions);
  body.append(content, footer);
  card.append(cover, body);

  return card;
}

/* =============================
   Sort + Search
   ============================= */

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
    const ok = fuzzyMatch(c.dataset.name,currentSearch);
    c.style.display = ok?'':'none';
    if(ok) visible++;
  });

  const status = document.getElementById('search-status');
  status.textContent = `${visible} result${visible===1?'':'s'}`;
  status.classList.toggle('hidden',!currentSearch);

  document.getElementById('empty-state')
    .classList.toggle('hidden',visible>0);
}

function clearSearch() {
  currentSearch='';
  document.getElementById('search-input').value='';
  document.getElementById('search-status').classList.add('hidden');
  cardMap.forEach(c=>c.style.display='');
}

/* =============================
   Load
   ============================= */

async function loadGames(refresh=false) {
  const grid=document.getElementById('games-container');
  if(refresh){cardMap.clear();grid.innerHTML='';}
  gamesCache=await fetchGames();
  gamesCache.forEach(g=>{
    if(!cardMap.has(g.id)){
      const c=createGameCard(g);
      cardMap.set(g.id,c);
      grid.appendChild(c);
    }
  });
  applySort();
  applySearch();
}

/* =============================
   DOM
   ============================= */

document.addEventListener('DOMContentLoaded',()=>{
  loadGames();

  const input=document.getElementById('search-input');
  input.addEventListener('input',e=>{
    currentSearch=e.target.value.toLowerCase().trim();
    applySearch();
  });

  document.addEventListener('keydown',e=>{
    if(e.key==='/'){e.preventDefault();input.focus();input.select();}
    if(e.key==='Escape'){clearSearch();input.blur();}
  });

  // Refresh
  document.getElementById('gs-refresh-trigger')
    .addEventListener('click',async()=>{
      clearSearch();
      await fetch('/api/games?forceRefresh=1');
      loadGames(true);
    });

  // Sort menu
  const btn=document.getElementById('sort-button');
  const menu=document.getElementById('sort-menu');

  btn.addEventListener('click',e=>{
    e.stopPropagation();
    menu.classList.toggle('hidden');
  });

  document.addEventListener('click',()=>menu.classList.add('hidden'));

  menu.querySelectorAll('button').forEach(b=>{
    b.addEventListener('click',()=>{
      currentSort=b.dataset.sort;
      menu.classList.add('hidden');
      applySort();
    });
  });
});
