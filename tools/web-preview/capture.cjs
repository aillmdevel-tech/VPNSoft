// Phone-size captures of the web preview + idle fps probe.
// Usage: PLAYWRIGHT=/path/to/node_modules/playwright node tools/web-preview/capture.cjs http://localhost:5180 out-dir
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
const [base = "http://localhost:5180", out = "build/captures"] = process.argv.slice(2);
require("fs").mkdirSync(out, { recursive: true });

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  page.on("response", r => { if (r.status() >= 400) errors.push(r.status() + " " + r.url()); });
  const shot = async name => { await page.screenshot({ path: `${out}/${name}.png` }); };
  const fps = ms => page.evaluate(ms => new Promise(done => {
    let n = 0; const t0 = performance.now();
    const tick = () => { n++; if (performance.now() - t0 < ms) requestAnimationFrame(tick); else done(Math.round(n * 1000 / (performance.now() - t0))); };
    requestAnimationFrame(tick);
  }), ms);
  const draws = ms => page.evaluate(ms => new Promise(done => {
    const c = document.getElementById("globe-map"), gl = c.getContext("webgl2");
    let n = 0; const orig = gl.drawElements.bind(gl), origA = gl.drawArrays.bind(gl);
    let frames = 0, lastFrame = -1;
    const mark = () => { const f = Math.floor(performance.now()); if (f !== lastFrame) { lastFrame = f; } n++; };
    gl.drawElements = (...a) => { mark(); return orig(...a); };
    gl.drawArrays = (...a) => { mark(); return origA(...a); };
    const t0 = performance.now();
    const raf = () => { frames++; if (performance.now() - t0 < ms) requestAnimationFrame(raf); else { gl.drawElements = orig; gl.drawArrays = origA; done({ calls: n, frames }); } };
    requestAnimationFrame(raf);
  }), ms);

  await page.goto(base + "/");
  await page.waitForTimeout(3500);
  await shot("home-day");
  const idle = await draws(3000);
  console.log("rAF fps:", await fps(1500), "draw calls in 3s idle:", idle.calls, "rAF frames:", idle.frames);
  await page.click('[data-toy="meteor"]'); await page.waitForTimeout(900); await shot("meteor-impact");
  await page.waitForTimeout(1500);
  await page.click('[data-toy="storm"]'); await page.waitForTimeout(2200); await shot("storm");
  await page.click('[data-toy="tornado"]'); await page.waitForTimeout(2000); await shot("tornado");
  await page.waitForTimeout(6500);
  await page.click("#action"); await page.waitForTimeout(1200); await shot("travel");
  await page.waitForTimeout(2600); await page.evaluate(() => scrollTo(0, 0)); await shot("connected-stamp");
  await page.waitForTimeout(2600);
  await page.click("#pass-chip"); await page.waitForTimeout(600); await shot("passport");
  await page.keyboard.press("Escape");
  await page.evaluate(() => { const h = document.documentElement; new MutationObserver(() => { if (h.dataset.sky !== "night") h.dataset.sky = "night"; }).observe(h, { attributes: true, attributeFilter: ["data-sky"] }); h.dataset.sky = "night"; });
  await page.waitForTimeout(800); await shot("night-css");
  await page.goto(base + "/index-es.html"); await page.waitForTimeout(3000); await shot("home-es");
  await page.evaluate(() => scrollTo(0, 600)); await page.waitForTimeout(500); await shot("servers-es");
  console.log("errors:", errors.length ? errors.slice(0, 5) : "none");
  await browser.close();
})();
