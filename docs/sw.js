/* sw.js — Service Worker：让在线版离线可玩
 *
 * 为什么在线版也需要它：一旦走「微信里打开链接」这条路，就依赖网络。
 * 而孩子玩的时候可能在地下室、在车上、在飞行模式 —— 大人的手机流量也不是无限的。
 * 预缓存之后，第二次打开起完全离线，跟单文件版体验一致。
 *
 * 另一个作用更大：iOS 上「添加到主屏幕」的 Web App 有独立的持久化存储，
 * **不受那条「7 天未访问即清空」规则的限制**。这是解决存档丢失最彻底的办法，
 * 比反复提醒家长备份有效得多。
 *
 * 策略：预缓存 + cache-first。
 * 整个应用连音频不到 1 MB，全量预缓存最简单也最可靠 ——
 * 不需要区分「这条要不要缓存」这种容易出错的判断。
 *
 * VERSION 和 PRECACHE 由 tools/build.py 在构建时注入。
 * VERSION 取全部产物的内容哈希，所以内容一变缓存名就变，激活时自动清掉旧的。
 * 不这么做的话，孩子会被永久钉在第一次打开的版本上。
 */

var VERSION = 'yxjx-826f64d4b8';
var PRECACHE = ["index.html", "app.css", "data.js", "app.js", "manifest.webmanifest", "icons/favicon-32.png", "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png", "audio/en/bag.m4a", "audio/en/bed.m4a", "audio/en/big.m4a", "audio/en/can.m4a", "audio/en/cat.m4a", "audio/en/cot.m4a", "audio/en/dad.m4a", "audio/en/did.m4a", "audio/en/fin.m4a", "audio/en/gun.m4a", "audio/en/ham.m4a", "audio/en/hid.m4a", "audio/en/hit.m4a", "audio/en/hug.m4a", "audio/en/jam.m4a", "audio/en/jug.m4a", "audio/en/lap.m4a", "audio/en/led.m4a", "audio/en/lip.m4a", "audio/en/mad.m4a", "audio/en/man.m4a", "audio/en/mop.m4a", "audio/en/pen.m4a", "audio/en/pop.m4a", "audio/en/pot.m4a", "audio/en/rag.m4a", "audio/en/rat.m4a", "audio/en/sad.m4a", "audio/en/sip.m4a", "audio/en/sit.m4a", "audio/en/sun.m4a", "audio/en/tap.m4a", "audio/en/ten.m4a", "audio/en/van.m4a", "audio/en/vet.m4a", "audio/en/wag.m4a", "audio/en/wet.m4a", "audio/en/wig.m4a", "audio/en/win.m4a", "audio/en/yam.m4a", "audio/en/sentence/01.m4a", "audio/en/sentence/02.m4a", "audio/en/sentence/03.m4a", "audio/en/sentence/04.m4a", "audio/en/sentence/05.m4a", "audio/en/sentence/06.m4a", "audio/en/sentence/07.m4a", "audio/en/sentence/08.m4a", "audio/en/sentence/09.m4a", "audio/en/sentence/10.m4a", "audio/en/sentence/11.m4a", "audio/en/sentence/12.m4a", "audio/en/sentence/13.m4a", "audio/en/sentence/14.m4a", "audio/en/sentence/15.m4a", "audio/en/sentence/16.m4a", "audio/en/sentence/17.m4a", "audio/en/sentence/18.m4a", "audio/en/sentence/19.m4a", "audio/en/sentence/20.m4a", "audio/en/sentence/21.m4a", "audio/en/sentence/22.m4a", "audio/en/sentence/23.m4a", "audio/en/sentence/24.m4a", "audio/en/sentence/25.m4a", "audio/en/sentence/26.m4a", "audio/en/sentence/27.m4a"];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION).then(function (cache) {
      // 逐条 add 而不是 addAll：addAll 只要有一个 404 就整体失败，
      // SW 装不上，用户完全离线可用性就没了。单条失败只丢一个文件。
      return Promise.all(PRECACHE.map(function (url) {
        // cache: 'reload' 绕过浏览器 HTTP 缓存 —— 否则新版本可能装进旧字节
        return cache.add(new Request(url, { cache: 'reload' }))
          .catch(function (err) {
            console.warn('[sw] 预缓存失败：', url, err);
          });
      }));
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== VERSION) return caches.delete(k);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;

  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }

  // 只接管自己域内的请求。跨域的（比如以后接 TTS 接口）交给浏览器。
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;

      return fetch(req).then(function (res) {
        // 顺手缓存不在预缓存清单里的新资源，下次离线也能用
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(VERSION).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        // 离线且没缓存。导航请求退回首页，避免白屏。
        if (req.mode === 'navigate') return caches.match('index.html');
        return new Response('', { status: 504, statusText: 'offline' });
      });
    })
  );
});
