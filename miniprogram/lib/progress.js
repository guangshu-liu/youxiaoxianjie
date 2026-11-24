/* progress.js — 1.2.16 第二批：把 sessions 变成「看得到的前进」
 *
 * 全是纯读函数：只读 save，不写存档、不碰 wx，页面负责渲染和写设置。
 * 刻意只放小程序端、不进 src/js/ —— 网页版产物哈希保持零改动。
 *
 *   1. levelMap    三科各自的 6 关小地图，按累计完成局数点亮
 *   2. trend       最近 10 局正确率折线的坐标（rpx 单位，纯数据不画图）
 *   3. bigTextOf   家长开关「大字模式」的统一口径
 *
 * 三者都不碰 points / redemptions / sessions：星星账目仍只有整局结算
 * 一个入口，家长页三方审计和每日 60 星上限不受影响。
 *
 * 为什么折线坐标用 rpx：小程序不能用 SVG，canvas 又要异步量尺寸、无头
 * 测试也测不到。rpx 会随屏幕等比缩放，于是「x/y 的像素比例」恒定，
 * 用 atan2 算出来的旋转角度在任何机型上都对得上端点，WXML 只负责摆
 * 绝对定位的小圆点和线段。
 */
var G = require('../generated/lib/game.js');

var LAP = 6;               // 每 6 局一轮，走满后开新一轮，永远有下一关
var TREND_LIMIT = 10;
var CHART_W = 540;         // rpx：绘图区宽（容器 600，左右各留 30）
var CHART_X0 = 30;
var CHART_Y0 = 18;         // rpx：0% 的 bottom
var CHART_H = 114;         // rpx：100% 相对 0% 的高度

/**
 * 一局属于哪一科。
 *
 * 1.2.17：finishSession 写 session 时只存了 items，从来没存 subject
 * （src/js/40-runner.js 是网页版共用逻辑，按「网页版不动」的约定不改它）。
 * 于是老版本直接读 s.subject 会让三科地图永远停在「第 1 关」。
 * 现在退而求其次从 items[].subject 推断：小程序是单科局，每题的科目一致；
 * 混合科目（复习局 / 网页版 3:3:4 混合局）一律不归任何一科。
 * 这样老存档里已经打过的局也能立刻点亮，不用等新局、不用迁移存档。
 */
function subjectOf(s) {
  if (!s || s.aborted || s.review) return '';
  if (s.subject) return s.subject;
  var items = s.items || [];
  if (!items.length) return '';
  var first = items[0] && items[0].subject;
  if (!first) return '';
  for (var i = 1; i < items.length; i++) {
    if (items[i].subject !== first) return '';
  }
  return first;
}

/** 某科累计完成的局数。中途退出、复习局、混合科目局都不算。 */
function roundsOf(save, subject) {
  var sessions = (save && save.sessions) || [];
  if (!Array.isArray(sessions)) return 0;
  var n = 0;
  for (var i = 0; i < sessions.length; i++) {
    if (subjectOf(sessions[i]) === subject) n++;
  }
  return n;
}

/**
 * 三科关卡地图。
 *
 * 「通关一轮后会不会突然清零」是这里最容易被吐槽的点，所以：刚走满 6 关
 * 时仍显示 6 格全亮（justFinished），下一局才回到第 1 格，同时轮次 +1，
 * 文案写「第 N 轮 · 第 1 关」，孩子看到的是开新地图而不是倒退。
 */
function levelMap(save) {
  return G.SUBJECTS.map(function (s) {
    var n = roundsOf(save, s);
    // 1.2.17：刚走满 6 关时仍算「第 1 轮通关」，轮次等下一局才 +1。
    // 旧算法用 floor(n/6)，n=6 就写「第 2 轮 · 第 1 关 · 通关」，
    // 和「6 格全亮」自相矛盾。n-1 让轮次在真正开新地图时才跳。
    var lap = Math.floor(Math.max(0, n - 1) / LAP);
    var step = n % LAP;
    var justFinished = n > 0 && step === 0;
    var cleared = justFinished ? LAP : step;
    var nextStep = justFinished ? 1 : step + 1;
    var nodes = [];
    for (var i = 1; i <= LAP; i++) {
      nodes.push({
        i: i,
        done: i <= cleared,
        now: !justFinished && i === nextStep
      });
    }
    return {
      subject: s,
      label: G.SUBJECT_LABEL[s] || s,
      rounds: n,
      cleared: cleared,
      total: LAP,
      nodes: nodes,
      justFinished: justFinished,
      lapText: lap > 0 ? '第 ' + (lap + 1) + ' 轮 · ' : '',
      title: justFinished ? '通关' : '第 ' + nextStep + ' 关',
      fullTitle: justFinished
        ? '第 ' + (lap + 1) + ' 轮 · 通关'
        : (lap > 0 ? '第 ' + (lap + 1) + ' 轮 · ' : '') + '第 ' + nextStep + ' 关'
    };
  });
}

/** 首页 WXML 用对象取，别依赖 SUBJECTS 的数组下标。 */
function levelMapBySubject(save) {
  var out = {};
  levelMap(save).forEach(function (row) { out[row.subject] = row; });
  return out;
}

/**
 * 折线只认「能算出正确率」的局。
 *
 * 1.2.20：原来的 filter 只看 `total > 0`，导入备份 / 老存档里的脏数据
 * （correct 是字符串、NaN、比 total 还大、ts 是未来时间）会把 NaNrpx
 * 和越界坐标直接交给 WXML；sessions 顺序也从不检查，导入后线段左右乱穿。
 * 复习局和三科难度评估（30-bank.js 的 levelDetailOf）一样排除：一局全是
 * 专门挑出来的错题，混进折线会把「最近正确率」压低，和家长页看到的档位
 * 对不上。
 */
function isTrendRow(s, now) {
  if (!s || s.aborted || s.review) return false;
  if (typeof s.total !== 'number' || !isFinite(s.total) || s.total <= 0) return false;
  if (typeof s.correct !== 'number' || !isFinite(s.correct)) return false;
  var ts = +s.ts;
  return isFinite(ts) && ts <= now;
}

/** 最近若干局正确率折线。按时间从旧到新，脏数据一律夹回 0~100%。 */
function trend(save, limit) {
  var max = TREND_LIMIT;
  if (limit !== undefined && limit !== null) {
    // 延续 1.2.18 的空局语义：显式 0 / 负数 / NaN 是「不要点」，不是省略。
    max = (typeof limit === 'number' && isFinite(limit) && limit >= 0)
      ? Math.floor(limit) : 0;
  }
  var now = Date.now();
  var all = (save && save.sessions) || [];
  var sorted = (Array.isArray(all) ? all : [])
    .filter(function (s) { return isTrendRow(s, now); })
    .sort(function (a, b) { return (+a.ts) - (+b.ts); });
  var rows = max > 0 ? sorted.slice(-max) : [];

  var points = rows.map(function (s, i) {
    var correct = Math.max(0, Math.min(s.total, s.correct));
    var pct = Math.round(correct / s.total * 100);
    return {
      i: i,
      x: rows.length === 1 ? CHART_X0 + CHART_W / 2 : CHART_X0 + i * CHART_W / (rows.length - 1),
      y: CHART_Y0 + pct * CHART_H / 100,
      pct: pct,
      label: correct + '/' + s.total
    };
  });

  var segments = [];
  for (var j = 1; j < points.length; j++) {
    var a = points[j - 1], b = points[j];
    var dx = b.x - a.x, dy = b.y - a.y;
    segments.push({
      i: j,
      x: a.x,
      y: a.y,
      w: Math.sqrt(dx * dx + dy * dy),
      // bottom 增大 = 屏幕向上，所以角度取负
      deg: -Math.atan2(dy, dx) * 180 / Math.PI
    });
  }

  var sum = points.reduce(function (t, p) { return t + p.pct; }, 0);
  // 保留一位小数，WXML 的 style 字符串才不会长得离谱。
  var round = function (v) { return Math.round(v * 10) / 10; };
  return {
    count: points.length,
    avg: points.length ? Math.round(sum / points.length) : 0,
    points: points.map(function (p) {
      return { i: p.i, x: round(p.x), y: round(p.y), pct: p.pct, label: p.label };
    }),
    segments: segments.map(function (s) {
      return { i: s.i, x: round(s.x), y: round(s.y), w: round(s.w), deg: round(s.deg) };
    })
  };
}

/** 大字模式默认关：老存档没这个键，字号和 1.2.15 完全一样。 */
function bigTextOf(save) {
  return !!(save && save.settings && save.settings.bigText === true);
}

module.exports = {
  LAP: LAP,
  TREND_LIMIT: TREND_LIMIT,
  CHART_W: CHART_W,
  CHART_H: CHART_H,
  roundsOf: roundsOf,
  subjectOf: subjectOf,
  levelMap: levelMap,
  levelMapBySubject: levelMapBySubject,
  trend: trend,
  bigTextOf: bigTextOf
};
