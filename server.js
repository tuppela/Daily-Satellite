/* Daily Satellite server
 *
 * - Serves the app with the Mapbox token and a build id injected.
 * - /api/tles: orbital elements for the whole catalogue in one request.
 *   Checksum-validated, cached, and persisted as last-known-good. There are
 *   no invented fallbacks: a satellite without real data is simply absent.
 * - /api/story and /api/narrate/:id/:hash.mp3 only accept catalogue ids, so
 *   nobody can spend the API credits on arbitrary text.
 * - Stories are generated once and kept. Audio is keyed by a hash of the exact
 *   story text, so narration can never drift out of step with what is shown.
 * - Concurrent requests for the same story or audio share one upstream call.
 */
const express = require("express");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const crypto = require("crypto");
const http = require("http");
const https = require("https");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, ".data");
const STORY_DIR = path.join(DATA_DIR, "stories");
const AUDIO_DIR = path.join(DATA_DIR, "audio");
const TLE_STORE = path.join(DATA_DIR, "tle-store.json");

const CELESTRAK_URL = process.env.CELESTRAK_URL || "https://celestrak.org/NORAD/elements/gp.php";
const SATNOGS_URL = process.env.SATNOGS_URL || "https://db.satnogs.org/api/tle/";
const TLEAPI_URL = process.env.TLEAPI_URL || "https://tle.ivanstanojevic.me/api/tle";
const SOURCE_TIMEOUT_MS = +process.env.SOURCE_TIMEOUT_MS || 8000;
const ANTHROPIC_URL =process.env.ANTHROPIC_URL || "https://api.anthropic.com/v1/messages";
const ELEVENLABS_URL = process.env.ELEVENLABS_URL || "https://api.elevenlabs.io/v1/text-to-speech";
const STORY_MODEL = process.env.STORY_MODEL || "claude-opus-4-5";
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "jiCqTo2ITOfNYppNYZtK";

const BUILD = (process.env.RENDER_GIT_COMMIT || String(Date.now())).slice(0, 12);
const TLE_TTL_MS = 2 * 3600 * 1000;            // CelesTrak asks for no more than this
const TLE_RETRY_MS = 10 * 60 * 1000;           // after a failed refresh of a known satellite
const MISS_NO_DATA_MS = 6 * 3600 * 1000;       // decayed or unknown: it will not come back soon
const MISS_ERROR_MS = 10 * 60 * 1000;          // network or server trouble: try again shortly
const TLE_MAX_AGE_DAYS = 30;                   // older elements are fiction

for (const d of [DATA_DIR, STORY_DIR, AUDIO_DIR]) fs.mkdirSync(d, { recursive: true });

const CATALOGUE = JSON.parse(fs.readFileSync(path.join(PUBLIC, "data", "catalogue.json"), "utf8"));
const BY_ID = new Map(CATALOGUE.map(s => [s.id, s]));

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "4kb" }));

// ─── shared helpers ───────────────────────────────────────────────────────
const inflight = new Map();
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = Promise.resolve().then(fn).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

// Outbound HTTP through Node's http/https modules rather than global fetch.
// On Render, fetch (undici) tried IPv6 first and every connection sat until
// its 10 s connect timeout. net.connect's autoSelectFamily races IPv4 and
// IPv6 instead, which is what the old server relied on without knowing it.
// Returns a small fetch-like object so call sites stay readable.
function fetchWithTimeout(url, opts = {}, ms = 15000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "http:" ? http : https;
    const body = opts.body == null ? null : Buffer.from(opts.body);
    const headers = { ...(opts.headers || {}) };
    if (body) headers["Content-Length"] = body.length;

    const req = lib.request(u, {
      method: opts.method || "GET",
      headers,
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 500,
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          text: async () => buf.toString("utf8"),
          json: async () => JSON.parse(buf.toString("utf8")),
          arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
        });
      });
    });
    req.setTimeout(ms, () => req.destroy(Object.assign(new Error(`timed out after ${ms} ms`), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// "fetch failed" told us nothing; the code and host do.
const describe = e => [e.message, e.code, e.cause && e.cause.code].filter(Boolean).join(" / ");

const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status }, extra);

// ─── TLEs ─────────────────────────────────────────────────────────────────
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

function epochOf(l1) {
  const yy = +l1.slice(18, 20), doy = +l1.slice(20, 32);
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  return new Date(Date.UTC(year, 0, 1) + (doy - 1) * 86400000);
}

function parseTle(body, norad) {
  const lines = String(body).split(/\r?\n/).map(l => l.trimEnd()).filter(Boolean);
  const l1 = lines.find(l => l.startsWith("1 ") && l.length >= 69);
  const l2 = lines.find(l => l.startsWith("2 ") && l.length >= 69);
  if (!l1 || !l2 || !checksumOk(l1) || !checksumOk(l2)) return null;
  if (+l1.slice(2, 7) !== norad || +l2.slice(2, 7) !== norad) return null;
  return { l1: l1.slice(0, 69), l2: l2.slice(0, 69) };
}

const tles = new Map();                        // norad -> { l1, l2, fetchedAt, nextRefresh }
const misses = new Map();                      // norad -> do not ask CelesTrak again before this time

function loadTleStore() {
  try {
    const saved = JSON.parse(fs.readFileSync(TLE_STORE, "utf8"));
    for (const [norad, t] of Object.entries(saved)) {
      if (checksumOk(t.l1) && checksumOk(t.l2)) tles.set(+norad, { ...t, nextRefresh: 0 });
    }
  } catch (e) { /* first run */ }
}

let storeTimer = null;
function saveTleStoreSoon() {
  clearTimeout(storeTimer);
  storeTimer = setTimeout(() => {
    const out = {};
    for (const [norad, t] of tles) out[norad] = { l1: t.l1, l2: t.l2, source: t.source, fetchedAt: t.fetchedAt };
    writeAtomic(TLE_STORE, JSON.stringify(out)).catch(e => console.warn("TLE store write failed:", e.message));
  }, 500);
}

function fresh(t) {
  return !!t && (Date.now() - epochOf(t.l1).getTime()) / 86400000 <= TLE_MAX_AGE_DAYS;
}

/* Sources, tried in order. CelesTrak is the origin; the other two republish
 * the same public element sets. From Render, CelesTrak does not answer at all
 * (connections time out on IPv4 and IPv6 alike), so the mirrors are not a
 * nicety. Whatever a source returns must still pass the checksum, catalogue
 * number and freshness checks, so a mirror cannot slip in bad data. */
const UA = { "User-Agent": "DailySatellite/2.0 (+https://daily-satellite.onrender.com)" };
const SOURCES = [
  {
    name: "CelesTrak",
    url: n => `${CELESTRAK_URL}?CATNR=${n}&FORMAT=TLE`,
    lines: body => (/no gp data/i.test(body) ? "" : body),
  },
  {
    name: "SatNOGS",
    url: n => `${SATNOGS_URL}?norad_cat_id=${n}&format=json`,
    lines: body => { const a = JSON.parse(body); return a.length ? `${a[0].tle1}\n${a[0].tle2}` : ""; },
  },
  {
    name: "TLE API",
    url: n => `${TLEAPI_URL}/${n}`,
    lines: body => { const j = JSON.parse(body); return j.line1 ? `${j.line1}\n${j.line2}` : ""; },
    notFound: 404,
  },
];
const SOURCE_DOWN_MS = 30 * 60 * 1000;
const sourceDownUntil = new Map();             // name -> time; a source that timed out is skipped a while

async function fromSource(src, norad) {
  let res;
  try {
    res = await fetchWithTimeout(src.url(norad), { headers: UA }, SOURCE_TIMEOUT_MS);
  } catch (e) {
    sourceDownUntil.set(src.name, Date.now() + SOURCE_DOWN_MS);
    console.warn(`${src.name} unreachable (${describe(e)}); skipping it for ${SOURCE_DOWN_MS / 60000} min`);
    throw e;
  }
  if (res.status === src.notFound) return { noData: true };
  if (!res.ok) throw new Error(`${src.name} ${res.status}`);
  const text = src.lines(await res.text());
  if (!text) return { noData: true };
  const parsed = parseTle(text, norad);
  if (!parsed) throw new Error(`${src.name} sent an invalid TLE`);
  return { parsed };
}

async function refreshTle(norad) {
  return once(`tle:${norad}`, async () => {
    let best = null, noData = 0, tried = 0;
    const problems = [];
    for (const src of SOURCES) {
      if (Date.now() < (sourceDownUntil.get(src.name) || 0)) continue;
      tried++;
      try {
        const r = await fromSource(src, norad);
        if (r.noData) { noData++; continue; }
        const cand = { ...r.parsed, source: src.name };
        if (!best || epochOf(cand.l1) > epochOf(best.l1)) best = cand;
        if (fresh(cand)) break;                      // good enough; do not bother the rest
      } catch (e) {
        problems.push(`${src.name}: ${describe(e)}`);
      }
    }
    if (!best) {
      const allNoData = tried > 0 && noData === tried;
      throw httpError(502, allNoData ? "no current data from any source (decayed?)" : problems.join("; ") || "no source reachable", { noData: allNoData });
    }
    const t = { l1: best.l1, l2: best.l2, source: best.source, fetchedAt: Date.now(), nextRefresh: Date.now() + TLE_TTL_MS };
    tles.set(norad, t);
    saveTleStoreSoon();
    return t;
  });
}

async function getTle(norad) {
  const t = tles.get(norad);
  if (t && Date.now() < t.nextRefresh) return fresh(t) ? t : null;
  if (!t && Date.now() < (misses.get(norad) || 0)) return null;   // asked recently, nothing there
  try {
    const got = await refreshTle(norad);
    misses.delete(norad);
    return got;
  } catch (e) {
    if (t) t.nextRefresh = Date.now() + TLE_RETRY_MS;
    else misses.set(norad, Date.now() + (e.noData ? MISS_NO_DATA_MS : MISS_ERROR_MS));
    console.warn(`TLE ${norad}: ${describe(e)}${t ? " (keeping last known good)" : ""}`);
    return fresh(t) ? t : null;
  }
}

async function allTles() {
  const out = [];
  const queue = CATALOGUE.slice();
  const worker = async () => {
    while (queue.length) {
      const sat = queue.shift();
      const t = await getTle(sat.norad);
      if (t) out.push({ id: sat.id, norad: sat.norad, l1: t.l1, l2: t.l2, source: t.source || "stored" });
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  const order = new Map(CATALOGUE.map((s, i) => [s.id, i]));
  return out.sort((a, b) => order.get(a.id) - order.get(b.id));
}

app.get("/api/tles", async (req, res) => {
  try {
    const satellites = await allTles();
    res.set("Cache-Control", "public, max-age=300");
    res.json({ generatedAt: new Date().toISOString(), satellites });
  } catch (e) {
    res.status(500).json({ error: e.message, satellites: [] });
  }
});

// ─── stories ──────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are the keeper of a very old archive of objects in Earth orbit. You have been alone with this material for a long time and have developed a deep, unsentimental familiarity with each object — when it was made, why, what it has witnessed, what became of it. You write as someone who is genuinely delighted when another person shows interest, but who expresses that delight quietly. You do not perform enthusiasm. You do not oversell. You trust the facts to be interesting, because they are. Your tone is warm but never sentimental. Precise but never cold. You allow dark things — failures, cover-ups, debris fields, forgotten machines — to simply be what they are, without dramatising or softening them. When something is absurd, you note it briefly and move on. You write in the tradition of Mika Waltari and long-form literary journalism — flowing prose, no lists, no headers. You are helping someone understand something for the first time and you take that quietly seriously. Write until the story is told, then stop. Some entries will be 300 words, some 600. Follow the shape of the story. Every entry should end by opening outward — from the specific satellite into something larger about time, human ambition, or the strangeness of what we have put into the sky.`;

const stories = new Map();                     // id -> { text, hash }

const hashOf = text => crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);

// Whatever the model returns, keep only prose paragraphs.
function cleanStory(raw) {
  return String(raw)
    .split(/\n+/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("#") && !/^[-*_]{3,}$/.test(l))
    .join("\n\n");
}

async function readStory(id) {
  if (stories.has(id)) return stories.get(id);
  try {
    const saved = JSON.parse(await fsp.readFile(path.join(STORY_DIR, `${id}.json`), "utf8"));
    if (saved && saved.text) {
      const s = { text: saved.text, hash: hashOf(saved.text) };
      stories.set(id, s);
      return s;
    }
  } catch (e) { /* not written yet */ }
  return null;
}

async function getStory(id) {
  const existing = await readStory(id);
  if (existing) return existing;

  return once(`story:${id}`, async () => {
    const again = await readStory(id);
    if (again) return again;

    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw httpError(503, "The archive is closed (no Anthropic key configured).");

    const sat = BY_ID.get(id);
    const res = await fetchWithTimeout(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: STORY_MODEL,
        max_tokens: 1400,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: `Write an entry for the satellite: ${sat.name}. What we know about it: ${sat.desc}` }],
      }),
    }, 90000);

    if (!res.ok) {
      console.error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
      throw httpError(502, "The archivist could not be reached.");
    }
    const data = await res.json();
    const text = cleanStory((data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n"));
    if (!text) throw httpError(502, "The archivist returned an empty page.");

    await writeAtomic(path.join(STORY_DIR, `${id}.json`),
      JSON.stringify({ id, text, model: STORY_MODEL, createdAt: new Date().toISOString() }, null, 2));
    const s = { text, hash: hashOf(text) };
    stories.set(id, s);
    return s;
  });
}

app.post("/api/story", async (req, res) => {
  const id = req.body && req.body.id;
  if (!BY_ID.has(id)) return res.status(404).json({ error: "Unknown satellite." });
  try {
    const s = await getStory(id);
    res.json({ text: s.text, audio: `/api/narrate/${id}/${s.hash}.mp3` });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ─── narration ────────────────────────────────────────────────────────────
// Read the prose, not the markup.
const spoken = text => text.replace(/\*([^*\n]+)\*/g, "$1");

async function getAudio(id, story) {
  const file = path.join(AUDIO_DIR, `${id}-${story.hash}.mp3`);
  try { await fsp.access(file); return file; } catch (e) { /* generate */ }

  return once(`audio:${id}:${story.hash}`, async () => {
    try { await fsp.access(file); return file; } catch (e) { /* still missing */ }

    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) throw httpError(503, "Narration is not configured.");

    const res = await fetchWithTimeout(`${ELEVENLABS_URL}/${VOICE_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "xi-api-key": key, Accept: "audio/mpeg" },
      body: JSON.stringify({
        text: spoken(story.text),
        model_id: "eleven_turbo_v2_5",
        voice_settings: { stability: 0.55, similarity_boost: 0.75 },
      }),
    }, 120000);

    if (!res.ok) {
      console.error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
      throw httpError(502, `Narration unavailable (${res.status}).`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) throw httpError(502, "Narration came back empty.");
    await writeAtomic(file, buf);
    console.log(`Audio cached: ${path.basename(file)} (${Math.round(buf.length / 1024)} KB)`);
    return file;
  });
}

app.get("/api/narrate/:id/:hash.mp3", async (req, res) => {
  const { id, hash } = req.params;
  if (!BY_ID.has(id)) return res.status(404).end();
  try {
    const story = await readStory(id);
    if (!story) return res.status(404).json({ error: "No entry yet." });
    if (story.hash !== hash) return res.status(410).json({ error: "This entry has been rewritten." });
    const file = await getAudio(id, story);
    // Content-addressed, so it can be cached forever. sendFile handles Range
    // requests, which mobile Safari needs for audio.
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.type("audio/mpeg");
    res.sendFile(file);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ─── app shell ────────────────────────────────────────────────────────────
app.get("/healthz", (req, res) => res.json({ ok: true, build: BUILD, satellites: tles.size }));

const indexPath = path.join(PUBLIC, "index.html");
function serveIndex(req, res) {
  const token = JSON.stringify(process.env.MAPBOX_TOKEN || "");
  const html = fs.readFileSync(indexPath, "utf8")
    .replace('window.MAPBOX_TOKEN || ""', token)
    .replace(/__BUILD__/g, BUILD);
  res.set("Cache-Control", "no-cache");
  res.type("html").send(html);
}

app.get("/", serveIndex);
app.use(express.static(PUBLIC, {
  index: false,
  setHeaders: res => res.set("Cache-Control", "no-cache"),     // revalidate; cheap 304s
}));
app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));
app.get("*", serveIndex);

// ─── start ────────────────────────────────────────────────────────────────
loadTleStore();

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Daily Satellite ${BUILD} on port ${PORT}`);

    // Warm the element cache so the first visitor does not wait, and keep it fresh.
    const warm = () => allTles().then(s => {
      const by = {};
      for (const x of s) by[x.source] = (by[x.source] || 0) + 1;
      console.log(`TLEs ready: ${s.length}/${CATALOGUE.length} ${JSON.stringify(by)}`);
    });
    warm();
    setInterval(warm, TLE_TTL_MS).unref();

    // Keep the free Render instance awake by visiting ourselves. This hits a
    // local health check, never CelesTrak.
    const self = process.env.RENDER_EXTERNAL_URL;
    if (self) {
      setInterval(() => {
        fetchWithTimeout(`${self}/healthz`).catch(e => console.warn("Self-ping failed:", describe(e)));
      }, 10 * 60 * 1000).unref();
    }
  });
}

module.exports = { app, checksumOk, parseTle, epochOf, cleanStory };
