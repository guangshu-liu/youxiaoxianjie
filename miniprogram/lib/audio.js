/* audio.js — 单词语音（听音选字母题）
 *
 * 网页版用 Web Audio 解码 AudioBuffer；小程序里换成 InnerAudioContext 播
 * 包内文件。语音文件随包发布，不走网络，所以：
 *   · 不需要域名白名单
 *   · 不需要 PWA 的 Service Worker
 *   · 首次打开就可用，断网也能玩
 *
 * **接口必须和 Store 对得上**：10-store.js 的 exportAll / importAll 会调用
 * G.Audio.dumpOverrides() / loadOverrides()。小程序的这一版没有「家长录音
 * 覆盖」功能，所以这两个方法返回空结果，但必须存在 —— 否则点备份按钮会
 * 直接抛 TypeError。
 */
var AUDIO_MAP = require('../generated/data/audio.js');

var current = null;

function release(ctx) {
  if (current === ctx) current = null;
  try { ctx.destroy(); } catch (e) { /* 已经销毁过 */ }
}

/**
 * 播一条语音。同一时刻只播一条 —— 连点喇叭时把上一条掐掉，
 * 否则两段语音叠在一起听不清。
 */
function play(audioId) {
  var src = audioId && AUDIO_MAP[audioId];
  if (!src) return Promise.resolve(false);

  try {
    if (current) {
      try { current.stop(); } catch (e) {}
      release(current);
    }

    var ctx = wx.createInnerAudioContext();
    current = ctx;
    ctx.src = src;
    ctx.onEnded(function () { release(ctx); });
    ctx.onError(function () { release(ctx); });
    ctx.play();
    return Promise.resolve(true);
  } catch (e) {
    return Promise.resolve(false);
  }
}

function has(audioId) {
  return !!(audioId && AUDIO_MAP[audioId]);
}

/**
 * 预加载。包内文件是本地读取，没有网络延迟，InnerAudioContext 也没有
 * 真正的「预解码」接口 —— 这里保留同名方法是为了调用方（play 页）不用
 * 为两个平台写两份代码。
 */
function preload(ids) {
  return Promise.resolve(ids || []);
}

/* ---- 10-store.js 需要的两个方法（网页版用来搬家录音） ---- */

function dumpOverrides() { return Promise.resolve([]); }
function loadOverrides() { return Promise.resolve(0); }

module.exports = {
  play: play,
  has: has,
  preload: preload,
  dumpOverrides: dumpOverrides,
  loadOverrides: loadOverrides
};
