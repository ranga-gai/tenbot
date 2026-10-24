/**
 * TennisRecord lookup module
 * Fetches estimated dynamic ratings or NTRP benchmark ratings from TennisRecord.com.
 * When multiple players match the same name, prioritizes players from San Jose, CA.
 *
 * Configurable SSL certificate validation check allows suspending certificate
 * verification when TennisRecord.com SSL certificates expire.
 */

const https = require('https');
const http = require('http');

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT_MS = 6000;

// Configurable certificate check state: default suspended (true) or resumed (false)
let isCertCheckSuspended = true;

function setCertCheckSuspended(suspended) {
  isCertCheckSuspended = Boolean(suspended);
  console.log(`[tennisrecord] SSL certificate check ${isCertCheckSuspended ? 'SUSPENDED (insecure allowed)' : 'RESUMED (strict verification)'}`);
  return isCertCheckSuspended;
}

function getCertCheckSuspended() {
  return isCertCheckSuspended;
}

function suspendCertCheck() {
  return setCertCheckSuspended(true);
}

function resumeCertCheck() {
  return setCertCheckSuspended(false);
}

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
 * Custom HTTP/HTTPS request helper supporting configurable rejectUnauthorized
 * and redirect following.
 */
function fetchHttp(url, options = {}, maxRedirects = 3) {
  return new Promise((resolve, reject) => {
    let urlObj;
    try {
      urlObj = new URL(url);
    } catch (err) {
      return reject(err);
    }

    const isHttps = urlObj.protocol === 'https:';
    const client = isHttps ? https : http;

    const reqOptions = {
      protocol: urlObj.protocol,
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeout || TIMEOUT_MS
    };

    if (isHttps) {
      reqOptions.rejectUnauthorized = !isCertCheckSuspended;
    }

    const req = client.request(reqOptions, (res) => {
      // Handle redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
        const nextUrl = new URL(res.headers.location, url).toString();
        return fetchHttp(nextUrl, options, maxRedirects - 1).then(resolve, reject);
      }

      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: res.headers,
          text: () => Promise.resolve(data)
        });
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request to ${url} timed out after ${reqOptions.timeout}ms`));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

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

function parseProfileLocation(html) {
  if (!html) return null;
  const locMatch = html.match(/Location\s*<\/td>\s*<td[^>]*>\s*(?:<[^>]+>)*([^<]+)/i) ||
                   html.match(/City\s*,\s*State\s*<\/td>\s*<td[^>]*>\s*(?:<[^>]+>)*([^<]+)/i) ||
                   html.match(/Area\s*<\/td>\s*<td[^>]*>\s*(?:<[^>]+>)*([^<]+)/i);
  if (locMatch && locMatch[1]) {
    const clean = locMatch[1].replace(/&nbsp;/g, ' ').trim();
    if (clean && clean !== '----') return clean;
  }
  return null;
}

const NEARBY_BAY_AREA_CITIES = [
  'santa clara', 'sunnyvale', 'cupertino', 'saratoga', 'campbell',
  'milpitas', 'mountain view', 'los gatos', 'palo alto', 'los altos',
  'fremont', 'newark', 'union city', 'morgan hill', 'gilroy',
  'san francisco', 'oakland', 'pleasanton', 'dublin', 'san ramon',
  'san mateo', 'redwood city', 'menlo park', 'foster city', 'san carlos',
  'belmont', 'burlingame'
];
const NEARBY_CITIES_REGEX = new RegExp(`\\b(${NEARBY_BAY_AREA_CITIES.join('|')})\\b`, 'i');

function isSanJoseLocation(location = '') {
  const loc = String(location).trim().toLowerCase();
  if (!loc) return false;
  return loc.includes('san jose');
}

function isSanJoseOrNearbyLocation(location = '') {
  const loc = String(location).trim().toLowerCase();
  if (!loc) return false;
  return rankLocation(loc) >= 100;
}

function rankLocation(location = '') {
  const loc = String(location).trim().toLowerCase();
  if (!loc) return 0;

  // Highest priority: San Jose, CA
  if (loc.includes('san jose') && (loc.includes('ca') || loc.includes('california'))) return 1000;
  if (loc.includes('san jose')) return 500;

  // Next: Nearby South Bay / Bay Area, CA cities
  if (NEARBY_CITIES_REGEX.test(loc) && (/\bca\b/i.test(loc) || loc.includes('california'))) {
    return 200;
  }
  if (NEARBY_CITIES_REGEX.test(loc)) {
    return 100;
  }

  // California general
  if (/\bca\b/i.test(loc) || loc.includes('california')) return 50;

  return 10;
}

/**
 * Searches TennisRecord for a player's rating.
 * If multiple players match the name, selects the player from San Jose, CA.
 * If directProfileUrl is supplied, fetches directly from that profile page.
 * Returns an object { success, tennisRecord, rating, profileUrl, location, reason, details } or null.
 */
async function fetchTennisRecordRating(name, directProfileUrl = null) {
  if (!name || typeof name !== 'string') return null;

  // Clean name from digits, parentheticals, guest tags
  const cleanName = name
    .replace(/\([^)]*\)/g, '')
    .replace(/#\d+/g, '')
    .trim();

  if (!cleanName || /^player(?:\s+\d+)?$/i.test(cleanName) || /^(?:me|someone)$/i.test(cleanName)) {
    return {
      success: false,
      tennisRecord: false,
      rating: null,
      profileUrl: null,
      location: null,
      reason: 'not_found'
    };
  }

  const parts = cleanName.split(/\s+/);
  const firstName = parts[0] || '';
  const lastName = parts.slice(1).join(' ') || '';

  try {
    let targetProfileUrl = sanitizeUrl(directProfileUrl);
    let selectedLocation = null;

    // Search search.aspx if no direct profile URL was supplied
    if (!targetProfileUrl && firstName) {
      try {
        const params = new URLSearchParams();
        params.append('firstname', firstName);
        params.append('lastname', lastName);

        const searchRes = await fetchHttp('https://www.tennisrecord.com/adult/search.aspx', {
          method: 'POST',
          headers: {
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: params.toString()
        });

        if (searchRes.ok) {
          const searchHtml = await searchRes.text();
          const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
          let match;
          const candidates = [];
          const seenHrefs = new Set();

          while ((match = rowRegex.exec(searchHtml)) !== null) {
            const rowHtml = match[1];
            const linkMatch = rowHtml.match(/<a[^>]+href=["']([^"']*profile\.aspx[^"']*)["'][^>]*>(.*?)<\/a>/i);
            if (linkMatch) {
              const href = linkMatch[1];
              if (seenHrefs.has(href)) continue;
              seenHrefs.add(href);

              const pName = linkMatch[2].replace(/<[^>]+>/g, '').trim();
              const tdMatches = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((td) => td[1].replace(/<[^>]+>/g, '').trim());
              const location = tdMatches[1] || '';
              const ratingStr = tdMatches[3] || '';

              const cleanLower = cleanName.toLowerCase();
              const pLower = pName.toLowerCase();

              // Exact name match or contains both first & last
              const isNameMatch = pLower === cleanLower ||
                (lastName && pLower.includes(firstName.toLowerCase()) && pLower.includes(lastName.toLowerCase())) ||
                (!lastName && pLower.startsWith(cleanLower));

              if (isNameMatch) {
                candidates.push({
                  href,
                  pName,
                  location,
                  ratingStr,
                  rank: rankLocation(location)
                });
              }
            }
          }

          // Condition 1: Tennis record URL not found
          if (candidates.length === 0) {
            console.warn(`[tennisrecord] No matching players found on TennisRecord for "${cleanName}".`);
            return {
              success: false,
              tennisRecord: false,
              rating: null,
              profileUrl: null,
              location: null,
              reason: 'not_found'
            };
          }

          const sanJoseMatches = candidates.filter((c) => isSanJoseLocation(c.location));
          const nearbyMatches = candidates.filter((c) => isSanJoseOrNearbyLocation(c.location));

          // Condition 3: Multiple players with same name found in San Jose
          if (sanJoseMatches.length > 1) {
            console.warn(`[tennisrecord] Multiple players (${sanJoseMatches.length}) found in San Jose for "${cleanName}".`);
            return {
              success: false,
              tennisRecord: false,
              rating: null,
              profileUrl: null,
              location: 'San Jose, CA',
              reason: 'multiple_in_san_jose',
              details: {
                sanJoseCount: sanJoseMatches.length,
                candidates: sanJoseMatches
              }
            };
          }

          // Condition 2: Player with name not found within San Jose or nearby areas
          if (nearbyMatches.length === 0) {
            console.warn(`[tennisrecord] Player "${cleanName}" not found within San Jose or nearby areas. Candidates found: ${candidates.map((c) => c.location).join(', ')}`);
            return {
              success: false,
              tennisRecord: false,
              rating: null,
              profileUrl: null,
              location: null,
              reason: 'not_in_area',
              details: {
                locations: [...new Set(candidates.map((c) => c.location).filter(Boolean))]
              }
            };
          }

          // Pick single San Jose match or highest-ranked nearby Bay Area match
          let chosen = null;
          if (sanJoseMatches.length === 1) {
            chosen = sanJoseMatches[0];
          } else {
            nearbyMatches.sort((a, b) => {
              if (b.rank !== a.rank) return b.rank - a.rank;
              const aHasRating = a.ratingStr && a.ratingStr !== '----' ? 1 : 0;
              const bHasRating = b.ratingStr && b.ratingStr !== '----' ? 1 : 0;
              return bHasRating - aHasRating;
            });
            chosen = nearbyMatches[0];
          }

          if (chosen?.href) {
            const path = chosen.href.startsWith('/') ? chosen.href : `/${chosen.href}`;
            targetProfileUrl = sanitizeUrl(`https://www.tennisrecord.com${path}`);
            selectedLocation = chosen.location || null;
            console.log(`[tennisrecord] Selected profile for "${cleanName}": "${chosen.pName}" (${chosen.location || 'Unknown location'}) -> ${targetProfileUrl}`);
          }
        }
      } catch (searchErr) {
        console.warn(`[tennisrecord] Search error for "${cleanName}":`, searchErr.message);
      }
    }

    if (!targetProfileUrl) {
      return {
        success: false,
        tennisRecord: false,
        rating: null,
        profileUrl: null,
        location: null,
        reason: 'not_found'
      };
    }

    const res = await fetchHttp(targetProfileUrl, {
      headers: {
        'User-Agent': USER_AGENT
      }
    });

    if (!res.ok) {
      return {
        success: false,
        tennisRecord: false,
        rating: null,
        profileUrl: null,
        location: null,
        reason: 'not_found'
      };
    }

    const html = await res.text();
    if (html.includes('No Player Found') || (!html.includes('Player Profile') && !parseProfileRating(html))) {
      return {
        success: false,
        tennisRecord: false,
        rating: null,
        profileUrl: null,
        location: null,
        reason: 'not_found'
      };
    }

    const rating = parseProfileRating(html);
    const profileLoc = parseProfileLocation(html);

    return {
      success: true,
      tennisRecord: true,
      rating,
      profileUrl: targetProfileUrl,
      location: selectedLocation || profileLoc
    };
  } catch (err) {
    console.warn(`[tennisrecord] Lookup failed for "${cleanName}":`, err.message);
    return {
      success: false,
      tennisRecord: false,
      rating: null,
      profileUrl: null,
      location: null,
      reason: 'not_found',
      error: err.message
    };
  }
}

module.exports = {
  fetchTennisRecordRating,
  rankLocation,
  isSanJoseLocation,
  isSanJoseOrNearbyLocation,
  setCertCheckSuspended,
  getCertCheckSuspended,
  suspendCertCheck,
  resumeCertCheck
};
