/* Behavioural tests. The real page scripts run in jsdom, loaded as classic
 * scripts sharing one global scope exactly as the browser loads them, against
 * a fake Mapbox that implements every method the code touches. Then the tests
 * drive it like a user would. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(ROOT, f), "utf8");
const DEG = Math.PI / 180;

// ─── fresh, checksum-valid element sets placed at different points in orbit ──
function checksum(line) {
  let s = 0;
  for (const c of line.slice(0, 68)) { if (c >= "0" && c <= "9") s += +c; else if (c === "-") s += 1; }
  return String(s % 10);
}
function makeTle(norad, meanAnomaly, raan) {
  const L1 = "1 25544U 98067A   26077.80687812  .00008636  00000+0  16833-3 0  9998";
  const L2 = "2 25544  51.6341  27.2872 0006206 206.1039 153.9638 15.48363739557747";
  const now = new Date();
  const yy = String(now.getUTCFullYear() % 100).padStart(2, "0");
  const doy = ((now - Date.UTC(now.getUTCFullYear(), 0, 1)) / 86400000 + 1).toFixed(8).padStart(12, "0");
  const n = String(norad).padStart(5, "0");
  const l1 = "1 " + n + L1.slice(7, 18) + yy + doy + L1.slice(32);
  const l2 = "2 " + n + L2.slice(7, 17) + raan.toFixed(4).padStart(8) + L2.slice(25, 43) + meanAnomaly.toFixed(4).padStart(8) + L2.slice(51);
  return [l1.slice(0, 68) + checksum(l1), l2.slice(0, 68) + checksum(l2)];
}

// ─── environment: jsdom page + fake Mapbox + fake network and audio ──────────
function createEnvironment({ width = 1280, height = 800 } = {}) {
  let clock = 1000;
  let rafQueue = [];
  const raf = fn => { rafQueue.push(fn); return rafQueue.length; };

  const html = read("public/index.html").replace(/<script[\s\S]*?<\/script>/g, "");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/" });
  const w = dom.window;

  Object.defineProperty(w, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(w, "innerHeight", { value: height, configurable: true });
  Object.defineProperty(w.performance, "now", { value: () => clock, configurable: true });
  w.requestAnimationFrame = raf;
  w.devicePixelRatio = 2;

  const drawn = { strokes: 0, arcs: 0, gradients: 0 };
  w.HTMLCanvasElement.prototype.getContext = () => ({
    setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
    stroke() { drawn.strokes++; }, arc() { drawn.arcs++; }, fill() {},
    createLinearGradient() { drawn.gradients++; return { addColorStop() {} }; },
  });
  Object.defineProperty(w.HTMLElement.prototype, "offsetWidth", { get() { return this.textContent.length * 7 + 14; }, configurable: true });
  Object.defineProperty(w.HTMLElement.prototype, "offsetHeight", { get() { return 16; }, configurable: true });

  class LngLat { constructor(lng, lat) { this.lng = lng; this.lat = lat; } }

  const env = {};

  class FakeMap {
    constructor(opts) {
      this._h = {};
      this.c = { lng: opts.center[0], lat: opts.center[1] };
      this.zoom = opts.zoom;
      this.moving = false; this.easing = false; this.isLoaded = false;
      this.flyCalls = []; this.jumpCalls = 0; this.transformWrites = 0; this.updates = 0;
      const self = this;
      this.transform = {
        get center() { return new LngLat(self.c.lng, self.c.lat); },
        set center(v) { self.c = { lng: v.lng, lat: v.lat }; self.transformWrites++; },
      };
      const handler = () => ({ enabled: true, opts: undefined, disable() { this.enabled = false; }, enable(o) { this.enabled = true; this.opts = o; } });
      this.scrollZoom = handler();
      this.touchZoomRotate = handler();
      this.renderQueued = false;
      env.map = this;
    }
    on(t, fn) { (this._h[t] = this._h[t] || []).push(fn); return this; }
    off(t, fn) { this._h[t] = (this._h[t] || []).filter(f => f !== fn); return this; }
    once(t, fn) { const wrap = e => { this.off(t, wrap); fn(e); }; return this.on(t, wrap); }
    fire(t, data = {}) { (this._h[t] || []).slice().forEach(f => f({ type: t, ...data })); }
    loaded() { return this.isLoaded; }
    getCenter() { return new LngLat(this.c.lng, this.c.lat); }
    getZoom() { return this.zoom; }
    getBearing() { return 0; }
    isMoving() { return this.moving; }
    isEasing() { return this.easing; }
    setPaintProperty() {}
    setFog() {}
    triggerRepaint() {
      if (this.renderQueued) return;
      this.renderQueued = true;
      raf(() => { this.renderQueued = false; this.fire("render"); });
    }
    _update() { this.updates++; this.triggerRepaint(); }
    jumpTo(o) { this.jumpCalls++; this.c = { lng: o.center[0], lat: o.center[1] }; }
    flyTo(o) { this.flyCalls.push(o); this.moving = true; this.pendingFly = o; this.fire("movestart"); }
    finishFly() {
      const o = this.pendingFly;
      this.c = { lng: o.center[0], lat: o.center[1] }; this.zoom = o.zoom; this.moving = false;
      this.fire("moveend");
    }
    // Globe: pinhole camera looking at the Earth's centre, unhelpful past the
    // horizon. Above zoom 6: a flat local projection, as Mapbox's Mercator.
    project([lng, lat]) {
      const W = width, H = height;
      if (this.zoom >= 6) {
        const S = (256 * Math.pow(2, this.zoom)) / 360;
        const dl = ((lng - this.c.lng + 540) % 360) - 180;
        return { x: W / 2 + dl * Math.cos(this.c.lat * DEG) * S, y: H / 2 - (lat - this.c.lat) * S };
      }
      const D = 1 + 2.2 * Math.pow(2, 1.8 - this.zoom), f = 900;
      const la = this.c.lat * DEG, lo = this.c.lng * DEG;
      const ax = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
      const ea = [-Math.sin(lo), Math.cos(lo), 0];
      const no = [ax[1] * ea[2] - ax[2] * ea[1], ax[2] * ea[0] - ax[0] * ea[2], ax[0] * ea[1] - ax[1] * ea[0]];
      const p = lat * DEG, l = lng * DEG;
      const v = [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
      const a = v[0] * ax[0] + v[1] * ax[1] + v[2] * ax[2];
      if (a < 1 / D) return { x: NaN, y: NaN };
      const s = f / (D - a);
      return { x: W / 2 + s * (v[0] * ea[0] + v[1] * ea[1] + v[2] * ea[2]), y: H / 2 - s * (v[0] * no[0] + v[1] * no[1] + v[2] * no[2]) };
    }
  }

  const [issL1, issL2] = makeTle(25544, 153.9638, 27.2872);
  const [hstL1, hstL2] = makeTle(20580, 20, 27.2872);
  const [terL1, terL2] = makeTle(25994, 300, 120);
  const storyDelay = {};
  const json = (data, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => data });
  w.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u === "/data/catalogue.json") return json(JSON.parse(read("public/data/catalogue.json")));
    if (u === "/api/tles") return json({ satellites: [
      { id: "iss", l1: issL1, l2: issL2 },
      { id: "hubble", l1: hstL1, l2: hstL2 },
      { id: "terra", l1: terL1, l2: terL2 },
      { id: "noaa-19", l1: "1 junk", l2: "2 junk" },            // must be dropped, not drawn
    ] });
    if (u === "/api/story") {
      const { id } = JSON.parse(opts.body);
      await new Promise(r => setTimeout(r, storyDelay[id] || 0));
      return json({ text: `# ${id}\n\nThe entry for ${id}.\n\nIt went *quietly* on.`, audio: `/api/narrate/${id}/abc.mp3` });
    }
    throw new Error("unexpected fetch " + u);
  };

  const audios = [];
  class FakeAudio extends w.EventTarget {
    constructor(src) { super(); this.src = src; this.paused = true; this.ended = false; audios.push(this); }
    play() { this.paused = false; this.dispatchEvent(new w.Event("playing")); return Promise.resolve(); }
    pause() { if (this.paused) return; this.paused = true; this.dispatchEvent(new w.Event("pause")); }
    removeAttribute(k) { if (k === "src") this.src = ""; }
    load() {}
  }
  w.Audio = FakeAudio;
  w.mapboxgl = { Map: FakeMap, LngLat };
  w.MAPBOX_TOKEN = "pk.test";

  Object.assign(env, {
    w, dom, drawn, audios, storyDelay,
    step(ms = 16) { clock += ms; const q = rafQueue; rafQueue = []; q.forEach(fn => fn(clock)); },
    run(ms) { const end = clock + ms; while (clock < end) this.step(16); },
    flush: () => new Promise(r => setTimeout(r, 0)),
    wait: ms => new Promise(r => setTimeout(r, ms)),
    $: id => w.document.getElementById(id),
    labels: () => [...w.document.querySelectorAll(".sat-label")],
    label: name => [...w.document.querySelectorAll(".sat-label")].find(l => l.textContent === name),
  });

  const ctx = dom.getInternalVMContext();
  // The same UMD bundle the page loads from the CDN, in the page's own realm.
  new vm.Script(read("node_modules/satellite.js/dist/satellite.min.js"), { filename: "satellite.min.js" }).runInContext(ctx);
  for (const f of ["orbit.js", "projector.js", "scene.js", "ui.js", "main.js"]) {
    new vm.Script(read(`public/js/${f}`), { filename: f }).runInContext(ctx);
  }
  return env;
}

async function booted(opts) {
  const env = createEnvironment(opts);
  await env.flush(); await env.flush();
  env.map.fire("style.load");
  env.map.isLoaded = true;
  env.map.fire("load");
  await env.flush();
  env.run(48);                                   // let the first frames run
  return env;
}

const orbitOf = env => env.w.eval("Orbit");

function lookAt(env, id) {
  const head = env.w.__ds.scene.headOf(id);
  env.map.c = { lng: head.lon, lat: head.lat };
  env.run(48);
}

// ─── tests ───────────────────────────────────────────────────────────────────

test("boot: valid satellites become labels, junk is dropped, status is honest", async () => {
  const env = await booted();
  assert.deepEqual(env.labels().map(l => l.textContent), ["ISS", "HUBBLE SPACE TELESCOPE", "TERRA"]);
  assert.equal(env.$("sat-count").textContent, "3 objects tracked");
  assert.ok(env.$("masthead").classList.contains("visible"));
  assert.match(env.$("clock").textContent, /UTC$/);
  env.w.close();
});

test("render: trails drawn, labels placed on screen and never overlapping", async () => {
  const env = await booted();
  lookAt(env, "iss");
  assert.ok(env.drawn.strokes > 0, "trails stroked");
  const iss = env.label("ISS");
  assert.equal(iss.style.visibility, "visible", "the satellite we are looking at is labelled");
  assert.match(iss.style.transform, /^translate3d\(-?\d+px,-?\d+px,0\)$/);

  const rects = env.labels().filter(l => l.style.visibility === "visible").map(l => {
    const [, x, y] = l.style.transform.match(/translate3d\((-?\d+)px,(-?\d+)px/).map(Number);
    return [x, y, l.offsetWidth, l.offsetHeight];
  });
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const [a, b] = [rects[i], rects[j]];
    assert.ok(!(a[0] < b[0] + b[2] && a[0] + a[2] > b[0] && a[1] < b[1] + b[3] && a[1] + a[3] > b[1]), "labels overlap");
  }
  env.w.close();
});

test("selecting a label: panel opens, label hides, flight aims at the arrival point", async () => {
  const env = await booted();
  lookAt(env, "iss");
  env.label("ISS").dispatchEvent(new env.w.MouseEvent("click", { bubbles: true }));
  await env.flush(); await env.flush();

  assert.ok(env.$("info-panel").classList.contains("visible"));
  assert.ok(env.label("ISS").classList.contains("tracked"));
  assert.equal(env.$("panel-sat-name").textContent, "ISS");
  assert.equal(env.map.flyCalls.length, 1);
  const fly = env.map.flyCalls[0];
  assert.equal(fly.zoom, 7, "desktop fly-in zoom");

  const Orbit = orbitOf(env);
  const rec = env.w.__ds.scene.satrecOf("iss");
  const arrival = Orbit.positionAt(rec, new env.w.Date(Date.now() + 2800));   // a page-realm Date, as in the browser
  assert.ok(Orbit.arcDeg(fly.center[0], fly.center[1], arrival.lon, arrival.lat) < 0.05, "aims where the ISS will be, not where it was");
  assert.equal(env.map.scrollZoom.opts.around, "center", "zoom anchored to the satellite");
  assert.equal(env.map.touchZoomRotate.opts.around, "center");

  const paras = [...env.$("panel-text-content").querySelectorAll("p")].map(p => p.textContent);
  assert.deepEqual(paras, ["The entry for iss.", "It went quietly on."], "heading stripped");
  assert.equal(env.$("panel-text-content").querySelector("em").textContent, "quietly");
  assert.match(env.$("panel-live-alt").textContent, /^\d{3} km$/, "live altitude");
  env.w.close();
});

test("following: locks on exactly, never calls gesture-cancelling camera methods, survives pinch", async () => {
  const env = await booted();
  lookAt(env, "iss");
  env.w.__ds.scene.track("iss");
  env.map.finishFly();
  assert.equal(env.w.__ds.scene.cameraMode, "recovering");
  env.run(700);
  assert.equal(env.w.__ds.scene.cameraMode, "locked");

  const jumpsBefore = env.map.jumpCalls;
  for (let i = 0; i < 30; i++) {
    env.step(16);
    const h = env.w.__ds.scene.headOf("iss");
    assert.ok(Math.abs(env.map.c.lng - h.lon) < 1e-9 && Math.abs(env.map.c.lat - h.lat) < 1e-9, "centred exactly on the satellite");
  }
  assert.equal(env.map.jumpCalls, jumpsBefore, "no jumpTo/easeTo while following");
  assert.ok(env.map.transformWrites > 30 && env.map.updates > 30, "moves the camera through the transform");

  env.map.zoom = 10.4;                                  // a pinch happens
  env.run(200);
  assert.equal(env.map.zoom, 10.4, "follow never touches zoom");
  assert.equal(env.w.__ds.scene.cameraMode, "locked");
  env.w.close();
});

test("dragging away while tracking: holds, then glides back rather than snapping", async () => {
  const env = await booted();
  lookAt(env, "iss");
  env.w.__ds.scene.track("iss");
  env.map.finishFly();
  env.run(700);

  env.map.fire("dragstart");
  env.map.c = { lng: env.map.c.lng + 3, lat: env.map.c.lat - 2 };
  const dragged = { ...env.map.c };
  env.run(300);
  assert.equal(env.w.__ds.scene.cameraMode, "held");
  assert.deepEqual(env.map.c, dragged, "does not fight the user's hand");

  env.map.fire("dragend");
  env.map.fire("moveend");
  env.step(16);
  const Orbit = orbitOf(env);
  const h = () => env.w.__ds.scene.headOf("iss");
  const gap0 = Orbit.arcDeg(env.map.c.lng, env.map.c.lat, h().lon, h().lat);
  env.run(250);
  const gapMid = Orbit.arcDeg(env.map.c.lng, env.map.c.lat, h().lon, h().lat);
  assert.ok(gapMid < gap0 && gapMid > 0.01, "part way back, not snapped");
  env.run(500);
  assert.equal(env.w.__ds.scene.cameraMode, "locked");
  assert.ok(Math.abs(env.map.c.lng - h().lon) < 1e-9 && Math.abs(env.map.c.lat - h().lat) < 1e-9, "back on the satellite");
  env.w.close();
});

test("an inertia ease after a pinch is left alone, then the camera glides back", async () => {
  const env = await booted();
  lookAt(env, "iss");
  env.w.__ds.scene.track("iss");
  env.map.finishFly();
  env.run(700);

  env.map.easing = true;
  env.map.c = { lng: env.map.c.lng + 0.5, lat: env.map.c.lat };
  const pinned = { ...env.map.c };
  env.run(200);
  assert.deepEqual(env.map.c, pinned, "does not fight the ease");
  env.map.easing = false;
  env.step(16);
  assert.equal(env.w.__ds.scene.cameraMode, "recovering");
  env.run(700);
  assert.equal(env.w.__ds.scene.cameraMode, "locked");
  env.w.close();
});

test("narrator: listen, pause, resume; switching satellite stops the old voice", async () => {
  const env = await booted();
  env.label("ISS").click();
  await env.wait(5);

  const btn = env.$("ctrl-listen");
  assert.equal(btn.disabled, false);
  btn.click();
  assert.equal(env.audios.length, 1);
  assert.equal(env.audios[0].src, "/api/narrate/iss/abc.mp3", "content-addressed url from the server");
  assert.equal(btn.textContent, "◼ Pause");
  btn.click();
  assert.equal(btn.textContent, "▶ Resume");
  btn.click();
  assert.equal(btn.textContent, "◼ Pause");

  env.label("TERRA").click();
  assert.equal(env.audios[0].paused, true, "old narration stopped");
  assert.equal(env.audios[0].src, "", "and released");
  assert.equal(btn.disabled, true, "no Listen until the new story is in");
  await env.wait(5);
  btn.click();
  assert.equal(env.audios[1].src, "/api/narrate/terra/abc.mp3", "Listen now plays the new satellite");
  env.w.close();
});

test("a slow story never lands on the wrong panel", async () => {
  const env = await booted();
  env.storyDelay.hubble = 60;
  env.label("HUBBLE SPACE TELESCOPE").click();
  await env.wait(5);
  env.label("TERRA").click();
  await env.wait(100);
  assert.equal(env.$("panel-sat-name").textContent, "Terra");
  assert.equal(env.$("panel-text-content").querySelector("p").textContent, "The entry for terra.");
  env.w.close();
});

test("closing: releases the camera, restores labels and zoom, stops audio", async () => {
  const env = await booted();
  env.label("ISS").click();
  await env.wait(5);
  env.map.finishFly();
  env.run(700);
  env.$("ctrl-listen").click();

  env.$("ctrl-close").click();
  assert.ok(!env.$("info-panel").classList.contains("visible"));
  assert.equal(env.w.__ds.scene.cameraMode, "free");
  assert.equal(env.w.__ds.scene.trackedId, null);
  assert.ok(env.labels().every(l => !l.classList.contains("tracked")));
  assert.equal(env.map.scrollZoom.opts, undefined, "zoom back to normal");
  assert.equal(env.audios[0].paused, true);
  env.w.close();
});

test("rotation: turns about the poles only when zoomed out and idle", async () => {
  const env = await booted();
  env.map.zoom = 2;
  env.run(100);
  const c0 = { ...env.map.c };
  env.run(1000);
  assert.ok(env.map.c.lng < c0.lng, "drifts west as the Earth turns east");
  assert.equal(env.map.c.lat, c0.lat, "about the polar axis: latitude unchanged");

  env.map.fire("mousedown");
  const c1 = { ...env.map.c };
  env.run(2000);
  assert.deepEqual(env.map.c, c1, "pauses after interaction");
  env.run(2500);
  assert.ok(env.map.c.lng < c1.lng, "resumes after four seconds");

  env.map.zoom = 7;
  const c2 = { ...env.map.c };
  env.run(6000);
  assert.deepEqual(env.map.c, c2, "never drifts under you when zoomed in");
  env.w.close();
});

test("daily card: rotates by UTC day and behaves exactly like clicking the label", async () => {
  const env = await booted();
  const name = env.$("daily-card-name").textContent;
  assert.ok(["ISS", "Hubble Space Telescope", "Terra"].includes(name), "picks an available satellite: " + name);
  assert.match(env.$("daily-card-issue").textContent, /^Issue No\. \d+ — Daily Satellite$/);

  env.$("daily-card").click();
  await env.wait(5);
  const label = env.labels().find(l => l.textContent === name.toUpperCase());
  assert.ok(label.classList.contains("tracked"), "its label hides, like a label click");
  assert.equal(env.map.flyCalls.length, 1, "and it flies there");
  assert.ok(env.$("info-panel").classList.contains("visible"));
  env.w.close();
});

test("mobile flies in closer", async () => {
  const env = await booted({ width: 390, height: 844 });
  env.label("ISS").click();
  await env.wait(5);
  assert.equal(env.map.flyCalls[0].zoom, 8);
  env.w.close();
});
