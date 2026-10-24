/* Active covers and the viewport use individual particles, never tiled rain textures. */
(() => {
  const active = new Set();
  const rainThemes = new Set(['rain', 'storm', 'autumn']);
  let background = null;
  const weather = {
    stopAll() { for (const effect of [...active]) effect.stop(); },
    setTheme(theme, speed) {
      background?.stop(); background = null;
      if (rainThemes.has(theme)) background = weather.start(document.body, theme, speed, true);
    },
    refreshBackground() { background?.refresh(); },
    start(host, theme, speed, viewport = false) {
      const canvas = document.createElement('canvas');
      canvas.className = viewport ? 'gs-weather-canvas' : 'gs-rain-canvas';
      canvas.setAttribute('aria-hidden', 'true');
      let width, height;
      const ratio = Math.min(window.devicePixelRatio || 1, viewport ? 1.25 : 1.5);
      const context = canvas.getContext('2d');
      if (!context) return { move() {}, refresh() {}, stop() {} };
      function resize() {
        const bounds = host.getBoundingClientRect();
        width = Math.max(1, viewport ? innerWidth : bounds.width);
        height = Math.max(1, viewport ? innerHeight : bounds.height);
        canvas.width = width * ratio; canvas.height = height * ratio;
        context.scale(ratio, ratio);
      }
      resize(); host.appendChild(canvas);
      const motion = matchMedia('(prefers-reduced-motion: reduce)');
      const count = viewport ? Math.round(Math.min(350, Math.max(65, width * height / (theme === 'storm' ? 4400 : theme === 'autumn' ? 11000 : 7000)))) : theme === 'storm' ? 90 : theme === 'autumn' ? 42 : 62;
      const velocity = viewport ? (theme === 'storm' ? 510 : theme === 'autumn' ? 260 : 360) : theme === 'storm' ? 320 : theme === 'autumn' ? 150 : 230;
      const wind = theme === 'storm' ? -105 : theme === 'autumn' ? -36 : -62;
      const drops = Array.from({ length: count }, () => ({ x: Math.random() * width, y: Math.random() * height, vx: 0, depth: .55 + Math.random() * .75, length: viewport ? 10 + Math.random() * 24 : 6 + Math.random() * 11, alpha: viewport ? .06 + Math.random() * .2 : .15 + Math.random() * .4 }));
      let pointer = null, frame = null, last = 0, stopped = false;
      function draw(now) {
        frame = null;
        if (stopped) return;
        if (!host.isConnected) { effect.stop(); return; }
        const rate = motion.matches ? 0 : speed();
        const dt = Math.min(32, last ? now - last : 16) / 1000 * rate;
        last = now; context.clearRect(0, 0, width, height);
        for (const drop of drops) {
          const before = drop.y, vy = velocity * drop.depth, vx = wind * drop.depth + drop.vx;
          drop.y += vy * dt; drop.x += vx * dt;
          drop.vx *= Math.max(0, 1 - dt * 1.3);
          if (pointer && Math.abs(drop.x - pointer.x) < 48) {
            const dx = drop.x - pointer.x;
            const canopy = pointer.y - 18 + dx * dx / 180;
            if (before <= canopy && drop.y >= canopy) {
              const side = dx < 0 ? -1 : 1;
              drop.x = pointer.x + side * 49; drop.y = pointer.y - 5;
              drop.vx = side * (95 + Math.random() * 45);
            }
          }
          if (drop.y > height + drop.length) { drop.y = -drop.length; drop.x = Math.random() * width; drop.vx = 0; }
          if (drop.x < -40) drop.x = width + 20;
          if (drop.x > width + 40) drop.x = -20;
          if (pointer && drop.y > pointer.y - 6 && drop.y < pointer.y + 100 && Math.abs(drop.x - pointer.x) < 32) continue;
          context.strokeStyle = theme === 'autumn' ? `rgba(243,208,160,${drop.alpha})` : `rgba(172,205,236,${drop.alpha})`;
          context.lineWidth = (viewport ? .65 : .85) * drop.depth;
          // Each streak is drawn along the same vector that advances the drop.
          context.beginPath(); context.moveTo(drop.x, drop.y);
          context.lineTo(drop.x - vx / vy * drop.length, drop.y - drop.length); context.stroke();
        }
        if (pointer) {
          context.strokeStyle = theme === 'autumn' ? 'rgba(242,198,143,.35)' : 'rgba(192,222,244,.3)';
          context.lineWidth = 1; context.beginPath();
          context.ellipse(pointer.x, pointer.y + 4, 48, 22, 0, Math.PI, Math.PI * 2); context.stroke();
        }
        if (rate > 0) frame = requestAnimationFrame(draw);
      }
      const onResize = () => { resize(); effect.refresh(); };
      const effect = {
        get stopped() { return stopped; },
        refresh() { if (!frame && !stopped) draw(performance.now()); },
        move(x, y) { if (!viewport) pointer = { x, y }; effect.refresh(); },
        stop() {
          stopped = true; cancelAnimationFrame(frame); canvas.remove(); active.delete(effect);
          if (viewport) window.removeEventListener('resize', onResize);
          motion.removeEventListener?.('change', effect.refresh);
        }
      };
      if (viewport) window.addEventListener('resize', onResize); else active.add(effect);
      motion.addEventListener?.('change', effect.refresh);
      draw(performance.now()); return effect;
    }
  };
  window.GameShelfRain = weather;
})();
