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

var VERSION = '__SW_VERSION__';
var PRECACHE = __SW_PRECACHE__;

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
