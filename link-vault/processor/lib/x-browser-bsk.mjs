// Default driver for x-replies.mjs: bsk (browser-skill CLI) drives the user's real, already logged-in Chrome
// in a background Agent Window. No login of our own, no cookie is read or printed. Never imported by tests.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
// launchd/cron PATH often lacks ~/.local/bin (where the bsk installer puts the CLI): fall back to it explicitly
const bin = () => {
  if (process.env.LV_BSK_BIN) return process.env.LV_BSK_BIN;
  const local = path.join(os.homedir(), '.local', 'bin', 'bsk');
  const onPath = (process.env.PATH || '').split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, 'bsk')));
  return !onPath && fs.existsSync(local) ? local : 'bsk';
};

// -> { ok, reason }  (bsk installed, daemon up, at least one browser connected)
export function bskStatus() {
  try {
    const out = execFileSync(bin(), ['status', '--json'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
    const j = JSON.parse(out);
    if (!Array.isArray(j.browsers) || j.browsers.length === 0) return { ok: false, reason: 'bsk: no browser connected' };
    return { ok: true, reason: '' };
  } catch (e) {
    return { ok: false, reason: e.code === 'ENOENT' ? 'bsk not installed' : 'bsk daemon not reachable' };
  }
}
export const bskAvailable = () => bskStatus().ok;

const bsk = async (args, timeoutMs = 45000) => {
  const { stdout } = await run(bin(), args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
};
const json = async (args, t) => JSON.parse(await bsk([...args, '--json'], t));

// In-page extraction (X's current "xds" DOM has no data-testid and no <time>; the legacy testid DOM is also handled).
// Returns JSON { href, login:bool, posts:[{handle,name,sid,time,text,links:[{href,text,title}]}] } for top-level articles only.
const EXTRACT_JS = `(()=>{
const top=[...document.querySelectorAll('article')].filter(a=>!a.parentElement.closest('article'));
const own=(a,sel)=>[...a.querySelectorAll(sel)].filter(e=>e.closest('article')===a);
const posts=[];
for(const a of top){
  const hl=own(a,'a[href]').find(x=>/^\\/[A-Za-z0-9_]{1,15}$/.test(x.getAttribute('href'))&&(x.textContent||'').trim().startsWith('@'))||own(a,'a[href]').find(x=>/^\\/[A-Za-z0-9_]{1,15}$/.test(x.getAttribute('href')));
  if(!hl)continue;
  const handle=hl.getAttribute('href').slice(1);
  const nl=own(a,'a[href]').find(x=>x.getAttribute('href')===hl.getAttribute('href')&&!(x.textContent||'').trim().startsWith('@')&&(x.textContent||'').trim());
  const name=(nl&&nl.textContent.trim())||handle;
  const re=new RegExp('^/'+handle+'/status/(\\\\d+)$','i');
  const st=own(a,'a[href]').find(x=>re.test(x.getAttribute('href')));
  if(!st)continue;
  const sid=st.getAttribute('href').match(re)[1];
  let time='';
  const sc=st.parentElement&&st.parentElement.querySelector('script');
  const tm=sc&&sc.textContent.match(/"timestamp":(\\d+)/);
  if(tm)time=new Date(Number(tm[1])).toISOString();
  const tx=own(a,'[data-testid="tweetText"],[dir="auto"]').find(e=>e.tagName!=='A');
  const text=tx?tx.innerText.trim():'';
  const links=[];const seen=new Set();
  for(const l of own(a,'a[href^="http"]')){
    let h=l.getAttribute('href');let host='';try{host=new URL(h).hostname}catch{}
    if(/(^|\\.)(x|twitter)\\.com$/.test(host)||seen.has(h))continue;
    seen.add(h);links.push({href:h,text:(l.textContent||'').trim(),title:l.getAttribute('title')||''});
  }
  posts.push({handle,name,sid,time,text,links});
}
const login=!!document.querySelector('[data-testid="loginButton"],[data-testid="signupButton"]');
return JSON.stringify({href:location.href,login,posts});
})()`;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// extracted posts -> HTML in the shape parseArticle() reads (so the pure parser and its fixtures stay the single source)
export function postsToHtml({ login, posts }) {
  const parts = [];
  if (login) parts.push('<button data-testid="loginButton">Log in</button>');
  for (const p of posts) {
    const inline = p.links.map((l) => `<a href="${esc(l.href)}" title="${esc(l.title)}">${esc(l.text)}</a>`).join(' ');
    parts.push(`<article><a href="/${esc(p.handle)}/status/${esc(p.sid)}"><time datetime="${esc(p.time)}"></time></a>`
      + `<div data-testid="User-Name"><span>${esc(p.name)}</span><span>@${esc(p.handle)}</span></div>`
      + `<div data-testid="tweetText">${esc(p.text).replace(/\n/g, '<br>')}</div>${inline}</article>`);
  }
  return parts.join('\n');
}

export async function bskDriver() {
  const st = bskStatus();
  if (!st.ok) throw new Error(st.reason);
  return {
    async loadThread(url, { maxScrolls = 3, delay = async () => {} } = {}) {
      const s = await json(['session', 'start', '--name', 'link-vault x-replies', '--no-focus']);
      const sid = s.session_id;
      try {
        await bsk(['navigate', '--session', sid, '--wait-until', 'domcontentloaded', url]);
        const snap = async () => {
          const r = await json(['evaluate', '--session', sid, EXTRACT_JS]);
          const d = JSON.parse(String(r.value ?? '{"href":"","login":false,"posts":[]}'));
          return { href: d.href, html: postsToHtml(d), n: d.posts.length, login: d.login };
        };
        // wait for articles / login button (max ~15 s)
        let cur = await snap();
        for (let i = 0; i < 6 && !cur.n && !cur.login; i++) { await new Promise((r) => setTimeout(r, 2500)); cur = await snap(); }
        const snapshots = [cur.html];
        for (let i = 0; i < maxScrolls; i++) {
          await delay();
          await bsk(['evaluate', '--session', sid, 'window.scrollBy(0, 900)']);
          await delay();
          cur = await snap();
          snapshots.push(cur.html);
        }
        return { finalUrl: cur.href, snapshots };
      } finally {
        try { await bsk(['session', 'stop', sid], 15000); } catch {}
      }
    },
  };
}
