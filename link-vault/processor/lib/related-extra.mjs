/*
 * Related capture, supplement (DESIGN-v3.md addendum "v3.1"):
 *   A) author profile website fallback: fxtwitter /<handle> -> user.website / bio facets (+ link hubs)
 * Everything here is best effort: callers wrap it; a failure never blocks archiving or analysis.
 * Env: LV_HUB_HOSTS (extra hub hosts, tests).
 */
import { fxBase, fetchWithTimeout } from './fetch-content.mjs';
import { classifyUrl } from './related.mjs';

// ---------- A) profile website ----------

const HUB_RE = /(^|\.)(linktr\.ee|lit\.link|bento\.me|beacons\.ai|linkin\.bio|carrd\.co|campsite\.bio|taplink\.cc|potion\.so|lnk\.bio)$/i;
const JUNK_HOST = /(^|\.)(x\.com|twitter\.com|t\.co|instagram\.com|facebook\.com|tiktok\.com|linkedin\.com|discord\.gg|discord\.com|threads\.net|youtube\.com|youtu\.be|twitch\.tv|patreon\.com|ko-fi\.com|apple\.com|play\.google\.com|google\.com|googleapis\.com|gstatic\.com|w3\.org|schema\.org|sjv\.io|pxf\.io|linksynergy\.com|awin1\.com|shareasale\.com|doubleclick\.net|datagrail\.io|cookiebot\.com|onetrust\.com|linktr\.ee|lit\.link|bento\.me|beacons\.ai)$/i;
// LV_HUB_HOSTS (tests): comma list of "host[:port]/path-prefix" treated as link hubs.
const hubPrefixes = () => (process.env.LV_HUB_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
export const isHubUrl = (url) => {
  try {
    const u = new URL(url);
    return HUB_RE.test(u.hostname) || hubPrefixes().some((p) => `${u.host}${u.pathname}`.toLowerCase().startsWith(p));
  } catch { return false; }
};
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const alnum = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Hostname label that most resembles the account (official domain preferred): mirelo.ai for @MireloAI.
function officialScore(url, user) {
  const h = hostOf(url).split('.').slice(0, -1).join('');
  if (!h) return 0;
  const tokens = [alnum(user.screen_name).replace(/(ai|hq|official|app|labs?)$/, ''), alnum(user.name)].filter((t) => t.length >= 3);
  return tokens.some((t) => h.includes(t) || t.includes(h)) ? 1 : 0;
}

// Pure. html of a link hub -> outbound candidate URLs, official domain first (max 3).
export function extractHubLinks(html, user = {}) {
  const urls = [];
  for (const m of String(html).matchAll(/href=["'](https?:\/\/[^"'\s>]+)["']/gi)) {
    const u = m[1].replace(/&amp;/g, '&');
    if (JUNK_HOST.test(hostOf(u)) || isHubUrl(u) || !classifyUrl(u)) continue;
    if (!urls.some((x) => hostOf(x) === hostOf(u))) urls.push(u); // one link per site: the first (top of the hub) wins
  }
  const ranked = urls.map((u, i) => ({ u, i, o: officialScore(u, user) })).sort((a, b) => b.o - a.o || a.i - b.i);
  const official = ranked.filter((x) => x.o);
  return (official.length ? official : ranked).slice(0, 3).map((x) => x.u);
}

// Pure. fxtwitter user object -> candidate website URLs (website + bio facets), not yet hub-expanded.
export function profileUrls(user) {
  const out = [];
  const add = (u) => { if (u && /^https?:\/\//i.test(u) && !out.includes(u)) out.push(u); };
  add(user?.website?.url);
  for (const f of user?.raw_description?.facets || []) if (f.type === 'url') add(f.replacement || f.original);
  return out;
}

/*
 * Returns { status: 'ok'|'none'|'error', urls: [...] }. Never throws.
 * 'error' = network trouble (retry later); 'none' = the profile answered but has no usable site.
 */
export async function fetchProfileSites(handle, log = () => {}) {
  const h = String(handle).replace(/^@/, '');
  try {
    const r = await fetchWithTimeout(`${fxBase()}/${h}`, { headers: { Accept: 'application/json' } });
    if (r.status >= 500) return { status: 'error', urls: [] };
    if (!r.ok) return { status: 'none', urls: [] };
    const user = (await r.json()).user;
    if (!user) return { status: 'none', urls: [] };
    const out = [];
    for (const u of profileUrls(user)) {
      if (isHubUrl(u)) {
        try {
          const hr = await fetchWithTimeout(u, { headers: { 'User-Agent': 'Mozilla/5.0 (link-vault)', Accept: 'text/html' } });
          if (hr.ok) for (const l of extractHubLinks(await hr.text(), user)) if (!out.includes(l)) out.push(l);
        } catch (e) { log(`profile hub ${u}: ${e.message}`); }
      } else if (classifyUrl(u) && !JUNK_HOST.test(hostOf(u)) && !out.some((x) => hostOf(x) === hostOf(u))) out.push(u); // one link per site
    }
    return { status: out.length ? 'ok' : 'none', urls: out.slice(0, 3) };
  } catch (e) {
    log(`profile ${h}: ${e.message}`);
    return { status: 'error', urls: [] };
  }
}
