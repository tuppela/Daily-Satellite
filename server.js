const express = require("express");
const path = require("path");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 3000;

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

function parseTLEText(body) {
  // Parse multi-satellite TLE text into a map of norad -> {name, l1, l2}
  const lines = body.trim().split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  const result = {};
  for (let i = 0; i < lines.length - 1; i++) {
    const l1 = lines[i];
    const l2 = lines[i + 1];
    if (l1.startsWith("1 ") && l1.length > 50 && l2.startsWith("2 ") && l2.length > 50) {
      const norad = parseInt(l1.substring(2, 7).trim());
      const name = i > 0 && !lines[i-1].startsWith("1 ") && !lines[i-1].startsWith("2 ")
        ? lines[i-1] : String(norad);
      result[norad] = { norad, name, l1, l2 };
      i++; // skip l2
    }
  }
  return result;
}

// Fetch all TLEs in one request
app.get("/api/tle/batch", async (req, res) => {
  const noradIds = req.query.ids;
  if (!noradIds) return res.status(400).json({ error: "Missing ids parameter" });

  const cacheKey = "batch_" + noradIds;
  const cached = tleCache[cacheKey];
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return res.json(cached.data);
  }

  try {
    // Fetch all at once using comma-separated CATNR
    const url = `https://celestrak.org/NORAD/elements/gp.php?CATNR=${noradIds}&FORMAT=TLE`;
    console.log(`Batch TLE fetch for: ${noradIds}`);
    const { status, body } = await httpsGet(url);
    console.log(`CelesTrak batch status: ${status}, length: ${body.length}`);

    if (status !== 200) return res.status(502).json({ error: `CelesTrak ${status}` });

    const tles = parseTLEText(body);
    console.log(`Parsed ${Object.keys(tles).length} TLEs`);

    tleCache[cacheKey] = { time: Date.now(), data: tles };
    res.json(tles);
  } catch (err) {
    console.error("Batch TLE error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/test", async (req, res) => {
  try {
    const url = "https://celestrak.org/NORAD/elements/gp.php?CATNR=25544,48274,20580&FORMAT=TLE";
    const { status, body } = await httpsGet(url);
    res.json({ status, bodyPreview: body.slice(0, 300), lines: body.split("\n").length });
  } catch(e) {
    res.json({ error: e.message });
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
    const { status, body } = await httpsGet(url);
    if (status !== 200) return res.status(502).json({ error: `CelesTrak ${status}` });

    const lines = body.trim().split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    let name = null, l1 = null, l2 = null;
    for (const line of lines) {
      if (line.startsWith("1 ") && line.length > 50) l1 = line;
      else if (line.startsWith("2 ") && line.length > 50) l2 = line;
      else if (!name) name = line;
    }

    if (!l1 || !l2) return res.status(404).json({ error: `No TLE for ${norad}`, body: body.slice(0, 200) });

    const result = { norad, name: name || String(norad), l1, l2 };
    tleCache[norad] = { time: Date.now(), data: result };
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Orbital Register running on port ${PORT}`);
});
