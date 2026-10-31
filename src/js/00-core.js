/* 00-core.js — 命名空间、常量、工具函数
 * 全部挂在 window.G 上。必须是经典 script（非 ES Module）：单文件版要在 file:// 下打开，
 * <script type="module"> 会被 CORS 拦截。
 */
(function (window) {
  'use strict';

  var G = window.G = window.G || {};

  G.VERSION = '1.0.0';

  /* ---------- 常量 ----------
   * 三科：语文（一年级认字）、数学（100 以内加减 + 数学思维）、
   * 英语（牛津自然拼读 1 阶段的字母）。题库合计 300 道，配比 3:3:4。
   */
  G.SUBJECTS = ['chinese', 'math', 'english'];

  G.SUBJECT_LABEL = { chinese: '语文', math: '数学', english: '英语' };

  /* 一局的固定构成：语文 3 + 数学 3 + 英语 4 = 10。
   *
   * **不能在这里写死** —— 它是从产物里的 G.DATA.mix 读进来的，
   * 而那个值是 tools/build.py 从 qbank.py 的 SUBJECT_MIX 推出来的。
   * 题库配比和每局构成必须是同一个数：题库按 3:3:4 出，一局却按 1:1:1 抽，
   * 那语文 90 道会被更快抽完、更早开始重复。
   * 这里的 3:3:4 只是 data 缺席时的兜底（比如直接开 index.html 调试）。 */
  G.DEFAULT_MIX = { chinese: 3, math: 3, english: 4 };

  /** 一局的题数 = 配比之和。G.sum 要等这个文件下面才定义，所以这里自己算。 */
  function mixTotal(mix) {
    var n = 0;
    for (var i = 0; i < G.SUBJECTS.length; i++) n += mix[G.SUBJECTS[i]];
    return n;
  }

  G.ROUND_SIZE = mixTotal(G.DEFAULT_MIX);

  /** 用产物里的真值覆盖兜底值。boot 时调一次。 */
  G.applyMix = function (mix) {
    if (!mix) return;
    var ok = G.SUBJECTS.every(function (s) { return typeof mix[s] === 'number' && mix[s] > 0; });
    if (!ok) {
      G.log('G.DATA.mix 不合法，沿用兜底配比', mix);
      return;
    }
    G.DEFAULT_MIX = mix;
    G.ROUND_SIZE = mixTotal(mix);
  };

  // 转盘奖项。概率和为 100。
  // 'none' 是空奖：中了就是「谢谢参与」，当场结束，**不重转**。
  // 它曾经是「再来一次」（占 20%，可重转最多 3 次，次数用完兜底送 1 分）——
  // 但重转会把一次抽奖拖成几轮，孩子盯着转盘的时间比答题还长，
  // 而且「兜底送分」让空奖实际上不存在。现在它就是明明白白的不中。
  //
  // face 是**盘面上**那行字，label 是结算条上那行字，两者不一样：
  //   盘面上最窄的扇区只占 18°（动画片，权重 5），在半径 76px 处弧长
  //   不到 24px —— 竖排一行最多站住一个字。「动画片 10 分钟」在这里
  //   无论怎么排都会糊成一团，所以盘面用「📺 10分钟」这种短形式，
  //   结算条有整行宽度，再用完整说法把话说清楚。
  G.PRIZES = [
    { id: 'tv10', points: 0,  weight: 5,  label: '动画片 10 分钟', face: '📺 10分钟', kind: 'tv' },
    { id: 'p1',   points: 1,  weight: 30, label: '1 分',           face: '1分',   kind: 'points' },
    { id: 'p2',   points: 2,  weight: 20, label: '2 分',           face: '2分',   kind: 'points' },
    { id: 'p5',   points: 5,  weight: 15, label: '5 分',           face: '5分',   kind: 'points' },
    { id: 'p10',  points: 10, weight: 10, label: '10 分',          face: '10分',  kind: 'points' },
    { id: 'none', points: 0,  weight: 20, label: '下次好运',       face: '下次好运', kind: 'none' }
  ];

  // 每个奖项有两个名字：face 写在盘面上，label 写在结算条上。
  // 盘面标签是 72px 宽、沿半径方向排的（见 50-wheel.js），只能放两三个字；
  // 结算条有整行宽度，那里把话说完整。
  G.NO_PRIZE_TEXT = '无奖励，下次好运';

  // 兑换项。500 分兑 1 元（原需求 50 分，期望值算下来 20 题 1 元，成本失控）。
  G.REWARDS = [
    { id: 'tv10', cost: 80,  label: '动画片 10 分钟', emoji: '📺' },
    { id: 'rmb1', cost: 500, label: '1 元',           emoji: '🪙' }
  ];

  G.LIMITS = {
    maxTvMinutesPerDay: 30,
    maxRedemptionsPerDay: 2,
    maxRedemptionsPerWeek: 5,
    maxPointsPerDay: 60
  };

  // 家长模式门禁：答案超出幼小衔接范围
  G.PARENT_GATE = { a: 7, b: 8, answer: 56, question: '7 × 8 = ?' };

  /* ---------- 工具 ---------- */

  G.clamp = function (n, lo, hi) { return Math.min(hi, Math.max(lo, n)); };

  G.shuffle = function (arr, rng) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor((rng ? rng() : Math.random()) * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  };

  G.pick = function (arr, rng) {
    return arr[Math.floor((rng ? rng() : Math.random()) * arr.length)];
  };

  G.sum = function (arr, fn) {
    return arr.reduce(function (a, x) { return a + (fn ? fn(x) : x); }, 0);
  };

  /* ---------- 确定性随机 ----------
   * 数学题的生成器需要可复现：同一天同一题号必须得到同一道题，
   * 否则家长看到孩子错了想再讲一遍，题目却变了。
   * 用 xorshift32，种子来自字符串哈希。
   */

  G.hashSeed = function (str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  };

  G.rngFrom = function (seed) {
    var s = (typeof seed === 'string') ? G.hashSeed(seed) : (seed >>> 0);
    if (s === 0) s = 0x9e3779b9;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;  s >>>= 0;
      return s / 4294967296;
    };
  };

  G.randInt = function (rng, lo, hi) {
    return lo + Math.floor(rng() * (hi - lo + 1));
  };

  /* ---------- 日期 ----------
   * 一律用本地日期。孩子的「今天」是北京时间，不是 UTC。
   */

  G.localDateStr = function (d) {
    d = d || new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  };

  // ISO 周起始（周一）。用于「每周兑换上限」。
  G.weekStartStr = function (d) {
    d = d ? new Date(d) : new Date();
    var dow = (d.getDay() + 6) % 7;          // 周一 = 0
    var monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow);
    return G.localDateStr(monday);
  };

  G.daysBetween = function (tsA, tsB) {
    return Math.floor((tsB - tsA) / 86400000);
  };

  /* ---------- DOM ---------- */

  G.$ = function (sel, root) { return (root || document).querySelector(sel); };

  G.$$ = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };

  G.el = function (tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.indexOf('on') === 0 && typeof v === 'function') {
          node.addEventListener(k.slice(2).toLowerCase(), v);
        } else node.setAttribute(k, v);
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  };

  G.clear = function (node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  };

  /* ---------- 环境探测 ---------- */

  G.env = {
    isIOS: /iPad|iPhone|iPod/.test(navigator.userAgent) ||
           (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
    isWeChat: /MicroMessenger/i.test(navigator.userAgent),
    isAndroid: /Android/i.test(navigator.userAgent),
    isFile: location.protocol === 'file:',
    isStandalone: window.navigator.standalone === true ||
                  (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
  };

  G.storageAvailable = function () {
    try {
      window.localStorage.setItem('__yxjx_probe', '1');
      window.localStorage.removeItem('__yxjx_probe');
      return true;
    } catch (e) { return false; }
  };

  /* ---------- 日志 ---------- */

  G.log = function () {
    if (G.DEBUG) console.log.apply(console, ['[yxjx]'].concat(Array.prototype.slice.call(arguments)));
  };

  G.DEBUG = /[?&]debug=1/.test(location.search);

})(window);
