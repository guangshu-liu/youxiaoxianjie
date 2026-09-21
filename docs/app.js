/* ===== 00-core.js ===== */
/* 00-core.js — 命名空间、常量、工具函数
 * 全部挂在 window.G 上。必须是经典 script（非 ES Module）：单文件版要在 file:// 下打开，
 * <script type="module"> 会被 CORS 拦截。
 */
(function (window) {
  'use strict';

  var G = window.G = window.G || {};

  G.VERSION = '0.1.0-phase0';

  /* ---------- 常量 ---------- */

  G.SUBJECTS = ['chinese', 'math', 'english'];

  G.SUBJECT_LABEL = { chinese: '语文', math: '数学', english: '英语' };

  // 一局构成：语文 4 + 数学 3 + 英语 3
  G.DEFAULT_MIX = { chinese: 4, math: 3, english: 3 };

  G.ROUND_SIZE = 10;

  // 转盘奖项。概率和为 100。'again' 替代原方案的「遗憾」空奖——可重转。
  G.PRIZES = [
    { id: 'tv10',  points: 0,  weight: 5,  label: '动画片 10 分钟', kind: 'tv' },
    { id: 'p1',    points: 1,  weight: 30, label: '1 分',           kind: 'points' },
    { id: 'p2',    points: 2,  weight: 20, label: '2 分',           kind: 'points' },
    { id: 'p5',    points: 5,  weight: 15, label: '5 分',           kind: 'points' },
    { id: 'p10',   points: 10, weight: 10, label: '10 分',          kind: 'points' },
    { id: 'again', points: 0,  weight: 20, label: '再来一次',       kind: 'again' }
  ];

  // 兑换项。500 分兑 1 元（原需求 50 分，期望值算下来 20 题 1 元，成本失控）。
  G.REWARDS = [
    { id: 'tv10', cost: 80,  label: '动画片 10 分钟', emoji: '📺' },
    { id: 'rmb1', cost: 500, label: '1 元',           emoji: '🪙' }
  ];

  G.LIMITS = {
    maxTvMinutesPerDay: 30,
    maxRedemptionsPerDay: 2,
    maxRedemptionsPerWeek: 5,
    maxPointsPerDay: 60,
    maxRespinsPerQuestion: 3
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

/* ===== 05-ui.js ===== */
/* 05-ui.js — 共享 UI 组件：提示条、进度点、对错反馈 */
(function (window) {
  'use strict';

  var G = window.G;

  var toastEl = null;
  var toastTimer = null;

  function toast(msg, ms) {
    if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
    toastEl = G.el('div', { class: 'toast', text: msg });
    document.body.appendChild(toastEl);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
      toastEl = null;
    }, ms || 2400);
  }

  var bannerEl = null;

  function banner(msg, kind) {
    if (bannerEl) return;
    bannerEl = G.el('div', {
      class: 'banner banner-' + (kind || 'info'),
      onclick: function () { dismissBanner(); }
    }, [G.el('span', { text: msg }), G.el('span', { class: 'banner-x', text: '✕' })]);
    document.body.appendChild(bannerEl);
  }

  function dismissBanner() {
    if (bannerEl && bannerEl.parentNode) bannerEl.parentNode.removeChild(bannerEl);
    bannerEl = null;
  }

  /* ---------- 进度点 ---------- */

  function progressDots(total, current, results) {
    var wrap = G.el('div', { class: 'dots' });
    for (var i = 0; i < total; i++) {
      var cls = 'dot';
      if (results && results[i] === true) cls += ' dot-ok';
      else if (results && results[i] === false) cls += ' dot-bad';
      else if (i === current) cls += ' dot-now';
      wrap.appendChild(G.el('span', { class: cls }));
    }
    return wrap;
  }

  /* ---------- 对错反馈 ---------- */

  /**
   * 答对：绿色脉冲 + 音效。
   * 答错：抖动 + 显示正确答案，绝不惩罚性动画（6 岁孩子的挫败感阈值很低）。
   */
  function feedback(node, correct) {
    node.classList.add(correct ? 'fb-ok' : 'fb-bad');
    if (!correct) {
      // 抖动
      node.classList.add('shake');
      setTimeout(function () { node.classList.remove('shake'); }, 480);
    }
    setTimeout(function () {
      node.classList.remove('fb-ok', 'fb-bad');
    }, 700);
  }

  function confetti(container) {
    var n = 18;
    for (var i = 0; i < n; i++) {
      var p = G.el('span', { class: 'confetti' });
      p.style.left = (10 + Math.random() * 80) + '%';
      p.style.animationDelay = (Math.random() * 0.25) + 's';
      p.style.background = ['#FFD54F', '#4FC3F7', '#FF8A65', '#81C784', '#BA68C8'][i % 5];
      container.appendChild(p);
      (function (node) {
        setTimeout(function () {
          if (node.parentNode) node.parentNode.removeChild(node);
        }, 1400);
      })(p);
    }
  }

  /* ---------- 通用页面外壳 ---------- */

  function screen(extraClass) {
    return G.el('div', { class: 'screen ' + (extraClass || '') });
  }

  /**
   * 大喇叭按钮。英语听音题的题干就是它。
   * 可重复点 —— 6 岁孩子会反复听，不能只让听一次。
   */
  function speakerButton(audioId, label, opts) {
    opts = opts || {};
    var btn = G.el('button', {
      class: 'speaker' + (opts.small ? ' speaker-sm' : ''),
      onclick: function () {
        btn.classList.add('playing');
        G.Audio.play(audioId).then(function () {
          btn.classList.remove('playing');
        });
      }
    }, [
      G.el('span', { class: 'speaker-icon', text: '🔊' }),
      label ? G.el('span', { class: 'speaker-label', text: label }) : null
    ]);

    if (opts.autoplay) setTimeout(function () { btn.click(); }, 350);
    return btn;
  }

  G.UI = {
    toast: toast,
    banner: banner,
    dismissBanner: dismissBanner,
    progressDots: progressDots,
    feedback: feedback,
    confetti: confetti,
    screen: screen,
    speakerButton: speakerButton
  };

  // 供 10-store / 20-audio 里的降级路径调用
  G.toast = toast;
  G.banner = banner;

})(window);

/* ===== 10-store.js ===== */
/* 10-store.js — 存档读写、双 key 回滚、时钟回拨检测、备份导出/导入
 *
 * 存在 localStorage（不是 IndexedDB）：存档小（3-8 KB）、写入频繁、
 * 需要在 pagehide 时可靠落盘——IndexedDB 是异步的，可能来不及。
 * IndexedDB 只用来存家长录音的 Blob（见 20-audio.js）。
 */
(function (window) {
  'use strict';

  var G = window.G;

  var KEY = 'yxjx.save.v1';
  var KEY_BAK = 'yxjx.save.v1.bak';
  var KEY_META = 'yxjx.meta.v1';

  /* ---------- 默认存档 ---------- */

  function defaultSave() {
    var now = Date.now();
    return {
      schema: 1,
      createdAt: now,
      updatedAt: now,
      child: { name: '宝宝' },

      // balance 和 lifetime 独立累加，是防作弊审计的基础（见 70-parent.js）
      points: { balance: 0, lifetime: 0 },

      progress: {
        english: { familyStats: {}, typeStats: {} },
        chinese: { byTag: {} },
        math: { byTag: {} }
      },

      // 错题本是唯一真相源。cleared 的条件是 rightStreak >= 2。
      wrongBook: [],

      // 只保留最近 30 局，滚动丢弃
      sessions: [],

      // 全量保留（一年也就几十条），要支持周上限统计和待办
      redemptions: [],

      dailyCounters: {},

      limits: JSON.parse(JSON.stringify(G.LIMITS)),

      settings: {
        audioEnabled: true,
        mix: JSON.parse(JSON.stringify(G.DEFAULT_MIX)),
        englishUnlockedThrough: 'U2',
        mutedAudio: [],
        weakMode: false
      },

      integrity: {
        maxSeenTs: now,
        bootId: 0,
        clockTampered: false
      }
    };
  }

  /* ---------- 读写 ---------- */

  var _cache = null;

  function load() {
    if (_cache) return _cache;

    var raw = null;
    try { raw = window.localStorage.getItem(KEY); } catch (e) { /* 无痕模式 */ }

    if (raw) {
      var parsed = safeParse(raw);
      if (parsed && parsed.schema === 1) {
        _cache = migrate(parsed);
        return _cache;
      }
      // 主 key 损坏 → 尝试备份
      G.log('主存档解析失败，尝试备份');
      G.toast('存档损坏，已回滚到上一版');
    }

    var bak = null;
    try { bak = window.localStorage.getItem(KEY_BAK); } catch (e) {}
    if (bak) {
      var fromBak = safeParse(bak);
      if (fromBak && fromBak.schema === 1) {
        _cache = migrate(fromBak);
        return _cache;
      }
    }

    _cache = defaultSave();
    return _cache;
  }

  function safeParse(s) {
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  // 补齐旧版本缺失的字段，避免升级后 undefined 崩溃
  function migrate(save) {
    var def = defaultSave();
    Object.keys(def).forEach(function (k) {
      if (save[k] === undefined) save[k] = def[k];
    });
    Object.keys(def.settings).forEach(function (k) {
      if (save.settings[k] === undefined) save.settings[k] = def.settings[k];
    });
    Object.keys(def.limits).forEach(function (k) {
      if (save.limits[k] === undefined) save.limits[k] = def.limits[k];
    });
    return save;
  }

  function save(s) {
    s = s || _cache;
    if (!s) return false;
    s.updatedAt = Date.now();
    try {
      var prev = window.localStorage.getItem(KEY);
      if (prev) window.localStorage.setItem(KEY_BAK, prev);
      window.localStorage.setItem(KEY, JSON.stringify(s));
      return true;
    } catch (e) {
      G.log('存档写入失败', e);
      G.banner('进度无法保存（可能是无痕模式或存储已满）。建议在浏览器中打开，或做一次备份。', 'warn');
      return false;
    }
  }

  function reset() {
    _cache = defaultSave();
    save(_cache);
    return _cache;
  }

  /* ---------- 元数据（与存档分开存） ---------- */

  function meta() {
    try {
      return safeParse(window.localStorage.getItem(KEY_META)) || { lastBackupAt: 0, wechatWarned: false };
    } catch (e) {
      return { lastBackupAt: 0, wechatWarned: false };
    }
  }

  function setMeta(patch) {
    var m = meta();
    Object.keys(patch).forEach(function (k) { m[k] = patch[k]; });
    try { window.localStorage.setItem(KEY_META, JSON.stringify(m)); } catch (e) {}
    return m;
  }

  /* ---------- 时钟回拨检测 ----------
   * 孩子改手机时间重置每日上限是很可能发生的。检测到只冻结兑换 + 通知家长，
   * 绝不删数据或惩罚——改时区、跨日旅行都会误报，惩罚性逻辑会造成真实伤害。
   */

  function checkClock(s) {
    var now = Date.now();
    var skew = s.integrity.maxSeenTs - now;
    if (skew > 120000) {                     // 回拨超过 2 分钟
      if (!s.integrity.clockTampered) {
        s.integrity.clockTampered = true;
        G.log('检测到时钟回拨', skew, 'ms');
      }
      return true;
    }
    s.integrity.maxSeenTs = Math.max(s.integrity.maxSeenTs, now);
    return s.integrity.clockTampered;
  }

  /* ---------- 每日计数 ---------- */

  function todayCounter(s) {
    var key = G.localDateStr();
    if (!s.dailyCounters[key]) {
      s.dailyCounters[key] = { spins: 0, pointsEarned: 0, tvMinutes: 0, redemptions: 0 };
    }
    return s.dailyCounters[key];
  }

  // 清理 30 天前的条目，否则一年后这个对象会膨胀到几百个 key
  function pruneCounters(s) {
    var cutoff = Date.now() - 30 * 86400000;
    Object.keys(s.dailyCounters).forEach(function (k) {
      var parts = k.split('-');
      var t = new Date(+parts[0], +parts[1] - 1, +parts[2]).getTime();
      if (t < cutoff) delete s.dailyCounters[k];
    });
  }

  /* ---------- 备份导出 / 导入 ----------
   * iOS 上脚本可写存储 7 天未访问即被清空。导出是唯一可靠的备份手段。
   * 录音的 Blob 由 20-audio.js 提供（异步），所以整体是 Promise。
   */

  function exportAll() {
    var s = load();
    return G.Audio.dumpOverrides().then(function (overrides) {
      var payload = {
        kind: 'yxjx-backup',
        version: G.VERSION,
        exportedAt: Date.now(),
        save: s,
        // Blob 转 base64 一并带走，否则换设备后家长录音全丢
        overrides: overrides
      };
      return payload;
    });
  }

  function importAll(payload) {
    if (!payload || payload.kind !== 'yxjx-backup') {
      throw new Error('这不是本游戏的备份文件');
    }
    if (!payload.save || payload.save.schema !== 1) {
      throw new Error('备份内容无法识别');
    }
    _cache = migrate(payload.save);
    save(_cache);

    var n = (payload.overrides && payload.overrides.length) || 0;
    var restore = n ? G.Audio.loadOverrides(payload.overrides) : Promise.resolve(0);

    return restore.then(function (restored) {
      setMeta({ lastBackupAt: Date.now() });
      return { save: _cache, overrides: restored };
    });
  }

  /* ---------- 积分三方审计 ----------
   * lifetime / balance / sessions 三处独立累加。孩子要作弊得同时改三处且保持自洽。
   * 这比任何加密都有效，而且不需要保密。
   */

  function audit(s) {
    var spent = G.sum(s.redemptions, function (r) {
      return r.status === 'rejected' ? 0 : r.cost;
    });
    var expected = s.points.lifetime - spent;
    var sessionEarned = G.sum(s.sessions, function (x) { return x.pointsEarned || 0; });

    return {
      balance: s.points.balance,
      lifetime: s.points.lifetime,
      spent: spent,
      expected: expected,
      ok: s.points.balance === expected,
      // 最近 30 局的收入不可能超过累计收入
      sessionEarned: sessionEarned,
      sessionOk: sessionEarned <= s.points.lifetime
    };
  }

  G.Store = {
    KEY: KEY,
    defaultSave: defaultSave,
    load: load,
    save: save,
    reset: reset,
    meta: meta,
    setMeta: setMeta,
    checkClock: checkClock,
    todayCounter: todayCounter,
    pruneCounters: pruneCounters,
    exportAll: exportAll,
    importAll: importAll,
    audit: audit,
    // 供测试/调试注入
    _setCache: function (s) { _cache = s; }
  };

})(window);

/* ===== 20-audio.js ===== */
/* 20-audio.js — 音频层（全项目风险最高的文件）
 *
 * 三件事必须同时成立，任何一件失败都会改变架构：
 *   1. iOS 音频解锁          → 用 Web Audio 而非 <audio>（145 条音频不可能逐个预解锁）
 *   2. 微信内置浏览器        → 更严，需要 WeixinJSBridgeReady + 失败可见反馈
 *   3. 家长替换录音          → IndexedDB 存 Blob，优先级覆盖内置音频
 *
 * 覆盖优先级：家长禁用(静音) > 家长录音 > 内置音频 > null
 */
(function (window) {
  'use strict';

  var G = window.G;

  /* ---------- 状态 ---------- */

  var ctx = null;
  var buffers = {};              // { audioId: AudioBuffer }
  var pending = {};              // { audioId: Promise<AudioBuffer|null> }
  var overrides = {};            // { audioId: {blob, url, gain, ts} } — 家长录音
  var unlocked = false;
  var failStreak = 0;            // 连续播放失败次数
  var needsRebuild = false;      // 检测到僵尸 context，下次点击时重建

  var IDB_NAME = 'youxiaoxianjie';
  var IDB_STORE = 'overrides';

  /* ---------- AudioContext ---------- */

  function getCtx() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    return ctx;
  }

  /**
   * 全局解锁。必须在真实用户手势里调用（pointerdown / click，不能用 touchstart，
   * iOS 9 之后 touchstart 里启动音频已失效）。
   *
   * 一次 ctx.resume() 之后整个 context 永久解锁 —— 这是选 Web Audio 而不是
   * <audio> 元素的唯一原因。145 个 <audio> 元素需要 145 次预激活。
   */
  function unlock() {
    var c = getCtx();
    if (!c) return Promise.resolve(false);

    var p = (c.state === 'running') ? Promise.resolve() : c.resume();

    return p.then(function () {
      // 播一个 1 帧的静音 buffer。resume() 返回不等于真的出声了 ——
      // iOS 上曾出现 state 报 running 但实际静音的情况，所以要做一次真实播放探测。
      var s = c.createBufferSource();
      s.buffer = c.createBuffer(1, 1, c.sampleRate);
      s.connect(c.destination);
      s.start(0);
      unlocked = true;
      G.log('音频已解锁, state =', c.state);
      hideSoundPrompt();
      return true;
    }).catch(function (e) {
      G.log('音频解锁失败', e);
      return false;
    });
  }

  function isUnlocked() { return unlocked; }

  /* ---------- 僵尸 context 检测 ----------
   * 切后台/锁屏回来后，ctx.state 可能仍报 running 但实际已静音。
   */

  var hiddenAt = 0;

  function watchVisibility() {
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { hiddenAt = Date.now(); return; }

      if (hiddenAt && Date.now() - hiddenAt > 1000) {
        var c = getCtx();
        if (!c) return;
        c.resume().then(function () {
          // 探测是否真的还活着：播一个静音 buffer，看是否抛错
          try {
            var s = c.createBufferSource();
            s.buffer = c.createBuffer(1, 1, c.sampleRate);
            s.connect(c.destination);
            s.start(0);
          } catch (e) {
            G.log('检测到僵尸 AudioContext，标记重建');
            needsRebuild = true;
            unlocked = false;
          }
        }).catch(function () {
          needsRebuild = true;
          unlocked = false;
        });
      }
      hiddenAt = 0;
    });
  }

  function rebuildIfNeeded() {
    if (!needsRebuild) return;
    G.log('重建 AudioContext');
    try { if (ctx) ctx.close(); } catch (e) {}
    ctx = null;
    buffers = {};
    pending = {};
    needsRebuild = false;
  }

  /* ---------- 播放失败的用户可见反馈 ----------
   * 微信内置浏览器即使已经交互过，仍可能拒绝播放。连续失败 2 次就弹按钮，
   * 把解锁动作交回一次真实的点击。
   */

  var soundPromptEl = null;

  function showSoundPrompt() {
    if (soundPromptEl) return;
    soundPromptEl = G.el('button', {
      class: 'sound-prompt',
      onclick: function () {
        failStreak = 0;
        rebuildIfNeeded();
        unlock();
      }
    }, ['🔈 点这里开启声音']);
    document.body.appendChild(soundPromptEl);
  }

  function hideSoundPrompt() {
    if (soundPromptEl && soundPromptEl.parentNode) {
      soundPromptEl.parentNode.removeChild(soundPromptEl);
    }
    soundPromptEl = null;
  }

  /* ---------- 解析：覆盖优先级 ---------- */

  function resolve(audioId) {
    if (!audioId) return Promise.resolve(null);

    var s = G.Store.load();
    if (!s.settings.audioEnabled) return Promise.resolve(null);
    if (s.settings.mutedAudio.indexOf(audioId) >= 0) return Promise.resolve(null);

    // 1. 家长录音（最高优先级）
    if (overrides[audioId]) {
      return getOverrideBuffer(audioId).then(function (buf) {
        return buf ? { buffer: buf, gain: overrides[audioId].gain || 1.0, src: 'override' } : null;
      });
    }

    // 2. 内置音频
    var entry = G.AUDIO_MAP && G.AUDIO_MAP[audioId];
    if (entry) {
      return getBuffer(audioId, entry.src).then(function (buf) {
        return buf ? { buffer: buf, gain: 1.0, src: 'builtin' } : null;
      });
    }

    // 3. 无
    return Promise.resolve(null);
  }

  /* ---------- 内置音频解码 ---------- */

  function getBuffer(audioId, src) {
    if (buffers[audioId]) return Promise.resolve(buffers[audioId]);
    if (pending[audioId]) return pending[audioId];

    var c = getCtx();
    if (!c) return Promise.resolve(null);

    pending[audioId] = fetchBytes(src).then(function (bytes) {
      return new Promise(function (res, rej) {
        // Safari 只支持 callback 形式，不支持 Promise 形式
        c.decodeAudioData(bytes, res, rej);
      });
    }).then(function (buf) {
      buffers[audioId] = buf;
      delete pending[audioId];
      return buf;
    }).catch(function (e) {
      G.log('解码失败', audioId, e);
      delete pending[audioId];
      return null;
    });

    return pending[audioId];
  }

  function fetchBytes(src) {
    // 单文件版：src 是 data URI，不需要网络
    if (src.indexOf('data:') === 0) {
      var comma = src.indexOf(',');
      var b64 = src.slice(comma + 1);
      var bin = window.atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return Promise.resolve(bytes.buffer);
    }
    return fetch(src).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + src);
      return r.arrayBuffer();
    });
  }

  /* ---------- 播放 ---------- */

  function play(audioId, opts) {
    opts = opts || {};
    rebuildIfNeeded();

    return resolve(audioId).then(function (hit) {
      if (!hit) return false;

      var c = getCtx();
      if (!c || c.state !== 'running') {
        // 还没解锁：尝试一次，失败则提示
        return unlock().then(function (ok) {
          if (!ok) { maybePrompt(); return false; }
          return doPlay(c, hit, opts);
        });
      }
      return doPlay(c, hit, opts);
    });
  }

  function doPlay(c, hit, opts) {
    return new Promise(function (res) {
      try {
        var src = c.createBufferSource();
        src.buffer = hit.buffer;

        var gain = c.createGain();
        gain.gain.value = (hit.gain || 1) * (opts.volume === undefined ? 1 : opts.volume);

        src.connect(gain);
        gain.connect(c.destination);
        src.onended = function () { failStreak = 0; res(true); };
        src.start(0);
      } catch (e) {
        G.log('播放异常', e);
        maybePrompt();
        res(false);
      }
    });
  }

  function maybePrompt() {
    failStreak++;
    if (failStreak >= 2) showSoundPrompt();
  }

  /**
   * 播放一个序列，片段之间留固定间隔。
   * 数学题的动态题干靠这个拼：「3 加 4 等于几」= num.3 + op.add + num.4 + op.eq + op.howmany
   * 用 Web Audio 的 start(when) 精确排期，不靠 setTimeout（后者在移动端会被节流）。
   */
  function playSequence(ids, opts) {
    opts = opts || {};
    var gap = opts.gap === undefined ? 0.08 : opts.gap;

    var c = getCtx();
    if (!c) return Promise.resolve(false);

    var doIt = function () {
      return Promise.all(ids.map(resolve)).then(function (hits) {
        var t = c.currentTime + 0.02;
        var last = null;
        hits.forEach(function (hit) {
          if (!hit) return;
          var src = c.createBufferSource();
          src.buffer = hit.buffer;
          var g = c.createGain();
          g.gain.value = (hit.gain || 1) * (opts.volume === undefined ? 1 : opts.volume);
          src.connect(g);
          g.connect(c.destination);
          src.start(t);
          t += hit.buffer.duration + gap;
          last = src;
        });
        if (!last) return false;
        return new Promise(function (res) {
          last.onended = function () { res(true); };
        });
      });
    };

    if (c.state !== 'running') {
      return unlock().then(function (ok) { return ok ? doIt() : false; });
    }
    return doIt();
  }

  /**
   * 带降级的播放 —— 音素音是目前最大的内容风险点（edge-tts 读单个音素不可靠）。
   * 如果音素音缺失或质量差，blend 题要能退回整词音。
   * 这个降级路径必须在 Phase 0 就存在，否则 Phase 1 发现音素音不行时要返工整个 blend 题。
   */
  function playWithFallback(primaryId, fallbackId, opts) {
    return resolve(primaryId).then(function (hit) {
      if (hit) return play(primaryId, opts);
      G.log('音频缺失，降级到', fallbackId);
      return play(fallbackId, opts);
    });
  }

  function has(audioId) {
    return !!(overrides[audioId] || (G.AUDIO_MAP && G.AUDIO_MAP[audioId]));
  }

  /* ---------- 预加载 ---------- */

  /**
   * 按需预加载。不阻塞 UI —— 先渲染题目骨架，音频到了再点亮喇叭图标。
   */
  function preload(ids) {
    var list = ids.filter(function (id) { return id && G.AUDIO_MAP && G.AUDIO_MAP[id]; });
    return Promise.all(list.map(function (id) {
      return getBuffer(id, G.AUDIO_MAP[id].src);
    }));
  }

  /* ---------- IndexedDB：家长录音 ---------- */

  var _db = null;

  function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (res, rej) {
      var req = window.indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = function () { _db = req.result; res(_db); };
      req.onerror = function () { rej(req.error); };
    });
  }

  function idbPut(rec) {
    return openDB().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(rec);
        tx.oncomplete = function () { res(rec.id); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }

  function idbGet(id) {
    return openDB().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(IDB_STORE, 'readonly');
        var req = tx.objectStore(IDB_STORE).get(id);
        req.onsuccess = function () { res(req.result || null); };
        req.onerror = function () { rej(req.error); };
      });
    });
  }

  function idbAll() {
    return openDB().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(IDB_STORE, 'readonly');
        var req = tx.objectStore(IDB_STORE).getAll();
        req.onsuccess = function () { res(req.result || []); };
        req.onerror = function () { rej(req.error); };
      });
    });
  }

  function idbDelete(id) {
    return openDB().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(id);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }

  /* ---------- 录音 ---------- */

  var recorder = null;
  var recChunks = [];
  var recStream = null;

  /**
   * iOS Safari 只支持 audio/mp4，不支持 audio/webm。这是整个替换功能的地基。
   * 探测结果写进 selftest（99-selftest.js）。
   */
  function pickMimeType() {
    if (!window.MediaRecorder || !window.MediaRecorder.isTypeSupported) return null;
    var candidates = [
      'audio/mp4',
      'audio/mp4;codecs=mp4a.40.2',
      'audio/aac',
      'audio/webm;codecs=opus',
      'audio/webm'
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (window.MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return null;
  }

  var usePcmFallback = false;

  function startRecording() {
    return navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      recStream = stream;
      recChunks = [];

      var mime = pickMimeType();
      if (!mime) {
        // 兜底：抓原始 PCM 自己编 WAV（约 30 行，无依赖）
        G.log('MediaRecorder 不可用，走 PCM→WAV 兜底');
        usePcmFallback = true;
        return startPcmRecording(stream);
      }

      usePcmFallback = false;
      recorder = new window.MediaRecorder(stream, { mimeType: mime });
      recorder.ondataavailable = function (e) {
        if (e.data && e.data.size > 0) recChunks.push(e.data);
      };
      recorder.start();
      return true;
    });
  }

  function stopRecording() {
    if (usePcmFallback) return stopPcmRecording();

    return new Promise(function (res) {
      if (!recorder) return res(null);
      recorder.onstop = function () {
        var blob = new Blob(recChunks, { type: recorder.mimeType || 'audio/mp4' });
        cleanupStream();
        res(blob);
      };
      recorder.stop();
    });
  }

  /* --- PCM → WAV 兜底 --- */

  var pcmChunks = [];
  var pcmNode = null;
  var pcmSource = null;

  function startPcmRecording(stream) {
    var c = getCtx();
    pcmSource = c.createMediaStreamSource(stream);
    // ScriptProcessor 已废弃但兼容性最好；AudioWorklet 在 iOS 上需要额外加载模块文件，
    // 而单文件版没有独立的 worklet 文件可加载。
    pcmNode = c.createScriptProcessor(4096, 1, 1);
    pcmChunks = [];
    pcmNode.onaudioprocess = function (e) {
      pcmChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    pcmSource.connect(pcmNode);
    pcmNode.connect(c.destination);   // 有些浏览器不连 destination 就不触发
    return true;
  }

  function stopPcmRecording() {
    return new Promise(function (res) {
      try { pcmNode.disconnect(); pcmSource.disconnect(); } catch (e) {}
      var flat = flattenPcm(pcmChunks);
      var blob = encodeWav(flat, getCtx().sampleRate);
      cleanupStream();
      res(blob);
    });
  }

  function flattenPcm(chunks) {
    var len = G.sum(chunks, function (c) { return c.length; });
    var out = new Float32Array(len);
    var off = 0;
    chunks.forEach(function (c) { out.set(c, off); off += c.length; });
    return out;
  }

  function encodeWav(samples, sampleRate) {
    var buf = new ArrayBuffer(44 + samples.length * 2);
    var view = new DataView(buf);

    function str(off, s) {
      for (var i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    }
    str(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);          // PCM
    view.setUint16(22, 1, true);          // 单声道
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    str(36, 'data');
    view.setUint32(40, samples.length * 2, true);

    var off = 44;
    for (var i = 0; i < samples.length; i++) {
      var s = G.clamp(samples[i], -1, 1);
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      off += 2;
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  function cleanupStream() {
    if (recStream) {
      recStream.getTracks().forEach(function (t) { t.stop(); });
      recStream = null;
    }
    recorder = null;
    pcmNode = null;
    pcmSource = null;
  }

  /* ---------- 覆盖管理 ---------- */

  function setOverride(id, blob, gain) {
    return idbPut({
      id: id,
      blob: blob,
      gain: gain === undefined ? 1.0 : gain,
      ts: Date.now(),
      source: 'parent-recorded'
    }).then(function () {
      overrides[id] = { blob: blob, gain: gain === undefined ? 1.0 : gain, ts: Date.now() };
      delete buffers['__override__' + id];
      return true;
    });
  }

  function removeOverride(id) {
    return idbDelete(id).then(function () {
      delete overrides[id];
      delete buffers['__override__' + id];
      return true;
    });
  }

  function getOverrideBuffer(id) {
    var key = '__override__' + id;
    if (buffers[key]) return Promise.resolve(buffers[key]);

    return idbGet(id).then(function (rec) {
      if (!rec || !rec.blob) return null;
      return rec.blob.arrayBuffer().then(function (bytes) {
        var c = getCtx();
        if (!c) return null;
        return new Promise(function (res, rej) {
          c.decodeAudioData(bytes, res, rej);
        }).then(function (buf) {
          buffers[key] = buf;
          return buf;
        }).catch(function (e) {
          G.log('家长录音解码失败', id, e);
          return null;
        });
      });
    });
  }

  // 启动时把所有家长录音的元信息读进内存，供 resolve 同步判断
  function loadOverrideIndex() {
    return idbAll().then(function (recs) {
      overrides = {};
      recs.forEach(function (r) {
        overrides[r.id] = { blob: r.blob, gain: r.gain, ts: r.ts };
      });
      G.log('已加载家长录音', Object.keys(overrides).length, '条');
      return overrides;
    }).catch(function (e) {
      G.log('读取家长录音索引失败', e);
      return {};
    });
  }

  /* ---------- 备份：Blob ↔ base64 ---------- */

  function blobToBase64(blob) {
    return new Promise(function (res) {
      var fr = new FileReader();
      fr.onload = function () {
        res(String(fr.result).split(',')[1]);
      };
      fr.readAsDataURL(blob);
    });
  }

  function base64ToBlob(b64, type) {
    var bin = window.atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: type || 'audio/mp4' });
  }

  function dumpOverrides() {
    var ids = Object.keys(overrides);
    return Promise.all(ids.map(function (id) {
      return blobToBase64(overrides[id].blob).then(function (b64) {
        return { id: id, data: b64, gain: overrides[id].gain, mime: overrides[id].blob.type };
      });
    })).catch(function (e) {
      G.log('导出录音失败', e);
      return [];
    });
  }

  function loadOverrides(list) {
    return Promise.all(list.map(function (item) {
      var blob = base64ToBlob(item.data, item.mime);
      return setOverride(item.id, blob, item.gain);
    })).then(function () { return list.length; });
  }

  /* ---------- 初始化 ---------- */

  function init() {
    watchVisibility();
    loadOverrideIndex();

    // 微信内置浏览器更严。WeixinJSBridgeReady 是微信最早可用的时机。
    if (G.env.isWeChat) {
      document.addEventListener('WeixinJSBridgeReady', function () {
        G.log('WeixinJSBridgeReady');
      }, false);
    }

    // 兜底：任何一次指针按下都尝试解锁（once 只保证主路径不重复，这里持续监听以防僵尸 context）
    document.addEventListener('pointerdown', function () {
      rebuildIfNeeded();
      if (!unlocked) unlock();
    }, { passive: true });
  }

  G.Audio = {
    init: init,
    unlock: unlock,
    isUnlocked: isUnlocked,
    resolve: resolve,
    play: play,
    playSequence: playSequence,
    playWithFallback: playWithFallback,
    preload: preload,
    has: has,

    startRecording: startRecording,
    stopRecording: stopRecording,
    pickMimeType: pickMimeType,
    setOverride: setOverride,
    removeOverride: removeOverride,
    loadOverrides: loadOverrides,
    dumpOverrides: dumpOverrides,
    listOverrides: function () { return Object.keys(overrides); },
    getOverrideMeta: function (id) { return overrides[id] || null; },

    // 调试用
    _buffers: function () { return buffers; },
    _ctx: function () { return ctx; }
  };

})(window);

/* ===== 30-curriculum.js ===== */
/* 30-curriculum.js — OPW2 课程表、解锁、干扰项生成、加权抽题
 *
 * 英语模块教学质量的核心。两个设计约束：
 *   1. 解锁由家长控制，不由游戏自动解锁 —— 游戏进度和课外班进度是两回事
 *   2. 范围之内按「新鲜度 × 薄弱度 × 冷却」加权，不均匀随机 ——
 *      均匀随机会让 -ag 这类低频词族永远得不到练习，而孩子已熟的在浪费时间
 */
(function (window) {
  'use strict';

  var G = window.G;

  var cur = null;                    // curriculum.json 内容
  var questions = { chinese: [], math: [], english: [] };
  var wordsByFamily = {};            // { family: [word] }
  var allWords = {};                 // { word: family } 全局词表，用于最小对立判断

  /* ---------- 加载 ---------- */

  function init(data) {
    cur = data.curriculum || (window.G.CURRICULUM_DATA);
    questions.chinese = (data.chinese || []).slice();
    questions.math = (data.math || []).slice();
    questions.english = (data.english || []).slice();

    if (!cur) throw new Error('缺少 curriculum 数据');

    wordsByFamily = {};
    allWords = {};
    Object.keys(cur.families).forEach(function (fam) {
      var ws = cur.families[fam].words || [];
      wordsByFamily[fam] = ws;
      ws.forEach(function (w) { allWords[w] = fam; });
    });

    G.log('课程已加载', Object.keys(cur.families).length, '个词族,',
          questions.chinese.length, questions.math.length, questions.english.length, '道题');
  }

  function curriculum() { return cur; }

  function unitById(id) {
    return cur.units.filter(function (u) { return u.id === id; })[0] || null;
  }

  /* ---------- 解锁 ---------- */

  /**
   * 家长在面板里选「孩子课上到哪了」，游戏只在这个范围内出题。
   * 若游戏自动解锁，孩子天赋好就会解锁到 U6 而老师才教到 U3 ——
   * 做 U6 全靠猜，会形成错误的拼读直觉。
   */
  function unlockedUnitIds(save) {
    var through = save.settings.englishUnlockedThrough || 'U2';
    var out = [];
    for (var i = 0; i < cur.units.length; i++) {
      out.push(cur.units[i].id);
      if (cur.units[i].id === through) break;
    }
    return out;
  }

  function unlockedFamilies(save) {
    var units = unlockedUnitIds(save);
    var out = [];
    units.forEach(function (uid) {
      var u = unitById(uid);
      if (u) out = out.concat(u.families);
    });
    return out;
  }

  function familyInUnit(family, unitId) {
    var u = unitById(unitId);
    return !!(u && u.families.indexOf(family) >= 0);
  }

  /* ---------- 英语加权 ---------- */

  var COOLDOWN_MS = 5 * 60 * 1000;   // 同一词族 5 分钟内刚出现过就大幅降权

  function familyWeight(family, save, recentFamilies) {
    var st = save.progress.english.familyStats[family] || { seen: 0, correct: 0, lastSeen: 0 };
    var units = unlockedUnitIds(save);
    var latest = units[units.length - 1];

    // 最近学的单元占大头（×2.5）
    var freshness = familyInUnit(family, latest) ? 1.0 : 0.4;

    // 错得多的多出
    var wrongRate = st.seen > 0 ? 1 - (st.correct / st.seen) : 0.5;
    var weakness = 1 + 0.5 * wrongRate;

    // 本局内已经用过该词族 → 降权，避免一局 3 道英语题全是 -an
    var used = (recentFamilies || []).indexOf(family) >= 0;

    // 刚做过 → 降权
    var cooled = st.lastSeen && (Date.now() - st.lastSeen < COOLDOWN_MS);

    var w = freshness * weakness * (used ? 0.05 : 1) * (cooled ? 0.2 : 1);
    return Math.max(w, 0.01);
  }

  function pickFamily(save, rng, recentFamilies) {
    var fams = unlockedFamilies(save);
    var weights = fams.map(function (f) { return familyWeight(f, save, recentFamilies); });
    var total = G.sum(weights);
    var r = rng() * total;
    for (var i = 0; i < fams.length; i++) {
      r -= weights[i];
      if (r <= 0) return fams[i];
    }
    return fams[fams.length - 1];
  }

  /* ---------- 干扰项生成 ----------
   * 100 道英语题手工写选项必然出错，而且很容易写出「孩子不用听就能排除」的废题
   * （比如 fan vs box）。所以干扰项必须程序化生成，且必须是最小对立对。
   */

  /**
   * 拆词：fan → {onset:'f', vowel:'a', coda:'n'}
   * 只处理 CVC（含 -ix 这类 CC 结尾）。
   */
  function split(word) {
    var m = word.match(/^([bcdfghjklmnpqrstvwyz]*)([aeiou])(.*)$/);
    if (!m) return null;
    return { onset: m[1], vowel: m[2], coda: m[3] };
  }

  /**
   * 最小对立干扰项。优先级：
   *   1. vowel-contrast  —— 换元音（OPW2 的核心考点）
   *   2. minimal-pair-initial —— 同词族换首音
   *   3. same-coda       —— 同尾不同元音
   * 全部要求是真实存在的词（用全局词表判断），否则孩子会靠「这词没见过」来排除。
   */
  function makeDistractors(word, family, unlockedFams, count) {
    count = count || 2;
    var parts = split(word);
    if (!parts) return [];

    var vowelOrder = (cur.minimalPairs.vowelSwaps[parts.vowel] || []).slice();
    var out = [];
    var seen = {};
    seen[word] = true;

    function add(w, kind) {
      if (!w || seen[w] || out.length >= count) return;
      seen[w] = true;
      out.push({ text: w, kind: kind });
    }

    // 1. 换元音，保持首音和尾音（fan → fin / fun）—— 最能考查短元音辨析
    vowelOrder.forEach(function (v) {
      var cand = parts.onset + v + parts.coda;
      if (allWords[cand]) add(cand, 'vowel-contrast');
    });

    // 2. 同词族换首音（fan → man / pan）
    var famWords = wordsByFamily[family] || [];
    G.shuffle(famWords, Math.random).forEach(function (w) {
      if (w !== word && split(w) && split(w).vowel === parts.vowel) {
        add(w, 'minimal-pair-initial');
      }
    });

    // 3. 同尾音不同元音，跨词族（兜底，保证一定凑够 count 个）
    if (out.length < count) {
      Object.keys(allWords).forEach(function (w) {
        if (out.length >= count) return;
        var p = split(w);
        if (p && p.coda === parts.coda && p.vowel !== parts.vowel && p.onset === parts.onset) {
          add(w, 'same-coda');
        }
      });
    }

    // 4. 仍不够就从已解锁词族里随便补真实词（宁可削弱区分度，也不能有假词选项）
    if (out.length < count) {
      var pool = [];
      unlockedFams.forEach(function (f) {
        pool = pool.concat(wordsByFamily[f] || []);
      });
      G.shuffle(pool, Math.random).forEach(function (w) { add(w, 'filler'); });
    }

    return out;
  }

  /**
   * 组装一道 listen 题的选项：1 个正确答案 + N 个最小对立干扰项，打乱。
   */
  function buildListenOptions(answerWord, family, unlockedFams, rng) {
    var n = 2;                                   // 6 岁工作记忆有限，3 个选项足够
    var ds = makeDistractors(answerWord, family, unlockedFams, n);
    var opts = [{ text: answerWord, kind: 'answer' }].concat(ds);
    opts = G.shuffle(opts, rng);
    return opts.map(function (o, i) {
      return { id: String.fromCharCode(97 + i), text: o.text, _kind: o.kind };
    });
  }

  /* ---------- 程序化生成题（数学） ----------
   * JSON 里只写模板，运行时用固定种子展开。投入产出比最高的一处。
   */

  function instantiateGenerator(q, rng) {
    var g = q.generator;
    var out = JSON.parse(JSON.stringify(q));
    out._generated = true;

    if (g.kind === 'add' || g.kind === 'sub') {
      var a, b, ans, guard = 0;
      do {
        a = G.randInt(rng, g.a[0], g.a[1]);
        b = G.randInt(rng, g.b[0], g.b[1]);
        guard++;
      } while (guard < 200 && !evalConstraint(g.constraint, a, b));

      if (g.kind === 'add') {
        ans = a + b;
        out.stem.text = g.missing === 'b'
          ? (a + ' + ? = ' + ans)          // 填加数，比直接算和难一档
          : (a + ' + ' + b + ' = ?');
      } else {
        ans = a - b;
        out.stem.text = g.missing === 'b'
          ? (a + ' − ? = ' + ans)
          : (a + ' − ' + b + ' = ?');
      }

      // 干扰项 = 正确答案 ±1/±2，都是「算错会得到的数」，比随机数有区分度得多
      var wrongs = nearMiss(ans, g.optionRule);
      out.options = makeNumericOptions(ans, wrongs, rng);
      out.answer = out.options.filter(function (o) { return o.text === String(ans); })[0].id;
      out.explain = buildExplain(g.kind, a, b, ans, g.missing);
      out._meta = { a: a, b: b, ans: ans };
    }

    else if (g.kind === 'compare') {
      var x, y, guard2 = 0;
      do {
        x = G.randInt(rng, g.a[0], g.a[1]);
        y = G.randInt(rng, g.b[0], g.b[1]);
        guard2++;
      } while (guard2 < 200 && !evalConstraint(g.constraint, x, y));

      var big = Math.max(x, y);
      var small = Math.min(x, y);
      // 3 个选项，避免 50% 蒙对率
      var third = small > 1 ? small - 1 : big + 1;
      out.stem.text = x + ' 和 ' + y + '，哪个大？';
      out.options = makeNumericOptions(big, [small, third], rng);
      out.answer = out.options.filter(function (o) { return o.text === String(big); })[0].id;
      out.explain = big + ' 比 ' + Math.min(x, y) + ' 大。';
      out._meta = { a: x, b: y, ans: big };
    }

    else if (g.kind === 'count') {
      // 数一数：随机撒几个图形，让孩子点数
      var n = G.randInt(rng, g.n[0], g.n[1]);
      var shapes = ['🍎', '⭐', '🐟', '🌸', '🎈'];
      var shape = G.pick(shapes, rng);
      var line = [];
      for (var i = 0; i < n; i++) line.push(shape);

      out.stem.text = line.join(' ') + '\n一共有几个？';
      out.stem.layout = 'count';
      out.options = makeNumericOptions(n, nearMiss(n, g.optionRule), rng);
      out.answer = out.options.filter(function (o) { return o.text === String(n); })[0].id;
      out.explain = '数一数，一共 ' + n + ' 个。';
      out._meta = { ans: n };
    }

    return out;
  }

  function makeNumericOptions(ans, wrongs, rng) {
    var vals = [ans].concat(wrongs);
    // 去重 + 去负
    var seen = {};
    vals = vals.filter(function (v) {
      if (v < 0 || seen[v]) return false;
      seen[v] = true;
      return true;
    });
    var opts = G.shuffle(vals, rng).map(function (v, i) {
      return { id: String.fromCharCode(97 + i), text: String(v) };
    });
    return opts;
  }

  function buildExplain(kind, a, b, ans, missing) {
    if (kind === 'add') {
      if (missing === 'b') return a + ' 再加 ' + b + ' 才是 ' + ans + '。';
      return a + ' 和 ' + b + ' 合起来是 ' + ans + '。';
    }
    if (missing === 'b') return a + ' 拿走 ' + b + ' 还剩 ' + ans + '。';
    return a + ' 拿走 ' + b + ' 还剩 ' + ans + '。';
  }

  function evalConstraint(expr, a, b) {
    if (!expr) return true;
    try {
      /* jshint evil:true */
      return !!(new Function('a', 'b', 'return (' + expr + ');'))(a, b);
    } catch (e) { return true; }
  }

  function nearMiss(ans, rule) {
    if (rule === 'near-miss') {
      var cands = [ans + 1, ans - 1, ans + 2, ans - 2, ans + 10, ans - 10]
        .filter(function (v) { return v >= 0 && v !== ans; });
      return cands.slice(0, 3);
    }
    return [ans + 1, ans - 1, ans + 2];
  }

  /* ---------- 抽题 ---------- */

  function poolFor(subject) {
    return questions[subject] || [];
  }

  /**
   * 从某科目抽一题。rng 决定生成题的展开结果，所以同一天同一种子得到同一道题。
   */
  function drawOne(subject, save, dateSeed, excludeIds) {
    var pool = poolFor(subject);
    if (!pool.length) return null;

    var rng = G.rngFrom(dateSeed + '|' + subject + '|' + (excludeIds || []).length + '|' + Math.floor(Math.random() * 1e9));

    var avail = pool.filter(function (q) {
      if ((excludeIds || []).indexOf(q.id) >= 0) return false;
      if (subject === 'english') {
        if (!familyUnlocked(q.family, save)) return false;
      }
      return true;
    });
    if (!avail.length) avail = pool;

    var picked = weightedPickQuestion(avail, save, rng);
    if (picked.generator) return instantiateGenerator(picked, rng);

    // 英语 listen 题的选项每次现生成，避免固定选项被记住
    if (picked.type === 'listen') {
      var out = JSON.parse(JSON.stringify(picked));
      var fams = unlockedFamilies(save);
      var opts = buildListenOptions(out.answerWord, out.family, fams, rng);
      out.options = opts;
      out.answer = opts.filter(function (o) { return o.text === out.answerWord; })[0].id;
      return out;
    }

    return JSON.parse(JSON.stringify(picked));
  }

  function familyUnlocked(family, save) {
    if (!family) return false;
    return unlockedFamilies(save).indexOf(family) >= 0;
  }

  /**
   * 题型加权：错题本里的题加权重出，已 cleared 的降权。
   */
  function weightedPickQuestion(pool, save, rng) {
    var wrongIndex = {};
    save.wrongBook.forEach(function (w) { wrongIndex[w.qid] = w; });

    var weights = pool.map(function (q) {
      var w = 1;
      var rec = wrongIndex[q.id];
      if (rec && !rec.cleared) w += 1.5 * rec.wrongCount;   // 错题重出
      if (rec && rec.cleared) w *= 0.4;                      // 已掌握 → 降权
      return w;
    });

    var total = G.sum(weights);
    var r = rng() * total;
    for (var i = 0; i < pool.length; i++) {
      r -= weights[i];
      if (r <= 0) return pool[i];
    }
    return pool[pool.length - 1];
  }

  /**
   * 挑一局英语题：锁定同一词族的「听 → 拼 → 用」固定教学序列。
   * 这不是「3 个随机题型」——自然拼读的标准教学顺序是 hear it → build it → use it，
   * 随机化会破坏它。而且 OPW2 每单元就是围绕 2-4 个词族展开，一节课教一个词族，
   * 3 道题都围绕 -an 才是「这节课我们在学 -an」的体验。6 岁孩子需要聚焦，不是覆盖。
   */
  function buildEnglishSequence(save, dateSeed, recentFamilies) {
    var rng = G.rngFrom(dateSeed + '|english-seq|' + Math.floor(Math.random() * 1e9));
    var family = pickFamily(save, rng, recentFamilies);

    // sort / realword 可能覆盖多个词族，所以同时认 family 和 families 两个字段
    var pick = function (type, mode) {
      var pool = questions.english.filter(function (q) {
        if (q.type !== type) return false;
        if (mode && q.mode !== mode) return false;
        var fams = q.families || (q.family ? [q.family] : []);
        return fams.indexOf(family) >= 0;
      });
      if (!pool.length) return null;
      return pool[Math.floor(rng() * pool.length)];
    };

    var seq = [];
    var listen = pick('listen');
    if (listen) seq.push(materialize(listen, save, rng, 'listen'));

    var blend = pick('blend', 'vowel-gap') || pick('blend');
    if (blend) seq.push(materialize(blend, save, rng, 'blend'));

    // 第 3 槽 sort / realword 交替
    var useSort = (save.sessions.length % 2) === 0;
    var third = useSort ? pick('sort') : pick('realword');
    if (!third) third = pick('sort') || pick('realword');
    if (third) seq.push(materialize(third, save, rng, third.type));

    return { family: family, questions: seq.filter(Boolean) };
  }

  function materialize(q, save, rng, type) {
    var out = JSON.parse(JSON.stringify(q));
    delete out._familyPool;

    if (type === 'listen') {
      var fams = unlockedFamilies(save);
      var opts = buildListenOptions(out.answerWord, out.family, fams, rng);
      out.options = opts;
      out.answer = opts.filter(function (o) { return o.text === out.answerWord; })[0].id;
    }
    return out;
  }

  G.Curriculum = {
    init: init,
    curriculum: curriculum,
    unitById: unitById,
    unlockedUnitIds: unlockedUnitIds,
    unlockedFamilies: unlockedFamilies,
    familyInUnit: familyInUnit,
    familyWeight: familyWeight,
    pickFamily: pickFamily,
    makeDistractors: makeDistractors,
    buildListenOptions: buildListenOptions,
    instantiateGenerator: instantiateGenerator,
    drawOne: drawOne,
    buildEnglishSequence: buildEnglishSequence,
    split: split,
    wordsByFamily: function () { return wordsByFamily; },
    allWords: function () { return allWords; }
  };

})(window);

/* ===== 40-runner.js ===== */
/* 40-runner.js — 一局的编排：4/3/3 配比 + 位置软约束 + 答题结算
 *
 * 位置软约束是这里最重要的设计：
 *   第 1 题和第 10 题必来自孩子正确率最高的池。
 *   6 岁孩子最后一题的成败，直接决定他明天还想不想玩。
 */
(function (window) {
  'use strict';

  var G = window.G;

  /* ---------- 成功概率估计 ---------- */

  /**
   * 估计孩子答对某题的概率。有历史用历史，没历史用难度 + 是否刚学过做代理。
   * 只用来排位置，不参与计分。
   */
  function successProb(q, save) {
    var rec = null;
    save.wrongBook.forEach(function (w) { if (w.qid === q.id) rec = w; });
    if (rec && rec.seen > 0) return rec.correct / rec.seen;

    // 无历史：难度 1 → 0.9, 难度 2 → 0.75, 难度 3 → 0.6
    var byDiff = { 1: 0.9, 2: 0.75, 3: 0.6 }[q.difficulty || 1] || 0.75;

    // 英语：最新学过的单元更熟
    if (q.subject === 'english' && q.family) {
      var units = G.Curriculum.unlockedUnitIds(save);
      var latest = units[units.length - 1];
      if (G.Curriculum.familyInUnit(q.family, latest)) byDiff += 0.05;
    }
    return G.clamp(byDiff, 0.1, 0.98);
  }

  /* ---------- 组局 ---------- */

  function buildRound(save) {
    var mix = save.settings.mix || G.DEFAULT_MIX;
    var total = mix.chinese + mix.math + mix.english;
    var dateSeed = G.localDateStr();

    var rng = G.rngFrom(dateSeed + '|round|' + save.sessions.length + '|' + Math.floor(Math.random() * 1e9));
    var used = [];

    // 语文、数学各自抽
    var cn = [], ma = [];
    for (var i = 0; i < mix.chinese; i++) {
      var q1 = G.Curriculum.drawOne('chinese', save, dateSeed, used);
      if (q1) { cn.push(q1); used.push(q1.id); }
    }
    for (var j = 0; j < mix.math; j++) {
      var q2 = G.Curriculum.drawOne('math', save, dateSeed, used);
      if (q2) { ma.push(q2); used.push(q2.id); }
    }

    // 英语：同一词族的固定序列
    var enSeq = G.Curriculum.buildEnglishSequence(save, dateSeed, []);
    var en = enSeq.questions.slice(0, mix.english);

    G.log('本局英语词族 =', enSeq.family, '题数 =', en.length);

    // ---- 位置安排 ----
    var slots = new Array(total).fill(null);

    // 1. 英语 3 题落在位置 2–7（1-based）→ index 1..6
    var enSlots = G.shuffle([1, 2, 3, 4, 5, 6], rng).slice(0, en.length).sort(function (a, b) { return a - b; });
    en.forEach(function (q, i) {
      if (enSlots[i] !== undefined) slots[enSlots[i]] = q;
    });

    // 2. 剩余位置放语文数学
    var rest = cn.concat(ma);
    var freeIdx = [];
    for (var k = 0; k < total; k++) if (!slots[k]) freeIdx.push(k);

    // 语数交替铺开，避免连着 4 道数学
    rest = interleave(cn, ma);

    freeIdx.forEach(function (idx, i) {
      slots[idx] = rest[i] || null;
    });

    // 3. 第 1 题和第 10 题换成高正确率池里的题（位置上原有的题退回候补）
    var filled = slots.filter(Boolean);
    swapForEasy(slots, 0, filled, save, q => q.subject !== 'english');
    swapForEasy(slots, total - 1, filled, save, q => q.subject !== 'english');

    var out = slots.filter(Boolean);

    // 兜底：万一某科目题量不足导致槽位空缺
    while (out.length < total) {
      var extra = G.Curriculum.drawOne('chinese', save, dateSeed, out.map(function (q) { return q.id; }));
      if (!extra) break;
      out.push(extra);
    }

    return {
      family: enSeq.family,
      questions: out,
      startedAt: Date.now()
    };
  }

  function interleave(a, b) {
    var out = [], i = 0, j = 0;
    var takeA = true;
    while (i < a.length || j < b.length) {
      if (takeA && i < a.length) out.push(a[i++]);
      else if (!takeA && j < b.length) out.push(b[j++]);
      else if (i < a.length) out.push(a[i++]);
      else if (j < b.length) out.push(b[j++]);
      takeA = !takeA;
    }
    return out;
  }

  /**
   * 把指定位置换成「孩子最可能答对」的题。
   * 只在非英语题里换 —— 英语题的顺序有教学意义（听→拼→用），不能动。
   */
  function swapForEasy(slots, idx, filled, save, filterFn) {
    var current = slots[idx];
    if (!current) return;

    var candidates = filled.filter(function (q) {
      return q !== current && filterFn(q) && slots.indexOf(q) < 0;
    });
    if (!candidates.length) return;

    // 从候补里找一道比当前题更容易的
    var better = candidates
      .map(function (q) { return { q: q, p: successProb(q, save) }; })
      .filter(function (x) { return x.p > successProb(current, save) + 0.05; })
      .sort(function (a, b) { return b.p - a.p; })[0];

    if (better) {
      var oldIdx = slots.indexOf(better.q);
      slots[idx] = better.q;
      if (oldIdx >= 0) slots[oldIdx] = current;   // 换下来的题回填到原位置
    }
  }

  /* ---------- 答题结算 ---------- */

  /**
   * 记录一次作答。更新错题本、分项统计、局内记录。
   */
  function recordAnswer(save, q, correct, ms) {
    var now = Date.now();

    // --- 错题本（唯一真相源）---
    var rec = null;
    save.wrongBook.forEach(function (w) { if (w.qid === q.id) rec = w; });
    if (!rec) {
      rec = {
        qid: q.id, subject: q.subject, family: q.family || null,
        seen: 0, correct: 0, wrongCount: 0, rightStreak: 0,
        lastWrongAt: 0, cleared: false
      };
      save.wrongBook.push(rec);
    }
    rec.seen++;
    if (correct) {
      rec.correct++;
      rec.rightStreak++;
      if (rec.rightStreak >= 2) rec.cleared = true;   // 连对两次才算真会了
    } else {
      rec.wrongCount++;
      rec.rightStreak = 0;
      rec.cleared = false;
      rec.lastWrongAt = now;
    }

    // --- 分项统计 ---
    if (q.subject === 'english') {
      if (q.family) {
        var fs = save.progress.english.familyStats[q.family] ||
                 (save.progress.english.familyStats[q.family] = { seen: 0, correct: 0, lastSeen: 0 });
        fs.seen++; if (correct) fs.correct++;
        fs.lastSeen = now;
      }
      var ts = save.progress.english.typeStats[q.type] ||
               (save.progress.english.typeStats[q.type] = { seen: 0, correct: 0 });
      ts.seen++; if (correct) ts.correct++;
    } else {
      var bucket = save.progress[q.subject].byTag;
      (q.tags || []).forEach(function (tag) {
        var t = bucket[tag] || (bucket[tag] = { seen: 0, correct: 0 });
        t.seen++; if (correct) t.correct++;
      });
    }

    return rec;
  }

  /**
   * 累计积分，并受每日上限约束。
   * 注意：转盘中奖的 tv10 也要累加 tvMinutes —— 转盘免费送的和 80 分兑换的
   * 是同一份「动画片时间」，家长关心的是总时长。
   */
  function awardPoints(save, points) {
    if (points <= 0) return { awarded: 0, capped: false };

    var dc = G.Store.todayCounter(save);
    var limit = save.limits.maxPointsPerDay;
    var room = Math.max(0, limit - dc.pointsEarned);
    var awarded = Math.min(points, room);

    dc.pointsEarned += awarded;
    save.points.balance += awarded;
    save.points.lifetime += awarded;

    return { awarded: awarded, capped: awarded < points };
  }

  function awardTvMinutes(save, minutes) {
    var dc = G.Store.todayCounter(save);
    dc.tvMinutes += minutes;
    return dc.tvMinutes;
  }

  function finishSession(save, round, items, spins, pointsEarned) {
    var session = {
      id: 's_' + round.startedAt,
      ts: Date.now(),
      correct: items.filter(function (x) { return x.correct; }).length,
      total: items.length,
      pointsEarned: pointsEarned,
      family: round.family || null,
      items: items,
      spins: spins
    };
    save.sessions.push(session);
    while (save.sessions.length > 30) save.sessions.shift();   // 只留最近 30 局
    G.Store.pruneCounters(save);
    G.Store.save(save);
    return session;
  }

  G.Runner = {
    buildRound: buildRound,
    successProb: successProb,
    recordAnswer: recordAnswer,
    awardPoints: awardPoints,
    awardTvMinutes: awardTvMinutes,
    finishSession: finishSession
  };

})(window);

/* ===== 41-render-choice.js ===== */
/* 41-render-choice.js — 选择题渲染器（choice 与 listen 共用）
 *
 * choice 和 listen 从渲染代码看是同一个东西：题干 + N 个选项。
 * 差别只是题干是文字还是音频。写两套渲染器是重复劳动，会带来两份 bug。
 * 它们真正不同的地方在内容模型（listen 的干扰项是最小对立对），那个在
 * 30-curriculum.js 里处理。
 */
(function (window) {
  'use strict';

  var G = window.G;

  G.Renderers = G.Renderers || {};

  G.Renderers.choice = function (container, q, handlers) {
    var options = q.options || [];
    var layout = (q.stem && q.stem.layout) || (options.length <= 2 ? 'row' : 'grid');
    var answered = false;

    var root = G.el('div', { class: 'q q-choice' });

    // ---- 题干 ----
    var stem = G.el('div', { class: 'stem' });

    if (q.type === 'listen') {
      // 听音辨认：不显示文字，纯听。答完才露出拼写。
      stem.appendChild(G.el('div', { class: 'stem-hint', text: '听一听，是哪个词？' }));
      stem.appendChild(G.UI.speakerButton(q.audio && q.audio[0], null, { autoplay: true }));

    } else if (q.type === 'prompt' || (q.stem && q.stem.audio)) {
      // 有语音的题干（语文拼音等）
      stem.appendChild(G.el('div', { class: 'stem-hint', text: q.stem.prompt || '' }));
      stem.appendChild(G.UI.speakerButton(q.stem.audio, null, { autoplay: true }));

    } else if (q.stem && q.stem.text) {
      var cls = 'stem-text';
      if (layout === 'big-number') cls += ' stem-number';
      else if (layout === 'count') cls += ' stem-count';
      stem.appendChild(G.el('div', { class: cls, text: q.stem.text }));
      if (q.stem.audio) {
        stem.appendChild(G.UI.speakerButton(q.stem.audio, null, { small: true }));
      }
    }

    root.appendChild(stem);

    // ---- 选项 ----
    var grid = G.el('div', { class: 'options options-' + layout });
    var buttons = {};

    options.forEach(function (opt) {
      var btn = G.el('button', {
        class: 'option',
        'data-id': opt.id,
        onclick: function () { choose(opt); }
      }, [G.el('span', { class: 'option-text', text: opt.text })]);

      buttons[opt.id] = btn;
      grid.appendChild(btn);
    });

    root.appendChild(grid);

    // ---- 解释条（答错时出现）----
    var explainBar = G.el('div', { class: 'explain hidden' });
    root.appendChild(explainBar);

    container.appendChild(root);

    function choose(opt) {
      if (answered) return;
      answered = true;

      var correct = opt.id === q.answer;
      G.UI.feedback(buttons[opt.id], correct);

      // 锁定所有选项，正确项高亮
      Object.keys(buttons).forEach(function (id) {
        buttons[id].classList.add('locked');
        if (id === q.answer) buttons[id].classList.add('is-answer');
      });

      // listen 题答完才显示拼写 —— 否则孩子靠字形猜
      if (q.type === 'listen') {
        stem.querySelectorAll('.stem-hint').forEach(function (n) {
          n.textContent = q.answerWord ? '答案是：' + q.answerWord : '';
        });
      }

      // 播放该选项自己的音（listen 题的选项本身就是词）
      var chosenWord = (q.options.filter(function (o) { return o.id === opt.id; })[0] || {}).text;
      if (q.type === 'listen' && chosenWord && G.Audio.has('word.' + chosenWord)) {
        setTimeout(function () { G.Audio.play('word.' + chosenWord); }, 260);
      }

      if (!correct) {
        showExplain(q.explain);
        if (q.explainAudio) {
          setTimeout(function () { G.Audio.play(q.explainAudio); }, 700);
        }
      } else {
        G.UI.confetti(container);
      }

      setTimeout(function () { handlers.onAnswer(correct); }, correct ? 620 : 1500);
    }

    function showExplain(text) {
      if (!text) return;
      explainBar.textContent = text;
      explainBar.classList.remove('hidden');
    }

    return { destroy: function () { /* 容器由调用方清空 */ } };
  };

})(window);

/* ===== 42-render-blend.js ===== */
/* 42-render-blend.js — 拼读合成题（OPW2 的核心题型）
 *
 * 两个子模式：
 *   vowel-gap    — 「f _ n」听音填元音。OPW2 整本书就是教 5 个短元音，
 *                  这个模式直接把考点变成题目本身，性价比最高。建议占 blend 的 60%。
 *   tap-to-blend — 点 onset/rime 两张卡听音素，再选整词。
 *
 * 音素音缺失或质量差时走降级路径（playWithFallback → 整词音 + 依次高亮）。
 * 这条降级路径必须在 Phase 0 就存在，否则 Phase 1 发现音素音不行时要返工整个题型。
 */
(function (window) {
  'use strict';

  var G = window.G;

  G.Renderers = G.Renderers || {};

  G.Renderers.blend = function (container, q, handlers) {
    var mode = q.mode || 'vowel-gap';
    var answered = false;

    var root = G.el('div', { class: 'q q-blend q-blend-' + mode });
    root.appendChild(G.el('div', { class: 'stem-hint', text: q.stem.prompt || '听一听，拼一拼' }));

    if (mode === 'tap-to-blend') {
      renderTapToBlend();
    } else {
      renderVowelGap();
    }

    container.appendChild(root);

    /* ---------- 子模式 A：听音拼装 ---------- */

    function renderTapToBlend() {
      var onset = q.stem.onset;
      var rime = q.stem.rime;
      var word = q.answerWord;
      var playedOnset = false, playedRime = false;

      var cards = G.el('div', { class: 'blend-cards' });

      var onsetCard = G.el('button', {
        class: 'blend-card',
        onclick: function () {
          playedOnset = true;
          onsetCard.classList.add('tapped');
          // 降级：音素音缺失就播整词音，卡片依次高亮
          G.Audio.playWithFallback(onset.audio, q.audio && q.audio[0]);
          checkBoth();
        }
      }, [G.el('span', { class: 'blend-card-text', text: onset.text })]);

      var plus = G.el('span', { class: 'blend-plus', text: '+' });

      var rimeCard = G.el('button', {
        class: 'blend-card',
        onclick: function () {
          playedRime = true;
          rimeCard.classList.add('tapped');
          G.Audio.playWithFallback(rime.audio, q.audio && q.audio[0]);
          checkBoth();
        }
      }, [G.el('span', { class: 'blend-card-text', text: rime.text })]);

      cards.appendChild(onsetCard);
      cards.appendChild(plus);
      cards.appendChild(rimeCard);
      root.appendChild(cards);

      function checkBoth() {
        if (playedOnset && playedRime) {
          root.querySelector('.blend-cards').classList.add('ready');
        }
      }

      root.appendChild(G.el('div', { class: 'stem-hint stem-hint-sm', text: '两个音合起来是哪个词？' }));
      root.appendChild(buildOptions(q.options || []));
    }

    /* ---------- 子模式 B：元音填空 ---------- */

    function renderVowelGap() {
      var display = G.el('div', { class: 'vowel-gap' });
      // "f _ n" 里的空位渲染成一个闪烁的槽，视觉上提示「这里缺一个字母」
      q.stem.display.split('').forEach(function (ch) {
        if (ch === '_') display.appendChild(G.el('span', { class: 'vg-blank', text: '?' }));
        else if (ch === ' ') display.appendChild(G.el('span', { class: 'vg-space' }));
        else display.appendChild(G.el('span', { class: 'vg-char', text: ch }));
      });

      root.appendChild(display);
      root.appendChild(G.UI.speakerButton(q.stem.audio, null, { autoplay: true }));

      // 选项是大号字母，比文字选项更好点
      var grid = G.el('div', { class: 'options options-row options-letters' });
      (q.options || []).forEach(function (opt) {
        var btn = G.el('button', {
          class: 'option option-letter',
          onclick: function () { choose(opt, btn); }
        }, [G.el('span', { class: 'option-text', text: opt.text })]);
        grid.appendChild(btn);
      });
      root.appendChild(grid);
    }

    function buildOptions(options) {
      var grid = G.el('div', { class: 'options options-grid options-words' });
      options.forEach(function (opt) {
        var btn = G.el('button', {
          class: 'option option-word',
          onclick: function () {
            if (answered) return;
            // 先让孩子听到这个词，再判定
            if (G.Audio.has('word.' + opt.text)) G.Audio.play('word.' + opt.text);
            choose(opt, btn);
          }
        }, [G.el('span', { class: 'option-text', text: opt.text })]);
        grid.appendChild(btn);
      });
      return grid;
    }

    function choose(opt, btn) {
      if (answered) return;
      answered = true;

      var correct = opt.id === q.answer;
      G.UI.feedback(btn, correct);

      G.$$('.option', root).forEach(function (b) {
        b.classList.add('locked');
        if (b.getAttribute('data-id') === q.answer) b.classList.add('is-answer');
      });

      if (correct) {
        G.UI.confetti(container);
        // 答对了再把整词读一遍，强化「拼出来的是什么」
        if (q.answerWord && G.Audio.has('word.' + q.answerWord)) {
          setTimeout(function () { G.Audio.play('word.' + q.answerWord); }, 320);
        }
      } else {
        showExplain(q.explain);
      }

      setTimeout(function () { handlers.onAnswer(correct); }, correct ? 750 : 1600);
    }

    function showExplain(text) {
      if (!text) return;
      var bar = G.el('div', { class: 'explain', text: text });
      root.appendChild(bar);
    }

    return { destroy: function () {} };
  };

})(window);

/* ===== 43-render-sort.js ===== */
/* 43-render-sort.js — 词族归类题
 *
 * 交互用「点选 → 点筐」而不是拖拽。6 岁孩子在手机上拖拽命中率很低，
 * 拖到一半掉了会很挫败。点选式容错高得多。
 *
 * passRatio：sort 占一题的槽位但含 4 次判断，全对才算对太苛刻 ——
 * 会打击积极性，也扭曲难度统计。
 */
(function (window) {
  'use strict';

  var G = window.G;

  G.Renderers = G.Renderers || {};

  G.Renderers.sort = function (container, q, handlers) {
    var answered = false;
    var selected = null;
    var placed = {};                       // { itemId: bucketId }
    var buckets = q.buckets || [];
    var items = q.items || [];
    var passRatio = q.passRatio === undefined ? 0.75 : q.passRatio;

    var root = G.el('div', { class: 'q q-sort' });
    root.appendChild(G.el('div', { class: 'stem-hint', text: q.stem.prompt || '把单词放进正确的筐子' }));

    // ---- 待归类的词 ----
    var tray = G.el('div', { class: 'sort-tray' });
    var itemEls = {};

    items.forEach(function (item) {
      var el = G.el('button', {
        class: 'sort-item',
        onclick: function () { selectItem(item.id, el); }
      }, [G.el('span', { text: item.text })]);
      itemEls[item.id] = el;
      tray.appendChild(el);
    });
    root.appendChild(tray);

    // ---- 筐子 ----
    var bucketRow = G.el('div', { class: 'sort-buckets' });
    var bucketEls = {};

    buckets.forEach(function (b) {
      var drop = G.el('div', { class: 'sort-drop' });
      var el = G.el('button', {
        class: 'sort-bucket',
        style: b.color ? ('--bucket-color:' + b.color) : null,
        onclick: function () { placeInto(b.id); }
      }, [
        G.el('span', { class: 'bucket-label', text: b.label }),
        drop
      ]);
      bucketEls[b.id] = { el: el, drop: drop };
      bucketRow.appendChild(el);
    });
    root.appendChild(bucketRow);

    root.appendChild(G.el('div', { class: 'stem-hint stem-hint-sm', text: '点一个词，再点一个筐子' }));
    container.appendChild(root);

    function selectItem(id, el) {
      if (answered) return;
      if (placed[id]) return;                  // 已放好的不能再选

      Object.keys(itemEls).forEach(function (k) { itemEls[k].classList.remove('selected'); });
      selected = id;
      el.classList.add('selected');

      var item = items.filter(function (i) { return i.id === id; })[0];
      if (item && item.audio && G.Audio.has(item.audio.replace(/\.mp3$/, '').replace(/\//g, '.'))) {
        G.Audio.play(item.audio.replace(/\.mp3$/, '').replace(/\//g, '.'));
      }
    }

    function placeInto(bucketId) {
      if (answered || !selected) return;

      var id = selected;
      placed[id] = bucketId;

      var el = itemEls[id];
      el.classList.remove('selected');
      el.classList.add('placed');
      bucketEls[bucketId].drop.appendChild(el);

      selected = null;
      if (Object.keys(placed).length === items.length) setTimeout(check, 320);
    }

    function check() {
      if (answered) return;
      answered = true;

      var right = 0;
      items.forEach(function (item) {
        var ok = placed[item.id] === item.bucket;
        if (ok) right++;
        var el = itemEls[item.id];
        el.classList.add(ok ? 'item-ok' : 'item-bad');
      });

      var ratio = right / items.length;
      var passed = ratio >= passRatio;

      // 错的词把正确归处标出来
      if (!passed) {
        items.forEach(function (item) {
          if (placed[item.id] !== item.bucket) {
            bucketEls[item.bucket].el.classList.add('bucket-hint');
          }
        });
        showExplain(q.explain || ('对了 ' + right + ' 个，再仔细看看尾音。'));
      } else {
        G.UI.confetti(container);
      }

      G.log('sort 结果', right + '/' + items.length, '通过 =', passed);
      setTimeout(function () { handlers.onAnswer(passed); }, passed ? 800 : 1900);
    }

    function showExplain(text) {
      if (!text) return;
      root.appendChild(G.el('div', { class: 'explain', text: text }));
    }

    return { destroy: function () {} };
  };

})(window);

/* ===== 44-render-realword.js ===== */
/* 44-render-realword.js — 真假词判断
 *
 * 假词默认不配音，只显示字母。两个原因：
 *   1. TTS 读 sep / fap 这类非词时发音不可预测（可能按拼写规则读，也可能触发
 *      语言模型纠错），孩子听到错音会破坏整个练习的意义。
 *   2. 不用音频反而更接近自然拼读的真实目标 —— 见词能读。孩子看到 sep，
 *      心里默拼 /s/ /e/ /p/，发现拼不出认识的词，就选「假词」。
 *
 * probeAudio 字段保留：若实测某几个假词的 TTS 读法标准，可以填上。
 */
(function (window) {
  'use strict';

  var G = window.G;

  G.Renderers = G.Renderers || {};

  G.Renderers.realword = function (container, q, handlers) {
    var answered = false;
    var probe = q.probe || {};

    var root = G.el('div', { class: 'q q-realword' });
    root.appendChild(G.el('div', { class: 'stem-hint', text: q.stem.prompt || '这个词是真的吗？' }));

    // ---- 词卡 ----
    var card = G.el('div', { class: 'word-card' }, [
      G.el('span', { class: 'word-card-text', text: probe.text })
    ]);

    // 真词可以给个喇叭（孩子可以点来确认），假词不给
    if (probe.isReal && G.Audio.has('word.' + probe.text)) {
      card.appendChild(G.el('button', {
        class: 'word-card-speaker',
        onclick: function (e) {
          e.stopPropagation();
          G.Audio.play('word.' + probe.text);
        }
      }, ['🔊']));
    }
    root.appendChild(card);

    // ---- 两个大按钮 ----
    var row = G.el('div', { class: 'realword-actions' });
    var btnReal = G.el('button', {
      class: 'rw-btn rw-real',
      onclick: function () { answer(true, btnReal); }
    }, ['✅ 真词']);
    var btnFake = G.el('button', {
      class: 'rw-btn rw-fake',
      onclick: function () { answer(false, btnFake); }
    }, ['❌ 假词']);
    row.appendChild(btnReal);
    row.appendChild(btnFake);
    root.appendChild(row);

    container.appendChild(root);

    function answer(saidReal, btn) {
      if (answered) return;
      answered = true;

      var correct = (saidReal === !!probe.isReal);
      G.UI.feedback(btn, correct);

      btnReal.classList.add('locked');
      btnFake.classList.add('locked');
      (probe.isReal ? btnReal : btnFake).classList.add('is-answer');

      var reveal = q.reveal || {};
      if (correct) {
        G.UI.confetti(container);
        // 揭晓真正的那个词
        if (reveal.audio && G.Audio.has(reveal.audio.replace(/\.mp3$/, '').replace(/\//g, '.'))) {
          setTimeout(function () {
            G.Audio.play(reveal.audio.replace(/\.mp3$/, '').replace(/\//g, '.'));
          }, 320);
        }
        if (reveal.text) showExplain(reveal.text);
      } else {
        showExplain(reveal.text || q.explain);
      }

      setTimeout(function () { handlers.onAnswer(correct); }, correct ? 800 : 1800);
    }

    function showExplain(text) {
      if (!text) return;
      var bar = G.el('div', { class: 'explain', text: text });
      root.appendChild(bar);
    }

    return { destroy: function () {} };
  };

  /**
   * 题型 → 渲染器。渲染器按视觉形态分（3 个），内容按题型分（5 个）。
   */
  G.rendererFor = function (type) {
    if (type === 'choice' || type === 'listen') return G.Renderers.choice;
    if (type === 'blend') return G.Renderers.blend;
    if (type === 'sort') return G.Renderers.sort;
    if (type === 'realword') return G.Renderers.realword;
    return G.Renderers.choice;
  };

})(window);

/* ===== 50-wheel.js ===== */
/* 50-wheel.js — 转盘抽奖
 *
 * 结果先定后动画：先按权重抽出奖品，再反推指针该停在哪。
 * 反过来（让动画时长或角度决定结果）会在慢设备上产生偏差，也会让
 * 「再来一次」的重转逻辑变得不可控。
 */
(function (window) {
  'use strict';

  var G = window.G;

  /* ---------- 抽奖 ---------- */

  function rollPrize(rng) {
    rng = rng || Math.random;
    var total = G.sum(G.PRIZES, function (p) { return p.weight; });
    var r = rng() * total;
    for (var i = 0; i < G.PRIZES.length; i++) {
      r -= G.PRIZES[i].weight;
      if (r <= 0) return G.PRIZES[i];
    }
    return G.PRIZES[G.PRIZES.length - 1];
  }

  // 每个奖项在转盘上占的弧度（累加），用于反推指针角度
  function segmentAngles() {
    var total = G.sum(G.PRIZES, function (p) { return p.weight; });
    var acc = 0;
    return G.PRIZES.map(function (p) {
      var sweep = (p.weight / total) * 360;
      var seg = { prize: p, start: acc, sweep: sweep, center: acc + sweep / 2 };
      acc += sweep;
      return seg;
    });
  }

  /* ---------- 渲染 ---------- */

  function wheelBackground(segments) {
    var stops = segments.map(function (s) {
      var color = colorFor(s.prize.id);
      return color + ' ' + s.start + 'deg ' + (s.start + s.sweep) + 'deg';
    });
    return 'conic-gradient(from -90deg, ' + stops.join(', ') + ')';
  }

  function colorFor(id) {
    return {
      tv10: '#FF8A65',
      p1: '#81C784',
      p2: '#4FC3F7',
      p5: '#FFD54F',
      p10: '#BA68C8',
      again: '#B0BEC5'
    }[id] || '#B0BEC5';
  }

  /**
   * 打开转盘。返回 Promise<{prize, respins}> —— resolve 时奖励已入账。
   *
   * @param {object} save
   * @param {object} roundState  {respinCount}
   */
  function open(save, roundState) {
    return new Promise(function (resolve) {
      var segments = segmentAngles();
      var respins = (roundState && roundState.respinCount) || 0;
      var maxRespins = save.limits.maxRespinsPerQuestion || 3;

      var overlay = G.el('div', { class: 'overlay wheel-overlay' });
      var box = G.el('div', { class: 'wheel-box' });

      box.appendChild(G.el('div', { class: 'wheel-title', text: '答对啦！转转盘 🎉' }));

      var stage = G.el('div', { class: 'wheel-stage' });
      var wheel = G.el('div', { class: 'wheel' });
      wheel.style.background = wheelBackground(segments);

      // 奖名贴在盘面上
      segments.forEach(function (s) {
        var label = G.el('span', { class: 'wheel-label', text: s.prize.label });
        label.style.transform = 'rotate(' + s.center + 'deg) translateY(-38%)';
        wheel.appendChild(label);
      });

      var pointer = G.el('div', { class: 'wheel-pointer' });
      stage.appendChild(wheel);
      stage.appendChild(pointer);
      box.appendChild(stage);

      var resultBar = G.el('div', { class: 'wheel-result' });
      box.appendChild(resultBar);

      var spinBtn = G.el('button', { class: 'btn btn-primary btn-spin', text: '转！' });
      box.appendChild(spinBtn);

      overlay.appendChild(box);
      document.body.appendChild(overlay);

      var done = false;
      var totalRot = 0;          // 累计旋转角。必须累加而不是每次从 0 起算，
                                 // 否则第二次转动的 transition 会反向绕回来。

      spinBtn.addEventListener('click', function () {
        if (done) return;
        done = true;
        spinBtn.disabled = true;
        spinBtn.classList.add('hidden');

        var prize = rollPrize();

        // 反推落点。conic-gradient 从 -90deg 起算，即 12 点方向，
        // 所以扇区中心在 center 度处；要让它对上 12 点的指针，需顺时针转 (360 - center)。
        var want = (360 - centerDegOf(prize, segments)) % 360;
        var jitter = Math.random() * 10 - 5;                    // 散开落点，别每次都停正中
        var cur = ((totalRot % 360) + 360) % 360;
        var delta = ((want - cur) + 360) % 360 + 360 * 5;        // 至少转 5 圈
        totalRot += delta;

        wheel.style.transition = 'transform 3.4s cubic-bezier(.17,.67,.24,1)';
        wheel.style.transform = 'rotate(' + (totalRot + jitter) + 'deg)';

        G.Audio.play('ui.spin');

        setTimeout(function () { settle(prize, respins); }, 3600);
      });

      function settle(prize, respinCount) {
        if (prize.kind === 'again') {
          if (respinCount >= maxRespins) {
            // 重转次数用完 —— 给最低档奖励，不能让孩子空手而归
            finish(G.PRIZES[1], respinCount);
            return;
          }
          G.Audio.play('ui.win');
          resultBar.textContent = '再来一次！';
          resultBar.className = 'wheel-result wheel-result-again';
          setTimeout(function () {
            overlay.classList.add('closing');
            setTimeout(function () {
              if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
              resolve({ prize: prize, respins: respinCount + 1, again: true });
            }, 320);
          }, 900);
          return;
        }
        finish(prize, respinCount);
      }

      function finish(prize, respinCount) {
        G.Audio.play('ui.win');

        var r = G.Runner.awardPoints(save, prize.points);
        var extra = '';

        if (prize.kind === 'tv') {
          G.Runner.awardTvMinutes(save, 10);
          extra = '（记得让爸爸妈妈知道哦）';
        } else if (r.capped) {
          extra = '（今天的积分已经攒满啦，明天继续！）';
        }

        resultBar.textContent = prize.points > 0
          ? ('+' + r.awarded + ' 分 ' + extra)
          : (prize.label + ' ' + extra);
        resultBar.className = 'wheel-result wheel-result-win';

        G.Store.save(save);

        setTimeout(function () {
          var ok = G.el('button', { class: 'btn btn-primary', text: '继续', onclick: close });
          box.appendChild(ok);
        }, 500);

        function close() {
          overlay.classList.add('closing');
          setTimeout(function () {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            resolve({ prize: prize, respins: respinCount, awarded: r.awarded });
          }, 320);
        }
      }
    });
  }

  // 取扇区中心角（供反推落点用）
  function centerDegOf(prize, segments) {
    var seg = segments.filter(function (s) { return s.prize.id === prize.id; })[0];
    return seg ? seg.center : 0;
  }

  /* ---------- 自检用：分布验证 ---------- */

  function simulate(n) {
    var counts = {};
    G.PRIZES.forEach(function (p) { counts[p.id] = 0; });
    for (var i = 0; i < n; i++) counts[rollPrize().id]++;
    return G.PRIZES.map(function (p) {
      var actual = counts[p.id] / n * 100;
      return {
        id: p.id,
        declared: p.weight,
        actual: +actual.toFixed(2),
        delta: +(actual - p.weight).toFixed(2)
      };
    });
  }

  G.Wheel = {
    rollPrize: rollPrize,
    open: open,
    simulate: simulate,
    _segments: segmentAngles,
    _centerDegOf: centerDegOf
  };

})(window);

/* ===== 60-redeem.js ===== */
/* 60-redeem.js — 积分兑换 + 日/周上限
 *
 * 兑换走「家长确认」而不是自动生效。这不是防作弊，是防冲突 ——
 * 钱和屏幕时间的兑现本来就发生在物理世界。而且孩子看到 pending
 * 比看到「兑换成功」更符合真实体验（要等爸妈同意）。
 */
(function (window) {
  'use strict';

  var G = window.G;

  function rewardById(id) {
    return G.REWARDS.filter(function (r) { return r.id === id; })[0] || null;
  }

  function countThisWeek(save) {
    var start = G.weekStartStr();
    return save.redemptions.filter(function (r) {
      if (r.status === 'rejected') return false;
      return G.localDateStr(new Date(r.ts)) >= start;
    }).length;
  }

  function pendingList(save) {
    return save.redemptions.filter(function (r) { return r.status === 'pending'; });
  }

  /**
   * 能不能兑换。返回 {ok, why}。why 的文案是直接给孩子看的，要温和。
   *
   * reward 可以是对象也可以是 id —— request() 收 id，要是这里只收对象，
   * 调用方就得记住两套约定，传错了不会报错、只会静默放行（reward.cost 是
   * undefined，所有金额比较都为 false）。这种失败方式最难查，所以在入口归一化。
   */
  function canRedeem(save, reward) {
    var lim = save.limits;

    if (typeof reward === 'string') reward = rewardById(reward);
    if (!reward) return { ok: false, why: '没有这个奖励' };

    if (save.integrity.clockTampered) {
      return { ok: false, why: '需要爸爸妈妈确认一下才能兑换哦' };
    }
    if (save.points.balance < reward.cost) {
      return { ok: false, why: '还差 ' + (reward.cost - save.points.balance) + ' 分，继续加油！' };
    }

    var dc = G.Store.todayCounter(save);

    if (dc.redemptions >= lim.maxRedemptionsPerDay) {
      return { ok: false, why: '今天已经兑换过啦，明天再来' };
    }
    if (countThisWeek(save) >= lim.maxRedemptionsPerWeek) {
      return { ok: false, why: '这周兑换次数用完啦' };
    }
    // 转盘免费送的 tv10 和这里兑换的是同一份「动画片时间」，家长关心的是总时长。
    // 漏了这条，孩子一天抽中 4 次就能看 40 分钟。
    if (reward.id === 'tv10' && dc.tvMinutes + 10 > lim.maxTvMinutesPerDay) {
      return { ok: false, why: '今天动画片时间已经用完啦' };
    }

    return { ok: true };
  }

  /**
   * 发起兑换 → 生成 pending 记录。积分此时不扣，等家长批准才扣。
   */
  function request(save, rewardId) {
    var reward = rewardById(rewardId);
    if (!reward) return { ok: false, why: '没有这个奖励' };

    var check = canRedeem(save, reward);
    if (!check.ok) return check;

    var rec = {
      id: 'r_' + Date.now(),
      ts: Date.now(),
      cost: reward.cost,
      reward: reward.id,
      rewardLabel: reward.label,
      status: 'pending',
      requestedAt: Date.now(),
      decidedAt: null
    };
    save.redemptions.push(rec);
    G.Store.save(save);

    G.log('兑换申请已提交', rec.id);
    return { ok: true, record: rec };
  }

  /**
   * 家长批准。此时才真正扣分 —— 这样孩子单方面改余额也没用，
   * 因为家长面板里的 lifetime/balance 审计会立刻对不上账。
   */
  function approve(save, redemptionId) {
    var rec = save.redemptions.filter(function (r) { return r.id === redemptionId; })[0];
    if (!rec || rec.status !== 'pending') return { ok: false, why: '记录不存在或已处理' };

    if (save.points.balance < rec.cost) {
      return { ok: false, why: '积分不足（余额 ' + save.points.balance + '，需要 ' + rec.cost + '）' };
    }

    save.points.balance -= rec.cost;
    rec.status = 'approved';
    rec.decidedAt = Date.now();

    var dc = G.Store.todayCounter(save);
    dc.redemptions += 1;
    if (rec.reward === 'tv10') dc.tvMinutes += 10;

    G.Store.save(save);
    return { ok: true, record: rec };
  }

  function reject(save, redemptionId) {
    var rec = save.redemptions.filter(function (r) { return r.id === redemptionId; })[0];
    if (!rec || rec.status !== 'pending') return { ok: false, why: '记录不存在或已处理' };

    rec.status = 'rejected';
    rec.decidedAt = Date.now();
    G.Store.save(save);
    return { ok: true, record: rec };
  }

  /* ---------- 界面 ---------- */

  function openScreen(save, onClose) {
    var overlay = G.el('div', { class: 'overlay' });
    var box = G.el('div', { class: 'panel' });

    box.appendChild(G.el('div', { class: 'panel-title', text: '我的奖励' }));
    box.appendChild(G.el('div', {
      class: 'points-big',
      text: save.points.balance + ' 分'
    }));

    var list = G.el('div', { class: 'reward-list' });
    G.REWARDS.forEach(function (r) {
      var check = canRedeem(save, r);
      var btn = G.el('button', {
        class: 'reward-card' + (check.ok ? '' : ' disabled'),
        onclick: function () {
          if (!check.ok) { G.UI.toast(check.why); return; }
          var res = request(save, r.id);
          if (res.ok) {
            G.UI.toast('已告诉爸爸妈妈啦！');
            G.Audio.play('ui.win');
            refresh();
          } else {
            G.UI.toast(res.why);
          }
        }
      }, [
        G.el('span', { class: 'reward-emoji', text: r.emoji }),
        G.el('div', { class: 'reward-info' }, [
          G.el('div', { class: 'reward-label', text: r.label }),
          G.el('div', { class: 'reward-cost', text: r.cost + ' 分' })
        ]),
        G.el('span', { class: 'reward-state', text: check.ok ? '可兑换' : '' })
      ]);
      list.appendChild(btn);
    });
    box.appendChild(list);

    var pending = pendingList(save);
    if (pending.length) {
      var pbox = G.el('div', { class: 'pending-box' });
      pbox.appendChild(G.el('div', { class: 'pending-title', text: '等爸爸妈妈确认' }));
      pending.forEach(function (p) {
        pbox.appendChild(G.el('div', {
          class: 'pending-item',
          text: p.rewardLabel + '（' + p.cost + ' 分）'
        }));
      });
      box.appendChild(pbox);
    }

    var limits = G.el('div', { class: 'limits-hint', text:
      '今天还能兑换 ' + Math.max(0, save.limits.maxRedemptionsPerDay - G.Store.todayCounter(save).redemptions) + ' 次 · ' +
      '这周还能 ' + Math.max(0, save.limits.maxRedemptionsPerWeek - countThisWeek(save)) + ' 次' });
    box.appendChild(limits);

    box.appendChild(G.el('button', {
      class: 'btn btn-ghost', text: '关闭',
      onclick: function () {
        overlay.classList.add('closing');
        setTimeout(function () {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
          if (onClose) onClose();
        }, 260);
      }
    }));

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    function refresh() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      openScreen(save, onClose);
    }
  }

  G.Redeem = {
    rewardById: rewardById,
    canRedeem: canRedeem,
    countThisWeek: countThisWeek,
    pendingList: pendingList,
    request: request,
    approve: approve,
    reject: reject,
    openScreen: openScreen
  };

})(window);

/* ===== 70-parent.js ===== */
/* 70-parent.js — 家长模式
 *
 * 门禁用 7×8（超出幼小衔接范围）。失败 3 次冷却 30 秒 —— 防孩子狂点蒙对。
 * 冷却写进 localStorage，刷新页面绕不过去。
 */
(function (window) {
  'use strict';

  var G = window.G;

  var COOLDOWN_KEY = 'yxjx.parent.cooldown';
  var FAIL_KEY = 'yxjx.parent.fails';
  var MAX_FAILS = 3;
  var COOLDOWN_MS = 30 * 1000;

  /* ---------- 门禁 ---------- */

  function gateState() {
    var until = 0, fails = 0;
    try {
      until = +(window.localStorage.getItem(COOLDOWN_KEY) || 0);
      fails = +(window.localStorage.getItem(FAIL_KEY) || 0);
    } catch (e) {}
    return { until: until, fails: fails, blocked: Date.now() < until };
  }

  function recordFail() {
    var s = gateState();
    var fails = s.fails + 1;
    try {
      window.localStorage.setItem(FAIL_KEY, String(fails));
      if (fails >= MAX_FAILS) {
        window.localStorage.setItem(COOLDOWN_KEY, String(Date.now() + COOLDOWN_MS));
        window.localStorage.setItem(FAIL_KEY, '0');
      }
    } catch (e) {}
    return fails >= MAX_FAILS;
  }

  function clearFails() {
    try {
      window.localStorage.removeItem(FAIL_KEY);
      window.localStorage.removeItem(COOLDOWN_KEY);
    } catch (e) {}
  }

  function openGate(onPass) {
    var s = gateState();
    if (s.blocked) {
      G.UI.toast('请等 ' + Math.ceil((s.until - Date.now()) / 1000) + ' 秒后再试');
      return;
    }

    var overlay = G.el('div', { class: 'overlay' });
    var box = G.el('div', { class: 'panel panel-narrow' });

    box.appendChild(G.el('div', { class: 'panel-title', text: '家长验证' }));
    box.appendChild(G.el('div', { class: 'gate-q', text: G.PARENT_GATE.question }));

    var input = G.el('input', {
      class: 'gate-input', type: 'number', inputmode: 'numeric',
      placeholder: '答案'
    });
    box.appendChild(input);

    var err = G.el('div', { class: 'gate-err hidden' });
    box.appendChild(err);

    var submit = G.el('button', {
      class: 'btn btn-primary', text: '进入',
      onclick: function () {
        if (+input.value === G.PARENT_GATE.answer) {
          clearFails();
          close();
          onPass();
        } else {
          var blocked = recordFail();
          err.textContent = blocked ? '错误次数过多，请 30 秒后再试' : '答案不对';
          err.classList.remove('hidden');
          input.value = '';
        }
      }
    });
    box.appendChild(submit);

    box.appendChild(G.el('button', {
      class: 'btn btn-ghost', text: '取消',
      onclick: close
    }));

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    setTimeout(function () { input.focus(); }, 200);

    function close() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
  }

  /* ---------- 主面板 ---------- */

  function open(save) {
    var overlay = G.el('div', { class: 'overlay overlay-scroll' });
    var box = G.el('div', { class: 'panel panel-wide' });

    function rerender() {
      G.clear(box);
      build(box, save, rerender, overlay);
    }
    rerender();

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    return function close() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };
  }

  function build(box, save, rerender, overlay) {
    box.appendChild(G.el('div', { class: 'panel-title', text: '家长面板' }));
    G.UI.dismissBanner();

    /* --- 警示区 --- */
    if (save.integrity.clockTampered) {
      box.appendChild(G.el('div', { class: 'warn-card' }, [
        G.el('div', { text: '⚠️ 检测到设备时间被回拨，兑换已冻结。' }),
        G.el('div', { class: 'warn-sub', text: '如果是改时区或跨日旅行导致的误报，点下面解除。' }),
        G.el('button', {
          class: 'btn btn-sm', text: '解除冻结',
          onclick: function () {
            save.integrity.clockTampered = false;
            save.integrity.maxSeenTs = Date.now();
            G.Store.save(save);
            rerender();
          }
        })
      ]));
    }

    if (!G.storageAvailable()) {
      box.appendChild(G.el('div', { class: 'warn-card' }, [
        G.el('div', { text: '⚠️ 当前环境无法保存进度（无痕模式或微信限制）' })
      ]));
    }

    /* --- 积分审计 --- */
    var a = G.Store.audit(save);
    var auditCard = G.el('div', { class: 'audit-card' });
    auditCard.appendChild(row('当前余额', a.balance + ' 分'));
    auditCard.appendChild(row('累计获得', a.lifetime + ' 分'));
    auditCard.appendChild(row('已兑换', a.spent + ' 分'));
    auditCard.appendChild(row('账目应等于', a.expected + ' 分'));
    if (!a.ok) {
      auditCard.appendChild(G.el('div', {
        class: 'audit-bad',
        text: '⚠️ 账目对不上，积分可能被修改过'
      }));
    }
    box.appendChild(section('积分账目', auditCard));

    /* --- 今日数据 --- */
    var dc = G.Store.todayCounter(save);
    var today = G.el('div', { class: 'stat-card' });
    today.appendChild(row('转盘次数', dc.spins + ' 次'));
    today.appendChild(row('今日得分', dc.pointsEarned + ' / ' + save.limits.maxPointsPerDay));
    today.appendChild(row('动画片时长', dc.tvMinutes + ' / ' + save.limits.maxTvMinutesPerDay + ' 分钟'));
    today.appendChild(row('今日兑换', dc.redemptions + ' / ' + save.limits.maxRedemptionsPerDay));
    box.appendChild(section('今天', today));

    /* --- 待确认兑换 --- */
    var pending = G.Redeem.pendingList(save);
    var pendBox = G.el('div', { class: 'stat-card' });
    if (!pending.length) {
      pendBox.appendChild(G.el('div', { class: 'muted', text: '暂无待确认的兑换' }));
    } else {
      pending.forEach(function (p) {
        var item = G.el('div', { class: 'approve-row' }, [
          G.el('div', { class: 'approve-label', text: p.rewardLabel + ' · ' + p.cost + ' 分' }),
          G.el('div', { class: 'approve-actions' }, [
            G.el('button', {
              class: 'btn btn-sm btn-primary', text: '已兑现',
              onclick: function () {
                var r = G.Redeem.approve(save, p.id);
                if (!r.ok) G.UI.toast(r.why);
                rerender();
              }
            }),
            G.el('button', {
              class: 'btn btn-sm btn-ghost', text: '拒绝',
              onclick: function () {
                G.Redeem.reject(save, p.id);
                rerender();
              }
            })
          ])
        ]);
        pendBox.appendChild(item);
      });
    }
    box.appendChild(section('待确认兑换', pendBox));

    /* --- 英语进度解锁 --- */
    var unlockBox = G.el('div', { class: 'stat-card' });
    unlockBox.appendChild(G.el('div', {
      class: 'muted',
      text: '孩子在课外班学到哪了？游戏只在这个范围内出题。'
    }));
    var cur = G.Curriculum.curriculum();
    cur.unlockOptions.forEach(function (opt) {
      var checked = save.settings.englishUnlockedThrough === opt.through;
      var optEl = G.el('button', {
        class: 'unlock-opt' + (checked ? ' unlock-on' : ''),
        onclick: function () {
          save.settings.englishUnlockedThrough = opt.through;
          G.Store.save(save);
          rerender();
        }
      }, [
        G.el('span', { class: 'unlock-radio', text: checked ? '●' : '○' }),
        G.el('div', {}, [
          G.el('div', { class: 'unlock-label', text: opt.label }),
          G.el('div', { class: 'unlock-detail', text: opt.detail })
        ])
      ]);
      unlockBox.appendChild(optEl);
    });

    // 只给建议，不自动执行 —— 决定权在家长
    var suggestion = englishSuggestion(save);
    if (suggestion) unlockBox.appendChild(G.el('div', { class: 'suggest', text: suggestion }));

    box.appendChild(section('英语进度', unlockBox));

    /* --- 学习数据 --- */
    box.appendChild(section('学习数据', buildStats(save)));

    /* --- 音频替换 --- */
    box.appendChild(section('音频', buildAudioPanel(save, rerender)));

    /* --- 备份 --- */
    box.appendChild(section('备份', buildBackupPanel(save, rerender)));

    /* --- 危险区 --- */
    var danger = G.el('div', { class: 'stat-card' });
    danger.appendChild(G.el('button', {
      class: 'btn btn-sm btn-danger', text: '清空所有数据（不可恢复）',
      onclick: function () {
        if (window.confirm('确定要清空所有进度和积分吗？这个操作不可恢复。\n建议先做一次备份。')) {
          G.Store.reset();
          G.UI.toast('已清空');
          rerender();
        }
      }
    }));
    box.appendChild(section('危险操作', danger));

    box.appendChild(G.el('button', {
      class: 'btn btn-ghost', text: '关闭',
      onclick: function () {
        overlay.classList.add('closing');
        setTimeout(function () {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }, 260);
      }
    }));
  }

  /* ---------- 各区块 ---------- */

  function englishSuggestion(save) {
    var fs = save.progress.english.familyStats;
    var fams = G.Curriculum.unlockedFamilies(save);
    var seen = 0, correct = 0;
    fams.forEach(function (f) {
      if (fs[f]) { seen += fs[f].seen; correct += fs[f].correct; }
    });
    if (seen < 20) return null;
    var acc = correct / seen;
    if (acc < 0.9) return null;

    var units = G.Curriculum.unlockedUnitIds(save);
    var idx = units.length;
    if (idx >= G.Curriculum.curriculum().unlockOptions.length) return null;

    return '建议：当前范围正确率 ' + Math.round(acc * 100) +
           '%，要不要跟老师确认后解锁下一单元？';
  }

  function buildStats(save) {
    var wrap = G.el('div', { class: 'stat-card' });

    // 英语按词族
    var fs = save.progress.english.familyStats;
    var fams = Object.keys(fs);
    if (fams.length) {
      wrap.appendChild(G.el('div', { class: 'stat-title', text: '英语 · 按词族' }));
      fams.sort(function (a, b) { return (fs[a].correct / fs[a].seen) - (fs[b].correct / fs[b].seen); })
        .forEach(function (f) {
          wrap.appendChild(bar(f + ' (-' + f + ')', fs[f].correct, fs[f].seen));
        });
    }

    // 语文数学按标签
    ['chinese', 'math'].forEach(function (sub) {
      var bucket = save.progress[sub].byTag;
      var tags = Object.keys(bucket);
      if (!tags.length) return;
      wrap.appendChild(G.el('div', { class: 'stat-title', text: G.SUBJECT_LABEL[sub] + ' · 按知识点' }));
      tags.sort(function (a, b) { return (bucket[a].correct / bucket[a].seen) - (bucket[b].correct / bucket[b].seen); })
        .forEach(function (t) { wrap.appendChild(bar(t, bucket[t].correct, bucket[t].seen)); });
    });

    // 错题本
    var wrong = save.wrongBook.filter(function (w) { return !w.cleared; })
      .sort(function (a, b) { return b.wrongCount - a.wrongCount; });
    if (wrong.length) {
      wrap.appendChild(G.el('div', { class: 'stat-title', text: '待巩固的题（' + wrong.length + '）' }));
      wrong.slice(0, 15).forEach(function (w) {
        var q = findQuestion(w.qid);
        wrap.appendChild(G.el('div', { class: 'wrong-row' }, [
          G.el('span', { text: (q ? (q.stem.text || q.answerWord || w.qid) : w.qid) }),
          G.el('span', { class: 'wrong-count', text: '错 ' + w.wrongCount + ' 次' })
        ]));
      });
    }

    // 最近局
    if (save.sessions.length) {
      wrap.appendChild(G.el('div', { class: 'stat-title', text: '最近 ' + Math.min(10, save.sessions.length) + ' 局' }));
      save.sessions.slice(-10).reverse().forEach(function (s) {
        wrap.appendChild(bar(
          G.localDateStr(new Date(s.ts)).slice(5) + ' · ' + (s.family ? '-' + s.family : ''),
          s.correct, s.total
        ));
      });
    }

    return wrap;
  }

  var _qIndex = null;
  function findQuestion(qid) {
    if (!_qIndex) {
      _qIndex = {};
      ['chinese', 'math', 'english'].forEach(function (s) {
        (window.G.DATA && window.G.DATA[s] || []).forEach(function (q) { _qIndex[q.id] = q; });
      });
    }
    return _qIndex[qid];
  }

  function buildAudioPanel(save, rerender) {
    var wrap = G.el('div', { class: 'stat-card' });
    var ids = Object.keys(G.AUDIO_MAP || {}).sort();

    wrap.appendChild(G.el('div', {
      class: 'muted',
      text: '共 ' + ids.length + ' 条音频。觉得哪条读得不准，可以自己录一条盖掉。录完拖动滑块调到和原音一样响。'
    }));

    var filter = G.el('input', { class: 'gate-input', placeholder: '搜索，如 fan 或 word.f' });
    wrap.appendChild(filter);

    var list = G.el('div', { class: 'audio-list' });
    wrap.appendChild(list);

    function renderList(kw) {
      G.clear(list);
      var shown = ids.filter(function (id) { return !kw || id.indexOf(kw) >= 0; }).slice(0, 60);
      if (!shown.length) {
        list.appendChild(G.el('div', { class: 'muted', text: '没有匹配的音频' }));
        return;
      }
      shown.forEach(function (id) {
        list.appendChild(audioRow(id, save, rerender));
      });
      if (ids.filter(function (id) { return !kw || id.indexOf(kw) >= 0; }).length > 60) {
        list.appendChild(G.el('div', { class: 'muted', text: '（结果太多，请用搜索缩小范围）' }));
      }
    }

    filter.addEventListener('input', function () { renderList(filter.value.trim()); });
    renderList('');

    wrap.appendChild(G.el('button', {
      class: 'btn btn-sm', text: '列出所有家长录音',
      onclick: function () {
        var ov = G.Audio.listOverrides();
        G.UI.toast(ov.length ? ('已录 ' + ov.length + ' 条：' + ov.slice(0, 5).join(', ')) : '还没有录过');
      }
    }));

    return wrap;
  }

  function audioRow(id, save, rerender) {
    var meta = G.Audio.getOverrideMeta(id);
    var muted = save.settings.mutedAudio.indexOf(id) >= 0;

    var rowEl = G.el('div', { class: 'audio-row' });

    rowEl.appendChild(G.el('div', { class: 'audio-id', text: id }));

    var actions = G.el('div', { class: 'audio-actions' });

    actions.appendChild(G.el('button', {
      class: 'btn btn-xs', text: '听内置',
      onclick: function () { G.Audio.play(id); }
    }));

    actions.appendChild(recButton(id, meta, rerender));

    if (meta) {
      actions.appendChild(G.el('button', {
        class: 'btn btn-xs', text: '听我的',
        onclick: function () { G.Audio.play(id); }
      }));

      // 音量对齐：录音和 TTS 音量必然不一致，忽大忽小会让孩子听不清
      var slider = G.el('input', {
        class: 'gain-slider', type: 'range', min: '0.2', max: '3', step: '0.1',
        value: String(meta.gain || 1)
      });
      slider.addEventListener('input', function () {
        G.Audio.setOverride(id, meta.blob, parseFloat(slider.value));
      });
      actions.appendChild(slider);

      actions.appendChild(G.el('button', {
        class: 'btn btn-xs btn-danger', text: '删',
        onclick: function () {
          G.Audio.removeOverride(id).then(rerender);
        }
      }));
    }

    actions.appendChild(G.el('button', {
      class: 'btn btn-xs' + (muted ? ' btn-danger' : ''),
      text: muted ? '已静音' : '静音',
      onclick: function () {
        var i = save.settings.mutedAudio.indexOf(id);
        if (i >= 0) save.settings.mutedAudio.splice(i, 1);
        else save.settings.mutedAudio.push(id);
        G.Store.save(save);
        rerender();
      }
    }));

    rowEl.appendChild(actions);
    return rowEl;
  }

  function recButton(id, meta, rerender) {
    var btn = G.el('button', {
      class: 'btn btn-xs ' + (meta ? '' : 'btn-primary'),
      text: meta ? '重录' : '录一条',
      onclick: function () {
        var original = btn.textContent;
        btn.textContent = '录音中…';
        btn.disabled = true;

        G.Audio.startRecording().then(function () {
          G.UI.toast('开始录音，读完点「停止」');
          btn.textContent = '停止';
          btn.disabled = false;
          btn.onclick = function () {
            btn.disabled = true;
            G.Audio.stopRecording().then(function (blob) {
              if (!blob) { G.UI.toast('录音失败'); return; }
              G.Audio.setOverride(id, blob, 1.0).then(function () {
                G.UI.toast('已替换');
                rerender();
              });
            });
          };
        }).catch(function (e) {
          G.log('录音失败', e);
          G.UI.toast('无法录音，请检查麦克风权限');
          btn.textContent = original;
          btn.disabled = false;
        });
      }
    });
    return btn;
  }

  function buildBackupPanel(save, rerender) {
    var wrap = G.el('div', { class: 'stat-card' });

    var m = G.Store.meta();
    var days = m.lastBackupAt ? G.daysBetween(m.lastBackupAt, Date.now()) : null;
    var hint = days === null
      ? '还没有备份过。iOS 上超过 7 天不玩，进度可能被系统清掉。'
      : ('上次备份：' + (days === 0 ? '今天' : days + ' 天前'));

    wrap.appendChild(G.el('div', {
      class: 'backup-hint' + (days === null || days >= 7 ? ' backup-warn' : ''),
      text: hint
    }));

    wrap.appendChild(G.el('button', {
      class: 'btn btn-sm btn-primary', text: '导出备份',
      onclick: function () {
        G.Store.exportAll().then(function (payload) {
          var text = JSON.stringify(payload);
          var size = Math.round(text.length / 1024);
          var name = 'yxjx-backup-' + G.localDateStr() + '.json';

          // 两条路都给：iOS/微信里 <a download> 大概率不工作，剪贴板是兜底
          try {
            var blob = new Blob([text], { type: 'application/json' });
            var url = URL.createObjectURL(blob);
            var a = G.el('a', { href: url, download: name });
            document.body.appendChild(a);
            a.click();
            setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
          } catch (e) {
            G.log('下载失败', e);
          }

          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () {
              G.Store.setMeta({ lastBackupAt: Date.now() });
              G.UI.toast('已复制到剪贴板（' + size + ' KB），粘贴到微信文件传输助手保存');
              rerender();
            }).catch(function () {
              G.UI.toast('已尝试下载备份文件（' + size + ' KB）');
              rerender();
            });
          } else {
            G.UI.toast('已尝试下载备份文件（' + size + ' KB）');
            rerender();
          }
        });
      }
    }));

    var importArea = G.el('textarea', {
      class: 'gate-input import-area', placeholder: '把备份内容粘贴到这里'
    });
    wrap.appendChild(importArea);

    wrap.appendChild(G.el('button', {
      class: 'btn btn-sm', text: '从上面内容恢复',
      onclick: function () {
        var text = importArea.value.trim();
        if (!text) { G.UI.toast('请先粘贴备份内容'); return; }
        try {
          var payload = JSON.parse(text);
          G.Store.importAll(payload).then(function (r) {
            G.UI.toast('已恢复：' + r.save.points.balance + ' 分，' + r.overrides + ' 条录音');
            rerender();
          }).catch(function (e) {
            G.UI.toast('恢复失败：' + e.message);
          });
        } catch (e) {
          G.UI.toast('内容不是有效的备份（' + e.message + '）');
        }
      }
    }));

    return wrap;
  }

  /* ---------- 小工具 ---------- */

  function section(title, content) {
    return G.el('div', { class: 'p-section' }, [
      G.el('div', { class: 'p-section-title', text: title }),
      content
    ]);
  }

  function row(label, value) {
    return G.el('div', { class: 'stat-row' }, [
      G.el('span', { class: 'stat-label', text: label }),
      G.el('span', { class: 'stat-value', text: value })
    ]);
  }

  function bar(label, correct, total) {
    var pct = total ? Math.round(correct / total * 100) : 0;
    return G.el('div', { class: 'bar-row' }, [
      G.el('span', { class: 'bar-label', text: label }),
      G.el('span', { class: 'bar-track' }, [
        G.el('span', { class: 'bar-fill', style: 'width:' + pct + '%' })
      ]),
      G.el('span', { class: 'bar-pct', text: pct + '%' })
    ]);
  }

  G.Parent = {
    openGate: openGate,
    open: open,
    gateState: gateState
  };

})(window);

/* ===== 90-main.js ===== */
/* 90-main.js — 启动、路由、一局的游戏循环 */
(function (window) {
  'use strict';

  var G = window.G;

  var root = null;
  var save = null;
  var round = null;          // {family, questions, startedAt}
  var idx = 0;
  var results = [];          // [true|false|null]
  var items = [];            // 逐题记录
  var spins = [];
  var roundPoints = 0;
  var respinCount = 0;
  var qStartAt = 0;

  /* ---------- 启动 ---------- */

  function boot(data) {
    root = G.$('#app');
    save = G.Store.load();

    G.Curriculum.init(data);
    G.Audio.init();

    save.integrity.bootId = (save.integrity.bootId || 0) + 1;
    G.Store.checkClock(save);
    G.Store.save(save);

    checkEnvironment();
    showHome();

    // 页面隐藏时落盘，防止 iOS 直接杀进程丢进度
    window.addEventListener('pagehide', function () { G.Store.save(save); });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) G.Store.save(save);
    });
  }

  function checkEnvironment() {
    if (!G.StorageAvailable) { /* 兼容旧调用 */ }
    if (!G.storageAvailable()) {
      G.banner('进度无法保存（可能是无痕模式）。建议在浏览器中打开。', 'warn');
    }

    // 微信内置浏览器没有「添加到主屏幕」，且 7 天不访问会被清缓存。
    // 不做这个提示，典型事故是：玩了三次攒了 150 分，一周后归零，孩子崩溃。
    var m = G.Store.meta();
    if (G.env.isWeChat && !m.wechatWarned) {
      G.Store.setMeta({ wechatWarned: true });
      setTimeout(function () {
        showModal('在微信里玩要注意', [
          '在微信里打开的游戏，进度可能会被系统清理掉。',
          '建议点右上角 ⋯ → 在浏览器中打开，再「添加到主屏幕」。',
          '或者直接用家长发给你的那个单文件版本，永久离线可玩。'
        ]);
      }, 600);
    }
  }

  function showModal(title, lines) {
    var overlay = G.el('div', { class: 'overlay' });
    var box = G.el('div', { class: 'panel panel-narrow' });
    box.appendChild(G.el('div', { class: 'panel-title', text: title }));
    lines.forEach(function (l) { box.appendChild(G.el('p', { class: 'modal-p', text: l })); });
    box.appendChild(G.el('button', {
      class: 'btn btn-primary', text: '知道了',
      onclick: function () {
        overlay.classList.add('closing');
        setTimeout(function () {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }, 260);
      }
    }));
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  }

  /* ---------- 首页 ---------- */

  function showHome() {
    G.clear(root);
    G.UI.dismissBanner();

    var s = G.UI.screen('screen-home');

    s.appendChild(G.el('div', { class: 'home-title', text: '知识闯关' }));
    s.appendChild(G.el('div', { class: 'home-sub', text: '语文 · 数学 · 英语' }));

    var stats = G.el('div', { class: 'home-stats' }, [
      G.el('div', { class: 'home-points', text: String(save.points.balance) }),
      G.el('div', { class: 'home-points-label', text: '积分' })
    ]);
    s.appendChild(stats);

    s.appendChild(G.el('button', {
      class: 'btn btn-primary btn-xl', text: '开始游戏',
      onclick: startRound
    }));

    var row = G.el('div', { class: 'home-row' });
    row.appendChild(G.el('button', {
      class: 'btn btn-secondary', text: '🎁 我的奖励',
      onclick: function () { G.Redeem.openScreen(save, showHome); }
    }));
    row.appendChild(G.el('button', {
      class: 'btn btn-ghost', text: '👨👩👧 家长',
      onclick: function () { G.Parent.openGate(function () { G.Parent.open(save); }); }
    }));
    s.appendChild(row);

    if (save.sessions.length) {
      var last = save.sessions[save.sessions.length - 1];
      s.appendChild(G.el('div', {
        class: 'home-last',
        text: '上次：' + last.correct + ' / ' + last.total + ' 题'
      }));
    }

    root.appendChild(s);

    if (G.DEBUG) s.appendChild(debugBar());
  }

  function debugBar() {
    var bar = G.el('div', { class: 'debug-bar' });
    bar.appendChild(G.el('button', {
      class: 'btn btn-xs', text: '自检',
      onclick: function () { location.hash = '#selftest'; location.reload(); }
    }));
    bar.appendChild(G.el('button', {
      class: 'btn btn-xs', text: '+100分',
      onclick: function () { save.points.balance += 100; save.points.lifetime += 100; G.Store.save(save); showHome(); }
    }));
    return bar;
  }

  /* ---------- 一局 ---------- */

  function startRound() {
    round = G.Runner.buildRound(save);
    idx = 0;
    results = new Array(round.questions.length).fill(null);
    items = [];
    spins = [];
    roundPoints = 0;
    respinCount = 0;

    G.log('本局题目：', round.questions.map(function (q) {
      return q.subject + ':' + q.type + (q.family ? '/' + q.family : '');
    }).join('  '));

    // 预加载本局音频，不阻塞渲染
    var ids = [];
    round.questions.forEach(function (q) { (q.audio || []).forEach(function (a) { ids.push(a); }); });
    G.Audio.preload(ids);

    showQuestion();
  }

  function showQuestion() {
    G.clear(root);

    if (idx >= round.questions.length) { showSummary(); return; }

    var q = round.questions[idx];
    qStartAt = Date.now();

    var s = G.UI.screen('screen-game');

    // ---- 顶栏 ----
    var top = G.el('div', { class: 'game-top' });
    top.appendChild(G.el('button', {
      class: 'btn btn-icon', text: '✕',
      onclick: function () {
        if (window.confirm('要退出这一局吗？这一局的进度不会保存。')) showHome();
      }
    }));
    top.appendChild(G.UI.progressDots(round.questions.length, idx, results));
    top.appendChild(G.el('span', { class: 'game-points', text: save.points.balance + '分' }));
    s.appendChild(top);

    // ---- 题面 ----
    var body = G.el('div', { class: 'game-body' });
    s.appendChild(body);

    root.appendChild(s);

    var renderer = G.rendererFor(q.type);
    renderer(body, q, {
      save: save,
      onAnswer: function (correct) { handleAnswer(q, correct); }
    });
  }

  function handleAnswer(q, correct) {
    var ms = Date.now() - qStartAt;

    results[idx] = correct;
    items.push({ qid: q.id, subject: q.subject, type: q.type, family: q.family || null, correct: correct, ms: ms });

    G.Runner.recordAnswer(save, q, correct, ms);
    G.Store.save(save);

    var advance = function () {
      idx++;
      showQuestion();
    };

    if (!correct) { advance(); return; }

    // 答对 → 转盘
    respinCount = 0;
    spinLoop(advance);
  }

  function spinLoop(then) {
    G.Wheel.open(save, { respinCount: respinCount }).then(function (res) {
      spins.push({ prize: res.prize.id, ts: Date.now() });
      roundPoints += res.awarded || 0;

      var dc = G.Store.todayCounter(save);
      dc.spins += 1;

      if (res.again) {
        respinCount = res.respins;
        G.log('再来一次，已重转', respinCount, '次');
        spinLoop(then);            // 重转，不推进题目
        return;
      }

      G.Store.save(save);
      updatePointsChip();
      setTimeout(then, 260);
    });
  }

  function updatePointsChip() {
    var chip = G.$('.game-points');
    if (chip) chip.textContent = save.points.balance + '分';
  }

  /* ---------- 结算 ---------- */

  function showSummary() {
    var session = G.Runner.finishSession(save, round, items, spins, roundPoints);
    G.clear(root);

    var s = G.UI.screen('screen-summary');

    var pct = Math.round(session.correct / session.total * 100);
    var praise = pct >= 90 ? '太棒了！' : pct >= 70 ? '做得很好！' : pct >= 50 ? '有进步！' : '继续加油！';

    s.appendChild(G.el('div', { class: 'summary-emoji', text: pct >= 70 ? '🌟' : '💪' }));
    s.appendChild(G.el('div', { class: 'summary-title', text: praise }));
    s.appendChild(G.el('div', { class: 'summary-score', text: session.correct + ' / ' + session.total }));

    var card = G.el('div', { class: 'summary-card' });
    card.appendChild(G.el('div', { class: 'stat-row' }, [
      G.el('span', { class: 'stat-label', text: '本局得分' }),
      G.el('span', { class: 'stat-value', text: '+' + roundPoints + ' 分' })
    ]));
    card.appendChild(G.el('div', { class: 'stat-row' }, [
      G.el('span', { class: 'stat-label', text: '当前积分' }),
      G.el('span', { class: 'stat-value', text: save.points.balance + ' 分' })
    ]));
    if (round.family) {
      card.appendChild(G.el('div', { class: 'stat-row' }, [
        G.el('span', { class: 'stat-label', text: '今天练的词族' }),
        G.el('span', { class: 'stat-value', text: '-' + round.family })
      ]));
    }
    s.appendChild(card);

    if (pct >= 70) G.UI.confetti(s);

    s.appendChild(G.el('button', {
      class: 'btn btn-primary btn-xl', text: '再来一局',
      onclick: startRound
    }));
    s.appendChild(G.el('button', {
      class: 'btn btn-ghost', text: '回到首页',
      onclick: showHome
    }));

    root.appendChild(s);
    G.Audio.play('ui.win');
  }

  /* ---------- 导出给入口 ---------- */

  G.App = { boot: boot, showHome: showHome };

})(window);

/* ===== 99-selftest.js ===== */
/* 99-selftest.js — 真机自检页（Phase 0 的核心交付物）
 *
 * Phase 0 的唯一目的是把所有「需实测验证」打掉。这些结论里任何一条为负面，
 * 都会改变架构。所以在真机上跑一遍，把结果复制回来看。
 *
 * 访问方式：index.html#selftest 或 index.html?debug=1 再点「自检」
 */
(function (window) {
  'use strict';

  var G = window.G;

  var results = [];
  var pass = 0, fail = 0, warn = 0;

  function record(name, status, detail) {
    results.push({ name: name, status: status, detail: detail });
    if (status === 'pass') pass++;
    else if (status === 'fail') fail++;
    else warn++;
  }

  /* ---------- 各项检测 ---------- */

  function checkEnvironment() {
    record('运行环境', 'info',
      (G.env.isIOS ? 'iOS' : G.env.isAndroid ? 'Android' : '桌面') +
      (G.env.isWeChat ? ' · 微信' : ' · 浏览器') +
      (G.env.isStandalone ? ' · 已添加到主屏幕' : ''));

    record('页面协议', G.env.isFile ? 'warn' : 'pass',
      location.protocol + (G.env.isFile ? '（file:// 下部分 API 受限，这正是单文件版要验证的）' : ''));

    record('屏幕', 'info', window.screen.width + '×' + window.screen.height +
      ' dpr=' + window.devicePixelRatio);

    record('UA', 'info', navigator.userAgent.slice(0, 120));
  }

  function checkAudioContext() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      record('AudioContext', 'fail', '不支持 —— 音频方案不可行，需要改用 <audio> 元素');
      return;
    }
    record('AudioContext', 'pass', '构造成功（实际播放需真人点击下方按钮测试）');
  }

  /**
   * 音频测试按钮。必须由真实手势触发，所以不能放进 run() 的自动流程里。
   * 结果写进 results 后重新渲染，让结论出现在报告里。
   */
  function audioTestCard() {
    var wrap = G.el('div', { class: 'st-manual st-audio-test' });
    wrap.appendChild(G.el('h2', { text: '音频测试（最重要的一项）' }));

    var btn = G.el('button', { class: 'btn btn-primary btn-xl', text: '▶ 点这里测试声音' });
    var log = G.el('div', { class: 'st-log', text: '在微信里也要单独测一次 —— 微信内置浏览器是全部待验证项里最不确定的一条。' });

    btn.addEventListener('click', function () {
      btn.disabled = true;
      var t0 = Date.now();
      log.textContent = '测试中…';

      G.Audio.unlock().then(function (ok) {
        record('全局解锁 AudioContext', ok ? 'pass' : 'fail',
          ok ? ('耗时 ' + (Date.now() - t0) + 'ms') : '解锁失败——音频方案需要调整');
        if (!ok) { log.textContent = '❌ 解锁失败'; render(); return; }

        var ids = Object.keys(G.AUDIO_MAP || {});

        // 还没有内置音频（Phase 0 的常态）→ 播一个合成正弦波，至少验证音频通路
        if (!ids.length) {
          var ctx = G.Audio._ctx();
          var osc = ctx.createOscillator();
          var g = ctx.createGain();
          g.gain.value = 0.15;
          osc.connect(g);
          g.connect(ctx.destination);
          osc.frequency.value = 660;
          osc.start();
          osc.stop(ctx.currentTime + 0.5);
          record('音频通路（合成音）', 'pass', '已播 0.5 秒 660Hz');
          log.textContent = '🔊 听到「嘀」了吗？听到就说明音频通路正常。';
          render();
          return;
        }

        // 有内置音频 → 端到端测一条真实的
        G.Audio.play(ids[0]).then(function (played) {
          record('端到端播放内置音频', played ? 'pass' : 'fail',
            played ? ('已播放 ' + ids[0]) : '解码或播放失败');
          log.textContent = played ? ('✅ 播放成功：' + ids[0]) : '❌ 播放失败';
          render();
        });
      }).catch(function (e) {
        record('音频测试', 'fail', String(e && e.message || e));
        log.textContent = '❌ ' + e;
        render();
      });
    });

    wrap.appendChild(btn);
    wrap.appendChild(log);
    return wrap;
  }

  function checkMediaRecorder() {
    if (!window.MediaRecorder) {
      record('MediaRecorder', 'fail', '不支持 —— 家长录音要走 PCM→WAV 兜底路径');
      return;
    }
    var candidates = ['audio/mp4', 'audio/mp4;codecs=mp4a.40.2', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm'];
    var supported = candidates.filter(function (m) {
      try { return window.MediaRecorder.isTypeSupported(m); } catch (e) { return false; }
    });

    if (!supported.length) {
      record('MediaRecorder 编码格式', 'fail', '没有支持的格式，录音要走 PCM→WAV 兜底');
    } else {
      var hasMp4 = supported.some(function (m) { return m.indexOf('audio/mp4') === 0 || m.indexOf('audio/aac') === 0; });
      record('MediaRecorder 编码格式', hasMp4 ? 'pass' : 'warn',
        '支持：' + supported.join(', ') +
        (hasMp4 ? '' : ' —— 只有 webm，iOS 上播不了，需要兜底'));
    }
  }

  function checkStorage() {
    return new Promise(function (res) {
      // localStorage
      try {
        var k = '__st_' + Date.now();
        window.localStorage.setItem(k, 'x');
        var v = window.localStorage.getItem(k);
        window.localStorage.removeItem(k);
        record('localStorage 读写', v === 'x' ? 'pass' : 'fail', v === 'x' ? '' : '写入后读不回来');
      } catch (e) {
        record('localStorage 读写', 'fail', '不可用：' + e.message + '（无痕模式或微信限制）');
      }

      // 持久性：写一个带时间戳的标记，下次打开若能读到说明还在
      try {
        var prev = window.localStorage.getItem('__st_persist');
        if (prev) {
          var age = Math.round((Date.now() - +prev) / 1000);
          record('localStorage 持久性', 'pass', '上次运行是 ' + age + ' 秒前，标记还在');
        } else {
          record('localStorage 持久性', 'warn', '首次运行。请关掉页面/微信后再打开本页，看这条会不会变绿');
        }
        window.localStorage.setItem('__st_persist', String(Date.now()));
      } catch (e) {}

      // 容量估算
      if (navigator.storage && navigator.storage.estimate) {
        navigator.storage.estimate().then(function (est) {
          record('存储配额', 'info',
            '已用 ' + fmtBytes(est.usage) + ' / 配额 ' + fmtBytes(est.quota));
          res();
        }).catch(function () { res(); });
      } else {
        record('存储配额', 'info', 'navigator.storage.estimate 不可用');
        res();
      }
    });
  }

  function checkIndexedDB() {
    return new Promise(function (res) {
      if (!window.indexedDB) {
        record('IndexedDB', 'fail', '不支持 —— 家长录音无处存放');
        return res();
      }
      try {
        var req = window.indexedDB.open('__st_test', 1);
        req.onupgradeneeded = function () {
          req.result.createObjectStore('t', { keyPath: 'id' });
        };
        req.onsuccess = function () {
          var db = req.result;
          var tx = db.transaction('t', 'readwrite');
          tx.objectStore('t').put({ id: 'k', blob: new Blob(['hello'], { type: 'text/plain' }) });
          tx.oncomplete = function () {
            var tx2 = db.transaction('t', 'readonly');
            var get = tx2.objectStore('t').get('k');
            get.onsuccess = function () {
              var ok = get.result && get.result.blob;
              record('IndexedDB 读写 Blob', ok ? 'pass' : 'fail',
                ok ? '可存可读（' + get.result.blob.size + ' 字节）' : '读回为空');
              db.close();
              try { window.indexedDB.deleteDatabase('__st_test'); } catch (e) {}
              res();
            };
            get.onerror = function () { record('IndexedDB 读写', 'fail', '读取失败'); res(); };
          };
          tx.onerror = function () { record('IndexedDB 读写', 'fail', '写入失败'); res(); };
        };
        req.onerror = function () {
          record('IndexedDB', 'fail', '打开失败：' + (req.error && req.error.message));
          res();
        };
      } catch (e) {
        record('IndexedDB', 'fail', e.message);
        res();
      }
    });
  }

  function checkAudioManifest() {
    var ids = Object.keys(G.AUDIO_MAP || {});
    if (!ids.length) {
      record('音频清单', 'warn', 'AUDIO_MAP 为空 —— Phase 0 只有占位音频，属正常');
      return;
    }
    record('音频清单', 'pass', ids.length + ' 条');

    // 抽 3 条解码，看会不会失败
    var sample = ids.slice(0, 3);
    var t0 = Date.now();
    var memBefore = performance.memory ? performance.memory.usedJSHeapSize : 0;

    G.Audio.preload(sample).then(function () {
      var dt = Date.now() - t0;
      var memAfter = performance.memory ? performance.memory.usedJSHeapSize : 0;
      var memNote = memBefore ? ('，堆增长 ' + fmtBytes(memAfter - memBefore)) : '';
      record('解码 ' + sample.length + ' 条音频', 'pass', dt + 'ms' + memNote);

      if (memBefore) {
        var perItem = (memAfter - memBefore) / sample.length;
        record('内存外推', 'info',
          '按此推算 145 条约需 ' + fmtBytes(perItem * 145) + '（含 LRU 可优化）');
      }
    });
  }

  function checkTouch() {
    record('指针事件', ('PointerEvent' in window) ? 'pass' : 'warn',
      ('PointerEvent' in window) ? '可用（用 pointerdown 解锁音频）' : '不支持，需要回退到 click');

    var hasSafeArea = window.CSS && CSS.supports && CSS.supports('padding', 'env(safe-area-inset-top)');
    record('安全区 env()', hasSafeArea ? 'pass' : 'warn',
      hasSafeArea ? '支持刘海屏安全区' : '不支持，刘海屏上可能被遮挡');
  }

  /* ---------- 渲染 ---------- */

  function fmtBytes(n) {
    if (!n && n !== 0) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  function render() {
    document.body.classList.add('selftest-mode');
    var wrap = G.el('div', { class: 'selftest' });

    wrap.appendChild(G.el('h1', { text: '真机自检' }));
    wrap.appendChild(G.el('p', { class: 'st-intro', text:
      'Phase 0 的目的是打掉技术不确定性。请在这台设备上跑完，点底部「复制结果」发回来。' }));

    var bar = G.el('div', { class: 'st-bar' });
    bar.appendChild(G.el('span', { class: 'st-pass', text: pass + ' 通过' }));
    bar.appendChild(G.el('span', { class: 'st-fail', text: fail + ' 失败' }));
    bar.appendChild(G.el('span', { class: 'st-warn', text: warn + ' 待确认' }));
    wrap.appendChild(bar);

    var list = G.el('div', { class: 'st-list', id: 'selftest-list' });
    results.forEach(function (r) {
      list.appendChild(G.el('div', { class: 'st-row st-' + r.status }, [
        G.el('span', { class: 'st-badge', text: badge(r.status) }),
        G.el('div', { class: 'st-body' }, [
          G.el('div', { class: 'st-name', text: r.name }),
          r.detail ? G.el('div', { class: 'st-detail', text: r.detail }) : null
        ])
      ]));
    });
    wrap.appendChild(list);

    // 音频测试必须由真实手势触发，不能放进自动流程
    wrap.appendChild(audioTestCard());

    // 重要的手动测试项
    wrap.appendChild(G.el('div', { class: 'st-manual' }, [
      G.el('h2', { text: '还需要手动确认的' }),
      G.el('ul', {}, [
        G.el('li', { text: '关掉本页/微信，30 秒后再打开 ——「localStorage 持久性」是否变绿？' }),
        G.el('li', { text: '把单文件 HTML 用微信发给自己，点开能不能玩、有没有声音？' }),
        G.el('li', { text: '切到别的 App 再切回来，声音还在吗？（僵尸 AudioContext 测试）' }),
        G.el('li', { text: '在微信里打开线上版链接，重复一次上面的音频测试。' })
      ])
    ]));

    var actions = G.el('div', { class: 'st-actions' });
    actions.appendChild(G.el('button', {
      class: 'btn btn-primary', text: '复制结果',
      onclick: function () {
        var text = reportText();
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () {
            G.UI.toast('已复制，粘贴发回即可');
          }).catch(function () {
            window.prompt('复制下面的内容：', text);
          });
        } else {
          window.prompt('复制下面的内容：', text);
        }
      }
    }));
    actions.appendChild(G.el('button', {
      class: 'btn btn-ghost', text: '返回游戏',
      onclick: function () { location.hash = ''; location.reload(); }
    }));
    wrap.appendChild(actions);

    G.clear(document.getElementById('app'));
    document.getElementById('app').appendChild(wrap);
  }

  function badge(s) {
    return { pass: '✅', fail: '❌', warn: '⚠️', info: 'ℹ️' }[s] || '·';
  }

  function reportText() {
    var lines = ['=== 幼小衔接游戏 自检报告 ===',
                 '时间：' + new Date().toLocaleString(),
                 '版本：' + G.VERSION,
                 (pass + ' 通过 / ' + fail + ' 失败 / ' + warn + ' 待确认'), ''];
    results.forEach(function (r) {
      lines.push(badge(r.status) + ' ' + r.name + (r.detail ? ' — ' + r.detail : ''));
    });
    return lines.join('\n');
  }

  /* ---------- 入口 ---------- */

  async function run() {
    checkEnvironment();
    checkAudioContext();
    checkMediaRecorder();
    checkTouch();
    await checkStorage();
    await checkIndexedDB();
    checkAudioManifest();
    render();
  }

  G.SelfTest = { run: run, reportText: reportText };

})(window);
