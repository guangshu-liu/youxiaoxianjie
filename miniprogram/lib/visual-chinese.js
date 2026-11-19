/* visual-chinese.js — 拼音声母 / 韵母拆合
 *
 * 47 道「看拼音选字」题干是「「hóng」是哪个字？」。孩子认字少，
 * 但题干朗读只会念「看拼音，选出正确的字」（22-tts-text.js 把拼音题
 * 归一成这句，因为 TTS 会把拼音念成汉字），屏幕上那串带声调的拉丁字母
 * 对他就是一团符号。这里把它拆成「声母 + 韵母」两块，错峰入场后靠拢
 * 合成完整拼音，把结构摆给他看。
 *
 * 不泄答案：合成结果就是题干里已经写着的那个拼音，选项才是要选的字。
 * 「声母韵母」那 30 道题问的是「下面哪个是声母/韵母」，题干里没有
 * 完整拼音可拆，跳过。
 */
'use strict';

/* 最长匹配优先：zh / ch / sh 必须排在 z / c / s / h 前面，
   否则「shēng」会被拆成 s + hēng。 */
var SHENGMU = [
  'zh', 'ch', 'sh',
  'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h',
  'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w'
];

var PINYIN_RE = /「([^」]+)」/;

function hasTag(q, tag) {
  var t = (q && q.tags) || [];
  for (var i = 0; i < t.length; i++) if (t[i] === tag) return true;
  return false;
}

function split(pinyin) {
  var py = String(pinyin || '').trim();
  for (var i = 0; i < SHENGMU.length; i++) {
    var s = SHENGMU[i];
    if (py.indexOf(s) === 0 && py.length > s.length) {
      return { sheng: s, yun: py.slice(s.length) };
    }
  }
  // 零声母（ai / er 之类）没有可拆的两块，就不演示。
  return { sheng: '', yun: py };
}

function forQuestion(q, enabled) {
  if (enabled === false) return null;
  if (!q || q.subject !== 'chinese' || !hasTag(q, '看拼音选字')) return null;

  var m = PINYIN_RE.exec(String((q.stem && q.stem.text) || ''));
  if (!m) return null;
  var s = split(m[1]);
  if (!s.sheng || !s.yun) return null;

  return {
    kind: 'pinyin',
    sheng: s.sheng,
    yun: s.yun,
    full: s.sheng + s.yun
  };
}

module.exports = {
  forQuestion: forQuestion,
  split: split,
  SHENGMU: SHENGMU
};
