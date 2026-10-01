/* Orbit
 * SGP4 propagation and geometry. Pure: no DOM, no map.
 * Depends only on the global `satellite` (satellite.js 4).
 *
 * Positions are placed on the same sphere Mapbox draws: radius 1 at the
 * surface, scaled up by altitude. Because lat/lon map onto that sphere exactly
 * as Mapbox maps them, a point at zero altitude sits exactly on the ground.
 */
const Orbit = (() => {
  const R_EARTH_KM = 6371.0;
  const DEG = Math.PI / 180;
  const MS_PER_MIN = 60000;

  const TRAIL_WINDOW_MS = 15 * MS_PER_MIN;
  const TRAIL_STEP_MS = 12000;                 // one sample every 12 s
  const MAX_TLE_AGE_DAYS = 30;                 // older than this is fiction

  // TLE line checksum: digits sum, minus signs count as 1, modulo 10.
  function checksumOk(line) {
    if (typeof line !== "string" || line.length < 69) return false;
    let sum = 0;
    for (let i = 0; i < 68; i++) {
      const c = line[i];
      if (c >= "0" && c <= "9") sum += c.charCodeAt(0) - 48;
      else if (c === "-") sum += 1;
    }
    return sum % 10 === line.charCodeAt(68) - 48;
  }

  function validTle(l1, l2) {
    return checksumOk(l1) && checksumOk(l2) &&
           l1[0] === "1" && l2[0] === "2" &&
           l1.slice(2, 7) === l2.slice(2, 7);        // same catalogue number
  }

  // Parse once. Building the satrec is the expensive part; propagating is ~2us.
  // satellite.js returns a satrec full of NaN for bad input rather than failing,
  // so validate before trusting it.
  function makeSatrec(l1, l2) {
    if (!validTle(l1, l2)) return null;
    try {
      const rec = satellite.twoline2satrec(l1, l2);
      if (!rec || rec.error || !(rec.no > 0) || !isFinite(rec.jdsatepoch)) return null;
      return rec;
    } catch (e) { return null; }
  }

  function epochOf(satrec) {
    return new Date((satrec.jdsatepoch - 2440587.5) * 86400000);
  }

  function ageDays(satrec, now = new Date()) {
    return (now - epochOf(satrec)) / 86400000;
  }

  // SGP4 happily extrapolates years past epoch without complaint. Past a few
  // weeks the along-track error is thousands of km, so treat it as unknown.
  function isFresh(satrec, now = new Date()) {
    return Math.abs(ageDays(satrec, now)) <= MAX_TLE_AGE_DAYS;
  }

  // Place geodetic coordinates on the render sphere.
  function toPoint(lat, lon, altKm) {
    const phi = lat * DEG, lam = lon * DEG;
    const r = 1 + altKm / R_EARTH_KM;
    const c = Math.cos(phi);
    return {
      lat, lon, alt: altKm,
      x: r * c * Math.cos(lam),
      y: r * c * Math.sin(lam),
      z: r * Math.sin(phi),
    };
  }

  // Position at a moment, or null if SGP4 cannot give one (decayed, bad TLE).
  function positionAt(satrec, date) {
    let pv;
    try { pv = satellite.propagate(satrec, date); } catch (e) { return null; }
    const p = pv && pv.position;
    if (!p || !isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) return null;

    const g = satellite.eciToGeodetic(p, satellite.gstime(date));
    if (!isFinite(g.height) || g.height < 80) return null;   // below this it has re-entered

    const pt = toPoint(satellite.degreesLat(g.latitude), satellite.degreesLong(g.longitude), g.height);
    const v = pv.velocity;
    pt.speed = v ? Math.hypot(v.x, v.y, v.z) : NaN;          // km/s, inertial
    return pt;
  }

  // Elements read straight from the TLE rather than hand-maintained copies.
  function elements(satrec) {
    return {
      inclination: satrec.inclo / DEG,           // degrees
      periodMin: (2 * Math.PI) / satrec.no,      // satrec.no is rad/min
      eccentricity: satrec.ecco,
      epoch: epochOf(satrec),
    };
  }

  // Great-circle angle between two lon/lat pairs, in degrees. Haversine form:
  // the acos form loses precision near zero (it reports ~1e-6 deg for two
  // identical points), which matters when checking that the camera is on target.
  function arcDeg(aLon, aLat, bLon, bLat) {
    const p1 = aLat * DEG, p2 = bLat * DEG;
    const sdp = Math.sin((p2 - p1) / 2), sdl = Math.sin(((bLon - aLon) * DEG) / 2);
    const h = sdp * sdp + Math.cos(p1) * Math.cos(p2) * sdl * sdl;
    return (2 * Math.asin(Math.min(1, Math.sqrt(h)))) / DEG;
  }

  // Shortest-path interpolation between two lon/lat pairs on the sphere.
  function slerpLngLat(aLon, aLat, bLon, bLat, t) {
    const a = toPoint(aLat, aLon, 0), b = toPoint(bLat, bLon, 0);
    const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
    const om = Math.acos(dot);
    if (om < 1e-9) return { lon: bLon, lat: bLat };
    const s = Math.sin(om);
    const wa = Math.sin((1 - t) * om) / s, wb = Math.sin(t * om) / s;
    const x = wa * a.x + wb * b.x, y = wa * a.y + wb * b.y, z = wa * a.z + wb * b.z;
    return { lon: Math.atan2(y, x) / DEG, lat: Math.atan2(z, Math.hypot(x, y)) / DEG };
  }

  /* Trail: samples on a fixed absolute-time grid, so a trail never needs
   * rebuilding. Each tick at most one new sample is appended and old ones
   * drop off the back. Fade is derived from sample age at draw time. */
  class Trail {
    constructor(satrec) {
      this.satrec = satrec;
      this.points = [];        // [{t, lat, lon, alt, x, y, z}]
      this.lastK = null;
    }

    update(nowMs) {
      const kNow = Math.floor(nowMs / TRAIL_STEP_MS);
      const kFirst = Math.ceil((nowMs - TRAIL_WINDOW_MS) / TRAIL_STEP_MS);

      if (this.lastK === null || kNow - this.lastK > (kNow - kFirst)) {
        this.points = [];
        for (let k = kFirst; k <= kNow; k++) this._push(k);
      } else {
        for (let k = this.lastK + 1; k <= kNow; k++) this._push(k);
      }
      this.lastK = kNow;

      const cutoff = nowMs - TRAIL_WINDOW_MS;
      let drop = 0;
      while (drop < this.points.length && this.points[drop].t < cutoff) drop++;
      if (drop) this.points.splice(0, drop);
    }

    _push(k) {
      const t = k * TRAIL_STEP_MS;
      const p = positionAt(this.satrec, new Date(t));
      if (p) { p.t = t; this.points.push(p); }
    }
  }

  return {
    R_EARTH_KM, DEG, TRAIL_WINDOW_MS, TRAIL_STEP_MS, MAX_TLE_AGE_DAYS,
    checksumOk, validTle, makeSatrec, epochOf, ageDays, isFresh,
    toPoint, positionAt, elements, arcDeg, slerpLngLat, Trail,
  };
})();
