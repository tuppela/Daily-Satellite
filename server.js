const express = require("express");
const path = require("path");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── TLE PROXY — must be before static middleware ─────────────────────────────
const tleCache = {};
const CACHE_TTL = 60 * 60 * 1000;

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "OrbitalRegister/1.0" } }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    }).on("error", reject);
  });
}

app.get("/api/test", async (req, res) => {
  try {
    const url = "https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE";
    const { status, body } = await httpsGet(url);
    res.setHeader("Content-Type", "application/json");
    res.send(JSON.stringify({ status, bodyPreview: body.slice(0, 500) }));
  } catch(e) {
    res.setHeader("Content-Type", "application/json");
    res.send(JSON.stringify({ error: e.message }));
  }
});

app.get("/api/tle/:norad", async (req, res) => {
  const norad = parseInt(req.params.norad);
  if (!norad) return res.status(400).json({ error: "Invalid NORAD ID" });

  const cached = tleCache[norad];
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return res.json(cached.data);
  }

  try {
    const url = `https://celestrak.org/NORAD/elements/gp.php?CATNR=${norad}&FORMAT=TLE`;
    console.log(`Fetching TLE for NORAD ${norad}...`);
    const { status, body } = await httpsGet(url);

    if (status !== 200) return res.status(502).json({ error: `CelesTrak ${status}` });

    // TLE format: name line, line1, line2
    const lines = body.trim().split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    let name = null, l1 = null, l2 = null;
    for (const line of lines) {
      if (line.startsWith("1 ") && line.length > 50) l1 = line;
      else if (line.startsWith("2 ") && line.length > 50) l2 = line;
      else if (!name) name = line;
    }

    if (!l1 || !l2) return res.status(404).json({ error: `No TLE for ${norad}`, lines });

    const result = { norad, name: name || String(norad), l1, l2 };
    tleCache[norad] = { time: Date.now(), data: result };
    console.log(`TLE OK: ${name}`);
    res.json(result);
  } catch (err) {
    console.error(`TLE error for ${norad}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── STATIC FILES — after API routes ─────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Orbital Register running on port ${PORT}`);
});
