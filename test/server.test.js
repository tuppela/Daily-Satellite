/* Server integration tests. The real server runs as a child process, pointed
 * at local stand-ins for CelesTrak, Anthropic and ElevenLabs, so every paid
 * upstream call can be counted. */
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");

function checksum(line) {
  let s = 0;
  for (const c of line.slice(0, 68)) { if (c >= "0" && c <= "9") s += +c; else if (c === "-") s += 1; }
  return String(s % 10);
}
function issTle(date) {
  const L1 = "1 25544U 98067A   26077.80687812  .00008636  00000+0  16833-3 0  9998";
  const L2 = "2 25544  51.6341  27.2872 0006206 206.1039 153.9638 15.48363739557747";
  const yy = String(date.getUTCFullYear() % 100).padStart(2, "0");
  const doy = ((date - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86400000 + 1).toFixed(8).padStart(12, "0");
  const l1 = L1.slice(0, 18) + yy + doy + L1.slice(32);
  return [l1.slice(0, 68) + checksum(l1), L2];
}

function tleFor(norad, date = new Date()) {
  const [a, b] = issTle(date);
  const n = String(norad).padStart(5, "0");
  const l1 = "1 " + n + a.slice(7), l2 = "2 " + n + b.slice(7);
  return [l1.slice(0, 68) + checksum(l1), l2.slice(0, 68) + checksum(l2)];
}

// ─── upstream stand-ins ─────────────────────────────────────────────────────
const calls = { celestrak: 0, satnogs: 0, tleapi: 0, anthropic: 0, eleven: 0 };
const sentToEleven = [];                       // { path, ...body } per narration request
const sentToAnthropic = [];                    // { system, content, max_tokens } per story request
let celestrakUp = true;
let celestrakHangs = false;                    // what Render actually sees: no answer at all
let mirrorsUp = false;
const [ISS1, ISS2] = issTle(new Date());

const stub = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/gp.php") {
    calls.celestrak++;
    if (celestrakHangs) return;                // never respond
    if (!celestrakUp) { res.writeHead(503); return res.end("down"); }
    const n = url.searchParams.get("CATNR");
    res.writeHead(200, { "content-type": "text/plain" });
    if (n === "25544") return res.end(`ISS (ZARYA)\r\n${ISS1}\r\n${ISS2}\r\n`);
    if (n === "20580") return res.end(`HST\n${ISS1.replace("25544", "20580")}\n${ISS2.replace("25544", "20580")}\n`); // checksum now wrong
    return res.end("No GP data found");
  }
  if (url.pathname === "/satnogs") {
    calls.satnogs++;
    if (!mirrorsUp) { res.writeHead(503); return res.end("down"); }
    const n = +url.searchParams.get("norad_cat_id");
    res.writeHead(200, { "content-type": "application/json" });
    if (n !== 25544) return res.end("[]");                          // SatNOGS has no Hubble
    const [a, b] = tleFor(25544);
    return res.end(JSON.stringify([{ tle0: "ISS", tle1: a, tle2: b }]));
  }
  if (url.pathname.startsWith("/tleapi/")) {
    calls.tleapi++;
    if (!mirrorsUp) { res.writeHead(503); return res.end("down"); }
    const n = +url.pathname.split("/").pop();
    if (n !== 20580 && n !== 25544) { res.writeHead(404); return res.end("{}"); }
    const [a, b] = tleFor(n);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ satelliteId: n, name: "X", line1: a, line2: b }));
  }
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    if (url.pathname === "/anthropic") {
      calls.anthropic++;
      const { messages, system, max_tokens } = JSON.parse(body);
      sentToAnthropic.push({ system, content: messages[0].content, max_tokens });
      if (/^You are the fact-checker/.test(system)) {
        assert.match(messages[0].content, /BRIEF AND FACT SHEET:[\s\S]*DRAFT ENTRY:/);
        const draft = messages[0].content.split("DRAFT ENTRY:")[1].trim();
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ content: [{ type: "text", text:
          `CHANGES:\n- removed "every hundred minutes"\n\nENTRY:\n${draft}\n\nChecked \u2014 twice.` }] }));
      }
      assert.match(system, /^You are the keeper of a very old archive/);
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ content: [{ type: "text", text: `# Heading to strip\n\nAn entry. ${messages[0].content.slice(0, 40)}\n\nIt went *quietly* on.\n\nIt covered three kilometres, twelve per cent of the colour, and the Centre for Modelling.\n\n---\n\nThe end.` }] }));
      }, 150);
    } else if (url.pathname.startsWith("/eleven/")) {
      calls.eleven++;
      const sent = JSON.parse(body);
      sentToEleven.push({ path: url.pathname, ...sent });
      assert.ok(!sent.text.includes("*"), "narration text has no markup");
      setTimeout(() => {
        res.writeHead(200, { "content-type": "audio/mpeg" });
        res.end(Buffer.alloc(8000, 7));
      }, 200);
    } else { res.writeHead(404); res.end(); }
  });
});

let stubUrl;
test.before(() => new Promise(r => stub.listen(0, "127.0.0.1", () => { stubUrl = `http://127.0.0.1:${stub.address().port}`; r(); })));
test.after(() => stub.close());

// ─── server process helper ──────────────────────────────────────────────────
async function startServer(dataDir, extraEnv = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = {
    PATH: process.env.PATH, PORT: String(port), DATA_DIR: dataDir,
    MAPBOX_TOKEN: "pk.test-token",
    CELESTRAK_URL: `${stubUrl}/gp.php`,
    SATNOGS_URL: `${stubUrl}/satnogs`,
    TLEAPI_URL: `${stubUrl}/tleapi`,
    SOURCE_TIMEOUT_MS: "400",
    ANTHROPIC_URL: `${stubUrl}/anthropic`, ANTHROPIC_API_KEY: "sk-test",
    ELEVENLABS_URL: `${stubUrl}/eleven`, ELEVENLABS_API_KEY: "el-test",
    NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
    ...extraEnv,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", d => (log += d));
  child.stderr.on("data", d => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch (e) { /* not yet */ }
    await new Promise(r => setTimeout(r, 50));
  }
  // let the startup warm-up finish so call counts are deterministic
  for (let i = 0; i < 100 && !/TLEs ready/.test(log); i++) await new Promise(r => setTimeout(r, 50));
  return { base, child, log: () => log, stop: () => new Promise(r => { child.on("exit", r); child.kill(); }) };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ds-"));
const post = (base, p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// ─── tests ──────────────────────────────────────────────────────────────────
test("app shell: token and build injected, assets served, unknown api 404s", async () => {
  const s = await startServer(tmp());
  try {
    const html = await (await fetch(s.base + "/")).text();
    assert.ok(html.includes('window.MAPBOX_TOKEN = "pk.test-token"'), "token injected");
    assert.ok(!html.includes("__BUILD__"), "build id injected everywhere");

    const deep = await fetch(s.base + "/some/deep/link");
    assert.equal(deep.status, 200);
    assert.ok((await deep.text()).includes("pk.test-token"), "deep links get the token too");

    for (const f of ["/js/orbit.js", "/js/projector.js", "/js/scene.js", "/js/ui.js", "/js/main.js", "/css/app.css", "/data/catalogue.json"]) {
      const r = await fetch(s.base + f);
      assert.equal(r.status, 200, f);
      assert.equal(r.headers.get("cache-control"), "no-cache", f);
    }
    assert.match((await fetch(s.base + "/js/orbit.js")).headers.get("content-type"), /javascript/);

    const api = await fetch(s.base + "/api/nope");
    assert.equal(api.status, 404);
    assert.equal((await api.json()).error, "Not found");
  } finally { await s.stop(); }
});

test("TLEs: only valid, current data is served, cached, and never invented", async () => {
  celestrakUp = true;
  const dir = tmp();
  const s = await startServer(dir);
  try {
    const before = calls.celestrak;
    const data = await (await fetch(s.base + "/api/tles")).json();
    assert.deepEqual(data.satellites.map(x => x.id), ["iss"], "hubble has a bad checksum, the rest have no data");
    assert.equal(data.satellites[0].l1, ISS1);
    await fetch(s.base + "/api/tles");
    assert.equal(calls.celestrak - before, 0, "after warm-up, visitors never reach CelesTrak: hits and misses both cached");

    await new Promise(r => setTimeout(r, 700));      // store write is debounced
    const store = JSON.parse(fs.readFileSync(path.join(dir, "tle-store.json"), "utf8"));
    assert.ok(store["25544"], "last known good persisted");
  } finally { await s.stop(); }

  // Restart with CelesTrak down: last known good still serves.
  celestrakUp = false;
  const s2 = await startServer(dir);
  try {
    const data = await (await fetch(s2.base + "/api/tles")).json();
    assert.deepEqual(data.satellites.map(x => x.id), ["iss"], "survives an outage");
  } finally { await s2.stop(); }

  // A stale last-known-good is not served as if it were current.
  const [o1, o2] = issTle(new Date(Date.now() - 45 * 86400000));
  fs.writeFileSync(path.join(dir, "tle-store.json"), JSON.stringify({ 25544: { l1: o1, l2: o2, fetchedAt: 0 } }));
  const s3 = await startServer(dir);
  try {
    const data = await (await fetch(s3.base + "/api/tles")).json();
    assert.equal(data.satellites.length, 0, "45-day-old elements are withheld");
  } finally { await s3.stop(); celestrakUp = true; }
});

test("TLEs: when CelesTrak does not answer, mirrors fill in and CelesTrak is skipped", async () => {
  celestrakHangs = true; mirrorsUp = true;
  const s = await startServer(tmp());
  try {
    const data = await (await fetch(s.base + "/api/tles")).json();
    const got = Object.fromEntries(data.satellites.map(x => [x.id, x.source]));
    assert.deepEqual(got, { iss: "SatNOGS", hubble: "TLE API" }, "each satellite from the first mirror that has it");
    assert.match(s.log(), /CelesTrak unreachable/);
    const before = calls.celestrak;
    // Force a refresh of an uncached satellite: CelesTrak must not be asked again while marked down.
    await fetch(s.base + "/api/tles");
    assert.equal(calls.celestrak - before, 0, "a silent source is skipped, not waited on for every satellite");
  } finally { await s.stop(); celestrakHangs = false; mirrorsUp = false; }
});

test("stories: catalogue ids only, cleaned, generated once even under concurrency, persisted", async () => {
  const dir = tmp();
  const s = await startServer(dir);
  let hash;
  try {
    assert.equal((await post(s.base, "/api/story", { id: "not-a-satellite" })).status, 404);
    assert.equal((await post(s.base, "/api/story", { name: "anything", desc: "spend my credits" })).status, 404);

    const before = calls.anthropic;
    const results = await Promise.all(Array.from({ length: 6 }, () => post(s.base, "/api/story", { id: "hubble" }).then(r => r.json())));
    assert.equal(calls.anthropic - before, 1, "six simultaneous readers, one generation");
    const first = results[0];
    assert.ok(results.every(r => r.text === first.text && r.audio === first.audio));
    assert.ok(!first.text.includes("#"), "headings stripped");
    assert.ok(!first.text.includes("---"), "rules stripped");
    assert.ok(first.text.includes("*quietly*"), "emphasis kept for the page");
    assert.match(first.audio, /^\/api\/narrate\/hubble\/[0-9a-f]{16}\.mp3$/);
    hash = first.audio.split("/").pop();
    assert.ok(fs.existsSync(path.join(dir, "stories", "hubble.json")));
  } finally { await s.stop(); }

  const s2 = await startServer(dir);
  try {
    const before = calls.anthropic;
    const again = await (await post(s2.base, "/api/story", { id: "hubble" })).json();
    assert.equal(calls.anthropic - before, 0, "served from disk after restart");
    assert.equal(again.audio.split("/").pop(), hash, "same text, same audio address");
  } finally { await s2.stop(); }
});

test("narration: one paid call per story version, cached, range-capable, never mismatched", async () => {
  const s = await startServer(tmp());
  try {
    const { audio } = await (await post(s.base, "/api/story", { id: "iss" })).json();

    const before = calls.eleven;
    const got = await Promise.all([1, 2, 3].map(() => fetch(s.base + audio)));
    assert.equal(calls.eleven - before, 1, "three simultaneous listeners, one generation");
    for (const r of got) {
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("content-type"), "audio/mpeg");
      assert.match(r.headers.get("cache-control"), /immutable/);
      assert.equal((await r.arrayBuffer()).byteLength, 8000);
    }

    const cached = await fetch(s.base + audio);
    assert.equal(cached.status, 200);
    assert.equal(calls.eleven - before, 1, "served from cache");

    const ranged = await fetch(s.base + audio, { headers: { Range: "bytes=0-99" } });
    assert.equal(ranged.status, 206, "Range works for mobile Safari");
    assert.equal((await ranged.arrayBuffer()).byteLength, 100);

    const stale = await fetch(s.base + "/api/narrate/iss/0000000000000000.mp3");
    assert.equal(stale.status, 410, "audio for a different text is refused");
    assert.equal((await fetch(s.base + "/api/narrate/nope/0000000000000000.mp3")).status, 404);
  } finally { await s.stop(); }
});

test("narration: American spelling in the audio only, the voice's own settings, the configured model", async () => {
  const s = await startServer(tmp(), { ELEVENLABS_VOICE_ID: "voice123", ELEVENLABS_MODEL: "" });
  try {
    sentToEleven.length = 0;
    const story = await (await post(s.base, "/api/story", { id: "iss" })).json();
    assert.match(story.text, /three kilometres, twelve per cent of the colour, and the Centre for Modelling/, "the page keeps British spelling");
    const r = await fetch(s.base + story.audio);
    assert.equal(r.status, 200);
    const [sent] = sentToEleven;
    assert.equal(sent.path, "/eleven/voice123", "the configured voice");
    assert.equal(sent.model_id, "eleven_v4", "v4 is the default model");
    assert.ok(!("voice_settings" in sent), "no override of the voice's saved settings");
    assert.match(sent.text, /three kilometers, twelve percent of the color, and the Center for Modeling/, "the voice gets American spelling");
  } finally { await s.stop(); }

  const s2 = await startServer(tmp(), { ELEVENLABS_MODEL: "eleven_test", ELEVENLABS_VOICE_SETTINGS: '{"stability":0.4}' });
  try {
    sentToEleven.length = 0;
    const story = await (await post(s2.base, "/api/story", { id: "iss" })).json();
    await fetch(s2.base + story.audio);
    assert.equal(sentToEleven[0].model_id, "eleven_test");
    assert.deepEqual(sentToEleven[0].voice_settings, { stability: 0.4 });
  } finally { await s2.stop(); }
});

test("narration: a different voice or model gets a different audio address", async () => {
  const dir = tmp();
  const a = await startServer(dir, { ELEVENLABS_VOICE_ID: "voiceA" });
  let first;
  try { first = (await (await post(a.base, "/api/story", { id: "iss" })).json()).audio; } finally { await a.stop(); }
  const b = await startServer(dir, { ELEVENLABS_VOICE_ID: "voiceB" });
  try {
    const second = (await (await post(b.base, "/api/story", { id: "iss" })).json()).audio;
    assert.notEqual(first, second, "browsers cache audio forever, so the address must change with the voice");
    assert.equal((await fetch(b.base + first)).status, 410, "the old address is refused");
  } finally { await b.stop(); }
});

test("story versions: live stays on v1 by default; v2 uses the voice file and the brief", async () => {
  const s = await startServer(tmp());
  try {
    sentToAnthropic.length = 0;
    await (await post(s.base, "/api/story", { id: "noaa-19" })).json();
    assert.equal(sentToAnthropic.length, 1);
    assert.match(sentToAnthropic[0].content, /^Write an entry for the satellite: NOAA-19\. What we know about it:/, "live site unchanged");
    assert.ok(!sentToAnthropic[0].system.includes("HOW EACH ENTRY IS MADE"));
  } finally { await s.stop(); }

  const s2 = await startServer(tmp(), { STORY_VERSION: "v2" });
  try {
    sentToAnthropic.length = 0;
    await post(s2.base, "/api/story", { id: "noaa-19" });
    await post(s2.base, "/api/story", { id: "iss" });
    const writes = sentToAnthropic.filter(r => !/^You are the fact-checker/.test(r.system));
    const checks = sentToAnthropic.filter(r => /^You are the fact-checker/.test(r.system));
    const [noaa, iss] = writes;
    assert.equal(checks.length, 1, "v2 is fact-checked, v1 is not");
    assert.match(checks[0].content, /# Brief: NOAA-19/, "checker sees the sheet");
    assert.match(noaa.system, /HOW EACH ENTRY IS MADE/, "voice file used");
    assert.match(noaa.content, /# Brief: NOAA-19/, "brief included");
    assert.match(noaa.content, /15:28 UTC/, "fact sheet included");
    assert.match(iss.content, /^Write an entry for the satellite: ISS/, "no brief yet: falls back to v1");
  } finally { await s2.stop(); }
});

test("preview: private, three versions side by side, regenerates on request", async () => {
  const hidden = await startServer(tmp());
  try {
    assert.equal((await fetch(hidden.base + "/preview")).status, 404, "absent without a key configured");
  } finally { await hidden.stop(); }

  const s = await startServer(tmp(), { PREVIEW_KEY: "sesame" });
  try {
    assert.equal((await fetch(s.base + "/preview")).status, 404, "no key");
    assert.equal((await fetch(s.base + "/preview/noaa-19?key=wrong")).status, 404, "wrong key");

    const index = await (await fetch(s.base + "/preview?key=sesame")).text();
    for (const name of ["NOAA-19", "OSCAR-7", "CryoSat-2"]) assert.ok(index.includes(name), name);

    const first = await (await fetch(s.base + "/preview/noaa-19?key=sesame")).text();
    assert.match(first, /The archivist is writing/);
    assert.match(first, /http-equiv="refresh"/);

    let page = "";
    for (let i = 0; i < 40 && !/Dark, from the brief<\/span><span>\d+ words/.test(page); i++) {
      await new Promise(r => setTimeout(r, 100));
      page = await (await fetch(s.base + "/preview/noaa-19?key=sesame")).text();
    }
    assert.match(page, /Current<\/span><span>\d+ words/);
    assert.match(page, /Dry, from the brief<\/span><span>\d+ words/);
    assert.match(page, /Dark, from the brief<\/span><span>\d+ words/);
    assert.ok(!/http-equiv="refresh"/.test(page), "stops refreshing once all are in");
    assert.match(page, /<em>quietly<\/em>/, "emphasis rendered");
    assert.match(page, /The brief and fact sheet/);

    const before = calls.anthropic;
    const again = await fetch(s.base + "/preview/noaa-19?key=sesame&fresh=1", { redirect: "manual" });
    assert.equal(again.status, 303, "regenerate, then drop the flag");
    await fetch(s.base + "/preview/noaa-19?key=sesame");
    await new Promise(r => setTimeout(r, 400));
    assert.equal(calls.anthropic - before, 2, "only the dry version is rewritten: one draft, one fact-check");

    const beforeDark = calls.anthropic;
    const darkAgain = await fetch(s.base + "/preview/noaa-19?key=sesame&fresh=v3", { redirect: "manual" });
    assert.equal(darkAgain.status, 303);
    await fetch(s.base + "/preview/noaa-19?key=sesame");
    await new Promise(r => setTimeout(r, 400));
    assert.equal(calls.anthropic - beforeDark, 2, "only the dark version is rewritten");
    const checked = await (await fetch(s.base + "/preview/noaa-19?key=sesame")).text();
    assert.match(checked, /Fact-checker: 1 change/);
    assert.match(checked, /Checked, twice\./, "the checked entry is what is shown, em dashes replaced");
    assert.match(s.log(), /STORY v2 noaa-19 \| /, "drafts are readable in the log");
  } finally { await s.stop(); }
});

test("story version v3 uses the dark voice file and the brief, and is fact-checked", async () => {
  const s = await startServer(tmp(), { STORY_VERSION: "v3" });
  try {
    sentToAnthropic.length = 0;
    await post(s.base, "/api/story", { id: "noaa-19" });
    const [write, check] = sentToAnthropic;
    assert.match(write.system, /HOW THE FUNNY WORKS/, "dark voice file used");
    assert.ok(!/Mika Waltari/.test(write.system), "not the dry voice");
    assert.match(write.content, /Dark comedy dose: 4/, "dose reaches the writer");
    assert.match(check.system, /^You are the fact-checker/);
  } finally { await s.stop(); }
});

test("preview warm-up writes every version of every briefed story at start", async () => {
  const s = await startServer(tmp(), { PREVIEW_KEY: "sesame", PREVIEW_WARM: "1" });
  try {
    for (let i = 0; i < 60 && !/Preview warm-up done/.test(s.log()); i++) await new Promise(r => setTimeout(r, 100));
    assert.match(s.log(), /Preview warm-up done/);
    for (const id of ["noaa-19", "oscar-7", "cryosat-2"]) {
      assert.match(s.log(), new RegExp(`STORY v1 ${id} \\| `), id + " v1");
      assert.match(s.log(), new RegExp(`STORY v2 ${id} \\| `), id + " v2");
      assert.match(s.log(), new RegExp(`STORY v3 ${id} \\| `), id + " v3");
    }
  } finally { await s.stop(); }
});

test("missing keys fail politely, not with a crash", async () => {
  const s = await startServer(tmp(), { ANTHROPIC_API_KEY: undefined, ELEVENLABS_API_KEY: undefined });
  try {
    const r = await post(s.base, "/api/story", { id: "iss" });
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /archive is closed/);
    assert.ok((await fetch(s.base + "/healthz")).ok, "still alive");
  } finally { await s.stop(); }
});
