/* result — 一局结算
 *
 * 只负责显示。星星在 play 页就已经入账了 —— 结算逻辑放进 onLoad 的话，
 * 页面一旦被重新进入就会重复发星。
 */
var stars = require('../../lib/stars.js');
var sfx = require('../../lib/sfx.js');
var confetti = require('../../lib/confetti.js');

Page({
  data: {
    emoji: '',
    title: '',
    score: '',
    stars: 0,
    capped: false,
    totalStars: 0,
    badges: [],
    newBadge: null,
    confetti: false,
    pieces: []
  },

  onLoad: function () {
    var r = getApp().globalData.lastResult;
    if (!r) {
      wx.reLaunch({ url: '/pages/home/home' });
      return;
    }

    var pct = Math.round(r.correct / r.total * 100);
    var praise = pct >= 90 ? '太棒了！'
               : pct >= 70 ? '做得很好！'
               : pct >= 50 ? '有进步！'
               : '继续加油！';

    // 这一局刚好跨过徽章门槛时，单独提示一下 —— 否则孩子只会看到
    // 数字变了几颗，感觉不到「解锁」。
    var all = stars.badgeState(r.lifetime);
    var fresh = all.filter(function (b) {
      return b.got && b.need > (r.lifetimeBefore || 0);
    })[0] || null;

    this.setData({
      emoji: pct >= 70 ? '🌟' : '💪',
      title: praise,
      score: r.correct + ' / ' + r.total,
      stars: r.stars,
      capped: r.capped,
      totalStars: r.lifetime,
      badges: all,
      newBadge: fresh,
      confetti: pct >= 70,
      pieces: pct >= 70 ? confetti.pieces() : []
    });

    sfx.play('ui.star');
  },

  onAgain: function () {
    sfx.play('ui.tap');
    wx.redirectTo({ url: '/pages/play/play' });
  },

  onHome: function () {
    sfx.play('ui.tap');
    wx.reLaunch({ url: '/pages/home/home' });
  }
});
