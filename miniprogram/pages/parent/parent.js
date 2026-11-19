/* parent — 家长模式
 *
 * 门禁 7×8：超出幼小衔接范围，孩子答不出来。失败 3 次冷却 30 秒，
 * 冷却时间写进存储，杀掉小程序重进也绕不过去（策略照搬网页版
 * src/js/70-parent.js:18-45）。
 *
 * 和网页版的功能差异（都是小程序这一版的有意取舍）：
 *   · 没有「待确认兑换」和「转盘次数」—— 抽奖和现金兑换整个去掉了
 *   · 备份从「下载文件 + 剪贴板」改成只走剪贴板（小程序没有 a[download]）
 *   · 录音覆盖没有移植，导入网页备份时会提示录音不会带过来
 */
var G = require('../../generated/lib/game.js');
var sfx = require('../../lib/sfx.js');

var COOLDOWN_KEY = 'yxjx.parent.cooldown';
var FAIL_KEY = 'yxjx.parent.fails';
var MAX_FAILS = 3;
var COOLDOWN_MS = 30 * 1000;

function getNum(key) {
  try { return +(wx.getStorageSync(key) || 0); } catch (e) { return 0; }
}

function setNum(key, v) {
  try { wx.setStorageSync(key, String(v)); } catch (e) {}
}

function del(key) {
  try { wx.removeStorageSync(key); } catch (e) {}
}

/* ---------- 门禁策略 ---------- */

function gateState() {
  var until = getNum(COOLDOWN_KEY);
  var fails = getNum(FAIL_KEY);
  return { until: until, fails: fails, blocked: Date.now() < until };
}

function recordFail() {
  var s = gateState();
  var fails = s.fails + 1;
  setNum(FAIL_KEY, fails);
  if (fails >= MAX_FAILS) {
    setNum(COOLDOWN_KEY, Date.now() + COOLDOWN_MS);
    setNum(FAIL_KEY, 0);
    return true;
  }
  return false;
}

function clearFails() {
  del(FAIL_KEY);
  del(COOLDOWN_KEY);
}

/* ---------- 题库反查 ---------- */

var _qIndex = null;

function findQuestion(qid) {
  if (!_qIndex) {
    _qIndex = {};
    G.Bank.all().forEach(function (q) { _qIndex[q.id] = q; });
  }
  return _qIndex[qid];
}

/** 答案对应的汉字；答案不是单个汉字就返回 null。 */
function answerChar(q) {
  var opts = q.options || [];
  for (var i = 0; i < opts.length; i++) {
    if (opts[i].id !== q.answer) continue;
    var t = (opts[i].text || '').trim();
    return /^[一-龥]$/.test(t) ? t : null;
  }
  return null;
}

Page({
  data: {
    unlocked: false,
    gateQuestion: '',
    gateInput: '',
    gateErr: '',
    gateFocus: false,

    clockTampered: false,
    audit: {},
    today: {},
    zibiao: { summary: '', weak: [], chars: [] },
    bySubject: [],
    wrong: [],
    wrongTotal: 0,
    sessions: [],
    backupHint: '',
    backupWarn: false,
    importText: '',
    readStem: true
  },

  onLoad: function () {
    this.setData({ gateQuestion: G.PARENT_GATE.question });

    var s = gateState();
    if (s.blocked) {
      this.setData({ gateErr: this.blockedText(s) });
      return;
    }
    this.setData({ gateFocus: true });
  },

  blockedText: function (s) {
    return '请等 ' + Math.ceil((s.until - Date.now()) / 1000) + ' 秒后再试';
  },

  /* ---------- 门禁 ---------- */

  onGateInput: function (e) {
    this.setData({ gateInput: e.detail.value });
  },

  onGateSubmit: function () {
    sfx.play('ui.tap');

    var s = gateState();
    if (s.blocked) {
      this.setData({ gateErr: this.blockedText(s) });
      return;
    }

    if (+this.data.gateInput === G.PARENT_GATE.answer) {
      clearFails();
      this.setData({ unlocked: true, gateInput: '', gateErr: '', gateFocus: false });
      this.buildPanel();
      return;
    }

    var blocked = recordFail();
    this.setData({
      gateErr: blocked ? '错误次数过多，请 30 秒后再试' : '答案不对',
      gateInput: ''
    });
  },

  onGateCancel: function () {
    sfx.play('ui.tap');
    wx.navigateBack({ delta: 1 });
  },

  /* ---------- 题干朗读开关 ---------- */

  onToggleReadStem: function (e) {
    var v = !!(e && e.detail && e.detail.value);
    var save = getApp().globalData.save;
    save.settings = save.settings || {};
    save.settings.readStem = v;
    G.Store.save(save);
    this.setData({ readStem: v });
    sfx.play('ui.tap');
  },

  /* ---------- 面板 ---------- */

  buildPanel: function () {
    var save = getApp().globalData.save;

    this.setData({
      clockTampered: !!save.integrity.clockTampered,
      audit: this.buildAudit(save),
      today: this.buildToday(save),
      zibiao: this.buildZibiao(save),
      bySubject: this.buildBySubject(save),
      wrong: this.buildWrong(save),
      wrongTotal: save.wrongBook.filter(function (w) { return !w.cleared; }).length,
      sessions: this.buildSessions(save),
      readStem: !(save.settings && save.settings.readStem === false)
    });
    this.buildBackupHint();
  },

  buildAudit: function (save) {
    var a = G.Store.audit(save);
    return {
      balance: a.balance,
      lifetime: a.lifetime,
      spent: a.spent,
      expected: a.expected,
      ok: a.ok
    };
  },

  buildToday: function (save) {
    var dc = G.Store.todayCounter(save);
    return {
      points: dc.pointsEarned,
      cap: save.limits.maxPointsPerDay,
      sessions: save.sessions.filter(function (s) {
        // 中途退出的局不算「玩了一局」，否则今日局数会虚高。
        return !s.aborted && G.localDateStr(new Date(s.ts)) === G.localDateStr();
      }).length
    };
  },

  /** 家长面板里直接开一局错题复习。 */
  onReview: function () {
    sfx.play('ui.tap');
    wx.navigateTo({ url: '/pages/play/play?mode=review' });
  },

  buildZibiao: function (save) {
    var zb = G.Bank.zibiao();
    if (!zb) return { summary: '字表未加载', weak: [], learned: 0, chars: [] };

    // 还没掌握的字：只统计「答案是一个汉字」的题 —— 笔画题的答案是数字，
    // 对不上字，不能混进来。
    var shaky = {};
    save.wrongBook.forEach(function (w) {
      if (w.cleared) return;
      var q = findQuestion(w.qid);
      var ch = q && answerChar(q);
      if (!ch) return;
      shaky[ch] = (shaky[ch] || 0) + w.wrongCount;
    });

    var weakChars = Object.keys(shaky)
      .sort(function (a, b) { return shaky[b] - shaky[a]; })
      .slice(0, 24)
      .map(function (ch) { return { char: ch, n: shaky[ch] }; });

    var learned = zb.chars.filter(function (c) { return !shaky[c.char]; }).length;

    return {
      summary: '题库共 ' + G.Bank.all().length + ' 道题（语文 ' +
               G.Bank.of('chinese').length + ' · 数学 ' +
               G.Bank.of('math').length + ' · 英语 ' +
               G.Bank.of('english').length + '）。语文的每个字都出自这张一年级字表（' +
               zb.chars.length + ' 字），题干和选项都不会超纲。',
      weak: weakChars,
      learned: learned,
      chars: zb.chars.map(function (c) {
        return { char: c.char, pinyin: c.pinyin, weak: !!shaky[c.char] };
      })
    };
  },

  buildBySubject: function (save) {
    var out = [];
    G.SUBJECTS.forEach(function (s) {
      var bucket = (save.progress[s] && save.progress[s].byTag) || {};
      var tags = Object.keys(bucket);
      if (!tags.length) return;

      // 正确率低的排前面：家长要的是「先补哪个」
      tags.sort(function (a, b) {
        return (bucket[a].correct / bucket[a].seen) - (bucket[b].correct / bucket[b].seen);
      });

      out.push({
        label: (G.SUBJECT_LABEL[s] || s) + ' · 按题型',
        rows: tags.map(function (t) {
          return rowOf(t, bucket[t].correct, bucket[t].seen);
        })
      });
    });
    return out;
  },

  buildWrong: function (save) {
    return save.wrongBook
      .filter(function (w) { return !w.cleared; })
      .sort(function (a, b) { return b.wrongCount - a.wrongCount; })
      .slice(0, 15)
      .map(function (w) {
        var q = findQuestion(w.qid);
        var stem = (q && q.stem && q.stem.text) || w.qid;
        return { id: w.qid, stem: stem, count: w.wrongCount };
      });
  },

  buildSessions: function (save) {
    return save.sessions.slice(-10).reverse().map(function (s) {
      return {
        id: s.id,
        label: G.localDateStr(new Date(s.ts)).slice(5) + ' · ' +
               s.correct + '/' + s.total + (s.aborted ? ' · 中途退出' : ''),
        pct: s.total ? Math.round(s.correct / s.total * 100) : 0
      };
    });
  },

  /* ---------- 备份 ---------- */

  buildBackupHint: function () {
    var m = G.Store.meta();
    var days = m.lastBackupAt ? G.daysBetween(m.lastBackupAt, Date.now()) : null;
    var hint = days === null
      ? '还没有备份过。换手机或清缓存前先备份一次。'
      : ('上次备份：' + (days === 0 ? '今天' : days + ' 天前'));
    this.setData({
      backupHint: hint,
      backupWarn: days === null || days >= 7
    });
  },

  onExport: function () {
    sfx.play('ui.tap');
    var self = this;
    G.Store.exportAll().then(function (payload) {
      var text = JSON.stringify(payload);
      var kb = Math.round(text.length / 1024);
      wx.setClipboardData({
        data: text,
        success: function () {
          G.Store.setMeta({ lastBackupAt: Date.now() });
          self.buildBackupHint();
          wx.showModal({
            title: '备份已复制',
            content: '约 ' + kb + ' KB。粘贴到微信「文件传输助手」保存，换手机时用得上。',
            showCancel: false
          });
        },
        fail: function () {
          wx.showToast({ title: '复制失败', icon: 'none' });
        }
      });
    });
  },

  onImportInput: function (e) {
    this.setData({ importText: e.detail.value });
  },

  onImport: function () {
    sfx.play('ui.tap');
    var text = (this.data.importText || '').trim();
    if (!text) {
      wx.showToast({ title: '请先粘贴备份内容', icon: 'none' });
      return;
    }

    var payload;
    try {
      payload = JSON.parse(text);
    } catch (e) {
      wx.showToast({ title: '内容不是有效的备份', icon: 'none' });
      return;
    }

    var self = this;
    G.Store.importAll(payload).then(function (r) {
      getApp().globalData.save = r.save;
      self.setData({ importText: '' });
      self.buildPanel();
      wx.showModal({
        title: '恢复完成',
        content: '当前 ' + r.save.points.balance + ' 颗星星。' +
                 (payload && payload.overrides && payload.overrides.length
                   ? '\n网页版里的家长录音不会带过来。' : ''),
        showCancel: false
      });
    }).catch(function (e) {
      wx.showToast({ title: '恢复失败：' + e.message, icon: 'none' });
    });
  },

  /* ---------- 维护 ---------- */

  onUnfreeze: function () {
    sfx.play('ui.tap');
    var save = getApp().globalData.save;
    save.integrity.clockTampered = false;
    save.integrity.maxSeenTs = Date.now();
    G.Store.save(save);
    this.buildPanel();
  },

  onReset: function () {
    sfx.play('ui.tap');
    var self = this;
    wx.showModal({
      title: '清空所有数据？',
      content: '进度、星星、错题本都会删掉，无法恢复。建议先做一次备份。',
      confirmText: '清空',
      confirmColor: '#EF5350',
      success: function (res) {
        if (!res.confirm) return;
        var save = G.Store.reset();
        getApp().globalData.save = save;
        self.buildPanel();
        wx.showToast({ title: '已清空', icon: 'none' });
      }
    });
  },

  onClose: function () {
    sfx.play('ui.tap');
    wx.navigateBack({ delta: 1 });
  }
});

/** 一条「名称 / 进度条 / 百分比」的数据。 */
function rowOf(label, correct, total) {
  return {
    label: label,
    pct: total ? Math.round(correct / total * 100) : 0
  };
}
