/* play — 一局的答题循环
 *
 * 这里的状态机是从网页版搬过来的（src/js/90-main.js + 41-render-choice.js）：
 *   · 答完立刻锁定，正确项永远标出来（答错也要让孩子看见正确答案）
 *   · 答错的题多停一会儿（1500ms vs 620ms），读解释要时间
 *   · 中途退出要二次确认
 * 唯一的结构性改动：答对后不再弹转盘，直接推进；星星在整局结束时结算。
 */
var G = require('../../generated/lib/game.js');
var stars = require('../../lib/stars.js');
var sfx = require('../../lib/sfx.js');
var audio = require('../../lib/audio.js');
var tts = require('../../lib/tts.js');
var confetti = require('../../lib/confetti.js');

/** 单个汉字或单个字母要放大（b/d/p/q 长得像，不放大只能靠猜）。 */
var SINGLE_RE = /^(?:[一-鿿]|[A-Za-z])$/;

Page({
  data: {
    subjectLabel: '',
    total: 0,
    stars: 0,
    dots: [],
    stemText: '',
    layout: 'grid',
    hasAudio: false,
    audioId: '',
    canRead: false,
    readText: '',
    options: [],
    answered: false,
    fb: '',
    shake: false,
    showExplain: false,
    explain: '',
    confetti: false,
    confettiPieces: []
  },

  onLoad: function (query) {
    var subject = (query && query.subject) || '';

    // 没有科目参数就直接回首页 —— 旧版本跳转过来时会是这种情况。
    if (G.SUBJECTS.indexOf(subject) < 0) {
      wx.reLaunch({ url: '/pages/home/home' });
      return;
    }

    this.subject = subject;
    // 顶部标题写成科目名，孩子一眼知道自己在做哪一科
    try {
      wx.setNavigationBarTitle({ title: G.SUBJECT_LABEL[subject] || '闯关' });
    } catch (e) { /* 低版本忽略 */ }

    this.save = getApp().globalData.save;
    this.round = G.Runner.buildSubjectRound(this.save, subject, G.ROUND_SIZE);
    this.idx = 0;
    this.results = this.round.questions.map(function () { return null; });
    this.items = [];
    this._answered = false;
    this._timers = [];
    this.renderQuestion();
  },

  onUnload: function () {
    this.clearTimers();
    tts.stop();
  },

  /* ---------- 渲染 ---------- */

  renderQuestion: function () {
    var q = this.round.questions[this.idx];
    var layout = (q.stem && q.stem.layout) ||
                 (q.options.length <= 2 ? 'row' : 'grid');

    var options = q.options.map(function (o) {
      return {
        id: o.id,
        text: o.text,
        single: SINGLE_RE.test(o.text || ''),
        state: ''
      };
    });

    this.clearTimers();
    // 先掐掉上一题的朗读和自动播定时器，否则会念出已经翻过去的题干。
    tts.stop();
    this._answered = false;
    this.qStartAt = Date.now();

    // 只朗读题干、不朗读选项；听音题有自带音频，跳过朗读。
    // 规则在 generated/lib/game.js 里，和网页版共用同一份实现。
    var readInfo = G.TTSText ? G.TTSText.forQuestion(q) : { text: '', skip: true };
    var canRead = !readInfo.skip && !!readInfo.text
      && !(this.save.settings && this.save.settings.readStem === false)
      && tts.available();

    this.setData({
      subjectLabel: G.SUBJECT_LABEL[this.subject] || '',
      total: this.round.questions.length,
      stars: this.save.points.balance,
      dots: this.buildDots(),
      stemText: (q.stem && q.stem.text) || '',
      layout: layout,
      hasAudio: !!(q.stem && q.stem.audio),
      audioId: (q.stem && q.stem.audio) || '',
      canRead: canRead,
      readText: canRead ? readInfo.text : '',
      options: options,
      answered: false,
      fb: '',
      shake: false,
      showExplain: false,
      explain: '',
      confetti: false,
      confettiPieces: []
    });

    // 听音题进来就自动播一遍（对应网页版的 autoplay）。延后 350ms
    // 让页面先画出来，否则声音会比画面早，孩子不知道在听什么。
    if (q.stem && q.stem.audio) {
      var id = q.stem.audio;
      this.later(350, function () { audio.play(id); });
    } else if (canRead) {
      var text = readInfo.text;
      tts.schedule(text, 350);
    }
  },

  buildDots: function () {
    var out = [];
    for (var i = 0; i < this.round.questions.length; i++) {
      var r = this.results[i];
      out.push({
        i: i,
        state: r === true ? 'ok' : r === false ? 'bad' : (i === this.idx ? 'now' : '')
      });
    }
    return out;
  },

  /* ---------- 作答 ---------- */

  onOption: function (e) {
    if (this._answered) return;      // setData 是异步的，不能用 data.answered 防连点
    this._answered = true;

    var id = e.currentTarget.dataset.id;
    var q = this.round.questions[this.idx];
    var correct = id === q.answer;

    // 选项不播「嗒」声（网页版用 data-sfx-off 关掉的就是它），
    // 直接出对/错音；两个叠在一起会糊成一团。
    sfx.play(correct ? 'ui.correct' : 'ui.wrong');

    var options = this.data.options.map(function (o) {
      var state = 'locked';
      if (o.id === q.answer) state = 'answer';
      else if (o.id === id) state = 'wrong';
      return { id: o.id, text: o.text, single: o.single, state: state };
    });

    this.setData({
      answered: true,
      options: options,
      fb: correct ? 'ok' : 'bad',
      shake: !correct,
      showExplain: !correct,
      explain: q.explain || '',
      confetti: correct,
      confettiPieces: correct ? confetti.pieces() : []
    });

    var self = this;
    this.later(correct ? 620 : 1500, function () { self.advance(correct); });
  },

  advance: function (correct) {
    var q = this.round.questions[this.idx];
    var ms = Date.now() - this.qStartAt;

    this.results[this.idx] = correct;
    this.items.push({
      qid: q.id,
      subject: q.subject,
      type: q.type,
      tags: q.tags || [],
      correct: correct,
      ms: ms
    });

    G.Runner.recordAnswer(this.save, q, correct, ms);
    G.Store.save(this.save);

    this.idx++;
    if (this.idx >= this.round.questions.length) {
      this.finish();
      return;
    }
    this.renderQuestion();
  },

  /* ---------- 结算 ---------- */

  finish: function () {
    var correct = this.results.filter(function (r) { return r === true; }).length;
    var total = this.results.length;
    var nominal = stars.forCorrect(correct, this.subject);

    // 顺序不能反：finishSession 记的是**实际到账**的星星。
    // 先 awardPoints 拿到被每日上限削过的值，再把它传给 finishSession，
    // 否则三方审计会发现「本次入账」对不上累计值。
    var lifetimeBefore = this.save.points.lifetime;
    var award = G.Runner.awardPoints(this.save, nominal);
    G.Runner.finishSession(this.save, this.round, this.items, [], award.awarded);

    getApp().globalData.lastResult = {
      subject: this.subject,
      correct: correct,
      total: total,
      stars: award.awarded,
      nominal: nominal,
      capped: award.capped,
      lifetime: this.save.points.lifetime,
      lifetimeBefore: lifetimeBefore
    };

    this.clearTimers();
    wx.redirectTo({ url: '/pages/result/result' });
  },

  /* ---------- 交互 ---------- */

  onSpeaker: function () {
    sfx.play('ui.tap');
    if (this.data.audioId) audio.play(this.data.audioId);
  },

  onReadStem: function () {
    sfx.play('ui.tap');
    if (this.data.readText) tts.speak(this.data.readText);
  },

  onExit: function () {
    sfx.play('ui.tap');
    var self = this;
    wx.showModal({
      title: '退出这一局？',
      content: '这一局的进度不会保存。',
      confirmText: '退出',
      cancelText: '继续玩',
      success: function (res) {
        if (!res.confirm) return;
        self.clearTimers();
        tts.stop();
        wx.navigateBack({ delta: 1 });
      }
    });
  },

  /* ---------- 定时器 ---------- */

  later: function (ms, fn) {
    var t = setTimeout(fn, ms);
    this._timers.push(t);
    return t;
  },

  clearTimers: function () {
    if (!this._timers) return;
    for (var i = 0; i < this._timers.length; i++) clearTimeout(this._timers[i]);
    this._timers = [];
  }
});
