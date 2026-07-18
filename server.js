const express = require('express');
const fetch = require('node-fetch');
const https = require('https');
const path = require('path');
const app = express();

// ==========================================
// 1. 設定：ターゲットドメイン
// ==========================================
const TARGET_HOST = "mangarw.com";
const TARGET_BASE = `https://${TARGET_HOST}`;

// 通信安定化エージェント
const proxyAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 512,
    timeout: 60000
});

// ボディサイズの制限解除
app.use(express.raw({ type: '*/*', limit: '50mb' }));

// embed.html 等の静的ファイルが public フォルダにあれば配信する設定
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 2. 注入：広告抹殺 ＆ 先読み ＆ 画像プロキシ化
// ==========================================
const INJECT_CODE = `
<style>
  /* 広告・不要要素の物理排除 */
  iframe, .pop--excl, .bg-ssp-11557, [id*="bg-ssp"], [class*="ad-"], #toast,
  [style*="z-index: 2147483647"], [style*="z-index: 9999"], 
  a[href*="adexchangerapid"], a[href*="university"] { 
    display: none !important; visibility: hidden !important; pointer-events: none !important; 
  }
  /* 続きを読むボタン等のUI保護 */
  #load-more-chapters, .load-more, .read-more { 
    display: block !important; visibility: visible !important; opacity: 1 !important;
    background: #3b82f6 !important; color: white !important; border-radius: 8px; padding: 15px !important; text-align: center; cursor: pointer;
  }
</style>
<script>
  (function() {
    window.open = function() { return null; }; // ポップアップ強制停止

    // 1. 画像のURLを「/embed.html#」経由に書き換える (MDM回避)
    const processImages = () => {
      document.querySelectorAll('img').forEach(img => {
        const src = img.dataset.src || img.getAttribute('src');
        if (src && !src.startsWith('data:') && !src.includes('/embed.html#')) {
          // 相対パスの場合は絶対パスに補完
          const absUrl = src.startsWith('http') ? src : window.location.origin + (src.startsWith('/') ? src : '/' + src);
          const proxyUrl = '/embed.html#' + absUrl;
          
          img.setAttribute('src', proxyUrl);
          img.setAttribute('data-src', proxyUrl);
          img.removeAttribute('loading'); // 遅延読み込みを解除
        }
      });
    };

    // 2. 透明ボタン監視・破壊エンジン（1秒おき）
    const nukeOverlays = () => {
      document.querySelectorAll('div, a, section, ins').forEach(el => {
        const s = window.getComputedStyle(el);
        const z = parseInt(s.zIndex);
        if ((z > 1000 && parseFloat(s.opacity) < 0.1) || 
            (el.href && (el.href.includes('adex') || el.href.includes('university')))) {
          if (!el.innerText.trim()) el.remove();
        }
      });
    };
    setInterval(nukeOverlays, 1000);

    // 3. 5枚先読み・スクロール最適化エンジン
    const initPrefetch = () => {
      const images = Array.from(document.querySelectorAll('img'));
      const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const index = images.indexOf(entry.target);
            for (let i = 1; i <= 5; i++) {
              const nextImg = images[index + i];
              if (nextImg && nextImg.dataset.src) {
                // まだ読み込まれていなければソースをセット
                if (nextImg.src !== nextImg.dataset.src) {
                  nextImg.src = nextImg.dataset.src;
                }
              }
            }
          }
        });
      }, { rootMargin: '1500px 0px' });

      images.forEach(img => {
        if (img.dataset.src) observer.observe(img);
      });
    };
    
    // イベントフック
    const initAll = () => {
      processImages();
      initPrefetch();
      // 動的に追加される画像にも対応
      const mo = new MutationObserver(processImages);
      mo.observe(document.body, { childList: true, subtree: true });
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initAll);
    } else {
      initAll();
    }

    // クリックジャッキング保護（広告への遷移を横取り）
    window.addEventListener('click', function(e) {
      const target = e.target.closest('a');
      if (target && target.href && (target.href.includes('adex') || target.href.includes('university'))) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return false;
      }
    }, true); 
  })();
</script>
`;

// ==========================================
// 3. メインプロキシ (Render単体処理)
// ==========================================
app.all('*', async (req, res) => {
    // すでに解決済みの embed.html や favicon へのアクセスはスキップ
    if (req.url === '/favicon.ico' || req.url.startsWith('/embed.html')) {
        return res.status(404).end(); 
        // ※ embed.html を Render 上に置いている場合は、上の app.use(express.static) が自動で返します
    }

    // アクセス先を本家ドメインへ
    const targetUrl = TARGET_BASE + req.url;
    const currentHost = req.get('host');

    // 偽装ヘッダーの構築
    const h = { ...req.headers };
    delete h.host; 
    delete h.connection; 
    delete h['content-length']; 
    h['Origin'] = TARGET_BASE;
    h['Referer'] = TARGET_BASE + '/';
    h['Accept-Encoding'] = 'identity'; // 文字化け防止

    try {
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: h,
            agent: proxyAgent,
            compress: true, 
            redirect: 'manual', // リダイレクトを自分で処理
            body: (req.method !== 'GET' && req.method !== 'HEAD') ? req.body : undefined,
            timeout: 15000 
        });

        let resHeaders = {};
        response.headers.forEach((v, k) => {
            const key = k.toLowerCase();
            // 不要・有害なヘッダーを除外
            if (!['content-encoding', 'transfer-encoding', 'content-length', 'content-security-policy', 'x-frame-options', 'strict-transport-security'].includes(key)) {
                resHeaders[key] = v;
            }
        });

        // リダイレクトのループ防止と自ドメイン同期
        if (resHeaders['location']) {
            resHeaders['location'] = resHeaders['location']
                .replace(new RegExp(`https:\/\/[a-z0-9.-]*${TARGET_HOST}`, 'gi'), `https://${currentHost}`);
        }

        // Cookieのドメイン同期（ループ防止の要）
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

        // --- HTMLの場合：広告を物理検閲 ＆ コード注入 ---
        if (contentType.includes("text/html")) {
            let text = await response.text();
            
            // 物理削除1: onclick属性を剥奪（クリック爆弾解除）
            text = text.replace(/onclick=".*?"/gi, 'data-removed-click=""');
            
            // 物理削除2: 悪質ドメインのコードを消去
            const badDomains = ['universityshocksooner.com', 'adexchangerapid.com', 'gomuraw.js', 'platform.pubadx.one'];
            badDomains.forEach(d => {
                const re = new RegExp('<script[^>]*' + d.replace('.', '\\.') + '[^>]*><\\/script>', 'gi');
                text = text.replace(re, "");
                text = text.split(d).join("localhost");
            });

            // 物理削除3: 末尾の広告リンクを消去
            text = text.replace(/<a[^>]*adexchangerapid\.com[^>]*>.*?<\/a>/gi, "");

            // ドメインの一括置換
            text = text.replace(new RegExp(`https:\/\/[a-z0-9.-]*${TARGET_HOST}`, 'gi'), `https://${currentHost}`);
            text = text.replace(new RegExp(`\/\/${TARGET_HOST}`, 'g'), `//${currentHost}`);

            // 保護コード注入
            text = text.replace('<head>', '<head>' + INJECT_CODE);
            res.set(resHeaders);
            res.set("Content-Type", "text/html; charset=utf-8");
            
            return res.status(response.status).send(text);
        }

        // --- CSSの場合：パス修復 ---
        if (contentType.includes("css")) {
            let cssText = await response.text();
            cssText = cssText.replace(/url\(['"]?\//g, `url("https://${currentHost}/`);
            res.set(resHeaders);
            return res.status(response.status).send(cssText);
        }

        // --- その他（JS等）はストリーミング ---
        res.set(resHeaders);
        res.status(response.status);
        response.body.pipe(res);

    } catch (error) {
        if (!res.headersSent) res.status(502).send("Server Error: " + error.message);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Standalone Manga Engine Online on port ${PORT}`));
