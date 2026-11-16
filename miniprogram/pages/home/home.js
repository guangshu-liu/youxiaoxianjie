/* home — 首页：星星、徽章、开始 */
var G = require('../../generated/lib/game.js');
var stars = require('../../lib/stars.js');
var sfx = require('../../lib/sfx.js');

Page({
  data: {
    stars: 0,
    mixText: '',
    badges: [],
    progressPct: 0,
    nextBadge: null,
    lastText: ''
  },

  onShow: function () {
    var save = getApp().globalData.save;
    if (!save) return;

    var lifetime = save.points.lifetime || 0;
    var last = save.sessions.length ? save.sessions[save.sessions.length - 1] : null;

    this.setData({
      stars: save.points.balance || 0,
      // 一局的构成在开始前就说清楚 —— 孩子和家长都该知道
      // 这一局会遇到什么，而不是玩到第 4 题才发现有数学。
      mixText: G.SUBJECTS.map(function (s) {
        return (G.SUBJECT_LABEL[s] || s) + ' ' + (G.DEFAULT_MIX[s] || 0);
      }).join(' · '),
      badges: stars.badgeState(lifetime),
      progressPct: stars.progressPct(lifetime),
      nextBadge: stars.nextBadge(lifetime),
      lastText: last ? ('上次：' + last.correct + ' / ' + last.total + ' 题') : ''
    });
  },

  onStart: function () {
    sfx.play('ui.tap');
    wx.navigateTo({ url: '/pages/play/play' });
  },

  onParent: function () {
    sfx.play('ui.tap');
    wx.navigateTo({ url: '/pages/parent/parent' });
  }
});
