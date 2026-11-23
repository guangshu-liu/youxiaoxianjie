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
var progress = require('../../lib/progress.js');

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
    // 分步讲解（进位 / 借位 / 凑十）：stepNow 是当前点亮到第几帧，
    // revealed 控制得数何时揭晓。没有分步的题 revealed 就是 answered。
    stepNow: -1,
    revealed: false,
    explainLong: false,
    // 音位格子 / 字母卡片「跟音频依次点亮」的脉冲 class。
    // a/b 交替是为了强制重播 CSS 动画，和 enterFlag 同一套机制。
    pulse: 'a',
    slotsClass: '',
    lettersClass: '',
    bigText: false
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
    // 大字模式只改字号，不影响组局、朗读、动画节奏；老存档默认关。
    this.setData({ bigText: progress.bigTextOf(this.save) });
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
    // tts.has() 不能省：available() 只看映射表非空。本地加了新题型却忘了
    // 重跑 npm run tts:audio 时，只查 available 会画出一个点了没反应、
    // 还不报错的哑巴喇叭；和下面听音指令用 has() 判断保持同一口径。
    var canRead = !readInfo.skip && !!readInfo.text
      && !(this.save.settings && this.save.settings.readStem === false)
      && tts.available()
      && tts.has(readInfo.text);

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
      // 纯函数解析题干，不改题库；forQuestion 只给答题前数据，得数积木 /
      // 正确词由 onOption 里的 reveal() 合并，答题前 data 里不存在答案。
      visual: visual.forQuestion(q, this.visualEnabled()),
      // 新题把分步演示整体归零，上一题的定时器已由 clearTimers 清掉。
      stepNow: -1,
      revealed: false,
      explainLong: false,
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

  /** 家长面板「把题目画出来」总开关；老存档没这个键时默认开。 */
  visualEnabled: function () {
    return !(this.save.settings && this.save.settings.visualMath === false);
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

    var v = this.data.visual;
    // 进位 / 借位 / 凑十题有过程帧：作答后分三个时刻演完再揭晓得数，
    // 窗口延长到 1900ms。其它题（含全部语文英语）节奏完全不变。家长可以
    // 只关「分步讲解」，积木图仍保留，节奏立刻回到 620 / 1500。
    var stepsOff = !!(this.save.settings && this.save.settings.visualSteps === false);
    var stepsOn = !!(v && v.steps && !stepsOff);

    // 作答后才把得数积木 / 正确词 / unknown.solved 合并进 visual。
    // 必须和 answered 放在同一次 setData：分两次会有一帧
    // 「answered=true 但 visual.after 还不存在」，字母卡片渲染空数据。
    var revealedVisual = visual.merge(v, visual.reveal(q, this.visualEnabled()));

    this.setData({
      answered: true,
      visual: revealedVisual,
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
      starPop: correct,
      // 有分步时先盖着得数，等 runSteps 走到最后一步再打开；没有分步的题
      // 仍是「作答即揭晓」，和 1.2.11 之前完全一样。
      revealed: !stepsOn,
      stepNow: -1,
      explainLong: stepsOn
    });

    if (stepsOn) this.runSteps();

    // 英语听音题答错时重播一次单词，让字母卡片的高亮真正跟着声音走。
    // 只有答错分支有 1500ms 窗口；答对 620ms 不重播，避免和切题抢时间、
    // 也避免 1.2.8 刚修好的「上一题串音」复发（advance 里有 audio.stop 兜底）。
    if (!correct && v && v.kind === 'english' && v.audioId) {
      this.playWord(v.audioId);
    } else {
      var p = this.data.pulse === 'a' ? 'b' : 'a';
      this.setData({ pulse: p, lettersClass: 'v-letters-pulse-' + p });
    }

    var self = this;
    // 分步题答对答错统一 1900ms：两帧 + 结果揭晓共 1080ms，留约 800ms 看结果。
    this.later(stepsOn ? 1900 : (correct ? 620 : 1500),
      function () { self.advance(correct); });
  },

  /* ---------- 分步讲解（进位 / 借位 / 凑十） ---------- */

  /**
   * 两帧过程 + 一次结果揭晓，共三个时刻：120 / 600 / 1080ms。
   * 定时器一律走 later()，切题、退出、结算时 clearTimers 会全部清掉，
   * 不会把上一题的揭晓动作漏到下一题。
   */
  runSteps: function () {
    var v = this.data.visual;
    var n = (v && v.steps) ? v.steps.frames.length : 0;
    if (!n) return;
    var self = this;
    for (var i = 0; i < n; i++) {
      (function (k) {
        self.later(120 + k * 480, function () { self.setStep(k, false); });
      })(i);
    }
    self.later(120 + n * 480, function () { self.setStep(n, true); });
  },

  /** 抽成方法，无头测试可以直接推进到某一帧，不必等真实定时器。 */
  setStep: function (n, reveal) {
    this.setData({ stepNow: n, revealed: !!reveal });
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
    // 复习局题数不固定，必须把 total 传进去按正确率判档，否则 3 道题
    // 全对在 9/6 的绝对阈值下只能拿 1 星。它同时走独立的 review 档：
    // 跨科混合局没有 subject，不能靠 `|| 'chinese'` 隐式落到语文档 ——
    // 以后单独调数学阈值时，复习局会悄悄跟着语文，谁也看不出来。
    var rule = this.review ? 'review' : (this.subject || 'chinese');
    var nominal = stars.forCorrect(correct, rule, total);

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
