const { chromium } = require("/home/ivan/visio2drawio/node_modules/playwright-core");
(async () => {
  const browser = await chromium.launch({ executablePath: "/home/ivan/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell" });
  for (const [name, vp] of [["desktop", { width: 1400, height: 900 }], ["phone", { width: 390, height: 844 }]]) {
    const ctx = await browser.newContext({ viewport: vp, extraHTTPHeaders: { "X-Test-User": "ivan" } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto("http://127.0.0.1:18081/admin.html");
    await page.waitForTimeout(1500);
    await page.locator(".admin-panel-tabs button").nth(2).click();
    await page.waitForTimeout(4500);
    await page.screenshot({ path: `${process.argv[2]}/monitor-${name}.png`, fullPage: false });
    console.log(name, "errors:", JSON.stringify(errors));
    await ctx.close();
  }
  await browser.close();
})();
