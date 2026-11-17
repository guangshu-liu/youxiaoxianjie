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
 */
(function (window) {
  'use strict';

  var G = window.G;
  var timer = null;
  var voices = [];

  function synth() {
    return window.speechSynthesis;
  }

  function available() {
    return !!(window.speechSynthesis && window.SpeechSynthesisUtterance);
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

  G.TTS = {
    available: available,
    enabled: enabled,
    speak: speak,
    stop: stop,
    schedule: schedule
  };

})(window);
