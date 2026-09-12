/**
 * TennisRecord lookup module
 * Fetches estimated dynamic ratings or NTRP benchmark ratings from TennisRecord.com.
 */

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT_MS = 6000;

/**
 * Searches TennisRecord for a player's rating.
 * Returns a number rounded to 2 decimals (e.g. 3.85, 4.0), or null if not found.
 */
async function fetchTennisRecordRating(name) {
  if (!name || typeof name !== 'string') return null;

  // Clean name from digits, parentheticals, guest tags
  const cleanName = name
    .replace(/\([^)]*\)/g, '')
    .replace(/#\d+/g, '')
    .trim();

  if (!cleanName || /^player(?:\s+\d+)?$/i.test(cleanName) || /^(?:me|someone)$/i.test(cleanName)) {
    return null;
  }

  const url = `https://www.tennisrecord.com/adult/profile.aspx?playername=${encodeURIComponent(cleanName)}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT
      },
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!res.ok) return null;

    const html = await res.text();
    if (!html.includes('Player Profile') || html.includes('No Player Found')) {
      return null;
    }

    // 1. Try to extract Estimated Dynamic Rating
    const dynamicMatch = html.match(/Estimated Dynamic Rating\s*<\/td>\s*<td[^>]*>\s*(?:<[^>]+>)*([0-9.]+)/i);
    if (dynamicMatch && parseFloat(dynamicMatch[1]) > 0) {
      const val = parseFloat(dynamicMatch[1]);
      return Math.round(val * 100) / 100;
    }

    // 2. Fall back to NTRP benchmark rating (e.g. "3.5 S", "4.0 C", etc.)
    const ntrpMatch = html.match(/<span style="font-weight:bold;">\s*([2-7]\.[05]|[2-7]\.\d+)\s*[A-Za-z]*/i);
    if (ntrpMatch && parseFloat(ntrpMatch[1]) > 0) {
      const val = parseFloat(ntrpMatch[1]);
      return Math.round(val * 100) / 100;
    }

    return null;
  } catch (err) {
    // Network errors, timeouts, or aborts safely return null
    return null;
  }
}

module.exports = {
  fetchTennisRecordRating
};
