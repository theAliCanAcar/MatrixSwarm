const TAU = 2 * Math.PI;
const colors = {
  queued: "#6c9d7b", running: "#a0ffba", evaluating: "#d4f490",
  passed: "#9dffad", rejected: "#ffa095", failed: "#ffa095"
};

export function mountFlightScope(canvas) {
  const context = canvas?.getContext("2d");
  if (!context) return;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const angles = new Map();
  let run;
  let stage;
  let lastFrame;
  let width = 0;
  let height = 0;
  let frame;
  let visible = true;
  let pointerX = 0;
  let pointerY = 0;

  function point(x, y, size, color) {
    context.fillStyle = color;
    context.beginPath();
    context.arc(x, y, size, 0, TAU);
    context.fill();
  }

  function draw(time) {
    frame = undefined;
    if (!width || !height) return;
    const elapsed = lastFrame === undefined ? 0 : Math.min(time - lastFrame, 50);
    lastFrame = time;
    context.clearRect(0, 0, width, height);
    const x = width * .5 + pointerX * 9;
    const y = height * .49 + pointerY * 6;
    const radius = Math.min(width * .40, height * .41);
    const halo = context.createRadialGradient(x, y, 0, x, y, radius * 1.38);
    halo.addColorStop(0, "#04110aca");
    halo.addColorStop(.65, "#06130c8a");
    halo.addColorStop(1, "#040b0700");
    context.fillStyle = halo;
    context.fillRect(0, 0, width, height);

    for (const ratio of [.35, .62, .83, 1]) {
      context.beginPath();
      context.strokeStyle = ratio === 1 ? "#a1ffb962" : "#a1ffb92e";
      context.setLineDash(ratio === .83 ? [2, 5] : []);
      context.arc(x, y, radius * ratio, 0, TAU);
      context.stroke();
    }
    context.setLineDash([]);

    context.strokeStyle = "#9affba34";
    context.beginPath();
    context.moveTo(x - radius * 1.17, y);
    context.lineTo(x + radius * 1.17, y);
    context.moveTo(x, y - radius * 1.11);
    context.lineTo(x, y + radius * 1.11);
    context.stroke();

    for (let tick = 0; tick < 72; tick++) {
      const angle = tick * TAU / 72;
      const outer = radius * 1.03;
      const inner = outer - (tick % 6 === 0 ? 7 : 3);
      context.strokeStyle = tick % 6 === 0 ? "#a1ffb994" : "#a1ffb942";
      context.beginPath();
      context.moveTo(x + Math.cos(angle) * inner, y + Math.sin(angle) * inner);
      context.lineTo(x + Math.cos(angle) * outer, y + Math.sin(angle) * outer);
      context.stroke();
    }

    for (let index = 0; index < 170; index++) {
      const angle = index * 2.399963;
      const r = radius * (.16 + ((index * 37) % 113) / 128);
      point(x + Math.cos(angle) * r, y + Math.sin(angle) * r, index % 11 === 0 ? 1.2 : .6, index % 11 === 0 ? "#a4f5b77e" : "#daffe334");
    }

    const branches = run?.branches || [];
    let isMoving = false;
    for (const [index, branch] of branches.entries()) {
      const r = radius * (.43 + index * .43 / Math.max(branches.length - 1, 1));
      const moving = !reduced.matches && ["running", "evaluating"].includes(branch.status);
      const previousAngle = angles.get(branch.id) ?? index * 2.4 + .3;
      const angle = moving ? (previousAngle + elapsed / (3100 + index * 500)) % TAU : previousAngle;
      angles.set(branch.id, angle);
      isMoving ||= moving;
      const color = colors[branch.status] || "#9eb8a4";
      context.strokeStyle = color + "48";
      context.beginPath();
      context.arc(x, y, r, angle - 1.4, angle);
      context.stroke();
      const bx = x + Math.cos(angle) * r;
      const by = y + Math.sin(angle) * r;
      point(bx, by, 11, color + "28");
      context.save();
      context.translate(bx, by);
      context.rotate(angle + Math.PI / 2);
      context.strokeStyle = color;
      context.fillStyle = "#0b2114";
      context.beginPath();
      context.ellipse(0, 0, branch.id === run.winner ? 7 : 5, 4, 0, 0, TAU);
      context.fill();
      context.stroke();
      for (const offset of [-3, 0, 3]) {
        context.beginPath();
        context.moveTo(-4, offset);
        context.quadraticCurveTo(-9, offset - 1, -13, offset * 1.6);
        context.stroke();
      }
      point(2, 0, 1.6, color);
      context.restore();

      context.fillStyle = color;
      context.font = "bold 10px monospace";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(branch.id, x + Math.cos(angle) * (r + 15), y + Math.sin(angle) * (r + 15));
    }

    context.strokeStyle = "#a1ffb9b9";
    context.strokeRect(x - 3.5, y - 3.5, 7, 7);
    if (visible && isMoving) schedule();
  }

  function schedule() {
    if (frame === undefined) frame = requestAnimationFrame(draw);
  }

  function resize() {
    const ratio = Math.min(devicePixelRatio || 1, 2);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    schedule();
  }

  function followPointer(event) {
    if (reduced.matches || event.pointerType === "touch") return;
    const bounds = stage.getBoundingClientRect();
    pointerX = (event.clientX - bounds.left) / bounds.width - .5;
    pointerY = (event.clientY - bounds.top) / bounds.height - .5;
    schedule();
  }

  function resetPointer() {
    pointerX = 0;
    pointerY = 0;
    schedule();
  }

  function syncScroll() {
    const landscape = canvas.closest(".flight-stage");
    if (!landscape) return;
    const progress = reduced.matches ? 0 : Math.min(1, Math.max(0, -landscape.getBoundingClientRect().top / 530));
    landscape.style.setProperty("--ascent", progress);
  }

  function setStage(nextStage) {
    if (stage === nextStage) return;
    stage?.removeEventListener("pointermove", followPointer);
    stage?.removeEventListener("pointerleave", resetPointer);
    stage = nextStage;
    stage?.addEventListener("pointermove", followPointer);
    stage?.addEventListener("pointerleave", resetPointer);
  }

  const resizer = new ResizeObserver(resize);
  resizer.observe(canvas);
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) schedule();
  });
  observer.observe(canvas);
  window.addEventListener("scroll", syncScroll, {passive: true});
  reduced.addEventListener("change", syncScroll);
  reduced.addEventListener("change", schedule);
  return {
    update(nextRun) {
      run = nextRun;
      setStage(canvas.closest(".flight-stage") || canvas);
      syncScroll();
      schedule();
    },
    dispose() {
      resizer.disconnect();
      observer.disconnect();
      setStage(null);
      window.removeEventListener("scroll", syncScroll);
      reduced.removeEventListener("change", syncScroll);
      reduced.removeEventListener("change", schedule);
      if (frame !== undefined) cancelAnimationFrame(frame);
    }
  };
}
