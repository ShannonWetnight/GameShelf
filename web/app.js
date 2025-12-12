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

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(1)} ${units[i]}`;
}

function createGameCard(game) {
  const card = document.createElement('article');
  card.className = 'gs-card';

  const cover = document.createElement('div');
  cover.className = 'gs-card-cover';

if (game.hasCover) {
    const img = document.createElement('img');
    img.src = `/covers/${encodeURIComponent(game.id)}`;
    img.alt = `${game.name} cover`;
    cover.appendChild(img);
} else {
    const img = document.createElement('img');
    img.src = `/covers/${encodeURIComponent(game.id)}`; // server will auto-fallback
    img.alt = `${game.name} cover placeholder`;
    cover.appendChild(img);
}

  const body = document.createElement('div');
  body.className = 'gs-card-body';

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

  actions.appendChild(dl);
  body.appendChild(title);
  body.appendChild(meta);
  body.appendChild(actions);

  card.appendChild(cover);
  card.appendChild(body);

  return card;
}

async function init() {
  const games = await fetchGames();
  const container = document.getElementById('games-container');
  const empty = document.getElementById('empty-state');

  container.innerHTML = '';

  if (!games.length) {
    empty.classList.remove('hidden');
    return;
  } else {
    empty.classList.add('hidden');
  }

  games
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach(game => {
      container.appendChild(createGameCard(game));
    });
}

document.addEventListener('DOMContentLoaded', () => {
  init();

  const trigger = document.getElementById('gs-refresh-trigger');
  const logoText = document.getElementById('gs-logo-text');
  const originalText = "GAMESHELF";
  const hoverText = "REFRESH";
  const refreshingText = "REFRESHING";
  const doneText = "REFRESHED";

  let refreshLock = false;

  // Measure text width only (not the icon)
  const originalWidth = logoText.offsetWidth;
  trigger.style.width = `${originalWidth + 20}px`; // small padding

  trigger.addEventListener('mouseenter', () => {
    if (!refreshLock) logoText.textContent = hoverText;
  });

  trigger.addEventListener('mouseleave', () => {
    if (!refreshLock) logoText.textContent = originalText;
  });

  trigger.addEventListener('click', async () => {
    if (refreshLock) return;

    refreshLock = true;
    trigger.classList.add("refreshing");
    logoText.textContent = refreshingText;

    await fetch('/api/games?forceRefresh=1');
    await init();

    // Bounce animation + done text
    logoText.textContent = doneText;
    logoText.classList.add("bounce");

    // Remove bounce after animation ends
    setTimeout(() => {
      logoText.classList.remove("bounce");
      logoText.textContent = originalText;
      trigger.classList.remove("refreshing");
      refreshLock = false;
    }, 1000);
  });
});
