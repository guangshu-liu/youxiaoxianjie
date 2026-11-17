/* 23-tts.js — 网页版题干朗读（Web Speech API）
 *
 * 为什么不生成音频文件：600 道题去重后有 375 条不同题干，按中文短句
 * 算下来约 3 MB，小程序主包上限 2 MB，单文件版也会从 1.0 MB 涨到 4 MB。
 * 浏览器自带的 speechSynthesis 用系统语音，零文件、断网也能念。
 *
 * 一次只念一句：进下一题或重播时先 cancel()，否则两句会叠在一起。
 * 自动播的定时器由本模块持有 —— 切题时 stop() 能把它一起清掉，
 * 不然已经从 DOM 里摘掉的旧按钮会在 350ms 后念出上一题。
 *
 * 已知限制（只能真机验）：iOS Safari 的 speechSynthesis 走的是和
 * InnerAudioContext 不同的音频通道，拨到静音时是否还出声不能假定
 * 「app.js 里设过 obeyMuteSwitch」就万事大吉。见 README 验收清单。
 *
 * 另一个坑：iOS Safari / 微信内置浏览器要求**第一次** speak() 发生在用户
 * 手势的调用栈里，之后才允许异步 speak()。进题自动播是 350ms 后的定时器，
 * 不在手势栈里，不解锁的话整局都静默失败（连 onerror 都不一定来）。
 * 所以模块加载时在 document 捕获阶段挂一次性监听，用一条音量为 0 的空
 * utterance 把语音通道激活；点「开始闯关」这一下就够了。
 */
(function (window) {
  'use strict';

  var G = window.G;
  var timer = null;
  var voices = [];
  var unlocked = false;
  var unlockBound = false;

  function synth() {
    return window.speechSynthesis;
  }

  function available() {
    return !!(window.speechSynthesis && window.SpeechSynthesisUtterance);
  }

  /** 必须在用户手势的调用栈里调一次，iOS 之后才肯异步朗读。 */
  function unlock() {
    if (unlocked || !available()) return;
    unlocked = true;
    try {
      var s = synth();
      if (s.resume) s.resume();
      var warm = new window.SpeechSynthesisUtterance(' ');
      warm.lang = 'zh-CN';
      warm.volume = 0;
      s.speak(warm);
    } catch (e) { /* 浏览器不支持预热就作罢，真朗读时再试一次 */ }
  }

  function bindUnlock() {
    var d = window.document;
    if (unlockBound || !d || typeof d.addEventListener !== 'function') return;
    unlockBound = true;
    var onGesture = function () {
      unlock();
      try {
        d.removeEventListener('pointerdown', onGesture, true);
        d.removeEventListener('touchend', onGesture, true);
        d.removeEventListener('click', onGesture, true);
      } catch (e) { /* 旧浏览器忽略 */ }
    };
    ['pointerdown', 'touchend', 'click'].forEach(function (t) {
      try { d.addEventListener(t, onGesture, true); } catch (e) {}
    });
  }

  function refreshVoices() {
    try {
      voices = (synth().getVoices && synth().getVoices()) || [];
    } catch (e) { voices = []; }
  }

  /** 家长开关。老存档没有这个字段时视为开启（孩子认字少是默认场景）。 */
  function enabled() {
    try {
      var s = G.Store && G.Store.load && G.Store.load();
      return !!(s && s.settings && s.settings.readStem !== false);
    } catch (e) { return true; }
  }

  function stop() {
    if (timer) { clearTimeout(timer); timer = null; }
    try { if (available()) synth().cancel(); } catch (e) { /* 忽略 */ }
  }

  function speak(text, opts) {
    opts = opts || {};
    if (!text || !available()) return false;
    try {
      var s = synth();
      unlock();                         // 手势监听没覆盖到时再兜一次
      if (s.resume) s.resume();         // Chrome 偶尔停在 paused 状态
      s.cancel();                       // 同一时刻只保留一句
      var u = new window.SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = 0.9;                     // 稍慢一点，6 岁孩子跟得上
      u.pitch = 1;
      u.volume = 1;

      if (!voices.length) refreshVoices();
      for (var i = 0; i < voices.length; i++) {
        if (/^zh[-_]?CN/i.test(voices[i].lang || '')) {
          u.voice = voices[i];
          break;
        }
      }

      u.onend = function () { if (opts.onEnd) opts.onEnd(); };
      u.onerror = function (ev) {
        G.log('题干朗读失败', ev && ev.error);
        if (opts.onEnd) opts.onEnd();
      };
      s.speak(u);
      return true;
    } catch (e) {
      G.log('题干朗读异常', e);
      if (opts.onEnd) opts.onEnd();
      return false;
    }
  }

  /** 进题后延迟一小会儿再念，让画面先出来（和听音题的 350ms 一致）。 */
  function schedule(text, ms, opts) {
    stop();
    timer = setTimeout(function () {
      timer = null;
      speak(text, opts);
    }, ms || 350);
  }

  // getVoices() 在 Chrome / Safari 上是异步填充的，首次调用常返回空数组。
  if (available() && synth().addEventListener) {
    try {
      synth().addEventListener('voiceschanged', refreshVoices);
    } catch (e) { /* 低版本忽略，按 lang 让浏览器自己挑 */ }
  }

  bindUnlock();

  G.TTS = {
    available: available,
    enabled: enabled,
    unlock: unlock,
    speak: speak,
    stop: stop,
    schedule: schedule
  };

})(window);
