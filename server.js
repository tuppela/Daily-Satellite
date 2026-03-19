const express = require("express");
const path = require("path");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── TLE PROXY ───────────────────────────────────────────────────────────────
const tleCache = {};
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

function fetchTLEFromCelesTrak(noradId) {
  return new Promise((resolve, reject) => {
    const url = `https://celestrak.org/satcat/tle.php?CATNR=${noradId}`;
    https.get(url, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

app.get("/api/tle/:norad", async (req, res) => {
  const norad = parseInt(req.params.norad);
  if (!norad) return res.status(400).json({ error: "Invalid NORAD ID" });

  const cached = tleCache[norad];
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return res.json(cached.data);
  }

  try {
    const text = await fetchTLEFromCelesTrak(norad);
    const lines = text.trim().split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);

    let l1 = null, l2 = null, name = null;
    for (const line of lines) {
      if (line.startsWith("1 ") && line.length > 50) l1 = line;
      else if (line.startsWith("2 ") && line.length > 50) l2 = line;
      else if (!name && !line.startsWith("1 ") && !line.startsWith("2 ")) name = line;
    }

    if (!l1 || !l2) {
      return res.status(404).json({ error: `No TLE found for NORAD ${norad}` });
    }

    const result = { norad, name: name || String(norad), l1, l2 };
    tleCache[norad] = { time: Date.now(), data: result };
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── STATIC FILES ────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Orbital Register running on port ${PORT}`);
});
