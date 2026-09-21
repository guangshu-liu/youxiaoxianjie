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
