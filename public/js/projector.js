/* Projector
 * One function turns a point on the render sphere into a screen position.
 * Labels, trails and the tracked dot all go through it, so they cannot
 * disagree about where a satellite is.
 *
 * Mapbox draws a true sphere below zoom 5 and flat Mercator above zoom 6,
 * blending between (GLOBE_ZOOM_THRESHOLD_MIN/MAX in mapbox-gl 3.3.0).
 *
 * Globe: rather than reverse-engineer Mapbox's camera, we measure it. Each
 * frame, three probe points on the sphere are pushed through map.project().
 * A pinhole camera looking at the Earth's centre gives
 *     d(theta) = f * sin(theta) / (D - cos(theta))
 * for a point at angle theta from the view axis, so two probes solve for the
 * camera distance D (in Earth radii) and focal length f (in px). The third
 * gives the screen direction of east, which absorbs any bearing.
 *
 * Map: above zoom 6 a satellite is effectively straight overhead, so its
 * ground position from map.project() is the correct answer.
 */
function createProjector(map) {
  const DEG = Math.PI / 180;
  const GLOBE_MAX = 5.0;
  const MAP_MIN = 6.0;

  const state = {
    blend: 0,       // 0 = pure globe, 1 = pure map
    ok: false,
    D: 3,           // last solved camera distance; seeds the next probe angles
    f: 1, C: null, ax: null, ea: null, no: null, sn: null, se: null,
  };

  function lngLatOf(v) {
    return [Math.atan2(v[1], v[0]) / DEG,
            Math.asin(Math.max(-1, Math.min(1, v[2]))) / DEG];
  }

  function probe(ax, basis, theta) {
    const c = Math.cos(theta), s = Math.sin(theta);
    return map.project(lngLatOf([ax[0] * c + basis[0] * s,
                                 ax[1] * c + basis[1] * s,
                                 ax[2] * c + basis[2] * s]));
  }

  function calibrate() {
    const c = map.getCenter();
    const la = c.lat * DEG, lo = c.lng * DEG;
    const ax = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
    const ea = [-Math.sin(lo), Math.cos(lo), 0];
    const no = [ax[1] * ea[2] - ax[2] * ea[1],
                ax[2] * ea[0] - ax[0] * ea[2],
                ax[0] * ea[1] - ax[1] * ea[0]];
    const C = map.project([c.lng, c.lat]);

    // Keep both probes well inside the visible cap, whose half-angle is
    // acos(1/D). Too wide and we would be measuring the far side.
    let t2 = Math.min(60 * DEG, 0.8 * Math.acos(1 / Math.max(state.D, 1.0001)));

    for (let attempt = 0; attempt < 4; attempt++, t2 *= 0.5) {
      const t1 = t2 / 2;
      if (t1 < 0.05 * DEG) break;
      const P1 = probe(ax, no, t1), P2 = probe(ax, no, t2), E1 = probe(ax, ea, t1);
      const d1 = Math.hypot(P1.x - C.x, P1.y - C.y);
      const d2 = Math.hypot(P2.x - C.x, P2.y - C.y);
      const e1 = Math.hypot(E1.x - C.x, E1.y - C.y);
      if (!(d1 > 0.5) || !(d2 > d1) || !(e1 > 0.5)) continue;

      const s1 = Math.sin(t1), c1 = Math.cos(t1), s2 = Math.sin(t2), c2 = Math.cos(t2);
      const k = d2 / d1;
      const den = k * s1 - s2;
      let D = Math.abs(den) < 1e-12 ? 1e4 : (k * s1 * c2 - s2 * c1) / den;
      if (!isFinite(D) || D > 1e4) D = 1e4;          // effectively orthographic
      if (D <= 1.00001) continue;                      // camera inside the Earth: bad fit
      const f = d1 * (D - c1) / s1;
      if (!isFinite(f) || f <= 0) continue;

      Object.assign(state, {
        D, f, C, ax, ea, no,
        sn: [(P1.x - C.x) / d1, (P1.y - C.y) / d1],
        se: [(E1.x - C.x) / e1, (E1.y - C.y) / e1],
      });
      return true;
    }
    return false;
  }

  // Does the straight segment from the camera to this point cross the Earth?
  function occluded(vx, vy, vz) {
    const D = state.D, ax = state.ax;
    const cx = D * ax[0], cy = D * ax[1], cz = D * ax[2];
    const dx = vx - cx, dy = vy - cy, dz = vz - cz;
    const A = dx * dx + dy * dy + dz * dz;
    const B = 2 * (cx * dx + cy * dy + cz * dz);
    const Cq = cx * cx + cy * cy + cz * cz - 1;
    const disc = B * B - 4 * A * Cq;
    if (disc <= 0) return false;
    const t = (-B - Math.sqrt(disc)) / (2 * A);
    return t > 1e-6 && t < 1 - 1e-6;
  }

  function update() {
    const z = map.getZoom();
    state.blend = z <= GLOBE_MAX ? 0 : z >= MAP_MIN ? 1 : (z - GLOBE_MAX) / (MAP_MIN - GLOBE_MAX);
    state.ok = state.blend >= 1 ? true : calibrate();
  }

  // pt: {x, y, z, lon, lat} on the render sphere. Returns {x, y, visible}.
  function project(pt) {
    const b = state.blend;
    if (b >= 1) {
      const m = map.project([pt.lon, pt.lat]);
      return { x: m.x, y: m.y, visible: true };
    }
    if (!state.ok) return { x: 0, y: 0, visible: false };

    const a  = pt.x * state.ax[0] + pt.y * state.ax[1] + pt.z * state.ax[2];
    const pe = pt.x * state.ea[0] + pt.y * state.ea[1] + pt.z * state.ea[2];
    const pn = pt.x * state.no[0] + pt.y * state.no[1] + pt.z * state.no[2];
    const zc = state.D - a;
    if (zc <= 1e-3) return { x: 0, y: 0, visible: false };

    const s = state.f / zc;
    let x = state.C.x + s * (pe * state.se[0] + pn * state.sn[0]);
    let y = state.C.y + s * (pe * state.se[1] + pn * state.sn[1]);
    const visible = !occluded(pt.x, pt.y, pt.z);

    if (b > 0) {
      const m = map.project([pt.lon, pt.lat]);
      x += (m.x - x) * b;
      y += (m.y - y) * b;
    }
    return { x, y, visible };
  }

  return { update, project, state, GLOBE_MAX, MAP_MIN };
}
