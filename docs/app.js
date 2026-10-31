/* ===== 00-core.js ===== */
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
    // 这个音效一直写在注释里，但从来没有实现过 ——
    // 视觉反馈有（绿脉冲/抖动），听觉反馈没有，所以试玩反馈是
    // 「点了没声音」。视觉 + 听觉要成对出现：孩子低头看选项的时候，
    // 声音是唯一能确认「我点到了」的东西。
    if (G.Audio) G.Audio.play(correct ? 'ui.correct' : 'ui.wrong');
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
   * 大喇叭按钮。题干带 audio 的题用它。
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

      // 三科各记一份 byTag 掌握度，家长面板按科目分开看。
      // 结构由 G.SUBJECTS 推出来，加科目不用改这里。
      progress: {
        chinese: { byTag: {} },
        math: { byTag: {} },
        english: { byTag: {} }
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
        mutedAudio: [],
        weakMode: false
      },
      // settings.mix 删掉了：它存了一份一局配比的副本，但从头到尾没人读。
      // 配比的唯一真相源是 tools/qbank.py 的 SUBJECT_MIX → 产物里的
      // G.DATA.mix → 运行时的 G.DEFAULT_MIX。在存档里再存一份，
      // 只会变成「改了配比，老用户的存档还是旧配比」这种查不出来的问题。

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

    // progress 是嵌套的，上面的浅拷贝补不到里层。老存档（识字一科时代）
    // 只有 progress.chinese，导入备份后 math/english 会缺 ——
    // 缺了不会崩，但那一科的掌握度会一直是空的，家长面板上看不出来是坏了。
    G.SUBJECTS.forEach(function (s) {
      if (!save.progress[s]) save.progress[s] = { byTag: {} };
      if (!save.progress[s].byTag) save.progress[s].byTag = {};
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

    // 合成音效优先。ui.tap / ui.correct 这些根本没有对应文件 ——
    // 它们是 21-sfx.js 用振荡器现场合成的（见那里的注释：为什么音效不走文件）。
    // 放前面是因为合成音效不需要解码、不会失败，能立刻出声。
    if (G.Sfx && G.Sfx.has(audioId)) {
      var ok = G.Sfx.play(audioId);
      return Promise.resolve(ok);
    }

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

  function has(audioId) {
    if (G.Sfx && G.Sfx.has(audioId)) return true;      // 合成音效，永远可用
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

    // 全局按钮反馈音。放在这里而不是各页面里 —— 见 21-sfx.js 的注释。
    if (G.Sfx && G.Sfx.installTap) G.Sfx.installTap();

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

    // 三重保险：pointerdown 在少数环境下拿不到手势授权 ——
    // 微信 X5 内核、部分安卓 WebView、以及 iOS 上「从后台切回来」后的
    // 第一次点击，都可能出现 pointerdown 到了但 resume() 被拒的情况。
    // 加 touchend 和 click 是因为它们**同样算真实手势**，但触发时机和
    // 事件路径都不同；多一条路径，就少一次「家长说没声音」。
    // 已解锁时是空转（unlocked 判断在 unlock() 之前），不产生开销。
    ['touchend', 'click'].forEach(function (type) {
      document.addEventListener(type, function () {
        if (unlocked) return;
        rebuildIfNeeded();
        unlock();
      }, { passive: true });
    });
  }

  G.Audio = {
    init: init,
    unlock: unlock,
    isUnlocked: isUnlocked,
    resolve: resolve,
    play: play,
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
    _ctx: function () { return ctx; },
    // 21-sfx.js 用这个拿 context —— 它必须复用同一个实例。
    // 各建一个的话，音效那个永远停在 suspended，症状又是「点了没声音」。
    _ensureCtx: getCtx
  };

})(window);

/* ===== 21-sfx.js ===== */
/* 21-sfx.js — 音效层（全部用振荡器现场合成，一个音频文件都不需要）
 *
 * 为什么不用音频文件：
 *   以前 audio/ui/ 下放着两个 12 KB 的占位蜂鸣音，manifest 里标着
 *   _placeholder: true —— 那是「先占位，回头再录」，然后就没有回头了。
 *   结果是整个游戏只有转盘那一声「嘀」，孩子点任何地方都没反馈，
 *   试玩反馈就是「音频异常，点击无声音」。
 *
 *   而这种音效（短促的「嗒」「叮」「嗡」）用振荡器合成只需要几行，
 *   好处是实打实的：
 *     · 零字节，单文件版不用为它多扛一份 base64
 *     · 不会解码失败 —— 音频文件在 iOS 上因为采样率/编码不合规放不出声，
 *       是这个项目里最难查的一类 bug（放不出声但不报错）
 *     · 可以随时调音（音高、时长、波形都是参数）
 *
 *   真正需要「人声」的只有英语单词，那部分走 20-audio.js 的
 *   G.AUDIO_MAP + 预生成语音文件，和这里不冲突。
 *
 * 音效表（id 全部带 ui. 前缀 —— 和 G.AUDIO_MAP 的命名规则一致，
 * 也让 G.Audio.play() 能一眼看出哪些走合成、哪些走文件）：
 *   ui.tap      按钮反馈        ui.correct  答对
 *   ui.wrong    答错            ui.spin     转盘转动（会响 3.4 秒）
 *   ui.win      中奖            ui.lose     空奖（要温柔，不能让孩子难受）
 *   ui.star     攒够分/里程碑
 */
(function (window) {
  'use strict';

  var G = window.G;

  function ctxOf() {
    // 复用 20-audio.js 的 AudioContext —— 一个页面只能有一个，
    // 而且那个已经被 user gesture 解锁过了。这里自己 new 一个的话，
    // 会得到一个永远 suspended 的 context，症状又是「没声音」。
    if (G.Audio && G.Audio._ensureCtx) return G.Audio._ensureCtx();
    return null;
  }

  function enabled() {
    try {
      var s = G.Store && G.Store.load();
      if (s && s.settings && s.settings.audioEnabled === false) return false;
    } catch (e) { /* store 还没起来时按有声处理 */ }
    return true;
  }

  /* ---------- 发声原语 ---------- */

  /**
   * 一个音符。t0 是相对当前时间的偏移（秒），不是绝对时间 ——
   * 调用方只关心「这几个音依次隔多久」，不关心 ctx.currentTime 走到哪了。
   */
  function note(c, opt) {
    var t0 = c.currentTime + (opt.at || 0);
    var dur = opt.dur || 0.12;
    var osc = c.createOscillator();
    var gain = c.createGain();

    osc.type = opt.type || 'sine';
    osc.frequency.setValueAtTime(opt.freq, t0);
    if (opt.to) osc.frequency.exponentialRampToValueAtTime(opt.to, t0 + dur);

    // 包络：瞬间起音 + 指数衰减。
    // 直接 gain=1 然后 stop() 会「啪」一声（波形被硬切），所以尾巴一定要收。
    var vol = (opt.vol === undefined ? 0.25 : opt.vol);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** 扫频噪声，用来做「唰」「咔」这类没有明确音高的声音。 */
  function noise(c, opt) {
    var t0 = c.currentTime + (opt.at || 0);
    var dur = opt.dur || 0.08;
    var len = Math.max(1, Math.floor(c.sampleRate * dur));
    var buf = c.createBuffer(1, len, c.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) {
      // 后面衰减得更快，听起来像敲击而不是白噪
      d[i] = (Math.random() * 2 - 1) * (1 - i / len) * (1 - i / len);
    }
    var src = c.createBufferSource();
    src.buffer = buf;

    var filt = c.createBiquadFilter();
    filt.type = opt.filter || 'bandpass';
    filt.frequency.value = opt.freq || 1800;
    filt.Q.value = opt.q === undefined ? 1.2 : opt.q;

    var gain = c.createGain();
    gain.gain.value = opt.vol === undefined ? 0.3 : opt.vol;

    src.connect(filt);
    filt.connect(gain);
    gain.connect(c.destination);
    src.start(t0);
  }

  /* ---------- 音效定义 ---------- */

  var RECIPES = {
    // 按钮「嗒」。用方波，短到 60ms —— 长一点就会拖慢答题节奏，
    // 一局 10 道题要按几十次，每次多 100ms 就很烦。
    'ui.tap': function (c) {
      note(c, { freq: 880, dur: 0.05, type: 'square', vol: 0.10 });
    },

    // 答对：C5-E5-G5 上行。上行音阶是跨文化通用的「对了」。
    'ui.correct': function (c) {
      note(c, { freq: 523.25, dur: 0.11, type: 'triangle', at: 0,    vol: 0.22 });
      note(c, { freq: 659.25, dur: 0.11, type: 'triangle', at: 0.09, vol: 0.22 });
      note(c, { freq: 783.99, dur: 0.22, type: 'triangle', at: 0.18, vol: 0.26 });
    },

    // 答错：两个下行音，音量压低。
    // 故意不用「嗡嗡」的刺耳低频 —— 6 岁孩子答错本来就挫败，
    // 音效再凶一点，下一题他就不敢点了。
    'ui.wrong': function (c) {
      note(c, { freq: 392.00, dur: 0.13, type: 'sine', at: 0,   vol: 0.18 });
      note(c, { freq: 311.13, dur: 0.24, type: 'sine', at: 0.11, vol: 0.16 });
    },

    // 转盘：棘轮声。26 下，间隔从 45ms 渐增到 260ms ——
    // 和 50-wheel.js 里 3.4s 的 cubic-bezier 减速曲线大致对得上，
    // 孩子听到「咔、咔、咔…… 咔」慢下来，就知道快停了。
    'ui.spin': function (c) {
      var n = 26, t = 0;
      for (var i = 0; i < n; i++) {
        var k = i / (n - 1);
        noise(c, { at: t, dur: 0.035, freq: 2400 - k * 900, vol: 0.10 + k * 0.06, q: 3 });
        t += 0.045 + k * k * 0.215;
      }
    },

    // 中奖：C5-E5-G5-C6 小号式收尾。最后一个音拉长，给「中了！」留出时间。
    'ui.win': function (c) {
      note(c, { freq: 523.25, dur: 0.12, type: 'triangle', at: 0,    vol: 0.24 });
      note(c, { freq: 659.25, dur: 0.12, type: 'triangle', at: 0.10, vol: 0.24 });
      note(c, { freq: 783.99, dur: 0.12, type: 'triangle', at: 0.20, vol: 0.24 });
      note(c, { freq: 1046.5, dur: 0.42, type: 'triangle', at: 0.30, vol: 0.30 });
      note(c, { freq: 523.25, dur: 0.42, type: 'sine',     at: 0.30, vol: 0.14 });
    },

    // 空奖：两个下行长音，柔和。
    // 「下次好运」是明明白白的不中，但孩子已经答对了一道题 ——
    // 这里要收住，不能像是惩罚。
    'ui.lose': function (c) {
      note(c, { freq: 440.00, dur: 0.20, type: 'sine', at: 0,    vol: 0.16 });
      note(c, { freq: 349.23, dur: 0.40, type: 'sine', at: 0.17, vol: 0.14 });
    },

    'ui.star': function (c) {
      note(c, { freq: 1046.5, dur: 0.09, type: 'sine', at: 0,    vol: 0.20 });
      note(c, { freq: 1318.5, dur: 0.09, type: 'sine', at: 0.07, vol: 0.20 });
      note(c, { freq: 1568.0, dur: 0.28, type: 'sine', at: 0.14, vol: 0.24 });
    }
  };

  /* ---------- 对外 ---------- */

  function has(id) { return Object.prototype.hasOwnProperty.call(RECIPES, id); }

  function play(id) {
    if (!enabled()) return false;
    if (!has(id)) return false;

    var c = ctxOf();
    if (!c) return false;

    // 还没解锁时直接放弃，不排队。
    // 排队看着更「对」，但音效是即时反馈 —— 攒到解锁后一起放出来
    // 只会变成一串错位的怪声，不如不放。
    if (c.state !== 'running') {
      G.log('sfx 跳过（context 未解锁）', id);
      return false;
    }

    try {
      RECIPES[id](c);
      return true;
    } catch (e) {
      // 音效永远不能把游戏搞崩
      G.log('sfx 合成失败', id, e);
      return false;
    }
  }

  /* ---------- 全局按钮「嗒」声 ---------- */

  /**
   * 用事件委托给所有按钮加反馈音，而不是在每个 onclick 里各写一行。
   *
   * 为什么值得这么绕：这个游戏里绝大多数点击是「翻页/开始/继续」这类
   * 没有对错的动作，它们也必须有声音 —— 6 岁孩子判断「我点到了没有」
   * 靠的就是这一下响。逐个按钮去加，一定会漏；漏掉的那个正好就是
   * 「点了没反应」，也就是这次试玩反馈的问题。
   *
   * 用捕获阶段（第三个参数 true）：在业务 handler 跑之前出声，
   * 手感更跟手；也避免业务 handler 里 stopPropagation 把它吃掉。
   */
  function installTap() {
    document.addEventListener('click', function (e) {
      var el = e.target;
      if (!el || !el.closest) return;

      var btn = el.closest('button, .tap');
      if (!btn || btn.disabled || btn.classList.contains('locked')) return;
      if (btn.hasAttribute('data-sfx-off')) return;

      play('ui.tap');
    }, true);
  }

  G.Sfx = {
    play: play,
    has: has,
    installTap: installTap,
    list: function () { return Object.keys(RECIPES); }
  };

})(window);

/* ===== 30-bank.js ===== */
/* 30-bank.js — 题库：三科分仓 + 加权抽题
 *
 * 从 300 道题里挑一局 10 道，挑得有讲究。
 *
 * 讲究一：**三科分开抽，不混在一起抽**。
 *   如果按 3:3:4 的比例做一张 300 道的加权表然后连抽 10 次，抽出来的
 *   科目分布会随题库大小和权重浮动 —— 语文 90 道、英语 120 道，均匀抽的话
 *   英语天然就多，再叠上错题加权，很可能一局里 8 道英语、1 道语文。
 *   「一局里三科各出几道」是产品要求，不是概率结果，所以按科目配额抽满为止。
 *
 * 讲究二：**科目内不均匀随机**（这部分和以前一样）。
 *   均匀随机会让孩子已经滚瓜烂熟的字反复出现（浪费时间），而总写错的字
 *   永远轮不到（得不到练习）。所以按错题本加权：没掌握的加权重出，
 *   连对两次的降权。
 *
 * 干扰项不在这里生成。所有科目的选项都是内容问题，已经在构建期由
 * tools/gen_*.py 算好写进题库 —— 运行时不猜。
 */
(function (window) {
  'use strict';

  var G = window.G;

  var banks = {};        // { chinese: [q, ...], math: [...], english: [...] }
  var zibiao = null;

  /* ---------- 加载 ---------- */

  function init(data) {
    banks = {};
    var missing = [];

    G.SUBJECTS.forEach(function (s) {
      var list = (data[s] || []).slice();
      if (!list.length) missing.push(G.SUBJECT_LABEL[s] || s);
      banks[s] = list;
    });

    zibiao = data.zibiao || null;

    // 缺一科就让构建期挡住，运行时不带病上线。
    // 少一科的后果不是「少几道题」——是那一局的 10 个坑里空出 3 个，
    // 表现成一局只出 7 道题，而且不报错。
    if (missing.length) {
      throw new Error('缺少题库：' + missing.join('、') + '（跑一次 npm run qbank）');
    }

    G.log('题库已加载',
          G.SUBJECTS.map(function (s) {
            return (G.SUBJECT_LABEL[s] || s) + ' ' + banks[s].length;
          }).join(' · '),
          zibiao ? ('，字表 ' + zibiao.chars.length + ' 字') : '');
  }

  function of(subject) { return banks[subject] || []; }

  /** 全部题目，三科拼一起。给家长页做统计用。 */
  function all() {
    return G.SUBJECTS.reduce(function (acc, s) { return acc.concat(banks[s] || []); }, []);
  }

  function byId(id) {
    for (var i = 0; i < G.SUBJECTS.length; i++) {
      var list = banks[G.SUBJECTS[i]] || [];
      for (var j = 0; j < list.length; j++) {
        if (list[j].id === id) return list[j];
      }
    }
    return null;
  }

  function zibiaoData() { return zibiao; }

  /** 某道题是哪一科的 —— 家长页按科目分组统计时要用。 */
  function subjectOf(id) {
    var q = byId(id);
    return q ? q.subject : null;
  }

  /* ---------- 加权 ---------- */

  /**
   * 一道题的抽取权重。
   *   - 错过的题，错得越多权重越高（+1.5 × 错误次数）
   *   - 连对两次（cleared）的题降到 0.4 —— 不是不出，是少出
   *   - 没做过的题权重 1
   */
  function weightOf(q, wrongIndex) {
    var w = 1;
    var rec = wrongIndex[q.id];
    if (rec && !rec.cleared) w += 1.5 * rec.wrongCount;
    if (rec && rec.cleared) w *= 0.4;
    return w;
  }

  function wrongIndexOf(save) {
    var idx = {};
    (save.wrongBook || []).forEach(function (w) { idx[w.qid] = w; });
    return idx;
  }

  /**
   * 从指定科目抽一道题。excludeIds 用来保证一局之内不重复。
   * @param {object} save
   * @param {string} subject
   * @param {string[]} excludeIds
   * @param {function} rng  可选，注入固定随机源便于测试
   */
  function drawOne(save, subject, excludeIds, rng) {
    rng = rng || Math.random;
    var pool = banks[subject] || [];
    if (!pool.length) return null;

    var excluded = {};
    (excludeIds || []).forEach(function (id) { excluded[id] = true; });

    var avail = pool.filter(function (q) { return !excluded[q.id]; });
    // 兜底：本科目的题被抽空时允许重复，也不让一局短题。
    // 一局只要 3~4 道，而每个科目至少 90 道，正常永远走不到这里；
    // 但题库被裁剪成十几道时就会 —— 那时候「重复一道」也比「少一道」好。
    if (!avail.length) avail = pool;

    var wrongIndex = wrongIndexOf(save);
    var weights = avail.map(function (q) { return weightOf(q, wrongIndex); });
    var total = G.sum(weights);
    if (total <= 0) return avail[Math.floor(rng() * avail.length)];

    var r = rng() * total;
    for (var i = 0; i < avail.length; i++) {
      r -= weights[i];
      if (r <= 0) return avail[i];
    }
    return avail[avail.length - 1];
  }

  G.Bank = {
    init: init,
    of: of,
    all: all,
    byId: byId,
    subjectOf: subjectOf,
    zibiao: zibiaoData,
    weightOf: weightOf,
    drawOne: drawOne
  };

})(window);

/* ===== 40-runner.js ===== */
/* 40-runner.js — 一局的编排：抽题、排位、答题结算
 *
 * 排位是这里最重要的设计：
 *   第 1 题和第 10 题必来自孩子正确率最高的池。
 *   6 岁孩子最后一题的成败，直接决定他明天还想不想玩。
 *
 * 第二重要的是「同一题型不连着出」：题库里 8 种题型（看拼音选字、
 * 数笔画、反义词…）均匀抽，但连续三道「数笔画」会让一局显得很单调。
 */
(function (window) {
  'use strict';

  var G = window.G;

  /* ---------- 成功概率估计 ---------- */

  /**
   * 估计孩子答对某题的概率。有历史用历史，没历史用难度做代理。
   * 只用来排位置，不参与计分。
   */
  function successProb(q, save) {
    var rec = null;
    save.wrongBook.forEach(function (w) { if (w.qid === q.id) rec = w; });
    if (rec && rec.seen > 0) return rec.correct / rec.seen;

    // 无历史：难度 1 → 0.9, 难度 2 → 0.75, 难度 3 → 0.6
    return G.clamp({ 1: 0.9, 2: 0.75, 3: 0.6 }[q.difficulty || 1] || 0.75, 0.1, 0.98);
  }

  /* ---------- 组局 ---------- */

  /**
   * 组一局。
   *
   * 抽题**不用固定种子**（数学时代用过「同一天同一局」的日种子，那是为了
   * 生成的算式可复现 —— 家长想再讲一遍时题目别变）。这里反过来：同一局
   * 重玩应该换一批字，否则孩子第二遍是背答案而不是认字。错题本的加权
   * 也依赖「刚答错的题立刻变得更常出」，日种子会把这条反馈延迟到明天。
   */
  function buildRound(save) {
    var used = [];
    var picked = [];

    // **按科目配额抽满，而不是一起抽再按比例挑。**
    // 一起抽的话，科目分布是概率结果不是配额：英语 120 道本来就比语文的
    // 90 道更容易被抽中，再叠上错题加权，一局很可能 8 道英语 1 道语文。
    // 「一局里三科各出几道」是产品要求，得用配额保证。
    G.SUBJECTS.forEach(function (s) {
      var want = G.DEFAULT_MIX[s] || 0;
      for (var i = 0; i < want; i++) {
        var q = G.Bank.drawOne(save, s, used);
        if (!q) break;
        used.push(q.id);
        picked.push(q);
      }
    });

    // 兜底。正常抽不到这一步（每科至少 90 道 >> 一局要的 3~4 道），
    // 只有题库被裁剪到一局以内才会走到：那时允许重复 ——
    // 宁可出现重题，也不要让一局变成半局。
    while (picked.length < G.ROUND_SIZE) {
      var extra = null;
      for (var k = 0; k < G.SUBJECTS.length && !extra; k++) {
        extra = G.Bank.drawOne(save, G.SUBJECTS[k], used);
      }
      if (!extra) break;
      used.push(extra.id);
      picked.push(extra);
    }

    return {
      questions: arrange(picked, save),
      startedAt: Date.now()
    };
  }

  /**
   * 排位置：
   *   1. 最可能答对的两道，分给第 1 题和第 10 题
   *   2. 剩下的打散，且相邻两题尽量不同科、同科内尽量不同题型
   */
  function arrange(questions, save) {
    if (questions.length <= 2) return questions.slice();

    var ranked = questions.slice().sort(function (a, b) {
      return successProb(b, save) - successProb(a, save);
    });

    var first = ranked[0];
    var last = ranked[1];
    var middle = spread(ranked.slice(2), first, last);

    return [first].concat(middle, [last]);
  }

  function tagOf(q) {
    return (q.tags && q.tags[0]) || q.type || '';
  }

  /**
   * 把中间几道排开：每次从剩下的题里挑一道最「不重样」的放进去。
   *
   * 为什么要重排而不是直接打散：
   *   一局 10 道是 3 语文 + 3 数学 + 4 英语。纯随机打散的话，出现
   *   「连着 3 道英语」甚至「连着 4 道英语」的概率相当高 —— 一局 10 道里
   *   连着刷 4 道英语，孩子感觉就是「这局全是英语」。
   *
   * 打分是字典序的，优先级从高到低：
   *   ① 科目和上一题不同     ② 题型和上一题不同
   *   ③ 科目不和末题撞       ④ 题型不和末题撞（只有剩最后一道时才起作用）
   *   ⑤ 该科目剩下最多       ⑥ 该题型剩下最多
   * 前四条是「别挨着」，后两条是经典的「先消耗大堆」—— 不先消耗大堆，
   * 小堆会剩到最后被迫相邻，前面白排了。
   *
   * 这是软约束：真到了只剩同一科的地步，①拿不到分，就按⑤⑥继续排下去，
   * 不为了满足约束把题目弄丢。
   */
  function spread(items, head, tail) {
    var pool = G.shuffle(items.slice(), Math.random);
    var out = [];
    var prevSub = head.subject;
    var prevTag = tagOf(head);
    var tailSub = tail.subject;
    var tailTag = tagOf(tail);

    while (pool.length) {
      var bySub = {};
      var bySubTag = {};
      pool.forEach(function (q) {
        bySub[q.subject] = (bySub[q.subject] || 0) + 1;
        var k = q.subject + '/' + tagOf(q);
        bySubTag[k] = (bySubTag[k] || 0) + 1;
      });

      var isLast = (pool.length === 1);
      var pick = 0;
      var best = null;

      for (var i = 0; i < pool.length; i++) {
        var q = pool[i];
        var t = tagOf(q);
        var score = [
          q.subject === prevSub ? 0 : 1,
          t === prevTag ? 0 : 1,
          (isLast && q.subject === tailSub) ? 0 : 1,
          (isLast && t === tailTag) ? 0 : 1,
          bySub[q.subject] || 0,
          bySubTag[q.subject + '/' + t] || 0
        ];
        if (best === null || lexGreater(score, best)) { best = score; pick = i; }
      }

      var chosen = pool.splice(pick, 1)[0];
      prevSub = chosen.subject;
      prevTag = tagOf(chosen);
      out.push(chosen);
    }
    return out;
  }

  /** 字典序比较：从前往后，第一个不相等的分量决定胜负。 */
  function lexGreater(a, b) {
    for (var i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] > b[i];
    }
    return false;
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
        qid: q.id, subject: q.subject, family: null,
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

    // --- 按知识点统计（家长面板用）---
    // 记到自己那一科下面。三科的题型名天然不重叠（归类 / 拆数 / 听音选字母），
    // 但分开记才看得出「数学应用题弱、语文笔画弱」这种分科结论。
    var prog = save.progress[q.subject] || (save.progress[q.subject] = { byTag: {} });
    var bucket = prog.byTag;
    (q.tags || []).forEach(function (tag) {
      var t = bucket[tag] || (bucket[tag] = { seen: 0, correct: 0 });
      t.seen++; if (correct) t.correct++;
    });

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
/* 41-render-choice.js — 选择题渲染器
 *
 * 三科 300 道题全部是 choice（题干 + 4 个选项），所以只有一个渲染分支。
 * 差异全在数据里：stem.layout 决定选项排布，stem.audio 决定要不要喇叭。
 *
 * rendererFor 也放在这里。它原来在 44-render-realword.js —— 那个文件承载的
 * 是「看图选词 / 排序 / 拼词」三种看图题型，都删了，只剩下「按 type 找
 * 渲染器」这一件小事，没必要为它单开一个文件。
 */
(function (window) {
  'use strict';

  var G = window.G;

  G.Renderers = G.Renderers || {};

  /**
   * 「单独一个字符」的选项。汉字（日 / 目 / 白）和英语的单个字母
   * （B / b）都要单独放大 —— 一眼看不清的字形，孩子只能靠猜。
   *
   * 数学题不在这条里：它的选项也是短的（7 / 70），把「7」放大到 50px
   * 会让同一排高低不平，看起来像排版坏了。
   */
  var SINGLE_RE = /^(?:[一-鿿]|[A-Za-z])$/;

  /**
   * 按题型取渲染器。目前只有 choice 一种，未知题型兜底也给它 ——
   * 宁可渲染出一道还能做的题，也不要空白屏。
   */
  G.rendererFor = function (type) {
    return G.Renderers[type] || G.Renderers.choice;
  };

  G.Renderers.choice = function (container, q, handlers) {
    var options = q.options || [];
    var layout = (q.stem && q.stem.layout) || (options.length <= 2 ? 'row' : 'grid');
    var answered = false;

    // 布局类别挂在根上，题干和选项都能按它取样式
    // （math 的 big-number 要连题干一起放大，只给选项加类做不到）。
    var root = G.el('div', { class: 'q q-choice q-layout-' + layout });

    // ---- 题干 ----
    var stem = G.el('div', { class: 'stem' });

    var hasAudio = !!(q.stem && q.stem.audio);

    if (q.stem && q.stem.prompt) {
      stem.appendChild(G.el('div', { class: 'stem-hint', text: q.stem.prompt }));
    }

    // 题干文字和喇叭按钮**不是二选一**：英语的听音题两者都有
    // （「听一听，这个词开头是哪个大写字母？」+ 音频）。
    // 早先这里写成了 if/else if，结果是英语题的文字题干全都不显示。
    if (q.stem && q.stem.text) {
      stem.appendChild(G.el('div', { class: 'stem-text', text: q.stem.text }));
    }

    if (hasAudio) {
      stem.appendChild(G.UI.speakerButton(q.stem.audio, null, { autoplay: true }));
    }

    root.appendChild(stem);

    // ---- 选项 ----
    var grid = G.el('div', { class: 'options options-' + layout });
    var buttons = {};

    options.forEach(function (opt) {
      // 单字选项（「日」「目」「白」这类形近字）单独放大 —— 一眼看不清的字
      // 会让孩子靠猜，而不是靠辨认。
      //
      // 必须限定「是一个汉字或一个字母」，不能只看长度：数学题的选项也是
      // 短的，「7」和「70」混在一道题里，只把「7」放大到 50px 会让这一排
      // 高低不平，看起来像是排版坏了。
      var single = SINGLE_RE.test(opt.text || '');

      var btn = G.el('button', {
        class: 'option' + (single ? ' option-single' : ''),
        'data-id': opt.id,
        // 关掉全局的「嗒」声：选项有自己的对/错音效（见 05-ui.js 的
        // feedback），两个叠在一起会糊成一团。
        'data-sfx-off': '1',
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

      if (!correct) {
        showExplain(q.explain);
      } else {
        G.UI.confetti(container);
      }

      // 答错的题留久一点，让孩子看清正确答案和解释
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

/* ===== 50-wheel.js ===== */
/* 50-wheel.js — 转盘抽奖
 *
 * 结果先定后动画：先按权重抽出奖品，再反推指针该停在哪。
 * 反过来让动画时长或角度决定结果，会在慢设备上产生偏差。
 *
 * 一次答对 = 一次转动，转完就结算。曾经有过「再来一次」的重转机制，
 * 已经去掉：重转把一次抽奖拖成几轮，孩子盯着盘转的时间比答题还长。
 * 空奖就是空奖（G.NO_PRIZE_TEXT），不兜底、不重来。
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

  // 扇区配色。**白字压在浅色上等于没字** —— 原来 p5 是 #FFD54F（亮黄）
  // 配白字，那个扇区基本是空的。这里每个色都压到能承住白色小字的深度，
  // 六个色相仍然分得开。
  function colorFor(id) {
    return {
      tv10: '#E4572E',
      p1: '#2E9E5B',
      p2: '#2A7FD4',
      p5: '#C9860A',
      p10: '#8E44AD',
      none: '#78909C'
    }[id] || '#78909C';
  }

  /* 标签中心到盘心的半径（px）。
   * 盘面 280px、白边 9px、box-sizing:border-box → 盘内半径 131px。
   * 标签宽 72px，所以它占 76±36 = 40px ~ 112px 这一段：
   *   外沿 112 < 131，不会压到白边；内沿 40 > 中心轴半径 23，不会被轴盖住。 */
  var LABEL_R = 76;

  /**
   * 盘面上的一个奖名。
   *
   * 为什么文字要转 90° 顺着半径排，而不是横着贴：
   *   六个奖项的权重是 5/30/20/15/10/20，摊到 360° 就是 18°/108°/72°/54°/36°/72°。
   *   最宽的和最窄的差了 6 倍。横排的话，18° 那个扇区在半径 100px 处只有
   *   31px 弧长，一行放不下两个字，必然和隔壁扇区叠在一起（这正是原来
   *   「转盘上看不清奖励」的原因之一）。
   *   转成径向之后，受角度限制的只剩行高（13px），而文字长度沿半径展开，
   *   有 72px 可用 —— 每个扇区都放得下。
   *
   * 上半圈从下往上读、下半圈翻过来从上往下读，都是正的，不会倒着。
   */
  function faceLabel(s) {
    var label = G.el('span', { class: 'wheel-label', text: s.prize.face || s.prize.label });

    // 变换链从左到右依次作用：
    //   translate(-50%,-50%) 先把标签自身中心对到盘心
    //   rotate(center)       绕盘心转到本扇区的角度
    //   translateY(-R)       沿这个方向推到半径 R
    //   rotate(±90deg)       把文字转成顺着半径读
    // 前两步一起等价于「把标签放到扇区中心」，后两步是让它在那个位置上可读。
    var text = (s.center > 180) ? 90 : -90;
    label.style.transform =
      'translate(-50%, -50%) rotate(' + s.center + 'deg)' +
      ' translateY(-' + LABEL_R + 'px) rotate(' + text + 'deg)';

    return label;
  }

  /**
   * 打开转盘。返回 Promise<{prize, awarded}> —— resolve 时奖励已入账。
   *
   * @param {object} save
   */
  function open(save) {
    return new Promise(function (resolve) {
      var segments = segmentAngles();

      var overlay = G.el('div', { class: 'overlay wheel-overlay' });
      var box = G.el('div', { class: 'wheel-box' });

      box.appendChild(G.el('div', { class: 'wheel-title', text: '答对啦！转转盘 🎉' }));

      var stage = G.el('div', { class: 'wheel-stage' });
      var wheel = G.el('div', { class: 'wheel' });
      wheel.style.background = wheelBackground(segments);

      // 奖名贴在盘面上
      segments.forEach(function (s) {
        wheel.appendChild(faceLabel(s));
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

        setTimeout(function () { finish(prize); }, 3600);
      });

      function finish(prize) {
        // 空奖有专门的音效。原来不管中没中都放 ui.win ——
        // 「下次好运」配一段中奖号角，孩子会先高兴一下再发现什么都没有，
        // 比直接给个温和的下行音更让人失望。
        G.Audio.play(prize.kind === 'none' ? 'ui.lose' : 'ui.win');

        var r = G.Runner.awardPoints(save, prize.points);
        var extra = '';

        if (prize.kind === 'none') {
          resultBar.textContent = G.NO_PRIZE_TEXT;
          resultBar.className = 'wheel-result wheel-result-none';
        } else if (prize.kind === 'tv') {
          G.Runner.awardTvMinutes(save, 10);
          resultBar.textContent = prize.label + '（记得让爸爸妈妈知道哦）';
          resultBar.className = 'wheel-result wheel-result-win';
        } else {
          if (r.capped) extra = '（今天的积分已经攒满啦，明天继续！）';
          resultBar.textContent = '+' + r.awarded + ' 分 ' + extra;
          resultBar.className = 'wheel-result wheel-result-win';
        }

        G.Store.save(save);

        setTimeout(function () {
          var ok = G.el('button', { class: 'btn btn-primary', text: '继续', onclick: close });
          box.appendChild(ok);
        }, 500);

        function close() {
          overlay.classList.add('closing');
          setTimeout(function () {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            resolve({ prize: prize, awarded: r.awarded });
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

    /* --- 语文认字范围 --- */
    box.appendChild(section('语文认字范围', buildZibiaoPanel(save)));

    /* --- 学习数据 --- */
    box.appendChild(section('学习数据', buildStats(save)));

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

  /**
   * 识字范围面板。
   *
   * 只读，没有任何开关 —— 原来这里是「英语学到第几单元」的解锁选择，现在
   * 题库固定在小学一、二年级范围内，没有可调的东西。留下的是家长真正想看
   * 的那个问题：**哪几个字还没会**。
   */
  function buildZibiaoPanel(save) {
    var wrap = G.el('div', { class: 'stat-card' });
    var zb = G.Bank.zibiao();
    if (!zb) {
      wrap.appendChild(G.el('div', { class: 'muted', text: '字表未加载' }));
      return wrap;
    }

    wrap.appendChild(G.el('div', {
      class: 'muted',
      text: '题库共 ' + G.Bank.all().length + ' 道题（语文 ' + G.Bank.of('chinese').length +
            ' · 数学 ' + G.Bank.of('math').length + ' · 英语 ' + G.Bank.of('english').length + '）。' +
            '语文的每一个字都出自下面这张一年级字表（' + zb.chars.length + ' 字），' +
            '题干和四个选项都不会超纲。'
    }));

    // 还没掌握的字。只从「答案是一个汉字」的题里统计 —— 数笔画题的答案是
    // 数字、看字选拼音的答案是拼音，那些题对不上字，不参与。
    var shaky = {};
    save.wrongBook.forEach(function (w) {
      if (w.cleared) return;
      var q = findQuestion(w.qid);
      var ch = q && answerChar(q);
      if (!ch) return;
      shaky[ch] = (shaky[ch] || 0) + w.wrongCount;
    });

    var chars = Object.keys(shaky).sort(function (a, b) { return shaky[b] - shaky[a]; });
    if (chars.length) {
      wrap.appendChild(G.el('div', { class: 'stat-title', text: '还没巩固的字（错得最多的在前）' }));
      wrap.appendChild(G.el('div', { class: 'zi-grid' }, chars.slice(0, 24).map(function (ch) {
        return G.el('span', { class: 'zi-chip zi-chip-weak', text: ch });
      })));
      if (chars.length > 24) {
        wrap.appendChild(G.el('div', { class: 'muted', text: '还有 ' + (chars.length - 24) + ' 个，先练这些。' }));
      }
    } else if (save.wrongBook.length) {
      wrap.appendChild(G.el('div', { class: 'muted', text: '错题本里没有尚未巩固的字，继续保持。' }));
    }

    var learned = zb.chars.filter(function (c) { return !shaky[c.char]; });
    wrap.appendChild(G.el('div', {
      class: 'stat-title',
      text: '字表（' + zb.chars.length + ' 字，' + learned.length + ' 个当前没在错题本里）'
    }));
    wrap.appendChild(G.el('div', { class: 'zi-grid' }, zb.chars.map(function (c) {
      return G.el('span', {
        class: 'zi-chip' + (shaky[c.char] ? ' zi-chip-weak' : ''),
        title: c.pinyin,
        text: c.char
      });
    })));

    return wrap;
  }

  /** 取一道题的答案对应的字；答案不是单个汉字就返回 null。 */
  function answerChar(q) {
    var opts = q.options || [];
    for (var i = 0; i < opts.length; i++) {
      if (opts[i].id !== q.answer) continue;
      var t = (opts[i].text || '').trim();
      return /^[一-龥]$/.test(t) ? t : null;
    }
    return null;
  }

  function buildStats(save) {
    var wrap = G.el('div', { class: 'stat-card' });

    // 按题型统计，三科分开列（语文：归类 / 笔画…；数学：拆数 / 比大小…；
    // 英语：听音选字母 / 大小写配对…）。合在一起列的话，家长看不出到底是
    // 哪一科弱 —— 而这正是他翻到这个页面想知道的。
    G.SUBJECTS.forEach(function (s) {
      var bucket = (save.progress[s] && save.progress[s].byTag) || {};
      var tags = Object.keys(bucket);
      if (!tags.length) return;
      wrap.appendChild(G.el('div', {
        class: 'stat-title',
        text: (G.SUBJECT_LABEL[s] || s) + ' · 按题型'
      }));
      // 正确率低的排前面：家长要的是「先补哪个」
      tags.sort(function (a, b) {
        return (bucket[a].correct / bucket[a].seen) - (bucket[b].correct / bucket[b].seen);
      }).forEach(function (t) {
        wrap.appendChild(bar(t, bucket[t].correct, bucket[t].seen));
      });
    });

    // 错题本
    var wrong = save.wrongBook.filter(function (w) { return !w.cleared; })
      .sort(function (a, b) { return b.wrongCount - a.wrongCount; });
    if (wrong.length) {
      wrap.appendChild(G.el('div', { class: 'stat-title', text: '待巩固的题（' + wrong.length + '）' }));
      wrong.slice(0, 15).forEach(function (w) {
        var q = findQuestion(w.qid);
        var stemText = (q && q.stem && q.stem.text) || '';
        wrap.appendChild(G.el('div', { class: 'wrong-row' }, [
          G.el('span', { text: stemText || w.qid }),
          G.el('span', { class: 'wrong-count', text: '错 ' + w.wrongCount + ' 次' })
        ]));
      });
    }

    // 最近局
    if (save.sessions.length) {
      wrap.appendChild(G.el('div', { class: 'stat-title', text: '最近 ' + Math.min(10, save.sessions.length) + ' 局' }));
      save.sessions.slice(-10).reverse().forEach(function (s) {
        wrap.appendChild(bar(
          G.localDateStr(new Date(s.ts)).slice(5) + ' · ' + s.correct + '/' + s.total,
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
      // 用 G.Bank.all() 而不是 window.G.DATA.chinese —— 三科都要能查到。
      // 只查语文的话，错题本里每道数学题都会显示成一串 qid。
      G.Bank.all().forEach(function (q) { _qIndex[q.id] = q; });
    }
    return _qIndex[qid];
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
  var round = null;          // {questions, startedAt}
  var idx = 0;
  var results = [];          // [true|false|null]
  var items = [];            // 逐题记录
  var spins = [];
  var roundPoints = 0;
  var qStartAt = 0;

  /* ---------- 启动 ---------- */

  function boot(data) {
    root = G.$('#app');

    // 配比必须在 Store.load() **之前**落定：save.settings 里不再存配比，
    // 但一局的题数是从 G.ROUND_SIZE 读的，而它由配比推出来。
    // 顺序反了的话，首次进入游戏的那一局会用兜底配比。
    G.applyMix(data && data.mix);

    save = G.Store.load();

    G.Bank.init(data);
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

    s.appendChild(G.el('div', { class: 'home-title', text: '幼小衔接闯关' }));
    s.appendChild(G.el('div', {
      class: 'home-sub',
      // 副标题把一局的构成说清楚。家长和孩子都该在开始前知道
      // 「这一局要做什么」，而不是玩到第 4 题才发现有数学。
      text: '一局 ' + G.ROUND_SIZE + ' 题：' + G.SUBJECTS.map(function (sub) {
        return (G.SUBJECT_LABEL[sub] || sub) + ' ' + (G.DEFAULT_MIX[sub] || 0);
      }).join(' · ') + '，答对就转盘'
    }));

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

    G.log('本局题目：', round.questions.map(function (q) {
      return q.id + '[' + ((q.tags && q.tags[0]) || q.type) + ']';
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
    items.push({ qid: q.id, subject: q.subject, type: q.type, tags: q.tags || [], correct: correct, ms: ms });

    G.Runner.recordAnswer(save, q, correct, ms);
    G.Store.save(save);

    var advance = function () {
      idx++;
      showQuestion();
    };

    if (!correct) { advance(); return; }

    // 答对 → 转盘。转完就翻页，空奖也一样 —— 没有重转。
    G.Wheel.open(save).then(function (res) {
      spins.push({ prize: res.prize.id, ts: Date.now() });
      roundPoints += res.awarded || 0;

      var dc = G.Store.todayCounter(save);
      dc.spins += 1;

      G.Store.save(save);
      updatePointsChip();
      setTimeout(advance, 260);
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
    // 一局结束用 ui.star（轻快上行），不用 ui.win（中奖号角）——
    // ui.win 留给转盘真的中奖那一刻。同样是「结束了」，一个是每局都有，
    // 一个是偶尔才有；共用一个音，中奖就不再特别了。
    G.Audio.play('ui.star');
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

          // 合成音效走的是另一条路径（G.Sfx，不经解码），
          // 而它现在是孩子点每个按钮都能听到的声音 —— 单独测一条。
          var sfxOk = G.Sfx ? G.Sfx.play('ui.correct') : false;
          record('合成音效（按钮/对错反馈）', sfxOk ? 'pass' : 'fail',
            sfxOk ? '已播放 ui.correct（三连上行音）'
                  : '合成失败 —— 检查 AudioContext 是否已解锁');

          log.textContent = (played ? '✅ 播放成功：' + ids[0] : '❌ 播放失败') +
            '　' + (sfxOk ? '✅ 音效正常' : '❌ 音效异常');
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
