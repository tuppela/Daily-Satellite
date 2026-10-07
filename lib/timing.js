/* Narration timing
 * ElevenLabs reports when every character of the spoken text begins and ends.
 * The page shows the same text with different markup and British spelling, so
 * this turns character times into one start time per displayed word, which is
 * what the panel needs to follow the voice.
 */

// Start and end offsets of every whitespace-separated word.
function wordSpans(text) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text))) out.push([m.index, m.index + m[0].length]);
  return out;
}

// The words the panel shows: markup removed, one entry per word.
const displayText = text => String(text).replace(/\*([^*\n]+)\*/g, "$1");

/**
 * @param {string} spoken     exactly what was sent to the voice
 * @param {object} alignment  { characters, character_start_times_seconds, character_end_times_seconds }
 * @param {number} shownCount number of words the page displays
 * @returns {number[]|null}   start time in seconds for each displayed word, or null
 */
function wordStarts(spoken, alignment, shownCount) {
  const starts = alignment && alignment.character_start_times_seconds;
  const ends = alignment && alignment.character_end_times_seconds;
  if (!Array.isArray(starts) || !Array.isArray(ends) || starts.length === 0 || starts.length !== ends.length) return null;
  if (!starts.every(Number.isFinite)) return null;

  // Usually one time per character. If the voice reports a different number of
  // characters, spread them evenly over the text rather than trust a shifted map.
  const n = starts.length, len = spoken.length;
  const at = i => starts[len === n ? i : Math.min(n - 1, Math.round(i * (n - 1) / Math.max(1, len - 1)))];

  const spoke = wordSpans(spoken).map(([a]) => Math.max(0, at(a)));
  if (spoke.length === 0) return null;

  // Spelling swaps never change the word order, and almost never the count
  // ("per cent" becomes "percent"). When the counts differ, map by position.
  const N = shownCount || spoke.length;
  const out = new Array(N);
  for (let i = 0; i < N; i++) {
    out[i] = spoke.length === N ? spoke[i] : spoke[Math.min(spoke.length - 1, Math.round(i * (spoke.length - 1) / Math.max(1, N - 1)))];
  }
  // Times must never run backwards.
  for (let i = 1; i < N; i++) if (out[i] < out[i - 1]) out[i] = out[i - 1];
  return out.map(t => Math.round(t * 100) / 100);
}

module.exports = { wordSpans, displayText, wordStarts };
