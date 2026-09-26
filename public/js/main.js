/* Boot
 * Data is requested at once, in parallel with the map loading, rather than
 * after it. Satellites without fresh, valid elements are left out: a gap is
 * honest, a satellite drawn on an invented orbit is not.
 */
(async function boot() {
  const catalogueP = fetch("/data/catalogue.json").then(r => r.json());
  const tlesP = fetch("/api/tles").then(r => (r.ok ? r.json() : { satellites: [] })).catch(() => ({ satellites: [] }));

  let map;
  try {
    mapboxgl.accessToken = window.MAPBOX_TOKEN || "";
    map = new mapboxgl.Map({
      container: "map",
      style: "mapbox://styles/mapbox/satellite-v9",
      projection: "globe",
      zoom: 1.8,
      center: [10, 25],
      pitch: 0,
      bearing: 0,
      minZoom: 0.5,
      maxZoom: 18,
      attributionControl: false,
      logoPosition: "bottom-left",
      scrollZoom: true,              // native wheel and pinch zoom, nothing custom on top
      touchZoomRotate: true,
    });
  } catch (e) {
    const el = document.getElementById("sat-count");
    el.textContent = "This browser cannot draw the globe (WebGL unavailable)";
    el.classList.add("visible");
    return;
  }

  map.on("style.load", () => {
    // Warm, slightly desaturated: matches the old Bing aerial character.
    map.setPaintProperty("satellite", "raster-saturation", -0.12);
    map.setPaintProperty("satellite", "raster-contrast", -0.04);
    map.setPaintProperty("satellite", "raster-brightness-min", 0.02);
    map.setPaintProperty("satellite", "raster-hue-rotate", 6);
    map.setFog({
      color: "#f0ebe0",
      "high-color": "#c8bfb0",
      "horizon-blend": 0.08,
      "space-color": "#f0ebe0",
      "star-intensity": 0,
    });
  });

  const projector = createProjector(map);
  const scene = createScene(map, projector);
  const ui = createUI(scene);
  ui.initMasthead();
  ui.setStatus("Fetching orbital data…");

  window.__ds = { map, scene, projector };   // handle for the browser console

  const [catalogue, tles] = await Promise.all([catalogueP, tlesP]);
  ui.setCatalogue(catalogue);

  const tleById = new Map((tles.satellites || []).map(t => [t.id, t]));
  const usable = [];
  for (const meta of catalogue) {
    const t = tleById.get(meta.id);
    if (!t) continue;
    const satrec = Orbit.makeSatrec(t.l1, t.l2);
    if (!satrec || !Orbit.isFresh(satrec)) continue;
    if (!Orbit.positionAt(satrec, new Date())) continue;      // decayed or unpropagatable
    usable.push({ meta, satrec });
  }

  const start = () => {
    scene.setSatellites(usable);
    scene.start();
    ui.setStatus(usable.length
      ? `${usable.length} objects tracked`
      : "Orbital data unavailable. Try again shortly.");
    ui.showDailyCard(catalogue, new Set(usable.map(u => u.meta.id)));
  };

  if (map.loaded()) start();
  else map.once("load", start);
})();
