const glyphs = "0123456789ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘｱﾎﾃﾏｹﾒｴｶｷﾑﾕ";

export function matrixRain(canvas) {
  const context = canvas.getContext("2d");
  if (!context) return () => {};
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let mode = "";
  let introUntil = 0;
  let frame;
  let last = 0;
  let width;
  let height;
  let columns = [];
  const cell = 17;

  function resize() {
    const scale = Math.min(window.devicePixelRatio || 1, 1.5);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * scale);
    canvas.height = Math.floor(height * scale);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    columns = Array.from({ length: Math.ceil(width / cell) }, (_, index) => ({
      x: index * cell, offset: Math.random() * height, speed: 60 + Math.random() * 185,
      length: 8 + Math.floor(Math.random() * 18), phase: Math.random() * 1000,
    }));
    update();
  }

  function paint(time) {
    frame = undefined;
    if (!mode || document.hidden) return;
    if (time - last >= 38 || reduced.matches) {
      last = time;
      const t = reduced.matches ? 0 : time;
      context.clearRect(0, 0, width, height);
      context.font = "13px Menlo, monospace";
      for (const column of columns) {
        const span = height + column.length * cell;
        const top = (column.offset + t / 1000 * column.speed) % span;
        for (let row = 0; row < column.length; row++) {
          const y = top - row * cell;
          if (y < 0 || y > height) continue;
          const n = Math.floor((y + column.phase) / cell + t / (row === 0 ? 72 : 350));
          const fade = 1 - row / column.length;
          context.fillStyle = row === 0 ? "rgba(210,255,221,.92)" : `rgba(79,243,129,${fade * fade * .72})`;
          context.fillText(glyphs[n % glyphs.length], column.x, y);
        }
      }
    }
    if (introUntil && time >= introUntil) {
      introUntil = 0;
      document.body.classList.remove("rain-entry");
    }
    if (!reduced.matches) frame = requestAnimationFrame(paint);
  }

  function update() {
    if (frame === undefined && mode && !document.hidden) frame = requestAnimationFrame(paint);
  }

  window.addEventListener("resize", resize, {passive: true});
  document.addEventListener("visibilitychange", update);
  reduced.addEventListener("change", () => {
    introUntil = 0;
    document.body.classList.remove("rain-entry");
    update();
  });
  resize();

  return (next, intro = false) => {
    mode = next;
    canvas.dataset.mode = mode;
    if (intro && !reduced.matches) {
      introUntil = performance.now() + 1050;
      document.body.classList.add("rain-entry");
    } else if (!mode) {
      introUntil = 0;
      document.body.classList.remove("rain-entry");
    }
    update();
  };
}
