// Drives the real page (ekstrak-pdf.html) in headless Chromium on the BNPB
// volcano risk map of Bali: two control points, "Lengkapi dari grid", three
// colour classes picked in the risk zones, extract, then the world-map check.
// Saves the downloads and a screenshot of the check tab.
//
//   npm start -- --bind 127.0.0.1   (or: python3 -m http.server 8000 --directory public)
//   node inspeksi/peta-risiko-letusan-bali/e2e.cjs <file.pdf> <out-dir> benar|salah
// Needs Playwright (NODE_PATH pointing at a global install is fine).
const { chromium } = require("playwright");
const fs = require("fs");
const [, , pdf, outDir, mode] = process.argv; // benar: right coordinates; salah: northing typed in 30 km steps
const URL = process.env.URL || "http://localhost:8000/ekstrak-pdf.html";
const PAGE_H = 1683.7795;
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1500 }, acceptDownloads: true });
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  await page.goto(URL);
  await page.setInputFiles("#px-file", pdf);
  await page.waitForSelector("#px-steps:not([hidden])", { timeout: 120000 });
  await page.waitForTimeout(1500);
  console.log("status:", await page.textContent("#px-status"));
  console.log("geo note:", (await page.textContent("#px-geo-note")).trim());
  console.log("crs:", await page.$eval("#px-crs", (s) => s.value));
  const screen = async (x, y) => { // PDF user space (y up) → screen
    const b = await page.$eval("canvas.px-base", (c) => { const r = c.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
    return [b[0] + (x / 2383.937) * b[2], b[1] + ((PAGE_H - y) / PAGE_H) * b[3]];
  };
  const addPoint = async (x, y, X, Y) => {
    const [sx, sy] = await screen(x, y);
    await page.mouse.click(sx, sy);
    await page.waitForTimeout(300);
    const li = page.locator("#px-points li[data-i]").last();
    await li.locator("input").nth(0).fill(String(X));
    await li.locator("input").nth(0).dispatchEvent("change");
    await li.locator("input").nth(1).fill(String(Y));
    await li.locator("input").nth(1).dispatchEvent("change");
    await page.waitForTimeout(300);
  };
  await addPoint(400.2, 346.5, 230000, 9020000);
  await addPoint(2065.2, 1595.4, 350000, mode === "salah" ? 9290000 : 9110000);
  console.log("fit after 2 pts:", await page.textContent("#px-fit"));
  console.log("interval guess:", await page.$eval("#px-interval", (i) => i.value));
  await page.click("#px-complete");
  await page.waitForTimeout(500);
  console.log("status:", await page.textContent("#px-status"));
  console.log("fit:", await page.textContent("#px-fit"));
  // Colour classes: pick a pixel inside each risk zone (positions on a 1330 × 940 preview of the page).
  const picks = [["Rendah", 905, 195], ["Sedang", 1080, 210], ["Tinggi", 1075, 300]];
  for (const [, px, py] of picks) {
    await page.click("#px-add-class");
    const [sx, sy] = await screen(px * 2383.937 / 1330, PAGE_H - py * PAGE_H / 940);
    await page.mouse.click(sx, sy);
    await page.waitForTimeout(400);
    await page.click("#px-mode-done");
  }
  console.log("classes:", await page.$$eval("#px-classes li", (l) => l.map((x) => x.querySelector(".px-c-name").value + ":" + [...x.querySelectorAll(".px-chip")].map((c) => c.title).join(","))));
  await page.check("#px-labels");
  await page.selectOption("#px-dpi", { index: 0 });
  await page.click("#px-run");
  await page.waitForFunction(() => /Selesai|gagal|Galat|salah/i.test(document.querySelector("#px-status").textContent), null, { timeout: 600000 });
  console.log("status:", await page.textContent("#px-status"));
  const n = await page.locator("#px-downloads a").count();
  for (let i = 0; i < n; i++) {
    const [dl] = await Promise.all([page.waitForEvent("download"), page.locator("#px-downloads a").nth(i).click()]);
    const dest = `${outDir}/${mode}_${dl.suggestedFilename()}`;
    await dl.saveAs(dest);
    console.log("saved", dest, fs.statSync(dest).size);
  }
  await page.click("#px-tab-map");
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${outDir}/${mode}_check.png` });
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
