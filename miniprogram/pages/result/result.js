/* result — 一局结算
 *
 * 只负责显示。星星在 play 页就已经入账了 —— 结算逻辑放进 onLoad 的话，
 * 页面一旦被重新进入就会重复发星。
 */
var G = require('../../generated/lib/game.js');
var stars = require('../../lib/stars.js');
var sfx = require('../../lib/sfx.js');
var confetti = require('../../lib/confetti.js');
var progress = require('../../lib/progress.js');

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
    pieces: [],
    // 结算页的错题复习入口：只报「点进去这一局几题」，口径和首页一致。
    reviewRoundSize: 0,
    bigText: false
  },

  onLoad: function () {
    var r = getApp().globalData.lastResult;
    if (!r) {
      wx.reLaunch({ url: '/pages/home/home' });
      return;
    }

    this.subject = r.subject;
    this.review = !!r.review;

    // 打完一局最自然的下一步是把刚错的题再过一遍。数据口径与首页完全
    // 一致：数错题本里还没 cleared 的题，再按一局上限截断。三点约束：
    //   · 全对局不摆 —— 没有刚错的题可练；
    //   · 复习局不摆 —— 它的「再来一局」本来就是复习，别放两个一样的入口；
    //   · 不足 3 题不摆（在 WXML 里判断）—— 和首页一样，一两道题的局
    //     孩子刚进入状态就结束了。
    // 复习局按错题权重从**整个错题本**挑题，可能带上更早的错题，所以
    // 按钮只报即将开的一局有几题，不承诺「全是刚错的那几道」。
    var wrongCount = 0;
    if (r.correct < r.total && !this.review) {
      var save = getApp().globalData.save;
      wrongCount = ((save && save.wrongBook) || []).filter(function (w) {
        return !w.cleared;
      }).length;
    }
    var reviewRoundSize = Math.min(wrongCount, G.ROUND_SIZE);

    // 1.2.18：lastResult 若来自异常路径 / 旧存档的 0 题局，除零会出 NaN，
    // 带进 setData 后文案、彩纸、emoji 全落到错误分支。0 题按 0% 处理。
    var pct = r.total > 0 ? Math.round(r.correct / r.total * 100) : 0;
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
      pieces: pct >= 70 ? confetti.pieces() : [],
      reviewRoundSize: reviewRoundSize,
      bigText: progress.bigTextOf(getApp().globalData.save)
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

  /** 直接把错题再过一遍。result 是 redirectTo 进来的，这里也用 redirectTo，
   *  不让「结算页 → 复习局 → 结算页」在页面栈里越堆越深。 */
  onReview: function () {
    sfx.play('ui.tap');
    wx.redirectTo({ url: '/pages/play/play?mode=review' });
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
