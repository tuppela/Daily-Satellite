/* UI
 * The story player, the narrator and the masthead. Every way of choosing a
 * satellite (its label, the waiting card, previous and next, a shared link)
 * goes through select(), so they all behave identically.
 *
 * The player has four modes:
 *   closed     nothing on screen but the globe
 *   idle       a card waiting with today's satellite; tap it to open
 *   open       the full panel
 *   collapsed  a small pill: the story carries on, the globe has the room
 * Opening is always silent. The voice only ever starts from a play button.
 */
function createUI(scene) {
  const $ = id => document.getElementById(id);
  const panel = $("info-panel");
  const mini = $("mini-player");
  const textEl = $("panel-text-content");
  const body = $("panel-body");
  const fadeTop = $("panel-fade-top");
  const listenBtn = $("ctrl-listen");
  const playBtns = [listenBtn, $("mini-play")];
  const collapseBtn = $("ctrl-collapse");
  const shareBtn = $("ctrl-share");

  const IDLE_DELAY = 1200;   // ms before the waiting card appears
  const PLAY_LABEL = {
    idle: "Play narration",
    loading: "Loading narration",
    playing: "Pause narration",
    paused: "Resume narration",
    error: "Narration unavailable",
  };

  let mode = "closed";       // closed | idle | open | collapsed
  let current = null;        // catalogue entry of the open satellite
  let idleId = null;         // the satellite the waiting card offers
  let request = 0;           // guards against a slow story landing on the wrong panel
  let liveTimer = null;
  let dailyId = null;
  let wantPlay = false;      // the voice was playing when the reader moved on: carry it over
  let order = [];            // everything that can be shown, in catalogue order
  let catalogueById = new Map();

  // The text follows the voice; scrolling it by hand pauses the voice.
  const follower = createFollower(textEl, body, {
    onReaderScroll() { if (narrator.audio && !narrator.audio.paused) narrator.audio.pause(); },
  });

  // ─── narrator ──────────────────────────────────────────────────────────
  // The <audio> element is created inside the click, so mobile Safari treats
  // play() as user-initiated. The URL is content-addressed by the server, so
  // audio can never drift out of step with the story on screen.
  // States: idle, loading, playing, paused, error. Both play buttons (the big
  // one and the one in the small player) always show the same state.
  const narrator = {
    audio: null,
    url: null,
    timings: null,
    get playing() { return !!(this.audio && !this.audio.paused); },
    set(state, enabled) {
      for (const b of playBtns) {
        b.dataset.state = state;
        b.disabled = !enabled;
        b.setAttribute("aria-label", PLAY_LABEL[state]);
      }
    },
    ready(url, timings) { this.stop(); this.url = url; this.timings = timings || null; this.set("idle", !!url); },
    reset(state = "idle") { this.stop(); this.url = null; this.timings = null; this.set(state, false); },
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
        if (this.audio.paused) Promise.resolve(this.audio.play()).catch(() => {});
        else this.audio.pause();
        return;
      }
      const a = new Audio(this.url);
      a.preload = "auto";
      this.audio = a;
      follower.attach(a, this.timings);
      this.set("loading", true);
      a.addEventListener("playing", () => { if (this.audio === a) this.set("playing", true); });
      a.addEventListener("pause", () => { if (this.audio === a && !a.ended) this.set("paused", true); });
      a.addEventListener("ended", () => { if (this.audio === a) { this.audio = null; this.set("idle", true); } });
      a.addEventListener("error", () => {
        if (this.audio !== a) return;
        this.audio = null;
        follower.detach();
        this.set("error", false);
        setTimeout(() => { if (!this.audio && this.url) this.set("idle", true); }, 4000);
      });
      a.play().catch(() => {
        // A browser may refuse a play() that did not start from a tap (the
        // voice carried over to the next story, say). Put the button back, so
        // the next tap, which does count, starts it.
        if (this.audio === a && a.paused && !a.error) {
          this.audio = null;
          follower.detach();
          a.removeAttribute("src");
          a.load();
          this.set("idle", true);
        }
      });
    },
  };

  for (const b of playBtns) {
    b.addEventListener("click", e => {
      e.stopPropagation();
      if (mode === "idle") select(idleId, { play: true });   // pressing play on the waiting card opens it and plays
      else narrator.toggle();
    });
  }

  // ─── modes ─────────────────────────────────────────────────────────────
  function setMode(next) {
    mode = next;
    const shown = next === "idle" || next === "open";
    panel.classList.toggle("visible", shown);
    panel.classList.toggle("idle", next === "idle");
    panel.classList.toggle("collapsed", next === "collapsed");
    mini.classList.toggle("visible", next === "collapsed");
    panel.inert = !shown;
    mini.inert = next !== "collapsed";
    panel.tabIndex = next === "idle" ? 0 : -1;
    updateStepButtons();
  }

  function updateStepButtons() {
    const can = order.length > 1;
    $("ctrl-prev").disabled = !can;
    $("ctrl-next").disabled = !can;
  }

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

  function setPreview(text) {
    follower.clear();
    textEl.textContent = "";
    const p = document.createElement("p");
    p.textContent = text;
    textEl.appendChild(p);
  }

  // ─── header ────────────────────────────────────────────────────────────
  // "Space Station" reads as "Space station": sentence case, acronyms left alone.
  const sentence = s => String(s).split(" ").map((w, i) => (i > 0 && /^[A-Z][a-z]+$/.test(w) ? w.toLowerCase() : w)).join(" ");

  function fillHeader(sat) {
    $("panel-sat-type").textContent = sentence(sat.type || "Satellite");
    $("panel-sat-theme").textContent = sentence(season().theme);
    $("panel-sat-name").textContent = sat.name;
    $("panel-sat-agency").textContent = sat.agency || "";
    $("mini-title").textContent = sat.name;
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

  // ─── open, close, collapse ─────────────────────────────────────────────
  async function openPanel(sat) {
    current = sat;
    const my = ++request;

    fillHeader(sat);
    renderData(sat);
    startLiveData(sat);

    setMessage("The archivist is searching the files", true);
    narrator.reset(wantPlay ? "loading" : "idle");
    body.scrollTop = 0;
    fadeTop.style.opacity = "0";
    setMode("open");

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
        if (wantPlay) { wantPlay = false; narrator.toggle(); }
      } else {
        wantPlay = false;
        narrator.set("idle", false);
        setMessage(data.error || "The archivist could not be reached.");
      }
    } catch (e) {
      if (my === request) {
        wantPlay = false;
        narrator.set("idle", false);
        setMessage("The archivist could not be reached.");
      }
    }
  }

  function closePanel(updateUrl = true) {
    if (mode === "idle") { setMode("closed"); return; }      // just puts the waiting card away
    request++;
    current = null;
    wantPlay = false;
    clearInterval(liveTimer);
    narrator.reset();
    setMode("closed");
    scene.release({ home: true });
    if (updateUrl) setUrl(null);
  }

  function collapse() { if (mode === "open") setMode("collapsed"); }
  function expand() { if (mode === "collapsed") setMode("open"); }

  collapseBtn.addEventListener("click", collapse);
  $("mini-expand").addEventListener("click", expand);
  $("ctrl-close").addEventListener("click", () => closePanel());
  $("mini-close").addEventListener("click", () => closePanel());
  body.addEventListener("scroll", () => { fadeTop.style.opacity = body.scrollTop > 20 ? "1" : "0"; });

  // The waiting card opens when tapped anywhere that is not a button.
  panel.addEventListener("click", e => {
    if (mode === "idle" && !e.target.closest("button")) select(idleId);
  });
  panel.addEventListener("keydown", e => {
    if (mode === "idle" && e.target === panel && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      select(idleId);
    }
  });

  // ─── addresses ─────────────────────────────────────────────────────────
  // Each entry lives at /s/<id>, so a link opens that exact satellite.
  const pathFor = id => (id ? `/s/${id}` : "/");
  function idFromPath(p = location.pathname) {
    const m = p.match(/^\/s\/([a-z0-9-]+)\/?$/);
    return m ? m[1] : null;
  }
  function setUrl(id) {
    const p = pathFor(id);
    if (location.pathname !== p) history.pushState({ id }, "", p);
    document.title = id && catalogueById.get(id) ? `${catalogueById.get(id).name} · Daily Satellite` : "Daily Satellite";
  }
  window.addEventListener("popstate", () => {
    const id = idFromPath();
    if (id && catalogueById.has(id)) select(id, { updateUrl: false });
    else if (current) closePanel(false);
  });

  // ─── share ─────────────────────────────────────────────────────────────
  shareBtn.addEventListener("click", async () => {
    if (!current) return;
    const url = location.origin + pathFor(current.id);
    const flash = (label, ok) => {
      shareBtn.setAttribute("aria-label", label);
      shareBtn.title = label;
      shareBtn.classList.toggle("done", ok);
      setTimeout(() => {
        shareBtn.setAttribute("aria-label", "Share this entry");
        shareBtn.removeAttribute("title");
        shareBtn.classList.remove("done");
      }, 2000);
    };
    if (navigator.share) {
      try { await navigator.share({ title: `${current.name} · Daily Satellite`, url }); }
      catch (e) { /* closed the share sheet */ }
      return;
    }
    try { await navigator.clipboard.writeText(url); flash("Link copied", true); }
    catch (e) { flash("Could not copy the link", false); }
  });

  // ─── selection ─────────────────────────────────────────────────────────
  // play: start the voice as soon as the story is in (pressing play on the
  // waiting card, or moving on while the voice was playing).
  function select(id, { play = false, updateUrl = true } = {}) {
    const sat = catalogueById.get(id);
    if (!sat) return;
    wantPlay = play;
    openPanel(sat);
    scene.track(id);
    if (updateUrl) setUrl(id);
  }
  scene.onSelect(id => select(id));

  // Previous and next walk the catalogue in order and wrap round. They keep
  // the reader's mode: voice playing, the next one plays; reading, it opens
  // silently.
  function step(dir) {
    if (order.length < 2) return;
    const from = current ? current.id : idleId;
    let i = order.findIndex(s => s.id === from);
    i = i < 0 ? 0 : (i + dir + order.length) % order.length;
    select(order[i].id, { play: narrator.playing || wantPlay });
  }
  $("ctrl-prev").addEventListener("click", e => { e.stopPropagation(); step(-1); });
  $("ctrl-next").addEventListener("click", e => { e.stopPropagation(); step(1); });

  // ─── the waiting card ──────────────────────────────────────────────────
  // One satellite per UTC day, rotating through the catalogue. If today's
  // pick has no current orbital data, the next available one steps in.
  const LAUNCH_UTC = Date.UTC(2025, 3, 1);

  function daily(catalogue, availableIds) {
    const day = Math.floor((Date.now() - LAUNCH_UTC) / 86400000);
    for (let i = 0; i < catalogue.length; i++) {
      const sat = catalogue[(((day + i) % catalogue.length) + catalogue.length) % catalogue.length];
      if (availableIds.has(sat.id)) return sat;
    }
    return null;
  }

  // The card shows the catalogue's own line, not the story: reading the story
  // writes it, and nobody should cost anything just by arriving.
  function showIdle(sat) {
    idleId = sat.id;
    fillHeader(sat);
    renderData(sat);
    setPreview(sat.desc || "");
    narrator.reset();
    narrator.set("idle", true);
    body.scrollTop = 0;
    fadeTop.style.opacity = "0";
    setMode("idle");
  }

  function showDailyCard(catalogue, availableIds) {
    order = catalogue.filter(s => availableIds.has(s.id));
    updateStepButtons();
    const sat = daily(catalogue, availableIds);
    if (!sat) return;
    dailyId = sat.id;
    scene.setPriority(dailyId);
    setTimeout(() => {
      if (mode === "closed" && !current) showIdle(sat);   // a shared link or an early tap got there first
    }, IDLE_DELAY);
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
    $("masthead").classList.add("visible");
  }

  // Quiet messages (all is well) stay in the page for screen readers but are
  // not drawn; loading and trouble are.
  function setStatus(text, quiet = false) {
    const el = $("sat-count");
    el.textContent = text;
    el.classList.toggle("visible", !quiet);
  }

  setMode("closed");

  return {
    initMasthead,
    setStatus,
    setCatalogue(catalogue) { catalogueById = new Map(catalogue.map(s => [s.id, s])); },
    showDailyCard,
    select,
    get mode() { return mode; },
    // A link to /s/<id> opens that entry straight away. Unknown ids fall back
    // to the front page.
    openFromUrl() {
      const id = idFromPath();
      if (!id) return false;
      if (!catalogueById.has(id)) { history.replaceState({}, "", "/"); return false; }
      select(id, { updateUrl: false });
      return true;
    },
  };
}
