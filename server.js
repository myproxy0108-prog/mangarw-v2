const express = require('express');
const fetch = require('node-fetch');
const https = require('https');
const path = require('path');
const fs = require('fs');
const app = express();

// ==========================================
// 1. Webプロキシ (Ultraviolet等) の処理
// ==========================================
const PROXY_DIR = path.join(__dirname, 'proxy'); 
const PROXY_ENDPOINTS = [
  'prxy', 'baremux', 'epoxy', 'libcurl', 'register-sw.mjs', 'uv'
];

app.get('/proxy', (req, res) => res.redirect('/proxy/'));
app.use('/proxy', express.static(PROXY_DIR));

app.use((req, res, next) => {
    if (res.headersSent) return next();
    
    const fileName = req.path.replace(/^\//, '');
    if (PROXY_ENDPOINTS.includes(fileName)) {
        const targetPath = path.join(PROXY_DIR, fileName);
        if (fs.existsSync(targetPath) && fs.lstatSync(targetPath).isFile()) {
            return res.sendFile(targetPath);
        }
    }
    next();
});

// ==========================================
// 2. 漫画プロキシからの保護（干渉防止壁）
// ==========================================
const UV_DYNAMIC_PATHS = [
    '/proxy', '/prxy', '/baremux', '/epoxy', '/libcurl', 
    '/register-sw.mjs', '/uv', '/~uv', '/bare', 
    '/_img_/' // ← 画像プロキシも保護
];

app.use((req, res, next) => {
    if (UV_DYNAMIC_PATHS.some(p => req.path.startsWith(p))) {
        if (req.path.startsWith('/_img_/')) return next(); 
        return res.status(404).end();
    }
    next();
});

// ==========================================
// 3. 【新設】外部CDNを使った超圧縮・画像プロキシ
// ==========================================
const proxyAgent = new https.Agent({ keepAlive: true, maxSockets: 512, timeout: 60000 });

app.get('/_img_/', async (req, res) => {
    const imgUrl = req.query.url;
    if (!imgUrl) return res.status(400).end();

    // 🌟 wsrv.nl を使って横幅720px、WebP、画質40%に超圧縮（通信量を1/10に！）
    const cdnUrl = `https://wsrv.nl/?url=${encodeURIComponent(imgUrl)}&w=720&output=webp&q=40`;

    try {
        const imgRes = await fetch(cdnUrl, {
            headers: { 'User-Agent': req.get('user-agent') || 'Mozilla/5.0' },
            agent: proxyAgent
        });

        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cache-Control', 'public, max-age=31536000, immutable');

        // 万が一 wsrv.nl が画像を弾いた場合（リファラ制限など）のフェイルセーフ（保険）
        if (!imgRes.ok) {
            console.log(`[CDN Miss] Fallback to direct fetch: ${imgUrl}`);
            const fallbackRes = await fetch(imgUrl, {
                headers: { 'Referer': 'https://mangarw.com/', 'User-Agent': 'Mozilla/5.0' },
                agent: proxyAgent
            });
            res.set('Content-Type', fallbackRes.headers.get('content-type'));
            return fallbackRes.body.pipe(res);
        }

        res.set('Content-Type', 'image/webp'); 
        imgRes.body.pipe(res);
        imgRes.body.on('error', () => {
            if (!res.headersSent) res.end();
        });
    } catch (e) {
        if (!res.headersSent) res.status(502).end();
    }
});

// ==========================================
// 4. 漫画プロキシ (MangaRaw 本体処理)
// ==========================================
const TARGET_HOST = "mangarw.com";
const TARGET_BASE = `https://${TARGET_HOST}`;

app.use(express.raw({ type: '*/*', limit: '50mb' }));

const INJECT_CODE = `
<style>
  iframe, .pop--excl, .bg-ssp-11557, [id*="bg-ssp"], [class*="ad-"], #toast,
  [style*="z-index: 2147483647"], [style*="z-index: 9999"], 
  a[href*="adexchangerapid"], a[href*="university"] { display: none !important; pointer-events: none !important; }
  #load-more-chapters, .load-more, .read-more { display: block !important; visibility: visible !important; opacity: 1 !important; background: #3b82f6 !important; color: white !important; border-radius: 8px; padding: 15px !important; text-align: center; cursor: pointer; }
</style>
<script>
  (function() {
    window.open = () => null;

    // 画像のURLを「超圧縮プロキシ」経由に書き換える
    const processImages = () => {
      document.querySelectorAll('img').forEach(img => {
        const src = img.dataset.src || img.getAttribute('src');
        if (src && !src.startsWith('data:') && !src.includes('/_img_/?url=')) {
          const absUrl = src.startsWith('http') ? src : window.location.origin + (src.startsWith('/') ? src : '/' + src);
          const proxyUrl = '/_img_/?url=' + encodeURIComponent(absUrl);
          
          img.setAttribute('src', proxyUrl);
          img.setAttribute('data-src', proxyUrl);
          img.removeAttribute('loading'); 
        }
      });
    };

    const nukeOverlays = () => {
      document.querySelectorAll('div, a, section, ins').forEach(el => {
        const s = window.getComputedStyle(el);
        if (parseInt(s.zIndex) > 1000 && parseFloat(s.opacity) < 0.1 && !el.innerText.trim()) el.remove();
      });
    };
    setInterval(nukeOverlays, 1000);

    const initAll = () => {
      processImages();
      const obs = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const imgs = Array.from(document.querySelectorAll('img'));
            const idx = imgs.indexOf(entry.target);
            for(let i=1; i<=5; i++) {
              if (imgs[idx+i] && imgs[idx+i].dataset.src && imgs[idx+i].src !== imgs[idx+i].dataset.src) {
                imgs[idx+i].src = imgs[idx+i].dataset.src;
              }
            }
          }
        });
      }, { rootMargin: '1500px 0px' });
      document.querySelectorAll('img').forEach(i => { if(i.dataset.src) obs.observe(i); });
      new MutationObserver(processImages).observe(document.body, { childList: true, subtree: true });
    };
    document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', initAll) : initAll();
    
    window.addEventListener('click', function(e) {
      const target = e.target.closest('a');
      if (target && target.href && (target.href.includes('adex') || target.href.includes('university'))) {
        e.preventDefault(); e.stopImmediatePropagation(); return false;
      }
    }, true); 
  })();
</script>
`;

app.all('*', async (req, res) => {
    if (req.url === '/favicon.ico') return res.status(204).end();

    const targetUrl = TARGET_BASE + req.url;
    const currentHost = req.get('host');

    const h = { ...req.headers };
    delete h.host; delete h.connection; delete h['content-length']; 
    h['Origin'] = TARGET_BASE;
    h['Referer'] = TARGET_BASE + '/';
    h['Accept-Encoding'] = 'identity'; 

    try {
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: h,
            agent: proxyAgent,
            compress: true, 
            redirect: 'manual', 
            body: (req.method !== 'GET' && req.method !== 'HEAD') ? req.body : undefined,
            timeout: 15000 
        });

        let resHeaders = {};
        response.headers.forEach((v, k) => {
            const key = k.toLowerCase();
            if (!['content-encoding', 'transfer-encoding', 'content-length', 'content-security-policy', 'x-frame-options', 'strict-transport-security'].includes(key)) {
                resHeaders[key] = v;
            }
        });

        if (resHeaders['location']) {
            resHeaders['location'] = resHeaders['location'].replace(new RegExp(`https:\/\/[a-z0-9.-]*${TARGET_HOST}`, 'gi'), `https://${currentHost}`);
        }

        if (resHeaders['set-cookie']) {
            let cookies = response.headers.raw()['set-cookie'];
            resHeaders['set-cookie'] = cookies.map(cookie => {
                let clean = cookie.replace(new RegExp(`domain=\\.?[a-z0-9.-]*${TARGET_HOST};?`, 'gi'), "");
                clean = clean.replace(/SameSite=(Lax|Strict)/gi, "SameSite=None");
                if (!clean.includes("Secure")) clean += "; Secure";
                return clean;
            });
        }

        const contentType = response.headers.get("content-type") || "";

        if (contentType.includes("text/html")) {
            let text = await response.text();
            
            text = text.replace(/onclick=".*?"/gi, 'data-removed-click=""');
            const badDomains = ['universityshocksooner.com', 'adexchangerapid.com', 'gomuraw.js', 'platform.pubadx.one'];
            badDomains.forEach(d => {
                const re = new RegExp('<script[^>]*' + d.replace('.', '\\.') + '[^>]*><\\/script>', 'gi');
                text = text.replace(re, "");
                text = text.split(d).join("localhost");
            });
            text = text.replace(/<a[^>]*adexchangerapid\.com[^>]*>.*?<\/a>/gi, "");

            text = text.replace(new RegExp(`https:\/\/[a-z0-9.-]*${TARGET_HOST}`, 'gi'), `https://${currentHost}`);
            text = text.replace(new RegExp(`\/\/${TARGET_HOST}`, 'g'), `//${currentHost}`);

            text = text.replace('<head>', '<head>' + INJECT_CODE);
            res.set(resHeaders);
            res.set("Content-Type", "text/html; charset=utf-8");
            
            return res.status(response.status).send(text);
        }

        if (contentType.includes("css")) {
            let cssText = await response.text();
            cssText = cssText.replace(/url\(['"]?\//g, `url("https://${currentHost}/`);
            res.set(resHeaders);
            return res.status(response.status).send(cssText);
        }

        res.set(resHeaders);
        res.status(response.status);
        response.body.pipe(res);

    } catch (error) {
        if (!res.headersSent) res.status(502).send("Server Error");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Super Compressed Manga Engine Online on port ${PORT}`));
