// Real browser driver for x-replies.mjs (playwright, persistent profile). Never imported by tests.
export async function playwrightDriver(profile) {
  const { chromium } = await import('playwright');
  return {
    async loadThread(url, { maxScrolls = 3, delay = async () => {} } = {}) {
      const ctx = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1000, height: 1400 } });
      try {
        const page = ctx.pages()[0] || await ctx.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForSelector('article, [data-testid="loginButton"]', { timeout: 15000 }).catch(() => {});
        const snapshots = [await page.content()];
        for (let i = 0; i < maxScrolls; i++) {
          await delay();
          await page.mouse.wheel(0, 900);
          await delay();
          snapshots.push(await page.content());
        }
        return { finalUrl: page.url(), snapshots };
      } finally { await ctx.close(); }
    },
  };
}
