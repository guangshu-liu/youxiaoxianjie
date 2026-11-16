/* sfx.js — 音效（振荡器现场合成）
 *
 * 移植自网页版 src/js/21-sfx.js 的配方，只改了「怎么拿到 AudioContext」：
 * 网页版复用 20-audio.js 的唯一一个上下文；小程序里用
 * wx.createWebAudioContext()（基础库 2.19.0+），仍然是**全进程一个**。
 *
 * 为什么不全改成音频文件：音效是即时反馈，走文件要多一次解码；而且
 * 合成音零体积、参数可调。真正的风险是低版本基础库没有这个 API，
 * 所以这里**懒创建 + 失败退化**：拿不到上下文就用震动代替，绝不因为
 * 音效把游戏搞崩。
 */
var G = require('../generated/lib/game.js');

var ctx = null;
var unavailable = false;

function ensureCtx() {
  if (ctx) return ctx;
  if (unavailable) return null;
  try {
    if (typeof wx === 'undefined' || typeof wx.createWebAudioContext !== 'function') {
      unavailable = true;
      return null;
    }
    ctx = wx.createWebAudioContext();
    return ctx;
  } catch (e) {
    unavailable = true;
    ctx = null;
    return null;
  }
}

function enabled() {
  try {
    var s = G.Store && G.Store.load();
    if (s && s.settings && s.settings.audioEnabled === false) return false;
  } catch (e) { /* store 还没起来时按有声处理 */ }
  return true;
}

/* ---------- 发声原语 ---------- */

/**
 * 一个音符。at 是相对当前时间的偏移（秒）——
 * 调用方只关心「这几个音依次隔多久」，不关心 currentTime 走到哪了。
 */
function note(c, opt) {
  var t0 = c.currentTime + (opt.at || 0);
  var dur = opt.dur || 0.12;
  var osc = c.createOscillator();
  var gain = c.createGain();

  osc.type = opt.type || 'sine';
  osc.frequency.setValueAtTime(opt.freq, t0);
  if (opt.to) osc.frequency.exponentialRampToValueAtTime(opt.to, t0 + dur);

  // 包络：瞬间起音 + 指数衰减。直接 gain=1 再 stop() 会「啪」一声，
  // 所以尾巴一定要收。
  var vol = (opt.vol === undefined ? 0.25 : opt.vol);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** 扫频噪声，做「咔」这类没有明确音高的声音。 */
function noise(c, opt) {
  var t0 = c.currentTime + (opt.at || 0);
  var dur = opt.dur || 0.08;
  var len = Math.max(1, Math.floor(c.sampleRate * dur));
  var buf = c.createBuffer(1, len, c.sampleRate);
  var d = buf.getChannelData(0);
  for (var i = 0; i < len; i++) {
    d[i] = (Math.random() * 2 - 1) * (1 - i / len) * (1 - i / len);
  }
  var src = c.createBufferSource();
  src.buffer = buf;

  var filt = c.createBiquadFilter();
  filt.type = opt.filter || 'bandpass';
  filt.frequency.value = opt.freq || 1800;
  filt.Q.value = opt.q === undefined ? 1.2 : opt.q;

  var gain = c.createGain();
  gain.gain.value = opt.vol === undefined ? 0.3 : opt.vol;

  src.connect(filt);
  filt.connect(gain);
  gain.connect(c.destination);
  src.start(t0);
}

/* ---------- 音效定义 ---------- */

var RECIPES = {
  // 按钮「嗒」。方波，短到 50ms —— 一局要按几十次，长一点就烦。
  'ui.tap': function (c) {
    note(c, { freq: 880, dur: 0.05, type: 'square', vol: 0.10 });
  },

  // 答对：C5-E5-G5 上行。上行音阶是跨文化通用的「对了」。
  'ui.correct': function (c) {
    note(c, { freq: 523.25, dur: 0.11, type: 'triangle', at: 0,    vol: 0.22 });
    note(c, { freq: 659.25, dur: 0.11, type: 'triangle', at: 0.09, vol: 0.22 });
    note(c, { freq: 783.99, dur: 0.22, type: 'triangle', at: 0.18, vol: 0.26 });
  },

  // 答错：两个下行音，音量压低。不用刺耳的低频 —— 孩子答错本来就挫败。
  'ui.wrong': function (c) {
    note(c, { freq: 392.00, dur: 0.13, type: 'sine', at: 0,    vol: 0.18 });
    note(c, { freq: 311.13, dur: 0.24, type: 'sine', at: 0.11, vol: 0.16 });
  },

  // 一局结束 / 攒够星星
  'ui.star': function (c) {
    note(c, { freq: 1046.5, dur: 0.09, type: 'sine', at: 0,    vol: 0.20 });
    note(c, { freq: 1318.5, dur: 0.09, type: 'sine', at: 0.07, vol: 0.20 });
    note(c, { freq: 1568.0, dur: 0.28, type: 'sine', at: 0.14, vol: 0.24 });
  }
};

/* ---------- 退化 ---------- */

/** 拿不到 AudioContext 时用触感代替，至少还有「我点到了」的反馈。 */
function fallback(id) {
  if (id !== 'ui.correct' && id !== 'ui.wrong') return;
  try {
    wx.vibrateShort({ type: id === 'ui.correct' ? 'light' : 'medium' });
  } catch (e) { /* 部分机型不支持，忽略 */ }
}

/* ---------- 对外 ---------- */

function play(id) {
  if (!enabled()) return false;
  if (!Object.prototype.hasOwnProperty.call(RECIPES, id)) return false;

  var c = ensureCtx();
  if (!c) { fallback(id); return false; }

  try {
    // 用户手势里 context 通常已经是 running；不是的话先唤醒，不排队。
    // 排队的音效攒到解锁后一起放，只会变成一串错位的怪声。
    if (c.state && c.state !== 'running' && typeof c.resume === 'function') c.resume();
    RECIPES[id](c);
    return true;
  } catch (e) {
    fallback(id);
    return false;
  }
}

function has(id) {
  return Object.prototype.hasOwnProperty.call(RECIPES, id);
}

module.exports = { play: play, has: has };
