/* Rain particles are created only for the cover currently under the pointer. */
(() => {
  const active = new Set();
  window.GameShelfRain = {
    stopAll() { for (const effect of [...active]) effect.stop(); },
    start(host, theme, speed) {
      const canvas = document.createElement('canvas');
      canvas.className = 'gs-rain-canvas'; canvas.setAttribute('aria-hidden', 'true');
      const bounds = host.getBoundingClientRect();
      const width = Math.max(1, bounds.width), height = Math.max(1, bounds.height);
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = width * ratio; canvas.height = height * ratio;
      const context = canvas.getContext('2d');
      if (!context) return { move() {}, stop() {} };
      context.scale(ratio, ratio); host.appendChild(canvas);
      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      const count = theme === 'storm' ? 90 : theme === 'autumn' ? 42 : 62;
      const velocity = theme === 'storm' ? 320 : theme === 'autumn' ? 150 : 230;
      const drops = Array.from({ length: count }, () => ({ x: Math.random() * width, y: Math.random() * height, vx: 0, length: 6 + Math.random() * 11, alpha: .15 + Math.random() * .4 }));
      let pointer = null, frame = null, last = 0, stopped = false;
      function draw(now) {
        frame = null;
        if (stopped) return;
        if (!host.isConnected) { effect.stop(); return; }
        const rate = reduced ? 0 : speed();
        const dt = Math.min(32, last ? now - last : 16) / 1000 * rate;
        last = now; context.clearRect(0, 0, width, height);
        for (const drop of drops) {
          const before = drop.y;
          drop.y += velocity * dt; drop.x += (drop.vx + (theme === 'storm' ? 25 : 8)) * dt;
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
          if (drop.y > height + 20) { drop.y = -20; drop.x = Math.random() * width; drop.vx = 0; }
          if (drop.x < -20) drop.x = width + 10;
          if (drop.x > width + 20) drop.x = -10;
          if (pointer && drop.y > pointer.y - 6 && drop.y < pointer.y + 100 && Math.abs(drop.x - pointer.x) < 32) continue;
          context.strokeStyle = theme === 'autumn' ? `rgba(243,208,160,${drop.alpha})` : `rgba(172,205,236,${drop.alpha})`;
          context.lineWidth = theme === 'storm' ? 1.2 : .8;
          context.beginPath();context.moveTo(drop.x,drop.y);context.lineTo(drop.x - (theme === 'storm' ? 3 : 1),drop.y - drop.length);context.stroke();
        }
        if (pointer) {
          context.strokeStyle = theme === 'autumn' ? 'rgba(242,198,143,.35)' : 'rgba(192,222,244,.3)';
          context.lineWidth = 1; context.beginPath();
          context.ellipse(pointer.x, pointer.y + 4, 48, 22, 0, Math.PI, Math.PI * 2);context.stroke();
        }
        if (rate > 0) frame = requestAnimationFrame(draw);
      }
      const effect = {
        get stopped() { return stopped; },
        move(x, y) { pointer = { x, y }; if (!frame) draw(performance.now()); },
        stop() { stopped = true; cancelAnimationFrame(frame); canvas.remove(); active.delete(effect); }
      };
      active.add(effect); draw(performance.now()); return effect;
    }
  };
})();
