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
var visual = require('../../lib/visual.js');

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
    confettiPieces: [],
    // 动态展示的状态。都只在换题/作答的瞬间变一次，不做持续动画。
    enterFlag: 'a',
    speaking: false,
    roundCorrect: 0,
    starPop: false,
    // 内容型演示；null 表示这题不演示（解析不出来或家长关了开关）。
    visual: null,
    // 音位格子 / 字母卡片「跟音频依次点亮」的脉冲 class。
    // a/b 交替是为了强制重播 CSS 动画，和 enterFlag 同一套机制。
    pulse: 'a',
    slotsClass: '',
    lettersClass: ''
  },

  onLoad: function (query) {
    var subject = (query && query.subject) || '';
    this.review = !!(query && query.mode === 'review');

    // 没有科目参数就直接回首页 —— 旧版本跳转过来时会是这种情况。
    // 复习局没有科目，走另一条路。
    if (!this.review && G.SUBJECTS.indexOf(subject) < 0) {
      wx.reLaunch({ url: '/pages/home/home' });
      return;
    }

    this.subject = subject;
    try {
      wx.setNavigationBarTitle({
        title: this.review ? '错题复习' : (G.SUBJECT_LABEL[subject] || '闯关')
      });
    } catch (e) { /* 低版本忽略 */ }

    this.save = getApp().globalData.save;
    this.round = this.review
      ? G.Runner.buildReviewRound(this.save, G.ROUND_SIZE)
      : G.Runner.buildSubjectRound(this.save, subject, G.ROUND_SIZE);

    // 错题被清空（比如刚导入了备份）时别开一局空的。
    if (!this.round.questions.length) {
      this._closed = true;
      wx.showToast({ title: '暂时没有要复习的题', icon: 'none' });
      wx.navigateBack({ delta: 1 });
      return;
    }

    this.idx = 0;
    this.results = this.round.questions.map(function () { return null; });
    this.items = [];
    this._answered = false;
    this._timers = [];
    this._closed = false;      // 已结算 / 已记未完成局，防止重复记账
    this.renderQuestion();
  },

  onUnload: function () {
    this.clearTimers();
    tts.stop();
    audio.stop();
    // 系统返回键和左滑退出不走 onExit，这里兜底把已答题记下来。
    this.closeRound();
  },

  /* ---------- 渲染 ---------- */

  renderQuestion: function () {
    var q = this.round.questions[this.idx];
    var layout = (q.stem && q.stem.layout) ||
                 (q.options.length <= 2 ? 'row' : 'grid');

    var options = q.options.map(function (o, i) {
      return {
        id: o.id,
        text: o.text,
        single: SINGLE_RE.test(o.text || ''),
        state: '',
        delay: (i * 0.06).toFixed(2)   // 选项错峰入场，眼睛有落点
      };
    });

    this.clearTimers();
    // 先掐掉上一题的朗读、自动播定时器和正在播的单词音频，
    // 否则会念出已经翻过去的题干 / 把上一题的词漏进这一题。
    tts.stop();
    audio.stop();
    this._answered = false;
    this.qStartAt = Date.now();

    // 只朗读题干、不朗读选项；听音题有自带音频，跳过朗读。
    // 规则在 generated/lib/game.js 里，和网页版共用同一份实现。
    var readInfo = G.TTSText ? G.TTSText.forQuestion(q) : { text: '', skip: true };
    var canRead = !readInfo.skip && !!readInfo.text
      && !(this.save.settings && this.save.settings.readStem === false)
      && tts.available();

    // 听音题的题干不朗读（会和单词音频抢喇叭），但孩子不认汉字，
    // 只听到一个词、看不懂屏幕上的「听一听…」，第一次遇到全靠猜。
    // 这里给三种听音题型各配一句固定中文指令，进题先念指令、念完再播词。
    // 音频不存在（旧包）时静默降级成原来的行为。
    var instruction = '';
    if (!(this.save.settings && this.save.settings.readStem === false)
        && G.TTSText && G.TTSText.instructionFor) {
      var want = G.TTSText.instructionFor(q);
      if (want && tts.has(want)) instruction = want;
    }
    this.instruction = instruction;

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
      confettiPieces: [],
      // 交替 class 强制重播入场动画；新题一律先清掉上一题的播放状态。
      enterFlag: this.data.enterFlag === 'a' ? 'b' : 'a',
      speaking: false,
      starPop: false,
      // 纯函数解析题干，不改题库；家长关掉开关时传 false 直接返回 null。
      visual: visual.forQuestion(q,
        !(this.save.settings && this.save.settings.visualMath === false)),
      // 新题先不点亮音位格子，等单词音频真正开播时再 pulse。
      slotsClass: '',
      lettersClass: ''
    });

    // 听音题进来就自动播一遍（对应网页版的 autoplay）。
    // 有中文指令时先念指令，靠 onEnded 串到单词音频 —— 两个播放器是不同
    // 实例，用固定延时会叠音；指令被 stop() 掐掉时回调也不会再触发。
    var self = this;
    if (q.stem && q.stem.audio) {
      var id = q.stem.audio;
      if (instruction) {
        tts.schedule(instruction, 250, function () { self.playWord(id); });
      } else {
        this.later(350, function () { self.playWord(id); });
      }
    } else if (canRead) {
      var text = readInfo.text;
      // 喇叭只在真的出声时脉冲，念完立刻停 —— 不是常驻的呼吸动画。
      tts.schedule(text, 350,
        function () { self.setData({ speaking: false }); },
        function () { self.setData({ speaking: true }); });
    }
  },

  /**
   * 播单词音频，同时让音位格子 / 字母卡片跟着依次点亮。
   * 挂 class 而不是用固定延时的原因：中文指令可能让音频晚 1s 才开始，
   * 从进题时刻算的动画会早在声音之前就演完，孩子看不到「跟着声音」。
   */
  playWord: function (id) {
    audio.play(id);
    var p = this.data.pulse === 'a' ? 'b' : 'a';
    this.setData({
      pulse: p,
      slotsClass: 'v-slots-pulse-' + p,
      lettersClass: 'v-letters-pulse-' + p
    });
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
      // 作答后把入场 delay 清零，反馈动画（pop-ok）才能立刻播。
      return { id: o.id, text: o.text, single: o.single, state: state, delay: 0 };
    });

    this.setData({
      answered: true,
      options: options,
      fb: correct ? 'ok' : 'bad',
      shake: !correct,
      showExplain: !correct,
      explain: q.explain || '',
      confetti: correct,
      // 答题页只有 620ms 窗口，彩纸的随机延迟也要压进去。
      confettiPieces: correct ? confetti.pieces(18, 0.06) : [],
      // 只加「本局答对数」这个视觉计数，不动 save.points ——
      // 真账目在整局结束时结算，逐题改会和每日上限、家长页审计对不上。
      roundCorrect: correct ? this.data.roundCorrect + 1 : this.data.roundCorrect,
      starPop: correct
    });

    // 英语听音题答错时重播一次单词，让字母卡片的高亮真正跟着声音走。
    // 只有答错分支有 1500ms 窗口；答对 620ms 不重播，避免和切题抢时间、
    // 也避免 1.2.8 刚修好的「上一题串音」复发（advance 里有 audio.stop 兜底）。
    var v = this.data.visual;
    if (!correct && v && v.kind === 'english' && v.audioId) {
      this.playWord(v.audioId);
    } else {
      var p = this.data.pulse === 'a' ? 'b' : 'a';
      this.setData({ pulse: p, lettersClass: 'v-letters-pulse-' + p });
    }

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
    this._closed = true;       // 正常结算，onUnload 不要再记未完成局
    var correct = this.results.filter(function (r) { return r === true; }).length;
    var total = this.results.length;
    var nominal = stars.forCorrect(correct, this.subject || 'chinese');

    // 顺序不能反：finishSession 记的是**实际到账**的星星。
    // 先 awardPoints 拿到被每日上限削过的值，再把它传给 finishSession，
    // 否则三方审计会发现「本次入账」对不上累计值。
    var lifetimeBefore = this.save.points.lifetime;
    var award = G.Runner.awardPoints(this.save, nominal);
    G.Runner.finishSession(this.save, this.round, this.items, [], award.awarded);

    getApp().globalData.lastResult = {
      subject: this.subject || 'chinese',
      review: this.review,
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

  /**
   * 中途退出：把已经答过的题记成一条「未完成」局。
   *
   * recordAnswer 在 advance() 里已经写进错题本和 progress 了，以前却
   * 不写 sessions —— 结果 levelOf 只统计 sessions.items，这些作答不参与
   * 难度评估，家长页「最近 N 局」也看不到，数据是半吊子的。
   * 未完成局不发球、不计入今日局数，只补上学习记录。
   */
  closeRound: function () {
    if (this._closed) return;
    this._closed = true;
    if (!this.save || !this.round) return;
    G.Runner.abandonSession(this.save, this.round, this.items);
  },

  /* ---------- 交互 ---------- */

  onSpeaker: function () {
    sfx.play('ui.tap');
    // 孩子可能在中文指令还没念完时就点喇叭：先停掉指令（连带取消它的
    // 播完回调），再直接播单词，避免两段声音叠在一起。
    tts.stop();
    if (this.data.audioId) this.playWord(this.data.audioId);
  },

  onReadStem: function () {
    sfx.play('ui.tap');
    if (!this.data.readText) return;
    var self = this;
    tts.speak(this.data.readText,
      function () { self.setData({ speaking: false }); },
      function () { self.setData({ speaking: true }); });
  },

  onExit: function () {
    sfx.play('ui.tap');
    var self = this;
    wx.showModal({
      title: '退出这一局？',
      content: '已经答过的题会记下来，但这一局不算完成，也不发星星。',
      confirmText: '退出',
      cancelText: '继续玩',
      success: function (res) {
        if (!res.confirm) return;
        self.clearTimers();
        tts.stop();
        audio.stop();
        self.closeRound();
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
