/* result — 一局结算
 *
 * 只负责显示。星星在 play 页就已经入账了 —— 结算逻辑放进 onLoad 的话，
 * 页面一旦被重新进入就会重复发星。
 */
var G = require('../../generated/lib/game.js');
var stars = require('../../lib/stars.js');
var sfx = require('../../lib/sfx.js');
var confetti = require('../../lib/confetti.js');

Page({
  data: {
    subjectLabel: '',
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

    this.subject = r.subject;
    this.review = !!r.review;
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
      subjectLabel: r.review ? '错题复习' : (G.SUBJECT_LABEL[r.subject] || ''),
      emoji: pct >= 70 ? '🌟' : '💪',
      title: praise,
      score: r.correct + ' / ' + r.total,
      stars: 0,               // 下面 countUp 滚到 r.stars
      capped: r.capped,
      totalStars: r.lifetime,
      badges: all,
      newBadge: fresh,
      confetti: pct >= 70,
      pieces: pct >= 70 ? confetti.pieces() : []
    });

    sfx.play('ui.star');
    this.countUp(r.stars);
  },

  /**
   * 本局星星从 0 滚到实际值 —— 一局结束唯一一次「成果揭晓」。
   * 用递归 setTimeout 而不是 setInterval：每次都留着句柄，页面一卸载就能
   * 清干净；无头测试里加载这一页时，链条也会在 ~0.4s 后自己结束，
   * 不会把 Node 事件循环挂住。
   */
  countUp: function (target) {
    var self = this;
    var steps = 12;
    var i = 0;
    if (this._countTimer) clearTimeout(this._countTimer);
    var tick = function () {
      i++;
      self.setData({ stars: Math.round(target * i / steps) });
      if (i < steps) self._countTimer = setTimeout(tick, 32);
      else self._countTimer = null;
    };
    this._countTimer = setTimeout(tick, 32);
  },

  onUnload: function () {
    if (this._countTimer) {
      clearTimeout(this._countTimer);
      this._countTimer = null;
    }
  },

  onAgain: function () {
    sfx.play('ui.tap');
    // 复习局没有科目参数，「再来一局」要回到复习，不能掉回语文闯关。
    var url = this.review
      ? '/pages/play/play?mode=review'
      : '/pages/play/play?subject=' + (this.subject || 'chinese');
    wx.redirectTo({ url: url });
  },

  onHome: function () {
    sfx.play('ui.tap');
    wx.reLaunch({ url: '/pages/home/home' });
  }
});
