/* 00-core.js — 命名空间、常量、工具函数
 * 全部挂在 window.G 上。必须是经典 script（非 ES Module）：单文件版要在 file:// 下打开，
 * <script type="module"> 会被 CORS 拦截。
 */
(function (window) {
  'use strict';

  var G = window.G = window.G || {};

  G.VERSION = '1.0.0';

  /* ---------- 常量 ----------
   * 整个游戏只有识字一科。原来是语文/数学/英语三科混排，英语还挂着一套
   * OPW2 自然拼读体系；现在全部收成一件事：认字。
   */
  G.SUBJECTS = ['chinese'];

  G.SUBJECT_LABEL = { chinese: '识字' };

  // 一局 10 道，全是识字题
  G.DEFAULT_MIX = { chinese: 10 };

  G.ROUND_SIZE = 10;

  // 转盘奖项。概率和为 100。
  // 'none' 是空奖：中了就是「谢谢参与」，当场结束，**不重转**。
  // 它曾经是「再来一次」（占 20%，可重转最多 3 次，次数用完兜底送 1 分）——
  // 但重转会把一次抽奖拖成几轮，孩子盯着转盘的时间比答题还长，
  // 而且「兜底送分」让空奖实际上不存在。现在它就是明明白白的不中。
  G.PRIZES = [
    { id: 'tv10', points: 0,  weight: 5,  label: '动画片 10 分钟', kind: 'tv' },
    { id: 'p1',   points: 1,  weight: 30, label: '1 分',           kind: 'points' },
    { id: 'p2',   points: 2,  weight: 20, label: '2 分',           kind: 'points' },
    { id: 'p5',   points: 5,  weight: 15, label: '5 分',           kind: 'points' },
    { id: 'p10',  points: 10, weight: 10, label: '10 分',          kind: 'points' },
    { id: 'none', points: 0,  weight: 20, label: '下次好运',       kind: 'none' }
  ];

  // 空奖在盘面上写「下次好运」（84px 的扇区贴不下更长），
  // 结算条上写全 —— 那里有整行宽度，也把话说清楚。
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
