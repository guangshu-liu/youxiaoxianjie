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

/** 某科累计完成的局数。中途退出不算；复习局没有 subject，不计入任何一科。 */
function roundsOf(save, subject) {
  return (save.sessions || []).filter(function (s) {
    return !s.aborted && s.subject === subject;
  }).length;
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
    var lap = Math.floor(n / LAP);
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
      title: '第 ' + nextStep + ' 关' + (justFinished ? ' · 通关' : ''),
      fullTitle: (lap > 0 ? '第 ' + (lap + 1) + ' 轮 · ' : '') +
                 '第 ' + nextStep + ' 关' + (justFinished ? ' · 通关' : '')
    };
  });
}

/** 首页 WXML 用对象取，别依赖 SUBJECTS 的数组下标。 */
function levelMapBySubject(save) {
  var out = {};
  levelMap(save).forEach(function (row) { out[row.subject] = row; });
  return out;
}

/** 最近若干局正确率折线。排除中途退出和 0 题的脏数据，按时间从旧到新。 */
function trend(save, limit) {
  var max = limit || TREND_LIMIT;
  var rows = (save.sessions || [])
    .filter(function (s) { return !s.aborted && s.total > 0; })
    .slice(-max);

  var points = rows.map(function (s, i) {
    var pct = Math.round(s.correct / s.total * 100);
    return {
      i: i,
      x: rows.length === 1 ? CHART_X0 + CHART_W / 2 : CHART_X0 + i * CHART_W / (rows.length - 1),
      y: CHART_Y0 + pct * CHART_H / 100,
      pct: pct,
      label: s.correct + '/' + s.total
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
  levelMap: levelMap,
  levelMapBySubject: levelMapBySubject,
  trend: trend,
  bigTextOf: bigTextOf
};
