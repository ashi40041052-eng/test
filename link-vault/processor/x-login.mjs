// One-time X login for the replies reader. Run: npm run x-login
// Opens a visible Chromium with the persistent profile; you log in yourself. No credentials/cookie values are read or printed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const profile = process.env.LV_X_PROFILE || path.join(os.homedir(), '.link-vault', 'x-profile');
fs.mkdirSync(profile, { recursive: true });

console.log('X のログイン画面を開きます。自分のアカウントでログインしてください。');
console.log('ログインが終わったらこのウィンドウを閉じてください。');
const ctx = await chromium.launchPersistentContext(profile, { headless: false, viewport: null });
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto('https://x.com/login').catch(() => {});
await new Promise((resolve) => ctx.on('close', resolve));

// verify: reopen headless WITHOUT visiting any page and look only at the cookie name
const check = await chromium.launchPersistentContext(profile, { headless: true });
const ok = (await check.cookies('https://x.com')).some((c) => c.name === 'auth_token');
await check.close();
if (ok) {
  try { fs.unlinkSync(process.env.LV_XREPLIES_LOGIN_FILE || path.join(HERE, 'logs', 'x-login-required.json')); } catch {}
  console.log('✓ ログインを確認しました。以降、他人のリプライを自動で読み取ります。');
} else {
  console.log('✗ ログインが確認できませんでした。もう一度 `npm run x-login` を実行してください。');
  process.exitCode = 1;
}
