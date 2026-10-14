// Fetches readable content for a saved link. Never throws: on failure returns what it could.

const UA = 'Mozilla/5.0 (compatible; LinkVault/1.0; +personal link archive)';
const MAX_BYTES = 3_000_000;
const MAX_TEXT = 12_000;

async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { redirect: 'follow', ...opts, signal: ctrl.signal, headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.8', ...(opts.headers || {}) } });
  } finally {
    clearTimeout(timer);
  }
}

const X_STATUS = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:([A-Za-z0-9_]{1,15})|i(?:\/web)?)\/status(?:es)?\/(\d+)/i;

// X/Twitter pages need JS, so use the public FxTwitter API to get the post text.
async function fetchXPost(url) {
  const m = url.match(X_STATUS);
  if (!m) return null;
  const user = m[1] && m[1].toLowerCase() !== 'i' ? m[1] : 'i';
  const r = await fetchWithTimeout(`https://api.fxtwitter.com/${user}/status/${m[2]}`, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`fxtwitter ${r.status}`);
  const j = await r.json();
  const t = j.tweet;
  if (!t) throw new Error('fxtwitter: no tweet');
  const parts = [t.text || t.raw_text?.text || ''];
  if (t.article) parts.push(`[記事] ${t.article.title || ''}\n${t.article.preview_text || ''}`);
  if (t.quote) parts.push(`[引用元 @${t.quote.author?.screen_name || ''}] ${t.quote.text || ''}`);
  const media = t.media?.all || [];
  media.forEach((x) => { if (x.altText) parts.push(`[画像説明] ${x.altText}`); });
  if (t.media?.external?.url) parts.push(`[外部メディア] ${t.media.external.url}`);
  return {
    source_type: 'x',
    title: `${t.author?.name || ''} (@${t.author?.screen_name || user}) のポスト`,
    author: t.author?.screen_name ? `@${t.author.screen_name}` : null,
    published_at: t.created_at ? new Date(t.created_at).toISOString() : null,
    description: null,
    text: parts.filter(Boolean).join('\n\n').slice(0, MAX_TEXT),
  };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(n); } catch { return m; }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// Attribute value in either quote style; an apostrophe inside "..." is part of the value.
const VALUE = `(?:"([^"]*)"|'([^']*)')`;

function meta(html, key) {
  const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*?content=${VALUE}`, 'i');
  const re2 = new RegExp(`<meta[^>]+?content=${VALUE}[^>]*(?:property|name)=["']${key}["']`, 'i');
  const m = html.match(re1) || html.match(re2);
  return m ? decodeEntities(m[1] ?? m[2]).trim() : null;
}

export function extractFromHtml(html) {
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = meta(html, 'og:title') || (titleTag ? decodeEntities(titleTag[1]).replace(/\s+/g, ' ').trim() : null);
  const description = meta(html, 'og:description') || meta(html, 'description');
  const author = meta(html, 'author') || meta(html, 'article:author') || meta(html, 'twitter:creator');
  const published = meta(html, 'article:published_time');
  const body = (html.match(/<(article|main)[\s\S]*?<\/\1>/i) || [html])[0];
  const text = decodeEntities(
    body
      .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/h\d)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/[ \t\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  return { title, description, author, published_at: published, text: text.slice(0, MAX_TEXT) };
}

function charsetOf(contentType, headBytes) {
  const m = (contentType || '').match(/charset="?([\w-]+)/i);
  if (m) return m[1];
  const head = new TextDecoder('latin1').decode(headBytes.subarray(0, 4096));
  const m2 = head.match(/<meta[^>]+charset=["']?([\w-]+)/i);
  return m2 ? m2[1] : 'utf-8';
}

async function fetchGeneric(url) {
  const r = await fetchWithTimeout(url, { headers: { Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const type = r.headers.get('content-type') || '';
  if (!/html|text\/plain|xml/i.test(type)) {
    return { source_type: 'file', title: null, description: `content-type: ${type}`, author: null, published_at: null, text: '', final_url: r.url };
  }
  const buf = new Uint8Array(await r.arrayBuffer()).subarray(0, MAX_BYTES);
  let html;
  try { html = new TextDecoder(charsetOf(type, buf)).decode(buf); } catch { html = new TextDecoder().decode(buf); }
  if (/text\/plain/i.test(type)) return { source_type: 'web', title: null, description: null, author: null, published_at: null, text: html.slice(0, MAX_TEXT), final_url: r.url };
  return { source_type: 'web', ...extractFromHtml(html), final_url: r.url };
}

export async function fetchContent(url) {
  if (!url) return { ok: false, source_type: 'memo', error: 'no url' };
  if (X_STATUS.test(url)) {
    try { return { ok: true, ...(await fetchXPost(url)) }; } catch (e) {
      // fall through to the generic fetch (usually only gets the og: tags)
      const g = await fetchGeneric(url).catch(() => null);
      if (g) return { ok: true, ...g, source_type: 'x' };
      return { ok: false, source_type: 'x', error: String(e.message || e) };
    }
  }
  try { return { ok: true, ...(await fetchGeneric(url)) }; } catch (e) {
    return { ok: false, source_type: 'web', error: String(e.message || e) };
  }
}
