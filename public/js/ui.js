/* UI
 * Panel, narrator, daily card and masthead. Every way of choosing a satellite
 * (its label, today's card) goes through select(), so they behave identically.
 */
function createUI(scene) {
  const $ = id => document.getElementById(id);
  const panel = $("info-panel");
  const textEl = $("panel-text-content");
  const listenBtn = $("ctrl-listen");
  const collapseBtn = $("ctrl-collapse");
  const body = $("panel-body");
  const fadeTop = $("panel-fade-top");

  let current = null;        // catalogue entry of the open satellite
  let request = 0;           // guards against a slow story landing on the wrong panel
  let liveTimer = null;
  let dailyId = null;

  // The text follows the voice; scrolling it by hand pauses the voice.
  const follower = createFollower(textEl, body, {
    onReaderScroll() { if (narrator.audio && !narrator.audio.paused) narrator.audio.pause(); },
  });

  // ─── narrator ──────────────────────────────────────────────────────────
  // The <audio> element is created inside the click, so mobile Safari treats
  // play() as user-initiated. The URL is content-addressed by the server, so
  // audio can never drift out of step with the story on screen.
  const narrator = {
    audio: null,
    url: null,
    timings: null,
    set(label, enabled) {
      listenBtn.textContent = label;
      listenBtn.disabled = !enabled;
    },
    ready(url, timings) { this.stop(); this.url = url; this.timings = timings || null; this.set("▶ Listen", !!url); },
    reset() { this.stop(); this.url = null; this.timings = null; this.set("▶ Listen", false); },
    stop() {
      follower.detach();
      if (this.audio) {
        const a = this.audio;
        this.audio = null;
        a.pause();
        a.removeAttribute("src");
        a.load();
      }
    },
    toggle() {
      if (!this.url) return;
      if (this.audio) {
        if (this.audio.paused) this.audio.play();
        else this.audio.pause();
        return;
      }
      const a = new Audio(this.url);
      a.preload = "auto";
      this.audio = a;
      follower.attach(a, this.timings);
      this.set("… Loading", true);
      a.addEventListener("playing", () => { if (this.audio === a) this.set("◼ Pause", true); });
      a.addEventListener("pause", () => { if (this.audio === a && !a.ended) this.set("▶ Resume", true); });
      a.addEventListener("ended", () => { if (this.audio === a) { this.audio = null; this.set("▶ Listen", true); } });
      a.addEventListener("error", () => {
        if (this.audio !== a) return;
        this.audio = null;
        follower.detach();
        this.set("✕ Unavailable", false);
        setTimeout(() => { if (!this.audio && this.url) this.set("▶ Listen", true); }, 4000);
      });
      a.play().catch(() => { /* surfaced by the error listener if it matters */ });
    },
  };
  listenBtn.addEventListener("click", () => narrator.toggle());

  // ─── story rendering ───────────────────────────────────────────────────
  // Built from DOM nodes, never innerHTML. The follower wraps each word, turns
  // *emphasis* into italics and draws the dial beside the lines.
  function renderStory(text) {
    follower.render(text);
  }

  function setMessage(msg, loading) {
    follower.clear();
    textEl.textContent = "";
    const p = document.createElement("p");
    if (loading) p.id = "panel-loading";
    else { p.style.fontStyle = "italic"; p.style.opacity = "0.5"; }
    p.textContent = msg;
    textEl.appendChild(p);
  }

  // ─── live orbital data ─────────────────────────────────────────────────
  const fmtKm = km => `${Math.round(km).toLocaleString("en-GB")} km`;

  function renderData(sat) {
    const rec = scene.satrecOf(sat.id);
    const el = rec ? Orbit.elements(rec) : null;
    const head = scene.headOf(sat.id);
    const rows = [
      ["Altitude", head ? fmtKm(head.alt) : ""],
      ["Inclination", el ? `${el.inclination.toFixed(1)}°` : ""],
      ["Period", el ? `${el.periodMin.toFixed(1)} min` : ""],
      ["Launched", sat.launched],
    ];
    const block = $("panel-data-block");
    block.textContent = "";
    for (const [k, v] of rows) {
      if (!v) continue;
      const row = document.createElement("div");
      row.className = "panel-data-row";
      const key = document.createElement("span");
      key.className = "panel-data-key";
      key.textContent = k;
      const val = document.createElement("span");
      val.className = "panel-data-val";
      val.textContent = v;
      if (k === "Altitude") val.id = "panel-live-alt";
      row.append(key, val);
      block.appendChild(row);
    }
  }

  function startLiveData(sat) {
    clearInterval(liveTimer);
    liveTimer = setInterval(() => {
      const head = scene.headOf(sat.id);
      const el = document.getElementById("panel-live-alt");
      if (head && el) el.textContent = fmtKm(head.alt);
    }, 1000);
  }

  // ─── panel ─────────────────────────────────────────────────────────────
  async function openPanel(sat) {
    current = sat;
    const my = ++request;

    $("panel-sat-type").textContent = `◆ ${sat.type || "Satellite"}`;
    $("panel-sat-name").textContent = sat.name;
    $("panel-sat-agency").textContent = sat.agency || "";
    renderData(sat);
    startLiveData(sat);

    setMessage("The archivist is searching the files", true);
    narrator.reset();
    body.scrollTop = 0;
    fadeTop.style.opacity = "0";

    panel.classList.remove("collapsed");
    collapseBtn.textContent = "Collapse";
    panel.classList.add("visible");

    try {
      const res = await fetch("/api/story", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: sat.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (my !== request) return;                 // the user has moved on
      if (res.ok && data.text) {
        renderStory(data.text);
        narrator.ready(data.audio || null, data.timings || null);
      } else {
        setMessage(data.error || "The archivist could not be reached.");
      }
    } catch (e) {
      if (my === request) setMessage("The archivist could not be reached.");
    }
  }

  function closePanel() {
    request++;
    current = null;
    clearInterval(liveTimer);
    narrator.reset();
    panel.classList.remove("visible");
    scene.release();
  }

  function togglePanel() {
    const collapsed = panel.classList.toggle("collapsed");
    collapseBtn.textContent = collapsed ? "↗ Expand" : "Collapse";
  }

  collapseBtn.addEventListener("click", togglePanel);
  $("ctrl-close").addEventListener("click", closePanel);
  body.addEventListener("scroll", () => { fadeTop.style.opacity = body.scrollTop > 20 ? "1" : "0"; });

  // ─── selection ─────────────────────────────────────────────────────────
  let catalogueById = new Map();

  function select(id) {
    const sat = catalogueById.get(id);
    if (!sat) return;
    $("daily-card").classList.remove("visible");
    openPanel(sat);
    scene.track(id);
  }
  scene.onSelect(select);

  // ─── daily card ────────────────────────────────────────────────────────
  // One satellite per UTC day, rotating through the catalogue. If today's
  // pick has no current orbital data, the next available one steps in.
  const LAUNCH_UTC = Date.UTC(2025, 3, 1);

  function daily(catalogue, availableIds) {
    const day = Math.floor((Date.now() - LAUNCH_UTC) / 86400000);
    const issue = Math.max(1, day + 1);
    for (let i = 0; i < catalogue.length; i++) {
      const sat = catalogue[(((day + i) % catalogue.length) + catalogue.length) % catalogue.length];
      if (availableIds.has(sat.id)) return { sat, issue };
    }
    return null;
  }

  function showDailyCard(catalogue, availableIds) {
    const d = daily(catalogue, availableIds);
    if (!d) return;
    dailyId = d.sat.id;
    scene.setPriority(dailyId);
    $("daily-card-issue").textContent = `Issue No. ${d.issue} — Daily Satellite`;
    $("daily-card-name").textContent = d.sat.name;
    $("daily-card-desc").textContent = d.sat.desc;
    $("daily-card").addEventListener("click", () => select(dailyId));
    setTimeout(() => {
      if (!current) $("daily-card").classList.add("visible");
    }, 3500);
  }

  // ─── masthead ──────────────────────────────────────────────────────────
  function season() {
    const m = new Date().getUTCMonth();
    if (m >= 2 && m <= 4) return { name: "Spring", theme: "The Watchers" };
    if (m >= 5 && m <= 7) return { name: "Summer", theme: "The Scientists" };
    if (m >= 8 && m <= 10) return { name: "Autumn", theme: "The Accidents" };
    return { name: "Winter", theme: "The Forgotten" };
  }

  function initMasthead() {
    const s = season();
    $("season-label").textContent = s.theme;
    $("season-indicator").textContent = `${s.name} — ${s.theme}`;
    const tickClock = () => { $("clock").textContent = new Date().toUTCString().replace("GMT", "UTC"); };
    tickClock();
    setInterval(tickClock, 1000);
    $("masthead").classList.add("visible");
    $("season-indicator").classList.add("visible");
  }

  function setStatus(text) {
    const el = $("sat-count");
    el.textContent = text;
    el.classList.add("visible");
  }

  return {
    initMasthead,
    setStatus,
    setCatalogue(catalogue) { catalogueById = new Map(catalogue.map(s => [s.id, s])); },
    showDailyCard,
    select,
  };
}
