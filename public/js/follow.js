/* Follow
 * Makes the story text follow the narrator, like a teleprompter, and draws the
 * dial: a column of fine ticks down both sides of the text, one per line, where
 * the line being spoken reaches furthest inward and its neighbours less so.
 *
 * Each word is wrapped in a span, so the browser tells us where every line
 * breaks at any width. The server sends the time each word begins (exact, from
 * ElevenLabs). If those are missing, times are estimated from how far through
 * the text each word falls, spread over the length of the audio.
 *
 * The reader can take over at any time. Only real wheel, touch and key input
 * counts, never our own scrolling, and it pauses the voice. Pressing play
 * glides the text back to the narrator and carries on.
 */
function createFollower(textEl, body, hooks) {
  const LOOKAHEAD = 0.12;       // seconds: light the line a moment before it is spoken
  const ANCHOR = 0.36;          // where the spoken line rests in the panel, from the top
  const EASE = 0.14;            // share of the remaining distance covered each frame
  const DIAL_REACH = 2;         // neighbours on each side that lean in

  let spans = [];               // one per displayed word
  let lines = [];               // { first, cy } cy: centre in scroll content
  let ticks = [];               // { l, r } per line
  let dial = null;
  let exact = null;             // start time per word from the server
  let estimate = null;          // { duration, starts }
  let audio = null;
  let raf = 0;
  let active = -1;
  let following = false;
  let touching = false;
  let touchY = 0;
  let pos = 0;                  // our own scroll position, kept fractional
  let ro = null;

  const reduced = () => !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  // ─── text ─────────────────────────────────────────────────────────────
  // Words in the same order and count as the server's: markup removed, split on
  // whitespace. A word that is partly in italics stays one span.
  function render(text) {
    clear();
    textEl.textContent = "";
    const paras = String(text).split(/\n+/).map(p => p.trim()).filter(p => p && !p.startsWith("#"));
    for (const para of paras) {
      let plain = "";
      const italics = [];
      for (const part of para.split(/(\*[^*\n]+\*)/)) {
        if (!part) continue;
        if (part.length > 2 && part.startsWith("*") && part.endsWith("*")) {
          italics.push([plain.length, plain.length + part.length - 2]);
          plain += part.slice(1, -1);
        } else plain += part;
      }
      const p = document.createElement("p");
      const emit = (a, b, parent) => {                 // text a..b, italic where it overlaps an italic range
        let at = a;
        for (const [ia, ib] of italics) {
          if (ib <= at || ia >= b) continue;
          if (ia > at) parent.appendChild(document.createTextNode(plain.slice(at, ia)));
          const em = document.createElement("em");
          em.textContent = plain.slice(Math.max(at, ia), Math.min(b, ib));
          parent.appendChild(em);
          at = Math.min(b, ib);
        }
        if (at < b) parent.appendChild(document.createTextNode(plain.slice(at, b)));
      };
      let pos = 0;
      const re = /\S+/g;
      let m;
      while ((m = re.exec(plain))) {
        if (m.index > pos) emit(pos, m.index, p);
        const w = document.createElement("span");
        w.className = "w";
        emit(m.index, m.index + m[0].length, w);
        p.appendChild(w);
        spans.push(w);
        pos = m.index + m[0].length;
      }
      if (pos < plain.length) emit(pos, plain.length, p);
      textEl.appendChild(p);
    }
    dial = document.createElement("div");
    dial.className = "dial";
    dial.setAttribute("aria-hidden", "true");
    textEl.appendChild(dial);
    layout();
    if (typeof ResizeObserver === "function") {
      ro = new ResizeObserver(() => layout());
      ro.observe(textEl);
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => spans.length && layout()).catch(() => {});
  }

  // Finds the lines as the browser has broken them and draws a tick pair on each.
  function layout() {
    if (!dial || !spans.length) return;
    const bodyTop = body.getBoundingClientRect().top;
    const textTop = textEl.getBoundingClientRect().top;
    lines = [];
    let lastCy = -1e9;
    spans.forEach((s, i) => {
      const r = s.getBoundingClientRect();
      const cy = r.top + r.height / 2;
      if (Math.abs(cy - lastCy) > 6) lines.push({ first: i, cy: cy - bodyTop + body.scrollTop, y: cy - textTop });
      lastCy = cy;
    });
    dial.textContent = "";
    ticks = lines.map(line => {
      const l = document.createElement("i"), r = document.createElement("i");
      l.className = "l"; r.className = "r";
      l.style.top = r.style.top = `${Math.round(line.y)}px`;
      dial.append(l, r);
      return { l, r };
    });
    const was = active;
    active = -1;
    paint(Math.min(was, lines.length - 1));
  }

  function paint(next) {
    if (next === active) return;
    const lo = Math.max(0, active - DIAL_REACH), hi = active + DIAL_REACH;
    if (active >= 0) for (let i = lo; i <= hi && i < ticks.length; i++) { ticks[i].l.className = "l"; ticks[i].r.className = "r"; }
    active = next;
    if (active < 0) return;
    for (let k = -DIAL_REACH; k <= DIAL_REACH; k++) {
      const t = ticks[active + k];
      if (!t) continue;
      t.l.className = "l d" + Math.abs(k);
      t.r.className = "r d" + Math.abs(k);
    }
  }

  function clear() {
    detach();
    if (ro) { ro.disconnect(); ro = null; }
    spans = []; lines = []; ticks = []; dial = null; exact = null; estimate = null; active = -1;
  }

  // ─── time → text ──────────────────────────────────────────────────────
  function startsFor(duration) {
    if (exact && exact.length) {
      if (exact.length === spans.length) return exact;
      const n = spans.length, m = exact.length;                       // counts differ: spread by position
      return spans.map((_, i) => exact[Math.min(m - 1, Math.round(i * (m - 1) / Math.max(1, n - 1)))]);
    }
    if (!Number.isFinite(duration) || duration <= 0) return null;
    if (estimate && estimate.duration === duration) return estimate.starts;
    const total = spans.reduce((n, s) => n + s.textContent.length + 1, 0);
    let seen = 0;
    const starts = spans.map(s => { const t = (seen / total) * duration; seen += s.textContent.length + 1; return t; });
    estimate = { duration, starts };
    return starts;
  }

  function lineAt(starts, t) {
    let lo = 0, hi = lines.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[lines[mid].first] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  // ─── the loop ─────────────────────────────────────────────────────────
  function frame() {
    if (!audio) { raf = 0; return; }                // detached: let the loop lapse
    raf = requestAnimationFrame(frame);
    if (audio.ended || !lines.length) return;
    const t = audio.currentTime || 0;
    const starts = startsFor(audio.duration);
    if (!starts) return;
    const li = lineAt(starts, t + LOOKAHEAD);
    paint(li);

    if (!following || touching || body.clientHeight === 0) return;
    // Glide between line centres in step with the voice, so the text moves
    // continuously rather than jumping a line at a time.
    const a = lines[li], b = lines[li + 1];
    let cy = a.cy;
    if (b) {
      const t0 = starts[a.first], t1 = starts[b.first];
      if (t1 > t0) cy += (b.cy - a.cy) * Math.min(1, Math.max(0, (t + LOOKAHEAD - t0) / (t1 - t0)));
    }
    const max = Math.max(0, body.scrollHeight - body.clientHeight);
    const target = Math.min(max, Math.max(0, cy - body.clientHeight * ANCHOR));
    // Some browsers round scrollTop, so keep our own fractional position and
    // only adopt the browser's when something else (the reader) has moved it.
    if (Math.abs(body.scrollTop - pos) > 2) pos = body.scrollTop;
    pos = reduced() || Math.abs(target - pos) < 0.3 ? target : pos + (target - pos) * EASE;
    body.scrollTop = pos;
  }

  function attach(el, timesUrl) {
    detach();
    audio = el;
    exact = null; estimate = null;
    const mine = el;
    el.addEventListener("playing", () => { if (audio === mine) following = true; });
    el.addEventListener("pause", () => { if (audio === mine) following = false; });
    el.addEventListener("ended", () => {
      if (audio !== mine) return;
      following = false;
      paint(-1);
    });
    following = !el.paused;
    if (!raf) raf = requestAnimationFrame(frame);

    if (timesUrl) {
      fetch(timesUrl).then(r => (r.ok ? r.json() : null)).then(j => {
        if (audio === mine && j && Array.isArray(j.words) && j.words.length) exact = j.words;
      }).catch(() => { /* the estimate carries on */ });
    }
  }

  function detach() {
    audio = null;
    following = false;
    paint(-1);
  }

  // ─── the reader takes over ────────────────────────────────────────────
  // Real input only. Our own scrolling never raises these events.
  function readerTookOver() {
    if (audio && !audio.paused && hooks && hooks.onReaderScroll) hooks.onReaderScroll();
  }
  body.addEventListener("wheel", readerTookOver, { passive: true });
  body.addEventListener("touchstart", e => { touching = true; touchY = e.touches && e.touches[0] ? e.touches[0].clientY : 0; }, { passive: true });
  body.addEventListener("touchmove", e => {
    const y = e.touches && e.touches[0] ? e.touches[0].clientY : touchY;
    if (Math.abs(y - touchY) > 4) readerTookOver();
  }, { passive: true });
  const release = () => { touching = false; };
  body.addEventListener("touchend", release, { passive: true });
  body.addEventListener("touchcancel", release, { passive: true });
  document.addEventListener("keydown", e => {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(e.key)) {
      if (body.offsetParent !== null && body.clientHeight > 0) readerTookOver();
    }
  });

  return { render, clear, attach, detach, layout, get active() { return active; }, get lineCount() { return lines.length; } };
}
