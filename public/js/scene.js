/* Scene
 * Owns the frame loop, the camera, the canvas overlay and the labels.
 *
 * Two rules keep this stable:
 *
 * 1. The camera never calls jumpTo / easeTo / setCenter while following.
 *    In mapbox-gl 3.3.0 all of those reach HandlerManager.stop(), which
 *    resets every gesture handler, so following a satellite that way cancels
 *    the user's pinch many times a second. Instead the centre is written to
 *    map.transform and map._update() marks tiles dirty. Zoom is anchored to
 *    the screen centre while tracking, so pinch changes zoom only and the
 *    follow changes centre only. They never touch the same value.
 *
 * 2. Everything is drawn inside Mapbox's own "render" event, from positions
 *    propagated this frame, through one projector. Map, trails, dot and
 *    labels are therefore always from the same frame and the same maths.
 */
function createScene(map, projector) {
  const canvas = document.getElementById("sat-canvas");
  const ctx = canvas.getContext("2d");
  const labelLayer = document.getElementById("sat-labels");

  const FLY_MS = 2800;
  const RECOVER_MS = 650;
  const ROTATE_DEG_PER_SEC = (360 / 86164) * 6;   // 6x sidereal
  const ROTATE_MAX_ZOOM = 3.5;
  const RESUME_MS = 4000;
  const TRAIL_ALPHA = 0.55;
  const INK = "26,22,16";

  let sats = [];            // [{ meta, satrec, trail, head, el, w, h, anchor }]
  let byId = new Map();
  let trackedId = null;
  let priorityId = null;    // today's satellite gets first claim on label space
  let selectHandler = () => {};

  const cam = {
    mode: "free",           // free | flying | held | recovering | locked
    dragging: false,
    recoverFrom: null,
    recoverStart: 0,
    lastInteraction: -Infinity,   // spin from the moment the page opens
    lastTick: 0,
    wasEasing: false,
  };

  // ─── helpers ───────────────────────────────────────────────────────────
  const wrapLng = lng => ((((lng + 180) % 360) + 360) % 360) - 180;
  const isMobile = () => window.innerWidth < 1000;
  const easeInOut = t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

  function setCenterDirect(lng, lat) {
    const tr = map.transform;
    if (tr && typeof map._update === "function") {
      try {
        tr.center = new mapboxgl.LngLat(wrapLng(lng), Math.max(-85, Math.min(85, lat)));
        map._update();
        return;
      } catch (e) { /* fall through to the public API */ }
    }
    map.jumpTo({ center: [wrapLng(lng), lat] });
  }

  function anchorZoomToCentre(on) {
    const opts = on ? { around: "center" } : undefined;
    for (const h of [map.scrollZoom, map.touchZoomRotate]) {
      if (!h) continue;
      h.disable();
      h.enable(opts);
    }
  }

  // ─── canvas sizing ─────────────────────────────────────────────────────
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener("resize", () => { resize(); measureLabels(); });

  // ─── satellites and labels ─────────────────────────────────────────────
  function setSatellites(list) {
    labelLayer.textContent = "";
    sats = list.map(({ meta, satrec }) => {
      const el = document.createElement("div");
      el.className = "sat-label";
      el.textContent = meta.name.toUpperCase();
      el.style.visibility = "hidden";
      el.addEventListener("click", e => { e.stopPropagation(); selectHandler(meta.id); });
      labelLayer.appendChild(el);
      return { meta, satrec, trail: new Orbit.Trail(satrec), head: null, el, w: 0, h: 0, anchor: 0 };
    });
    byId = new Map(sats.map(s => [s.meta.id, s]));
    measureLabels();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(measureLabels);
  }

  function measureLabels() {
    for (const s of sats) {
      s.w = s.el.offsetWidth;
      s.h = s.el.offsetHeight;
    }
  }

  // ─── camera ────────────────────────────────────────────────────────────
  function noteInteraction() { cam.lastInteraction = performance.now(); }

  map.on("dragstart", () => {
    cam.dragging = true;
    noteInteraction();
    if (cam.mode !== "free") cam.mode = "held";
  });
  map.on("dragend", () => { cam.dragging = false; noteInteraction(); });
  map.on("moveend", () => {
    // Our own follow never fires moveend, so this is always a real ending:
    // either the fly-in finished or the user let go (after any inertia).
    if ((cam.mode === "flying" || cam.mode === "held") && !cam.dragging) startRecover();
  });
  for (const ev of ["mousedown", "touchstart", "wheel", "zoomstart", "rotatestart", "pitchstart"]) {
    map.on(ev, noteInteraction);
  }

  function startRecover() {
    const c = map.getCenter();
    cam.recoverFrom = { lon: c.lng, lat: c.lat };
    cam.recoverStart = performance.now();
    cam.mode = "recovering";
  }

  function track(id) {
    const s = byId.get(id);
    if (!s) return;
    trackedId = id;
    for (const o of sats) o.el.classList.toggle("tracked", o.meta.id === id);
    anchorZoomToCentre(true);

    // Aim where the satellite will be when the flight lands, not where it is now.
    const arrival = Orbit.positionAt(s.satrec, new Date(Date.now() + FLY_MS));
    if (!arrival) { startRecover(); return; }
    cam.mode = "flying";
    map.flyTo({
      center: [arrival.lon, arrival.lat],
      zoom: isMobile() ? 8 : 7,
      pitch: 0,
      bearing: map.getBearing(),
      duration: FLY_MS,
      easing: easeInOut,
      essential: true,
    });
  }

  function release() {
    trackedId = null;
    cam.mode = "free";
    for (const o of sats) o.el.classList.remove("tracked");
    anchorZoomToCentre(false);
    noteInteraction();              // rotation resumes after the usual pause
  }

  function updateCamera(now, dt) {
    const s = trackedId ? byId.get(trackedId) : null;

    if (cam.mode === "free") {
      const idle = now - cam.lastInteraction > RESUME_MS;
      if (idle && !cam.dragging && !map.isMoving() && map.getZoom() <= ROTATE_MAX_ZOOM) {
        const c = map.getCenter();
        setCenterDirect(c.lng - ROTATE_DEG_PER_SEC * dt, c.lat);
      }
      return;
    }
    if (!s || !s.head) return;

    // An inertia ease after a pinch pins the centre for a moment. Let it
    // finish, then glide back rather than jumping.
    const easing = typeof map.isEasing === "function" && map.isEasing();
    if (cam.mode === "locked" || cam.mode === "recovering") {
      if (easing) { cam.wasEasing = true; return; }
      if (cam.wasEasing) { cam.wasEasing = false; startRecover(); }
    }

    if (cam.mode === "recovering") {
      const t = Math.min(1, (now - cam.recoverStart) / RECOVER_MS);
      const p = Orbit.slerpLngLat(cam.recoverFrom.lon, cam.recoverFrom.lat, s.head.lon, s.head.lat, easeInOut(t));
      setCenterDirect(p.lon, p.lat);
      if (t >= 1) cam.mode = "locked";
    } else if (cam.mode === "locked") {
      setCenterDirect(s.head.lon, s.head.lat);
    }
  }

  // ─── simulation tick ───────────────────────────────────────────────────
  function tick(now) {
    const dt = cam.lastTick ? Math.min(0.1, (now - cam.lastTick) / 1000) : 0;
    cam.lastTick = now;

    const date = new Date();
    const ms = date.getTime();
    for (const s of sats) {
      s.head = Orbit.positionAt(s.satrec, date);    // exact, every frame (~2us each)
      s.trail.update(ms);                           // at most one new sample
    }

    updateCamera(now, dt);
    map.triggerRepaint();                          // draw() runs in Mapbox's render event
    requestAnimationFrame(tick);
  }

  // ─── drawing ───────────────────────────────────────────────────────────
  function strokeRun(run) {
    const n = run.length / 3;
    const x0 = run[0], y0 = run[1], a0 = run[2];
    const x1 = run[(n - 1) * 3], y1 = run[(n - 1) * 3 + 1], a1 = run[(n - 1) * 3 + 2];
    if (Math.hypot(x1 - x0, y1 - y0) < 1) {
      ctx.strokeStyle = `rgba(${INK},${(TRAIL_ALPHA * a1).toFixed(3)})`;
    } else {
      const g = ctx.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, `rgba(${INK},${(TRAIL_ALPHA * a0).toFixed(3)})`);
      g.addColorStop(1, `rgba(${INK},${(TRAIL_ALPHA * a1).toFixed(3)})`);
      ctx.strokeStyle = g;
    }
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    for (let i = 1; i < n; i++) ctx.lineTo(run[i * 3], run[i * 3 + 1]);
    ctx.stroke();
  }

  function drawTrail(s, nowMs, W, H) {
    const pts = s.trail.points;
    if (!s.head || pts.length < 1) return;

    // In map mode every point costs a map.project(); skip satellites that are
    // nowhere near the view before walking the whole trail.
    if (projector.state.blend >= 1) {
      const h = projector.project(s.head);
      const m = Math.max(W, H) * 3;
      if (h.x < -m || h.x > W + m || h.y < -m || h.y > H + m) return;
    }

    const span = Orbit.TRAIL_WINDOW_MS;
    let run = [];
    const flush = () => { if (run.length >= 6) strokeRun(run); run = []; };

    for (const p of pts) {
      const q = projector.project(p);
      if (!q.visible) { flush(); continue; }
      run.push(q.x, q.y, Math.max(0, 1 - (nowMs - p.t) / span));
    }
    const h = projector.project(s.head);           // trail ends exactly on the satellite
    if (h.visible) run.push(h.x, h.y, 1);
    flush();
  }

  function drawDot(s) {
    if (!s || !s.head) return;
    const q = projector.project(s.head);
    if (!q.visible) return;
    ctx.beginPath();
    ctx.arc(q.x, q.y, 10.5, 0, Math.PI * 2);
    ctx.fillStyle = "rgb(240,235,224)";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgb(${INK})`;
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  // Greedy label placement. Each label prefers to sit centred on its
  // satellite, so the trail runs straight into it; if that spot is taken it
  // tries beside, above and below; failing all four it hides, and its trail
  // still shows where it is. The previous anchor is tried first so labels
  // do not flicker between spots.
  const ANCHORS = [
    (x, y, w, h) => [x - w / 2, y - h / 2],        // centred on the satellite
    (x, y, w, h) => [x + 9, y - h / 2],            // right
    (x, y, w, h) => [x - w - 9, y - h / 2],        // left
    (x, y, w, h) => [x - w / 2, y - h - 9],        // above
    (x, y, w, h) => [x - w / 2, y + 9],            // below
  ];

  function layoutLabels(W, H) {
    const placed = [];
    const hits = (x, y, w, h) => {
      for (const r of placed) {
        if (x < r[0] + r[2] + 3 && x + w + 3 > r[0] && y < r[1] + r[3] + 3 && y + h + 3 > r[1]) return true;
      }
      return false;
    };

    const order = sats.filter(s => s.meta.id !== trackedId);
    order.sort((a, b) => (b.meta.id === priorityId) - (a.meta.id === priorityId));

    for (const s of order) {
      const q = s.head ? projector.project(s.head) : null;
      if (!q || !q.visible || q.x < -200 || q.x > W + 200 || q.y < -200 || q.y > H + 200) {
        s.el.style.visibility = "hidden";
        continue;
      }
      if (!s.w) { s.w = s.el.offsetWidth; s.h = s.el.offsetHeight; }

      const tryOrder = [s.anchor, 0, 1, 2, 3, 4].filter((v, i, a) => a.indexOf(v) === i);
      let done = false;
      for (const k of tryOrder) {
        const [x, y] = ANCHORS[k](q.x, q.y, s.w, s.h);
        if (!hits(x, y, s.w, s.h)) {
          placed.push([x, y, s.w, s.h]);
          s.anchor = k;
          s.el.style.transform = `translate3d(${Math.round(x)}px,${Math.round(y)}px,0)`;
          s.el.style.visibility = "visible";
          done = true;
          break;
        }
      }
      if (!done) s.el.style.visibility = "hidden";
    }
  }

  function draw() {
    const W = window.innerWidth, H = window.innerHeight;
    ctx.clearRect(0, 0, W, H);
    if (!sats.length) return;

    projector.update();
    const nowMs = Date.now();

    ctx.lineWidth = 1;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const s of sats) drawTrail(s, nowMs, W, H);

    if (trackedId) drawDot(byId.get(trackedId));
    layoutLabels(W, H);
  }

  map.on("render", draw);

  return {
    setSatellites,
    start() { requestAnimationFrame(tick); },
    track,
    release,
    onSelect(fn) { selectHandler = fn; },
    setPriority(id) { priorityId = id; },
    headOf(id) { const s = byId.get(id); return s ? s.head : null; },
    satrecOf(id) { const s = byId.get(id); return s ? s.satrec : null; },
    get trackedId() { return trackedId; },
    get cameraMode() { return cam.mode; },
  };
}
