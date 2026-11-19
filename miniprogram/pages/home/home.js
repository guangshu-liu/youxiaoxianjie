/* home — 首页：星星、徽章、开始 */
var G = require('../../generated/lib/game.js');
var stars = require('../../lib/stars.js');
var sfx = require('../../lib/sfx.js');

Page({
  data: {
    stars: 0,
    subTitle: '',
    badges: [],
    progressPct: 0,
    nextBadge: null,
    lastText: '',
    reviewCount: 0
  },

  onShow: function () {
    var save = getApp().globalData.save;
    if (!save) return;

    var lifetime = save.points.lifetime || 0;
    var last = save.sessions.length ? save.sessions[save.sessions.length - 1] : null;

    this.setData({
      stars: save.points.balance || 0,
      subTitle: '选一科，每局 ' + G.ROUND_SIZE + ' 题',
      badges: stars.badgeState(lifetime),
      progressPct: stars.progressPct(lifetime),
      nextBadge: stars.nextBadge(lifetime),
      lastText: last ? ('上次：' + last.correct + ' / ' + last.total + ' 题') : '',
      // 少于 3 道错题不摆复习入口：一局太短，孩子刚进入状态就结束了。
      reviewCount: (save.wrongBook || []).filter(function (w) {
        return !w.cleared;
      }).length
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
