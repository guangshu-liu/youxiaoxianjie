/* home — 首页：星星、徽章、开始 */
var G = require('../../generated/lib/game.js');
var stars = require('../../lib/stars.js');
var rewards = require('../../lib/rewards.js');
var sfx = require('../../lib/sfx.js');

Page({
  data: {
    stars: 0,
    subTitle: '',
    badges: [],
    progressPct: 0,
    nextBadge: null,
    lastText: '',
    reviewCount: 0,
    reviewRoundSize: 0,
    // 1.2.15 第一批：错题小怪物、每日小目标、徽章已兑现角标
    monsters: [],
    monsterTotal: 0,
    goalReached: false
  },

  onShow: function () {
    var save = getApp().globalData.save;
    if (!save) return;

    var lifetime = save.points.lifetime || 0;
    var last = save.sessions.length ? save.sessions[save.sessions.length - 1] : null;
    var reviewCount = (save.wrongBook || []).filter(function (w) {
      return !w.cleared;
    }).length;

    // 两个孩子可见的小组件都能被家长单独关掉。关掉只影响显示：
    // reviewCount 始终按错题本真实数算，否则复习按钮会跟着一起消失。
    var settings = save.settings || {};
    var monstersOn = settings.monsters !== false;
    var goalOn = settings.dailyGoal !== false;
    var m = monstersOn ? rewards.monstersOf(save) : { total: 0, shown: [] };
    var g = goalOn ? rewards.goalState(save) : null;

    this.setData({
      stars: save.points.balance || 0,
      // 每日小目标塞进原有的副标题，不新增一行 —— 首页本来就快占满一屏。
      subTitle: '选一科，每局 ' + G.ROUND_SIZE + ' 题' + (g ? ' · ' + g.text : ''),
      badges: rewards.badgeList(save, stars.badgeState(lifetime)),
      progressPct: stars.progressPct(lifetime),
      nextBadge: stars.nextBadge(lifetime),
      lastText: last ? ('上次：' + last.correct + ' / ' + last.total + ' 题') : '',
      // 少于 3 道错题不摆复习入口：一局太短，孩子刚进入状态就结束了。
      // 按钮只报「本局几题」：以前报错题总数（比如 37），点进去却只做
      // 10 道，家长以为漏题。总错题数在家长页「待巩固的题」里看。
      reviewCount: reviewCount,
      reviewRoundSize: Math.min(reviewCount, G.ROUND_SIZE),
      monsters: m.shown,
      monsterTotal: m.total,
      goalReached: !!(g && g.reached)
    });
  },

  /** 三科入口。一局只出一科 —— 孩子清楚自己在练什么，家长也好看成绩。 */
  onStart: function (e) {
    sfx.play('ui.tap');
    var subject = e.currentTarget.dataset.subject;
    wx.navigateTo({ url: '/pages/play/play?subject=' + subject });
  },

  onParent: function () {
    sfx.play('ui.tap');
    wx.navigateTo({ url: '/pages/parent/parent' });
  },

  /** 只练错题本里还没掌握的题，最多 10 道。 */
  onReview: function () {
    sfx.play('ui.tap');
    wx.navigateTo({ url: '/pages/play/play?mode=review' });
  }
});
