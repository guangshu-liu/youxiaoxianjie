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

var VERSION = 'yxjx-5c4f4904b9';
var PRECACHE = ["index.html", "app.css", "data.js", "app.js", "manifest.webmanifest", "icons/favicon-32.png", "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png", "audio/en/ant.m4a", "audio/en/apple.m4a", "audio/en/bad.m4a", "audio/en/ball.m4a", "audio/en/big.m4a", "audio/en/bin.m4a", "audio/en/bit.m4a", "audio/en/bud.m4a", "audio/en/bug.m4a", "audio/en/bun.m4a", "audio/en/can.m4a", "audio/en/cap.m4a", "audio/en/car.m4a", "audio/en/cat.m4a", "audio/en/cop.m4a", "audio/en/cot.m4a", "audio/en/dig.m4a", "audio/en/dog.m4a", "audio/en/dot.m4a", "audio/en/elbow.m4a", "audio/en/fan.m4a", "audio/en/fed.m4a", "audio/en/fig.m4a", "audio/en/fin.m4a", "audio/en/fit.m4a", "audio/en/fix.m4a", "audio/en/fun.m4a", "audio/en/goat.m4a", "audio/en/gum.m4a", "audio/en/gun.m4a", "audio/en/ham.m4a", "audio/en/hand.m4a", "audio/en/hen.m4a", "audio/en/hit.m4a", "audio/en/hop.m4a", "audio/en/hot.m4a", "audio/en/hug.m4a", "audio/en/hum.m4a", "audio/en/insect.m4a", "audio/en/jet.m4a", "audio/en/juice.m4a", "audio/en/kid.m4a", "audio/en/king.m4a", "audio/en/leaf.m4a", "audio/en/lot.m4a", "audio/en/mat.m4a", "audio/en/men.m4a", "audio/en/mix.m4a", "audio/en/monkey.m4a", "audio/en/mop.m4a", "audio/en/mug.m4a", "audio/en/nap.m4a", "audio/en/net.m4a", "audio/en/nose.m4a", "audio/en/ostrich.m4a", "audio/en/pad.m4a", "audio/en/pen.m4a", "audio/en/pig.m4a", "audio/en/pin.m4a", "audio/en/pit.m4a", "audio/en/pop.m4a", "audio/en/pot.m4a", "audio/en/pup.m4a", "audio/en/question.m4a", "audio/en/rag.m4a", "audio/en/rat.m4a", "audio/en/red.m4a", "audio/en/rip.m4a", "audio/en/rug.m4a", "audio/en/sad.m4a", "audio/en/sit.m4a", "audio/en/six.m4a", "audio/en/snake.m4a", "audio/en/sum.m4a", "audio/en/sun.m4a", "audio/en/tag.m4a", "audio/en/tin.m4a", "audio/en/tip.m4a", "audio/en/top.m4a", "audio/en/tree.m4a", "audio/en/umbrella.m4a", "audio/en/vest.m4a", "audio/en/wig.m4a", "audio/en/win.m4a", "audio/en/window.m4a", "audio/en/yam.m4a", "audio/en/zip.m4a", "audio/en/zoo.m4a"];

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
