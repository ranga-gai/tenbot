function sanitizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  try {
    return encodeURI(decodeURI(trimmed));
  } catch (e) {
    return encodeURI(trimmed);
  }
}

/**
 * TennisRecord lookup module
 * Fetches estimated dynamic ratings or NTRP benchmark ratings from TennisRecord.com.
 * When multiple players match the same name, prioritizes players from San Jose, CA (or nearby Bay Area, CA).
 */

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT_MS = 6000;

function parseProfileRating(html) {
  if (!html) return null;
  if (!html.includes('Player Profile') || html.includes('No Player Found')) {
    return null;
  }

  // 1. Try to extract Estimated Dynamic Rating (e.g. 3.82)
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
}

function rankLocation(location = '') {
  const loc = String(location).trim();
  const isCA = /\bca\b/i.test(loc);
  if (/\bsan\s*jose\b/i.test(loc) && isCA) return 100;
  if (/\b(santa clara|sunnyvale|cupertino|saratoga|campbell|milpitas|mountain view|los gatos|palo alto|fremont|morgan hill|gilroy|san francisco|oakland|pleasanton|san mateo|redwood city)\b/i.test(loc) && isCA) return 50;
  if (isCA) return 25;
  return 10;
}

/**
 * Searches TennisRecord for a player's rating.
 * If multiple players match the name, selects the player from San Jose, CA.
 * If directProfileUrl is supplied, fetches directly from that profile page.
 * Returns an object { rating, profileUrl, location } or null if not found.
 */
async function fetchTennisRecordRating(name, directProfileUrl = null) {
  if (!name || typeof name !== 'string') return null;

  // Clean name from digits, parentheticals, guest tags
  const cleanName = name
    .replace(/\([^)]*\)/g, '')
    .replace(/#\d+/g, '')
    .trim();

  if (!cleanName || /^player(?:\s+\d+)?$/i.test(cleanName) || /^(?:me|someone)$/i.test(cleanName)) {
    return null;
  }

  const parts = cleanName.split(/\s+/);
  const firstName = parts[0] || '';
  const lastName = parts.slice(1).join(' ') || '';

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let targetProfileUrl = sanitizeUrl(directProfileUrl);
    let selectedLocation = null;

    // When both first and last names exist and no directProfileUrl was provided, query search.aspx
    if (!targetProfileUrl && firstName && lastName) {
      try {
        const params = new URLSearchParams();
        params.append('firstname', firstName);
        params.append('lastname', lastName);

        const searchRes = await fetch('https://www.tennisrecord.com/adult/search.aspx', {
          method: 'POST',
          headers: {
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: params.toString(),
          signal: controller.signal
        });

        if (searchRes.ok) {
          const searchHtml = await searchRes.text();
          const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
          let match;
          const candidates = [];

          while ((match = rowRegex.exec(searchHtml)) !== null) {
            const rowHtml = match[1];
            const linkMatch = rowHtml.match(/<a[^>]+href=["']([^"']*profile\.aspx[^"']*)["'][^>]*>(.*?)<\/a>/i);
            if (linkMatch) {
              const href = linkMatch[1];
              const pName = linkMatch[2].replace(/<[^>]+>/g, '').trim();
              const tdMatches = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((td) => td[1].replace(/<[^>]+>/g, '').trim());
              const location = tdMatches[1] || '';
              const ratingStr = tdMatches[3] || '';

              if (pName.toLowerCase() === cleanName.toLowerCase()) {
                candidates.push({ href, pName, location, ratingStr, rank: rankLocation(location) });
              }
            }
          }

          if (candidates.length > 0) {
            // Sort by location rank (San Jose, CA first) descending; prefer candidates with non-empty ratings if available
            candidates.sort((a, b) => {
              if (b.rank !== a.rank) return b.rank - a.rank;
              const aHasRating = a.ratingStr && a.ratingStr !== '----' ? 1 : 0;
              const bHasRating = b.ratingStr && b.ratingStr !== '----' ? 1 : 0;
              return bHasRating - aHasRating;
            });

            const chosen = candidates[0];
            if (chosen?.href) {
              const path = chosen.href.startsWith('/') ? chosen.href : `/${chosen.href}`;
              targetProfileUrl = sanitizeUrl(`https://www.tennisrecord.com${path}`);
              selectedLocation = chosen.location || null;
              console.log(`[tennisrecord] Multiple matches (${candidates.length}) for "${cleanName}". Selected: "${chosen.pName}" (${chosen.location || 'Unknown location'}) -> ${targetProfileUrl}`);
            }
          }
        }
      } catch (searchErr) {
        // Fall back to direct profile lookup if search request fails
      }
    }

    if (!targetProfileUrl) {
      targetProfileUrl = sanitizeUrl(`https://www.tennisrecord.com/adult/profile.aspx?playername=${cleanName}`);
    }

    const res = await fetch(targetProfileUrl, {
      headers: {
        'User-Agent': USER_AGENT
      },
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!res.ok) return null;

    const html = await res.text();
    const rating = parseProfileRating(html);
    return {
      rating,
      profileUrl: targetProfileUrl,
      location: selectedLocation
    };
  } catch (err) {
    // Network errors, timeouts, or aborts safely return null
    return null;
  }
}

module.exports = {
  fetchTennisRecordRating
};
