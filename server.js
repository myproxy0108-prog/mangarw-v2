const express = require('express');
const fetch = require('node-fetch');
const https = require('https');
const path = require('path');
const fs = require('fs');
const app = express();

// ==========================================
// 1. Webプロキシ (Ultraviolet等) の処理
// ==========================================
const PROXY_DIR = path.join(__dirname, 'proxy'); // 実際のフォルダ名に合わせてください
const PROXY_ENDPOINTS = [
  'prxy',
  'baremux',
  'epoxy',
  'libcurl',
  'register-sw.mjs',
  'uv'
];

app.use('/proxy', express.static(PROXY_DIR));

app.use((req, res, next) => {
  const fileName = req.path.replace(/^\//, '');

  // ユーザー定義のエンドポイントに完全一致する場合
  if (PROXY_ENDPOINTS.includes(fileName)) {
    const targetPath = path.join(PROXY_DIR, fileName);
    if (fs.existsSync(targetPath) && fs.lstatSync(targetPath).isFile()) {
      return res.sendFile(targetPath); // ここで処理完了（漫画には行かない）
    }
  }
  next();
});

// ==========================================
// 2. 【重要】漫画プロキシからの保護（除外リスト）
// ==========================================
// ここに書かれたパスから始まる通信は、漫画プロキシに吸い込まれません
const EXCLUDE_PATHS = [
    '/proxy', 
    '/prxy', 
    '/baremux', 
    '/epoxy', 
    '/libcurl', 
    '/register-sw.mjs', 
    '/uv', 
    '/~uv',     // Ultravioletの動的通信用
    '/bare',    // Bareサーバー通信用
    '/_cdn_/'   // 漫画用アセットの例外等があれば追加
];

// ==========================================
// 3. 漫画プロキシ (Render単体処理版)
// ==========================================
const TARGET_HOST = "mangarw.com";
const TARGET_BASE = `https://${TARGET_HOST}`;

const proxyAgent = new https.Agent({ keepAlive: true, maxSockets: 512, timeout: 60000 });
app.use(express.raw({ type: '*/*', limit: '50mb' }));

app.all('*', async (req, res, next) => {
    // --- 【干渉防止ガード】 ---
    // もしリクエストURLがWebプロキシ用のものなら、漫画プロキシをスキップして次に回す
    if (EXCLUDE_PATHS.some(p => req.url.startsWith(p))) {
        return next();
    }

    if (req.url === '/favicon.ico' || req.url.startsWith('/embed.html')) {
        return res.status(404).end(); 
    }

    const currentHost = req.get('host');
    const targetUrl = TARGET_BASE + req.url;

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

            // 広告除去と先読みエンジンの注入
            const INJECT_CODE = `
            <style>
              iframe, .pop--excl, .bg-ssp-11557, [id*="bg-ssp"], [class*="ad-"], #toast,
              [style*="z-index: 2147483647"], [style*="z-index: 9999"] { display: none !important; pointer-events: none !important; }
              #load-more-chapters, .load-more { display: block !important; visibility: visible !important; opacity: 1 !important; background: #3b82f6 !important; color: white !important; padding: 15px !important; text-align: center; border-radius: 8px; cursor: pointer; }
            </style>
            <script>
              (function() {
                window.open = () => null;
                const processImages = () => {
                  document.querySelectorAll('img').forEach(img => {
                    const src = img.dataset.src || img.getAttribute('src');
                    if (src && !src.startsWith('data:') && !src.includes('/embed.html#')) {
                      const absUrl = src.startsWith('http') ? src : window.location.origin + (src.startsWith('/') ? src : '/' + src);
                      const proxyUrl = '/embed.html#' + absUrl;
                      img.setAttribute('src', proxyUrl);
                      img.setAttribute('data-src', proxyUrl);
                      img.removeAttribute('loading'); 
                    }
                  });
                };
                const nukeOverlays = () => {
                  document.querySelectorAll('div, a').forEach(el => {
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
              })();
            </script>`;
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

// Ultraviolet / Bare サーバーを使用している場合はここで Bare サーバーのリスナーをマウントできます
// const { createBareServer } = require('@tomphttp/bare-server-node');
// const bareServer = createBareServer('/bare/');
// サーバー作成処理...

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy Engine Online on port ${PORT}`));
