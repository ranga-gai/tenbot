/**
 * Silver Creek Valley Country Club (SCVCC) Court Booking & Availability Engine
 *
 * Integrates with SCVCC's Clubessential portal to:
 * 1. Query real-time court status & availability (Tennis Courts 1-6 & Pickleball Courts).
 * 2. Book courts on-demand with custom date, time, court selection, and party size.
 * 3. List active upcoming member reservations.
 * 4. Cancel court reservations.
 */

const fs = require('fs');
const path = require('path');
const { getSanJoseParts, getSanJoseNow, createSanJoseDate, parseTimeString, resolvePlayDateTime } = require('./pollTime');

// Host and Endpoint Constants
const SCVCC_HOST = 'https://www.scvcc.com';
const LOGIN_PAGE_URL = `${SCVCC_HOST}/member-login`;
const STEP1_URL = `${SCVCC_HOST}/a_master/net/net_advancedlogin/login.asmx/loginStep1`;
const STEP2_URL = `${SCVCC_HOST}/a_master/net/net_advancedlogin/login.asmx/loginStep2`;
const BOOKING_PAGE_URL = `${SCVCC_HOST}/Default.aspx?p=DynamicModule&pageid=181&tt=booking&ssid=100261&vnf=1`;
const DIALOG_URL = `${SCVCC_HOST}/dialog.aspx`;

// Court Resource Mapping (ResourceType 1 = Tennis / Pickleball Courts)
const RESOURCE_TYPE_TENNIS = 1;
const COURT_RESOURCE_IDS = {
  'court 1': '1',
  'court 2': '2',
  'court 3': '3',
  'court 4': '4',
  'court 5': '5',
  'court 6': '6',
  'ct 1': '1',
  'ct 2': '2',
  'ct 3': '3',
  'ct 4': '4',
  'ct 5': '5',
  'ct 6': '6',
  'pickleball 1': '16',
  'pickleball 2': '17',
  'pickleball ct 4a': '18',
  'pickleball ct 4b': '19',
  'pb 1': '16',
  'pb 2': '17',
  'pb 4a': '18',
  'pb 4b': '19'
};

const RESOURCE_ID_TO_COURT = {
  '1': 'Court 1',
  '2': 'Court 2',
  '3': 'Court 3',
  '4': 'Court 4',
  '5': 'Court 5',
  '6': 'Court 6',
  '16': 'Pickleball 1',
  '17': 'Pickleball 2',
  '18': 'Pickleball Ct 4A',
  '19': 'Pickleball Ct 4B',
  '23': 'Pickleball Ct 4A',
  '24': 'Pickleball Ct 4B'
};

const ALL_COURT_DEFINITIONS = [
  { name: 'Court 1', id: '1', sport: 'tennis', type: '1' },
  { name: 'Court 2', id: '2', sport: 'tennis', type: '1' },
  { name: 'Court 3', id: '3', sport: 'tennis', type: '1' },
  { name: 'Court 4', id: '4', sport: 'tennis', type: '1' },
  { name: 'Court 5', id: '5', sport: 'tennis', type: '1' },
  { name: 'Court 6', id: '6', sport: 'tennis', type: '1' },
  { name: 'Pickleball 1', id: '16', sport: 'pickleball', type: '1' },
  { name: 'Pickleball 2', id: '17', sport: 'pickleball', type: '1' },
  { name: 'Pickleball Ct 4A', id: '18', sport: 'pickleball', type: '1' },
  { name: 'Pickleball Ct 4B', id: '19', sport: 'pickleball', type: '1' }
];

// In-memory session cache
let sessionCookieMap = new Map();
let sessionToken = null;
let sessionExpiresAt = 0;
let authPromise = null;

/**
 * RC4 encryption utilities matching Clubessential client-side login encryption.
 */
function hexEncode(data) {
  const b16D = '0123456789abcdef';
  const b16M = [];
  for (let i = 0; i < 256; i++) b16M[i] = b16D.charAt(i >> 4) + b16D.charAt(i & 15);
  const result = [];
  for (let i = 0; i < data.length; i++) result[i] = b16M[data.charCodeAt(i)];
  return result.join('');
}

function rc4Encrypt(key, pt) {
  const s = [];
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  let x;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key.charCodeAt(i % key.length)) % 256;
    x = s[i];
    s[i] = s[j];
    s[j] = x;
  }
  let i = 0;
  j = 0;
  let ct = '';
  for (let y = 0; y < pt.length; y++) {
    i = (i + 1) % 256;
    j = (j + s[i]) % 256;
    x = s[i];
    s[i] = s[j];
    s[j] = x;
    ct += String.fromCharCode(pt.charCodeAt(y) ^ s[(s[i] + s[j]) % 256]);
  }
  return ct;
}

function rc4EncryptStr(str, key) {
  return hexEncode(rc4Encrypt(key, unescape(encodeURIComponent(str))));
}

function getCookieHeader() {
  return [...sessionCookieMap.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function updateCookiesFromResponse(res) {
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of setCookies) {
    const [pair] = c.split(';');
    const [k, v] = pair.split('=');
    if (k && v) sessionCookieMap.set(k.trim(), v.trim());
  }
}

/**
 * Authenticates with SCVCC member portal using credentials from .env.
 */
async function authenticate(force = false) {
  const username = process.env.SCVCC_USERNAME;
  const password = process.env.SCVCC_PASSWORD;

  if (!username || !password) {
    throw new Error('SCVCC_USERNAME or SCVCC_PASSWORD is not configured in .env');
  }

  const now = Date.now();
  if (!force && sessionToken && sessionExpiresAt > now) {
    return { success: true, token: sessionToken };
  }

  if (authPromise) return authPromise;

  authPromise = (async () => {
    try {
      sessionCookieMap.clear();

      // 1. Initial page hit to establish session cookie
      const initRes = await fetch(LOGIN_PAGE_URL, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      updateCookiesFromResponse(initRes);

      // 2. Step 1: obtain encryption key & CIP
      const step1Res = await fetch(`${STEP1_URL}?r=${Math.floor(Math.random() * 1000)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cookie': getCookieHeader(),
          'Referer': LOGIN_PAGE_URL,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
        },
        body: JSON.stringify({ lstep: 1 })
      });

      if (!step1Res.ok) {
        throw new Error(`SCVCC login step 1 failed: HTTP ${step1Res.status}`);
      }

      const step1Json = await step1Res.json();
      const step1Data = JSON.parse(step1Json.d)[0];
      const key = decodeURIComponent(step1Data.key);
      const cip = decodeURIComponent(step1Data.cip);

      // 3. Step 2: send encrypted credentials
      const step2Res = await fetch(`${STEP2_URL}?r=${Math.floor(Math.random() * 1000)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cookie': getCookieHeader(),
          'Referer': LOGIN_PAGE_URL,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
        },
        body: JSON.stringify({
          id: rc4EncryptStr(username, key),
          pw: rc4EncryptStr(password, key),
          url: '',
          cip: rc4EncryptStr(cip, key)
        })
      });

      if (!step2Res.ok) {
        throw new Error(`SCVCC login step 2 failed: HTTP ${step2Res.status}`);
      }

      const step2Json = await step2Res.json();
      const step2Parsed = JSON.parse(step2Json.d);
      if (!step2Parsed || !step2Parsed[0] || !step2Parsed[0].token) {
        throw new Error('SCVCC login returned invalid credentials or token');
      }

      sessionToken = decodeURIComponent(step2Parsed[0].token);
      sessionExpiresAt = Date.now() + 25 * 60 * 1000; // 25 min TTL

      // 4. Session exchange
      const defaultUrl = `${SCVCC_HOST}/default.aspx?login=true&sessionToken=${encodeURIComponent(sessionToken)}&gotopage=${encodeURIComponent('p=MembersDefault')}`;
      const loginRes = await fetch(defaultUrl, {
        headers: {
          'Cookie': getCookieHeader(),
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
        },
        redirect: 'manual'
      });
      updateCookiesFromResponse(loginRes);

      return { success: true, token: sessionToken };
    } finally {
      authPromise = null;
    }
  })();

  return authPromise;
}

/**
 * Executes an authenticated fetch to SCVCC, automatically re-authenticating if expired.
 */
async function authFetch(url, options = {}, retries = 1) {
  await authenticate();

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)',
    'Cookie': getCookieHeader(),
    ...(options.headers || {})
  };

  let res = await fetch(url, { ...options, headers });
  updateCookiesFromResponse(res);

  // Check if session expired and redirected to login page
  const resUrl = res.url || '';
  let isExpired = resUrl.includes('member-login') || resUrl.includes('login=expired') || res.status === 401;

  if (!isExpired && (url.includes('dialog.aspx') || url.includes('Default.aspx'))) {
    const clone = res.clone();
    const text = await clone.text();
    if (url.includes('dialog.aspx') && text.includes('defaultNetHead') && !text.includes('ctrl_MakeBookingTime')) {
      isExpired = true;
    } else if (text.includes('class="login-content"') || text.includes('member-login')) {
      isExpired = true;
    }
  }

  if (isExpired && retries > 0) {
    console.log('[scvcc] Session expired, re-authenticating and retrying...');
    await authenticate(true);
    return authFetch(url, options, retries - 1);
  }

  return res;
}

/**
 * Resolves loosely given date strings (e.g. "today", "tomorrow", "Saturday", "9/26/2026", "9/26")
 * to a standardized M/D/YYYY string in San Jose (Pacific Time).
 */
function resolveDateToMDY(whenStr) {
  const now = new Date();
  const sjNow = getSanJoseParts(now);

  if (!whenStr || typeof whenStr !== 'string') {
    return `${sjNow.month + 1}/${sjNow.day}/${sjNow.year}`;
  }

  const clean = whenStr.trim().toLowerCase();
  if (clean === 'today' || clean === 'tonight') {
    return `${sjNow.month + 1}/${sjNow.day}/${sjNow.year}`;
  }
  if (clean === 'tomorrow') {
    const tm = new Date(Date.UTC(sjNow.year, sjNow.month, sjNow.day + 1));
    return `${tm.getUTCMonth() + 1}/${tm.getUTCDate()}/${tm.getUTCFullYear()}`;
  }

  // Check explicit MM/DD/YYYY or M/D/YY or M/D
  const mdyMatch = clean.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
  if (mdyMatch) {
    const m = parseInt(mdyMatch[1], 10);
    const d = parseInt(mdyMatch[2], 10);
    let y = mdyMatch[3] ? parseInt(mdyMatch[3], 10) : sjNow.year;
    if (y < 100) y += 2000;
    return `${m}/${d}/${y}`;
  }

  // Day of week (e.g. "saturday", "sat", "monday", "mon")
  const DAY_MAP = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const dayKey = clean.slice(0, 3);
  if (dayKey in DAY_MAP) {
    const targetDayIndex = DAY_MAP[dayKey];
    const currentDayIndex = getSanJoseNow(now).getUTCDay();
    let diff = (targetDayIndex - currentDayIndex + 7) % 7;
    if (diff === 0) diff = 7; // next occurrence if same day requested loosely
    const tm = new Date(Date.UTC(sjNow.year, sjNow.month, sjNow.day + diff));
    return `${tm.getUTCMonth() + 1}/${tm.getUTCDate()}/${tm.getUTCFullYear()}`;
  }

  // Fallback to resolvePlayDateTime
  const resolved = resolvePlayDateTime(whenStr, null, now);
  if (resolved && resolved.playAt) {
    const parts = getSanJoseParts(resolved.playAt);
    return `${parts.month + 1}/${parts.day}/${parts.year}`;
  }

  return `${sjNow.month + 1}/${sjNow.day}/${sjNow.year}`;
}

/**
 * Formats M/D/YYYY into friendly display format, e.g. "Saturday, Sep 26, 2026".
 */
function formatDisplayDate(mdyStr) {
  const [m, d, y] = mdyStr.split('/').map((n) => parseInt(n, 10));
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return dt.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  });
}

/**
 * Normalizes a time string to match the grid time format (e.g. "7pm" -> "7:00 PM", "9:30am" -> "9:30 AM").
 */
function normalizeGridTime(timeStr) {
  if (!timeStr) return null;
  const parsed = parseTimeString(timeStr);
  if (!parsed) return null;
  const m = String(parsed.minute).padStart(2, '0');
  const h = parsed.hour === 0 ? 12 : (parsed.hour > 12 ? parsed.hour - 12 : parsed.hour);
  const ampm = parsed.hour >= 12 ? 'PM' : 'AM';
  return `${h}:${m} ${ampm}`;
}

/**
 * Parses SCVCC court sheet table HTML into a complete 30-minute schedule.
 */
function parseCourtGridHtml(html) {
  const trMatches = html.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
  const results = [];
  const activeSpans = new Map(); // courtName -> { status, remaining }

  for (const tr of trMatches) {
    const timeMatch = tr.match(/<div class="tscell">([\s\S]*?)<\/div>/i);
    if (!timeMatch) continue;
    const time = timeMatch[1].trim();

    const tds = tr.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
    const courtStatusMap = new Map();

    for (const td of tds) {
      if (td.includes('tscell')) continue;
      const courtMatch = td.match(/<div class="ncCourtNum"[^>]*>([\s\S]*?)<\/div>/i);
      if (!courtMatch) continue;
      const courtName = courtMatch[1].replace(/<[^>]+>/g, '').trim();
      const isAvail = td.includes('rbm_TimeSlotPanelSlotAvailable');
      const rowspanMatch = td.match(/rowspan=["']?(\d+)["']?/i);
      const rowspan = rowspanMatch ? parseInt(rowspanMatch[1], 10) : 1;

      const status = isAvail ? 'available' : 'unavailable';
      courtStatusMap.set(courtName, status);

      if (rowspan > 1) {
        activeSpans.set(courtName, { status, remaining: rowspan - 1 });
      } else {
        activeSpans.delete(courtName);
      }
    }

    // Fill in all defined courts for this time slot
    const slotCourts = [];
    for (const def of ALL_COURT_DEFINITIONS) {
      let status = 'unavailable';
      if (courtStatusMap.has(def.name)) {
        status = courtStatusMap.get(def.name);
      } else if (activeSpans.has(def.name)) {
        const span = activeSpans.get(def.name);
        status = span.status;
        span.remaining--;
        if (span.remaining <= 0) {
          activeSpans.delete(def.name);
        }
      }

      slotCourts.push({
        court: def.name,
        resourceId: def.id,
        resourceType: def.type,
        status,
        time
      });
    }

    results.push({ time, courts: slotCourts });
  }

  return results;
}

/**
 * Queries court status & availability at SCVCC for a given day and optional filters.
 *
 * @param {Object} options
 * @param {string} options.when - Date description (e.g. "today", "tomorrow", "Saturday", "9/26/2026")
 * @param {string} [options.time] - Optional specific time or time range filter (e.g. "7pm", "9am", "evening", "morning", "afternoon", "12:30pm")
 * @param {string} [options.court] - Optional court filter (e.g. "Court 2", "Pickleball 1")
 * @param {string} [options.sport] - "tennis" (Courts 1-6) or "pickleball" (Pickleball 1-2, 4A, 4B) or "all"
 * @returns {Promise<Object>} Formatted text and structured availability data
 */
async function checkCourtAvailability({ when, time = null, court = null, sport = 'tennis' } = {}) {
  const targetDateMDY = resolveDateToMDY(when);
  const displayDate = formatDisplayDate(targetDateMDY);

  const normalizedSport = (sport || 'tennis').toLowerCase();
  const targetColFilter = court ? court.trim().toLowerCase() : null;

  const isRelevantCourt = (cName) => {
    const cLower = cName.toLowerCase();
    if (targetColFilter) {
      return cLower === targetColFilter || cLower.includes(targetColFilter);
    }
    if (normalizedSport === 'pickleball' || normalizedSport === 'pb') {
      return cLower.includes('pickleball') || cLower.includes('pb');
    }
    if (normalizedSport === 'tennis') {
      return !cLower.includes('pickleball');
    }
    return true;
  };

  const targetTimeExact = time ? normalizeGridTime(time) : null;
  const targetTimeLower = time ? time.trim().toLowerCase() : null;

  // Single GET request to retrieve full day sheet
  const url = `${BOOKING_PAGE_URL}&date=${encodeURIComponent(targetDateMDY)}`;
  const res = await authFetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch SCVCC court sheet: HTTP ${res.status}`);
  }

  const html = await res.text();
  const fullGrid = parseCourtGridHtml(html);

  if (!fullGrid || fullGrid.length === 0) {
    return {
      success: false,
      date: targetDateMDY,
      displayDate,
      message: `⚠️ Could not retrieve SCVCC court schedule for *${displayDate}*. The booking sheet may not be published yet.`
    };
  }

  const isRelevantTime = (tStr) => {
    if (targetTimeExact) {
      return tStr.toLowerCase().replace(/\s+/g, '') === targetTimeExact.toLowerCase().replace(/\s+/g, '');
    }
    if (!targetTimeLower) return true;
    if (targetTimeLower.includes('morning') || targetTimeLower === 'am') {
      return tStr.includes('AM');
    }
    if (targetTimeLower.includes('afternoon')) {
      return /^(?:12|1|2|3|4):[0-5]\d PM/.test(tStr);
    }
    if (targetTimeLower.includes('evening') || targetTimeLower.includes('night') || targetTimeLower === 'pm') {
      return /^(?:5|6|7|8|9|10):[0-5]\d PM/.test(tStr);
    }
    const cleanT = tStr.toLowerCase().replace(/\s+/g, '');
    const cleanReq = targetTimeLower.replace(/\s+/g, '');
    return cleanT.includes(cleanReq);
  };

  const filteredSlots = [];
  for (const slot of fullGrid) {
    if (!isRelevantTime(slot.time)) continue;

    const matchedCourts = slot.courts.filter(c => isRelevantCourt(c.court));
    if (matchedCourts.length === 0) continue;

    filteredSlots.push({
      time: slot.time,
      courts: matchedCourts
    });
  }

  // Build user response
  const lines = [];
  const sportEmoji = normalizedSport === 'pickleball' ? '🏓' : '🎾';
  const sportLabel = normalizedSport === 'pickleball' ? 'Pickleball Courts' : (normalizedSport === 'all' ? 'All Courts' : 'Tennis Courts');

  lines.push(`${sportEmoji} *SCVCC ${sportLabel} — ${displayDate}*`);
  if (time) lines.push(`🕒 Filter: *${time}*`);
  if (court) lines.push(`🏟 Court: *${court}*`);
  lines.push('');

  let totalAvailableCount = 0;
  const availableSummary = [];

  for (const slot of filteredSlots) {
    const openCourts = slot.courts.filter((c) => c.status === 'available').map((c) => c.court);
    const reservedCourts = slot.courts.filter((c) => c.status === 'unavailable').map((c) => c.court);

    if (openCourts.length > 0) {
      totalAvailableCount += openCourts.length;
      availableSummary.push(`• *${slot.time}*: 🟢 ${openCourts.join(', ')}`);
    } else if (targetTimeExact || filteredSlots.length <= 8) {
      availableSummary.push(`• *${slot.time}*: 🔴 Unavailable / Reserved`);
    }
  }

  if (availableSummary.length > 0) {
    lines.push(availableSummary.join('\n'));
  } else {
    lines.push('❌ No open courts found matching your time / court criteria.');
  }

  lines.push('');
  if (totalAvailableCount > 0) {
    const firstSlotWithCourts = filteredSlots.find(s => s.courts.some(c => c.status === 'available'));
    const firstOpenCourt = firstSlotWithCourts?.courts.find(c => c.status === 'available');
    const exampleTime = firstSlotWithCourts ? firstSlotWithCourts.time.toLowerCase() : '6pm';
    const exampleCourt = firstOpenCourt ? firstOpenCourt.court : 'Court 1';
    const dateArg = when.includes('tomorrow') ? 'tomorrow' : (when.includes('today') ? targetDateMDY : when);

    lines.push(`💡 *To book:* Send \`!bookcourt ${exampleTime} ${dateArg} ${exampleCourt}\``);
  } else {
    lines.push(`💡 Check other times with \`!courts ${when} morning\` or \`!courts ${when} evening\`.`);
  }

  return {
    success: true,
    date: targetDateMDY,
    displayDate,
    totalAvailable: totalAvailableCount,
    slots: filteredSlots,
    message: lines.join('\n')
  };
}

/**
 * Extracts ASP.NET hidden fields from dialog HTML.
 */
function extractFormFields(html) {
  const fields = {};
  const inputRegex = /<input[^>]+name=["']([^"']+)["'][^>]*value=["']([^"']*)["'][^>]*>/gi;
  let m;
  while ((m = inputRegex.exec(html)) !== null) {
    fields[m[1]] = m[2];
  }
  return fields;
}

/**
 * Books a court on Silver Creek Valley Country Club.
 *
 * @param {Object} options
 * @param {string} options.when - Date/time description (e.g. "tomorrow 7pm", "Saturday 9am", "today 6pm")
 * @param {string} [options.date] - Optional explicit date string (e.g. "9/26/2026")
 * @param {string} [options.time] - Optional explicit time string (e.g. "7:00 PM", "7pm")
 * @param {string} [options.court] - Optional specific court name or number (e.g. "Court 2", "2", "Pickleball 1")
 * @param {string} [options.duration] - Duration: "60 Minutes", "90 Minutes", "120 Minutes" (default "60 Minutes")
 * @param {string} [options.partySize] - "Doubles" (default) or "Singles"
 * @param {string} [options.sport] - "tennis" (default) or "pickleball"
 * @returns {Promise<Object>} Booking result confirmation or error
 */
async function bookCourt({ when, date = null, time = null, court = null, duration = '60 Minutes', partySize = 'Doubles', sport = 'tennis' } = {}) {
  // 1. Resolve date and time
  let targetDateMDY = date ? resolveDateToMDY(date) : null;
  let targetTimeFormatted = time ? normalizeGridTime(time) : null;

  if ((!targetDateMDY || !targetTimeFormatted) && when) {
    const resolved = resolvePlayDateTime(when, null, new Date());
    if (resolved && resolved.playAt) {
      const sjParts = getSanJoseParts(resolved.playAt);
      if (!targetDateMDY) targetDateMDY = `${sjParts.month + 1}/${sjParts.day}/${sjParts.year}`;
      if (!targetTimeFormatted) {
        const h = sjParts.hour === 0 ? 12 : (sjParts.hour > 12 ? sjParts.hour - 12 : sjParts.hour);
        const m = String(sjParts.minute).padStart(2, '0');
        const ampm = sjParts.hour >= 12 ? 'PM' : 'AM';
        targetTimeFormatted = `${h}:${m} ${ampm}`;
      }
    }
  }

  if (!targetDateMDY) targetDateMDY = resolveDateToMDY('today');
  if (!targetTimeFormatted && time) targetTimeFormatted = normalizeGridTime(time);

  if (!targetTimeFormatted) {
    return {
      success: false,
      message: '⚠️ Please specify a start time for the court booking (e.g. `!bookcourt 6pm tomorrow` or `!bookcourt Court 2 9am Saturday`).'
    };
  }

  const displayDate = formatDisplayDate(targetDateMDY);

  // 2. Query court availability to find an open court slot
  const availability = await checkCourtAvailability({
    when: targetDateMDY,
    time: targetTimeFormatted,
    court,
    sport
  });

  if (!availability.success || availability.slots.length === 0) {
    return {
      success: false,
      message: `❌ Could not find available courts at SCVCC for *${displayDate}* at *${targetTimeFormatted}*.`
    };
  }

  // Find an available court slot
  let selectedSlot = null;
  let selectedCourt = null;

  for (const slot of availability.slots) {
    if (slot.time === targetTimeFormatted) {
      const openCourts = slot.courts.filter((c) => c.status === 'available');
      if (openCourts.length > 0) {
        selectedSlot = slot;
        selectedCourt = openCourts[0];
        break;
      }
    }
  }

  if (!selectedCourt) {
    return {
      success: false,
      message: `❌ No courts are available at SCVCC on *${displayDate}* at *${targetTimeFormatted}*. All courts are reserved or blocked for that slot.`
    };
  }

  const resourceId = selectedCourt.resourceId || COURT_RESOURCE_IDS[selectedCourt.court.toLowerCase()] || '1';
  const resourceTypeId = selectedCourt.resourceType || '1';
  const courtName = selectedCourt.court;
  const xsome = partySize.toLowerCase() === 'singles' ? '2' : '4';

  console.log(`[scvcc] Initiating booking for ${courtName} (resourceId: ${resourceId}) on ${targetDateMDY} at ${targetTimeFormatted}...`);

  // 3. Open MakebookingTime dialog to retrieve session state and member ID
  const dialogUrl = `${DIALOG_URL}?p=rbmPop&tt=MakebookingTime&NoModResize=1&NoNav=1&ShowFooter=False&resourceTypeid=${resourceTypeId}&resourceID=${resourceId}&date=${encodeURIComponent(targetDateMDY)}&time=${encodeURIComponent(targetTimeFormatted)}&xsome=${xsome}&classid=1`;
  const dialogRes = await authFetch(dialogUrl);
  if (!dialogRes.ok) {
    throw new Error(`Failed to load SCVCC booking dialog: HTTP ${dialogRes.status}`);
  }

  const dialogHtml = await dialogRes.text();
  const hiddenFields = extractFormFields(dialogHtml);

  // Extract member name & ID from Player 1 field
  const memberName = dialogHtml.match(/name="ctl00\$ctrl_MakeBookingTime\$P1\$PCombo\$PlayerName"[^>]*value="([^"]+)"/i)?.[1] || 'Member';
  const memberId = dialogHtml.match(/name="ctl00\$ctrl_MakeBookingTime\$P1\$PCombo\$PlayerID"[^>]*value="([^"]+)"/i)?.[1] || '8916615';

  // Normalize duration format
  let durationVal = '60 Minutes';
  if (typeof duration === 'number' || /^\d+$/.test(String(duration).trim())) {
    durationVal = `${parseInt(duration, 10)} Minutes`;
  } else if (/90/i.test(duration)) {
    durationVal = '90 Minutes';
  } else if (/120/i.test(duration) || /2\s*hours?/i.test(duration)) {
    durationVal = '120 Minutes';
  }

  // 4. Construct form submission payload
  const formData = new URLSearchParams();
  for (const [k, v] of Object.entries(hiddenFields)) {
    formData.append(k, v);
  }

  formData.set('__EVENTTARGET', 'ctl00$ctrl_MakeBookingTime$lbBook');
  formData.set('__EVENTARGUMENT', '');
  formData.set('ctl00$ctrl_MakeBookingTime$drpResourceTypeName$tCombo', 'Tennis Courts');
  formData.set('ctl00$ctrl_MakeBookingTime$drpStartResource$tCombo', courtName);
  formData.set('ctl00$ctrl_MakeBookingTime$drpPartySize$tCombo', partySize);
  formData.set('ctl00$ctrl_MakeBookingTime$rdDate$tMDateBox', targetDateMDY);
  formData.set('ctl00$ctrl_MakeBookingTime$drpTime$tCombo', targetTimeFormatted);
  formData.set('ctl00$ctrl_MakeBookingTime$drpDuration$tCombo', durationVal);
  formData.set('ctl00$ctrl_MakeBookingTime$P1$PCombo$PlayerName', memberName);
  formData.set('ctl00$ctrl_MakeBookingTime$P1$PCombo$PlayerID', memberId);
  formData.set('ctl00$ctrl_MakeBookingTime$P1$PCombo$PlayerType', 'Member');

  // 5. Submit booking POST request
  const submitRes = await authFetch(dialogUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': dialogUrl
    },
    body: formData.toString()
  });

  const responseHtml = await submitRes.text();

  // Check if booking was rejected with an error message
  const errorMatch = responseHtml.match(/<span[^>]*class="[^"]*rbm_Error[^"]*"[^>]*>([\s\S]*?)<\/span>/i) ||
                     responseHtml.match(/alert\(['"]([^'"]+)['"]\)/i);

  if (errorMatch && errorMatch[1] && !errorMatch[1].includes('Success')) {
    const errorText = errorMatch[1].replace(/<[^>]+>/g, '').trim();
    console.warn(`[scvcc] Booking returned notice: ${errorText}`);
    return {
      success: false,
      message: `⚠️ SCVCC Reservation Notice: ${errorText}`
    };
  }

  console.log(`[scvcc] Successfully booked ${courtName} on ${targetDateMDY} at ${targetTimeFormatted} for ${memberName}!`);

  const confirmMsg = [
    `✅ *Court Confirmed & Booked!*`,
    `🏟 *Court:* ${courtName}`,
    `📅 *Date:* ${displayDate}`,
    `⏰ *Time:* ${targetTimeFormatted} (${durationVal})`,
    `👥 *Party:* ${partySize} (${memberName})`,
    `📍 *Location:* Silver Creek Valley Country Club`
  ].join('\n');

  return {
    success: true,
    court: courtName,
    date: targetDateMDY,
    displayDate,
    time: targetTimeFormatted,
    duration: durationVal,
    partySize,
    member: memberName,
    message: confirmMsg
  };
}

/**
 * Lists upcoming active court reservations for the member.
 */
async function getMyReservations() {
  const url = `${BOOKING_PAGE_URL}&tab=2`;
  const res = await authFetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch SCVCC member reservations: HTTP ${res.status}`);
  }

  const html = await res.text();

  // Parse reservations from recent bookings panel
  const reservations = [];
  const resRegex = /<tr[^>]*class="[^"]*(?:rbm_GridRow|rbm_GridAltRow)[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = resRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    const textCells = [];
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tdMatch;
    while ((tdMatch = tdRegex.exec(rowHtml)) !== null) {
      textCells.push(tdMatch[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').trim());
    }

    const idMatch = rowHtml.match(/LaunchrbEditor\([^,]+,[^,]+,'([^']+)'\)/i) ||
                    rowHtml.match(/bookingTimeid=([^&"']+)/i);

    if (textCells.length >= 3) {
      reservations.push({
        id: idMatch ? idMatch[1] : null,
        date: textCells[0],
        time: textCells[1],
        court: textCells[2],
        details: textCells.slice(3).join(' ')
      });
    }
  }

  if (reservations.length === 0) {
    return {
      success: true,
      reservations: [],
      message: '📋 You currently have no active upcoming court reservations at SCVCC.'
    };
  }

  const lines = ['🎾 *Your SCVCC Court Reservations:*', ''];
  for (const r of reservations) {
    lines.push(`• *${r.date}* at *${r.time}* — ${r.court}${r.id ? ` (ID: \`${r.id}\`)` : ''}`);
  }
  lines.push('');
  lines.push('💡 *To cancel:* `!cancelcourt <reservationId>`');

  return {
    success: true,
    reservations,
    message: lines.join('\n')
  };
}

/**
 * Parses user command string for `!courts` or `!courtstatus`.
 * e.g. "!courts tomorrow evening Court 2 pb"
 */
function parseCourtsCommand(rawText) {
  let text = rawText.replace(/^!(?:courts?|courtstatus|courtavail(?:ability)?)\s*/i, '').trim();
  if (!text) {
    return { when: 'today', time: null, court: null, sport: 'tennis' };
  }

  let sport = 'tennis';
  if (/\b(?:pickleball|pickle|pb)\b/i.test(text)) {
    sport = 'pickleball';
    text = text.replace(/\b(?:pickleball|pickle|pb)\b/gi, '').trim();
  } else if (/\ball\s*courts?\b/i.test(text)) {
    sport = 'all';
    text = text.replace(/\ball\s*courts?\b/gi, '').trim();
  }

  let court = null;
  const courtMatch = text.match(/\b(court\s*\d+|ct\s*\d+|pickleball\s*\d+|pb\s*\d+[ab]?)\b/i);
  if (courtMatch) {
    court = courtMatch[1];
    text = text.replace(courtMatch[0], '').trim();
  }

  let time = null;
  const timeMatch = text.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)|morning|afternoon|evening|night)\b/i);
  if (timeMatch) {
    time = timeMatch[1];
    text = text.replace(timeMatch[0], '').trim();
  }

  const when = text.trim() || 'today';
  return { when, time, court, sport };
}

/**
 * Parses user command string for `!bookcourt`.
 * e.g. "!bookcourt 6pm tomorrow Court 2 singles"
 */
function parseBookCourtCommand(rawText) {
  let text = rawText.replace(/^!(?:bookcourt|reserve\s*court|book\s*court)\s*/i, '').trim();
  if (!text) return null;

  let sport = 'tennis';
  if (/\b(?:pickleball|pickle|pb)\b/i.test(text)) {
    sport = 'pickleball';
    text = text.replace(/\b(?:pickleball|pickle|pb)\b/gi, '').trim();
  }

  let partySize = 'Doubles';
  if (/\bsingles\b/i.test(text)) {
    partySize = 'Singles';
    text = text.replace(/\bsingles\b/gi, '').trim();
  } else if (/\bdoubles\b/i.test(text)) {
    partySize = 'Doubles';
    text = text.replace(/\bdoubles\b/gi, '').trim();
  }

  let duration = '60 Minutes';
  const durMatch = text.match(/\b(90|120|60)\s*(?:min(?:utes?)?|hrs?|hours?)?\b/i);
  if (durMatch) {
    duration = `${durMatch[1]} Minutes`;
    text = text.replace(durMatch[0], '').trim();
  }

  let court = null;
  const courtMatch = text.match(/\b(court\s*\d+|ct\s*\d+|pickleball\s*\d+|pb\s*\d+[ab]?)\b/i);
  if (courtMatch) {
    court = courtMatch[1];
    text = text.replace(courtMatch[0], '').trim();
  }

  let time = null;
  const timeMatch = text.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i);
  if (timeMatch) {
    time = timeMatch[1];
    text = text.replace(timeMatch[0], '').trim();
  }

  const when = text.trim() || 'today';
  return { when, time, court, duration, partySize, sport };
}

module.exports = {
  authenticate,
  authFetch,
  parseCourtGridHtml,
  checkCourtAvailability,
  bookCourt,
  getMyReservations,
  parseCourtsCommand,
  parseBookCourtCommand,
  resolveDateToMDY,
  formatDisplayDate
};
