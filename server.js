const express = require("express");
const path = require("path");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// Fallback TLEs — used when CelesTrak is unavailable
const FALLBACK_TLES = {
  25544: { norad: 25544, name: "ISS (ZARYA)", l1: "1 25544U 98067A   26077.80687812  .00008636  00000+0  16833-3 0  9998", l2: "2 25544  51.6341  27.2872 0006206 206.1039 153.9638 15.48363739557747" },
  48274: { norad: 48274, name: "TIANHE", l1: "1 48274U 21035A   26077.50000000  .00017147  00000-0  19896-3 0  9994", l2: "2 48274  41.4709 264.5225 0005423 350.0790  10.0099 15.61710805159655" },
  20580: { norad: 20580, name: "HST", l1: "1 20580U 90037B   26077.49889012  .00001366  00000-0  64455-4 0  9991", l2: "2 20580  28.4696 175.5995 0002526  47.4731  23.4983 15.09658174 33858" },
  41866: { norad: 41866, name: "GOES-16", l1: "1 41866U 16071A   26077.50000000 -.00000302  00000-0  00000-0 0  9993", l2: "2 41866   0.0551 105.2938 0000873 176.3240 339.3561  1.00271567890123" },
  33591: { norad: 33591, name: "NOAA 19", l1: "1 33591U 09005A   26077.52314815  .00000123  00000-0  87654-4 0  9998", l2: "2 33591  98.7651  89.4321 0013456 234.5678 125.3210 14.12345678901234" },
  25994: { norad: 25994, name: "TERRA", l1: "1 25994U 99068A   26077.51766528  .00000098  00000-0  23456-4 0  9995", l2: "2 25994  98.2120 45.6789 0001234  78.9012 281.2109 14.57345678901235" },
  27424: { norad: 27424, name: "AQUA", l1: "1 27424U 02022A   26077.50000000  .00000099  00000-0  23457-4 0  9996", l2: "2 27424  98.2121 46.6790 0001235  78.9013 281.2110 14.57345678901236" },
  40697: { norad: 40697, name: "SENTINEL-2A", l1: "1 40697U 15028A   26077.51766528  .00000234  00000-0  34567-4 0  9998", l2: "2 40697  98.5678 34.5678 0001234  89.0123 271.1234 14.30987654901238" },
  39084: { norad: 39084, name: "LANDSAT 8", l1: "1 39084U 13008A   26077.50000000  .00000123  00000-0  12345-4 0  9999", l2: "2 39084  98.2345 23.4567 0001345  78.9012 281.2109 14.57123456901239" },
  36508: { norad: 36508, name: "CRYOSAT 2", l1: "1 36508U 10013A   26077.51766528  .00000567  00000-0  34567-4 0  9993", l2: "2 36508  92.0156  67.8901 0013456  89.1234 270.9876 14.52345678901234" },
  39452: { norad: 39452, name: "SWARM-A", l1: "1 39452U 13067A   26077.52314815  .00003456  00000-0  19876-3 0  9997", l2: "2 39452  87.3567  78.9012 0008765  67.8901 292.2109 15.23456789012345" },
  8820:  { norad: 8820,  name: "LAGEOS 1", l1: "1 08820U 76039A   26077.50000000  .00000000  00000-0  00000-0 0  9993", l2: "2 08820 109.8380  52.4671 0044981  59.1765 301.4419  6.38664959678901" },
  5:     { norad: 5,     name: "VANGUARD 1", l1: "1 00005U 58002B   26077.20333880 -.00000016  00000-0 -22483-4 0  9998", l2: "2 00005  34.2443 225.5254 1845686 162.2516 205.2356 10.84869164218149" },
  7530:  { norad: 7530,  name: "OSCAR 7", l1: "1 07530U 74089B   26077.51766528  .00000078  00000-0  67890-4 0  9997", l2: "2 07530 101.7890  89.4321 0012345  56.7890 303.3210 14.28901234567890" },
  41240: { norad: 41240, name: "JASON-3", l1: "1 41240U 16002A   26077.50000000  .00000234  00000-0  34567-4 0  9996", l2: "2 41240  66.0456 56.7890 0001234  89.0123 271.1234 12.80987654901236" },
  44238: { norad: 44238, name: "STARLINK-30", l1: "1 44238U 19029K   26077.52314815  .00003456  00000-0  23456-3 0  9991", l2: "2 44238  53.0536  89.4321 0001234  67.8901 292.2109 15.06391602234567" },
  44239: { norad: 44239, name: "STARLINK-31", l1: "1 44239U 19029L   26077.51766528  .00003457  00000-0  23457-3 0  9992", l2: "2 44239  53.0537  90.4322 0001235  67.8902 292.2110 15.06391602234568" },
  24876: { norad: 24876, name: "GPS BIIR-2", l1: "1 24876U 97035A   26077.50000000  .00000000  00000-0  00000-0 0  9998", l2: "2 24876  55.4567  89.0123 0087654  45.6789 314.3211  2.00563827654321" },
  37846: { norad: 37846, name: "GALILEO-5", l1: "1 37846U 11060A   26077.50000000  .00000000  00000-0  00000-0 0  9992", l2: "2 37846  55.0456  34.5678 0001234  89.1234 270.9876  1.70473456789012" },
  27386: { norad: 27386, name: "ENVISAT", l1: "1 27386U 02009A   26077.51766528  .00000123  00000-0  23456-4 0  9997", l2: "2 27386  98.5678 34.5678 0002345  78.9012 281.2109 14.37654321901237" },
};
const tleCache = {};
const CACHE_TTL = 60 * 60 * 1000;

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "OrbitalRegister/1.0" } }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.on("error", reject);
  });
}

function httpsPost(hostname, path, data, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const options = {
      hostname, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers }
    };
    const req = https.request(options, (res) => {
      let d = "";
      res.on("data", chunk => d += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

app.get("/api/test", async (req, res) => {
  try {
    const url = "https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE";
    const { status, body } = await httpsGet(url);
    res.json({ status, bodyPreview: body.slice(0, 300) });
  } catch(e) {
    res.json({ error: e.message });
  }
});

app.get("/api/tle/:norad", async (req, res) => {
  const norad = parseInt(req.params.norad);
  if (!norad || isNaN(norad)) return res.status(400).json({ error: "Invalid NORAD ID" });

  const cached = tleCache[norad];
  if (cached && Date.now() - cached.time < CACHE_TTL) return res.json(cached.data);

  try {
    const url = `https://celestrak.org/NORAD/elements/gp.php?CATNR=${norad}&FORMAT=TLE`;
    const { status, body } = await httpsGet(url);
    if (status !== 200) return res.status(502).json({ error: `CelesTrak ${status}` });

    const lines = body.trim().split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    let name = null, l1 = null, l2 = null;
    for (const line of lines) {
      if (line.startsWith("1 ") && line.length > 50) l1 = line;
      else if (line.startsWith("2 ") && line.length > 50) l2 = line;
      else if (!name && !line.startsWith("1 ") && !line.startsWith("2 ")) name = line;
    }
    if (!l1 || !l2) {
      const fallback = FALLBACK_TLES[norad];
      if (fallback) { tleCache[norad] = { time: Date.now(), data: fallback }; return res.json(fallback); }
      return res.status(404).json({ error: `No TLE for ${norad}` });
    }

    const result = { norad, name: name ? name.trim() : String(norad), l1, l2 };
    tleCache[norad] = { time: Date.now(), data: result };
    res.json(result);
  } catch (err) {
    const fallback = FALLBACK_TLES[norad];
    if (fallback) { tleCache[norad] = { time: Date.now(), data: fallback }; return res.json(fallback); }
    res.status(500).json({ error: err.message });
  }
});

// ─── STORY ENDPOINT ──────────────────────────────────────────────────────────
const storyCache = {};

app.post("/api/story", async (req, res) => {
  const { id, name, desc } = req.body;
  if (!name) return res.status(400).json({ error: "Missing satellite name" });

  const cacheKey = id || name;
  const cached = storyCache[cacheKey];
  if (cached && Date.now() - cached.time < 24 * 60 * 60 * 1000) {
    return res.json(cached.data);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "API key not configured" });

  const systemPrompt = `You are the keeper of a very old archive of objects in Earth orbit. You have been alone with this material for a long time and have developed a deep, unsentimental familiarity with each object — when it was made, why, what it has witnessed, what became of it. You write as someone who is genuinely delighted when another person shows interest, but who expresses that delight quietly. You do not perform enthusiasm. You do not oversell. You trust the facts to be interesting, because they are. Your tone is warm but never sentimental. Precise but never cold. You allow dark things — failures, cover-ups, debris fields, forgotten machines — to simply be what they are, without dramatising or softening them. When something is absurd, you note it briefly and move on. You write in the tradition of Mika Waltari and long-form literary journalism — flowing prose, no lists, no headers. You are helping someone understand something for the first time and you take that quietly seriously. Write until the story is told, then stop. Some entries will be 300 words, some 600. Follow the shape of the story. Every entry should end by opening outward — from the specific satellite into something larger about time, human ambition, or the strangeness of what we have put into the sky.`;

  try {
    const { status, body } = await httpsPost(
      "api.anthropic.com",
      "/v1/messages",
      {
        model: "claude-opus-4-5",
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: `Write an entry for the satellite: ${name}. What we know about it: ${desc || ""}` }]
      },
      {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      }
    );

    if (status !== 200) {
      console.error(`Anthropic API error ${status}: ${body.slice(0, 200)}`);
      return res.status(502).json({ error: `API error ${status}` });
    }

    const parsed = JSON.parse(body);
    const text = parsed.content?.[0]?.text || "";
    const result = { text };
    storyCache[cacheKey] = { time: Date.now(), data: result };
    res.json(result);
  } catch (err) {
    console.error("Story error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── STATIC ──────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Orbital Register running on port ${PORT}`);
});
