/* Engine tests: orbit.js and projector.js, run against the real satellite.js.
 * The browser files are classic scripts, so they are loaded into a VM context
 * exactly as a page would load them. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function load(files, globals = {}) {
  const ctx = vm.createContext({ Math, Date, console, isFinite, ...globals });
  const src = files.map(f => fs.readFileSync(path.join(__dirname, "..", "public", "js", f), "utf8")).join("\n;\n");
  vm.runInContext(src + "\n;globalThis.__exports = { Orbit, createProjector };", ctx);
  return ctx.__exports;
}

const satellite = require("satellite.js");
const { Orbit, createProjector } = load(["orbit.js", "projector.js"], { satellite });
const DEG = Math.PI / 180;

function tleChecksum(line) {
  let s = 0;
  for (const c of line.slice(0, 68)) { if (c >= "0" && c <= "9") s += +c; else if (c === "-") s += 1; }
  return String(s % 10);
}
function freshIss(date = new Date()) {
  // Real ISS lines; only the epoch (columns 19-32) is rewritten, then re-checksummed.
  const L1 = "1 25544U 98067A   26077.80687812  .00008636  00000+0  16833-3 0  9998";
  const L2 = "2 25544  51.6341  27.2872 0006206 206.1039 153.9638 15.48363739557747";
  const yy = String(date.getUTCFullYear() % 100).padStart(2, "0");
  const doy = ((date - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86400000 + 1).toFixed(8).padStart(12, "0");
  let l1 = L1.slice(0, 18) + yy + doy + L1.slice(32);
  l1 = l1.slice(0, 68) + tleChecksum(l1);
  return [l1, L2];
}

// ─── orbit ────────────────────────────────────────────────────────────────

test("TLE fixture is well formed", () => {
  const [l1, l2] = freshIss();
  assert.equal(l1.length, 69); assert.equal(l2.length, 69);
  assert.equal(l1[68], tleChecksum(l1)); assert.equal(l2[68], tleChecksum(l2));
});

test("elements come from the TLE", () => {
  const rec = Orbit.makeSatrec(...freshIss());
  const e = Orbit.elements(rec);
  assert.ok(Math.abs(e.periodMin - 93.0) < 0.2, "ISS period " + e.periodMin);
  assert.ok(Math.abs(e.inclination - 51.63) < 0.01, "ISS inclination " + e.inclination);
  assert.ok(Orbit.ageDays(rec) < 0.01);
});

test("position is plausible and sits on the render sphere", () => {
  const rec = Orbit.makeSatrec(...freshIss());
  for (let i = 0; i < 50; i++) {
    const p = Orbit.positionAt(rec, new Date(Date.now() + i * 97000));
    assert.ok(p, "propagates");
    assert.ok(p.alt > 350 && p.alt < 480, "alt " + p.alt);
    assert.ok(p.speed > 7.5 && p.speed < 7.8, "speed " + p.speed);
    assert.ok(Math.abs(p.lat) <= 51.63 + 0.2, "geodetic lat within inclination plus oblateness " + p.lat);
    const r = Math.hypot(p.x, p.y, p.z);
    assert.ok(Math.abs(r - (1 + p.alt / Orbit.R_EARTH_KM)) < 1e-12);
    const back = [Math.atan2(p.y, p.x) / DEG, Math.atan2(p.z, Math.hypot(p.x, p.y)) / DEG];
    assert.ok(Math.abs(((back[0] - p.lon + 540) % 360) - 180) < 1e-9);
    assert.ok(Math.abs(back[1] - p.lat) < 1e-9);
  }
});

test("garbage, corrupted and stale TLEs are rejected, not drawn", () => {
  const [l1, l2] = freshIss();
  assert.equal(Orbit.makeSatrec("1 junk", "2 junk"), null);
  assert.equal(Orbit.makeSatrec(l1, l2.slice(0, 40) + ((+l2[40] + 1) % 10) + l2.slice(41)), null, "checksum catches a flipped digit");
  assert.equal(Orbit.makeSatrec(l2, l1), null, "lines swapped");
  assert.ok(Orbit.makeSatrec(l1, l2), "fresh set accepted");
  const old = freshIss(new Date(Date.now() - 45 * 86400000));
  assert.ok(Orbit.makeSatrec(...old), "parses");
  assert.equal(Orbit.isFresh(Orbit.makeSatrec(...old)), false, "but 45 days old is not fresh");
});

test("incremental trail matches a full rebuild and stays in its window", () => {
  const rec = Orbit.makeSatrec(...freshIss());
  const t0 = Date.now();
  const inc = new Orbit.Trail(rec);
  inc.update(t0);
  const n0 = inc.points.length;
  assert.ok(n0 >= 75 && n0 <= 76, "sample count " + n0);

  for (let dt = 1000; dt <= 5 * 60000; dt += 1777) inc.update(t0 + dt);
  const tEnd = t0 + 5 * 60000;
  inc.update(tEnd);

  const full = new Orbit.Trail(rec);
  full.update(tEnd);
  assert.equal(inc.points.length, full.points.length);
  inc.points.forEach((p, i) => {
    assert.equal(p.t, full.points[i].t);
    assert.ok(Math.abs(p.x - full.points[i].x) < 1e-12);
  });
  for (const p of inc.points) {
    assert.ok(p.t >= tEnd - Orbit.TRAIL_WINDOW_MS && p.t <= tEnd);
    assert.equal(p.t % Orbit.TRAIL_STEP_MS, 0, "on the time grid");
  }
  for (let i = 1; i < inc.points.length; i++) assert.ok(inc.points[i].t > inc.points[i - 1].t);

  inc.update(tEnd + 3 * 3600000);           // long gap: rebuilds cleanly
  assert.ok(inc.points.length >= 75 && inc.points.length <= 76);
});

test("arc distance is exact for identical points and correct for known ones", () => {
  assert.equal(Orbit.arcDeg(24.9, 60.4, 24.9, 60.4), 0);
  assert.ok(Math.abs(Orbit.arcDeg(0, 0, 90, 0) - 90) < 1e-12);
  assert.ok(Math.abs(Orbit.arcDeg(10, -89, 190, -89) - 2) < 1e-9, "across the pole");
  assert.ok(Math.abs(Orbit.arcDeg(0, 0, 1e-7, 0) - 1e-7) < 1e-15, "tiny angles resolved");
});

test("slerp takes the short way across the antimeridian", () => {
  const m = Orbit.slerpLngLat(179, 10, -179, 10, 0.5);
  assert.ok(Math.abs(Math.abs(m.lon) - 180) < 0.01, "lon " + m.lon);
  const end = Orbit.slerpLngLat(10, 20, 30, 40, 1);
  assert.ok(Math.abs(end.lon - 30) < 1e-9 && Math.abs(end.lat - 40) < 1e-9);
});

// ─── projector against a synthetic Mapbox with a known camera ─────────────

function fakeMap({ D, f, lon, lat, bearing, zoom = 3, W = 1200, H = 800, hideFarSide = true }) {
  const la = lat * DEG, lo = lon * DEG, b = bearing * DEG;
  const ax = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  const ea = [-Math.sin(lo), Math.cos(lo), 0];
  const no = [ax[1] * ea[2] - ax[2] * ea[1], ax[2] * ea[0] - ax[0] * ea[2], ax[0] * ea[1] - ax[1] * ea[0]];
  const cam = v => {
    const a = v[0] * ax[0] + v[1] * ax[1] + v[2] * ax[2];
    const pe = v[0] * ea[0] + v[1] * ea[1] + v[2] * ea[2];
    const pn = v[0] * no[0] + v[1] * no[1] + v[2] * no[2];
    const s = f / (D - a);
    const u = pe * s, w = -pn * s;                          // screen y points down
    return { x: W / 2 + u * Math.cos(b) - w * Math.sin(b), y: H / 2 + u * Math.sin(b) + w * Math.cos(b), a };
  };
  const surf = (lngLat) => {
    const p = lngLat[1] * DEG, l = lngLat[0] * DEG;
    return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
  };
  return {
    cam,
    truthOccluded(v) {                                      // closest-approach test, independent of the code under test
      const c = [D * ax[0], D * ax[1], D * ax[2]], d = [v[0] - c[0], v[1] - c[1], v[2] - c[2]];
      const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
      const t = Math.max(0, Math.min(1, -(c[0] * d[0] + c[1] * d[1] + c[2] * d[2]) / dd));
      return Math.hypot(c[0] + t * d[0], c[1] + t * d[1], c[2] + t * d[2]) < 1;
    },
    getCenter: () => ({ lng: lon, lat }),
    getZoom: () => zoom,
    project(lngLat) {
      const r = cam(surf(lngLat));
      if (hideFarSide && r.a < 1 / D) return { x: NaN, y: NaN };   // pretend Mapbox is unhelpful past the horizon
      return { x: r.x, y: r.y };
    },
  };
}

function randomSat(rand) {
  const lat = Math.asin(2 * rand() - 1) / DEG, lon = rand() * 360 - 180, alt = 300 + rand() * 1700;
  return Orbit.toPoint(lat, lon, alt);
}

function rng(seed) { return () => (seed = (seed * 16807) % 2147483647) / 2147483647; }

const cameras = [
  { D: 1.15, f: 900,  lon: 24.9,   lat: 60.4, bearing: 0 },     // close in over Turku
  { D: 1.6,  f: 1100, lon: -120,   lat: 35,   bearing: 37 },
  { D: 3,    f: 1400, lon: 179.95, lat: -10,  bearing: 180 },   // on the antimeridian
  { D: 8,    f: 5000, lon: 10,     lat: 88,   bearing: -100 },  // over the pole
  { D: 200,  f: 9e4,  lon: 0,      lat: 0,    bearing: 12 },    // near-orthographic
];

for (const c of cameras) {
  test(`projector recovers camera and matches truth: D=${c.D} bearing=${c.bearing} centre=${c.lon},${c.lat}`, () => {
    const map = fakeMap(c);
    const P = createProjector(map);
    P.update();                                   // first frame, seeded with the default D
    P.update();                                   // second frame, seeded with the solved D
    assert.ok(P.state.ok, "calibrated");
    assert.ok(Math.abs(P.state.D - c.D) / c.D < 1e-6, "D " + P.state.D);

    const rand = rng(12345);
    let visibleCount = 0;
    for (let i = 0; i < 4000; i++) {
      const pt = randomSat(rand);
      const got = P.project(pt);
      const behindCamera = map.cam([pt.x, pt.y, pt.z]).a >= c.D - 1e-3;
      const truthHidden = behindCamera || map.truthOccluded([pt.x, pt.y, pt.z]);
      assert.equal(got.visible, !truthHidden, `visibility at ${pt.lon.toFixed(2)},${pt.lat.toFixed(2)} alt ${pt.alt.toFixed(0)}`);
      if (got.visible) {
        const want = map.cam([pt.x, pt.y, pt.z]);
        assert.ok(Math.hypot(got.x - want.x, got.y - want.y) < 1e-4, `pixel error ${Math.hypot(got.x - want.x, got.y - want.y)}`);
        visibleCount++;
      }
    }
    assert.ok(visibleCount > 100, "enough visible samples to mean something: " + visibleCount);
  });
}

test("blend band interpolates linearly toward the ground position", () => {
  const base = { D: 1.2, f: 1000, lon: 24.9, lat: 60.4, bearing: 0 };
  const globe = createProjector(fakeMap({ ...base, zoom: 4.9 }));
  const half = createProjector(fakeMap({ ...base, zoom: 5.5 }));
  const flat = createProjector(fakeMap({ ...base, zoom: 6.2 }));
  [globe, half, flat].forEach(p => { p.update(); p.update(); });
  const pt = Orbit.toPoint(61, 26, 420);
  const g = globe.project(pt), h = half.project(pt), m = flat.project(pt);
  assert.equal(half.state.blend, 0.5);
  assert.ok(Math.abs(h.x - (g.x + m.x) / 2) < 1e-6 && Math.abs(h.y - (g.y + m.y) / 2) < 1e-6);
});

test("a 400 km satellite peeks over the horizon, exactly as geometry says", () => {
  // Far camera: hidden once past 90 + acos(1/r) degrees from the sub-camera point.
  const P = createProjector(fakeMap({ D: 1e4, f: 1e7, lon: 0, lat: 0, bearing: 0 }));
  P.update(); P.update();
  const r = 1 + 400 / Orbit.R_EARTH_KM;
  const limit = 90 + Math.acos(1 / r) / DEG;
  assert.equal(P.project(Orbit.toPoint(0, limit - 0.2, 400)).visible, true);
  assert.equal(P.project(Orbit.toPoint(0, limit + 0.2, 400)).visible, false);
});
