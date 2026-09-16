// Microservicio de render HTML -> PNG para carruseles
const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json({ limit: '15mb' }));

let browser = null;
async function getBrowser() {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({
      headless: 'shell',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none']
    });
  }
  return browser;
}

// Cola simple: un render a la vez (protege la RAM del plan free)
let queue = Promise.resolve();
function enqueue(fn) {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}

// Salud del servicio
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Render principal: recibe HTML y devuelve 6 PNGs en base64 + metricas de overflow
app.post('/render', (req, res) => enqueue(async () => {
  try {
    const body = req.body || {};
    const html = body.html;
    const width = body.width || 1080;
    const height = body.height || 1080;
    const selectors = body.selectors || ['#slide-1', '#slide-2', '#slide-3', '#slide-4', '#slide-5', '#slide-6'];
    if (!html) return res.status(400).json({ error: 'falta el campo html' });

    const b = await getBrowser();
    const page = await b.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load', timeout: 45000 });

    // Espera fuentes web (Google Fonts) e imagenes externas
    await page.evaluateHandle('document.fonts.ready');
    await page.evaluate(async () => {
      const imgs = Array.from(document.images);
      await Promise.all(imgs.map(i => i.complete ? Promise.resolve() : new Promise(r => { i.onload = r; i.onerror = r; })));
    });
    await new Promise(r => setTimeout(r, 300));

    const results = [];
    for (let i = 0; i < selectors.length; i++) {
      const sel = selectors[i];
      const info = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return { found: false };
        const bad = [];
        if (el.scrollHeight > el.clientHeight + 2) bad.push('scrollHeight ' + el.scrollHeight + ' supera alto ' + el.clientHeight);
        const er = el.getBoundingClientRect();
        el.querySelectorAll('*').forEach(ch => {
          const r = ch.getBoundingClientRect();
          if (r.height === 0 && r.width === 0) return;
          if (r.bottom > er.bottom + 2) bad.push('se pasa abajo: ' + (ch.className || ch.tagName));
          if (r.top < er.top - 2) bad.push('se pasa arriba: ' + (ch.className || ch.tagName));
        });
        const failed = Array.from(el.querySelectorAll('img'))
          .filter(im => !(im.complete && im.naturalWidth > 0))
          .map(im => im.getAttribute('src') || 'sin-src');
        return { found: true, overflow: bad.length > 0, overflowDetails: bad.join(' | '), imagesOk: failed.length === 0, failedImages: failed };
      }, sel);

      let base64 = null;
      const el = await page.$(sel);
      if (el) {
        const buf = await el.screenshot({ type: 'png' });
        base64 = buf.toString('base64');
      }
      results.push({
        slide: i + 1,
        selector: sel,
        base64,
        overflow: info.found ? info.overflow : true,
        overflow_details: info.found ? info.overflowDetails : 'selector no encontrado en el HTML',
        images_ok: info.found ? info.imagesOk : false,
        failed_images: info.found ? info.failedImages : []
      });
    }
    await page.close();
    res.json({ images: results });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}));

// Prueba visual rapida: abre /demo en el navegador y debe verse un cuadrado navy
app.get('/demo', (req, res) => enqueue(async () => {
  try {
    const b = await getBrowser();
    const page = await b.newPage();
    await page.setViewport({ width: 1080, height: 1080 });
    await page.setContent('<div style="width:1080px;height:1080px;background:#101C4A;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:sans-serif"><div style="color:#C9A25E;font-size:90px;font-weight:800">RENDER OK</div><div style="color:#fff;font-size:40px">1080 x 1080</div></div>', { waitUntil: 'load' });
    const buf = await page.screenshot({ type: 'png' });
    await page.close();
    res.type('image/png').send(buf);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Render service escuchando en ' + PORT));