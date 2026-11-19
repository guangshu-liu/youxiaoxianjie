/* visual-english.js — 英语词族拆分与「听音 → 看拼写」演示
 *
 * 这里有个绕不开的冲突：听音题（94 道）的答案就是那个词，答题前把字母
 * 显示出来 = 直接给答案，题目就废了。所以拆成两段：
 *
 *   答题前
 *     · 题干本来就带词的题（拼合 CVC / 押韵配对）→ 画 onset + rime 两块，
 *       只把已有的信息摆出来，不合并成答案词。
 *     · 听音题 → 只画几个空心「音位格子」，不显示字母；音频一开始播，
 *       格子跟着依次点亮，训练「这个词有几个音」的节奏感。
 *   作答后
 *     正确答案已经在选项里标绿了，这时才把正确词拆成字母卡片依次高亮，
 *     形成「听到的音 → 看到的拼写」闭环。答错时会重播一次单词音频，
 *     让高亮严格跟着声音走（1500ms 窗口足够；答对只有 620ms，不重播，
 *     避免和切题抢时间、也避免刚修好的串音问题复发）。
 *
 * 全部一次性动画，无循环、无背景动效。
 */
'use strict';

var BLEND_RE = /^([a-z])\s*\+\s*([a-z]{2,4})\s*拼起来是哪个词？$/;
var RHYME_RE = /下面哪个词和\s*([a-z]{3,8})\s*的结尾音一样？/;
var WORD_RE = /^[a-z]{1,10}$/;

function hasTag(q, tag) {
  var t = (q && q.tags) || [];
  for (var i = 0; i < t.length; i++) if (t[i] === tag) return true;
  return false;
}

function answerText(q) {
  var opts = (q && q.options) || [];
  for (var i = 0; i < opts.length; i++) {
    if (opts[i].id === q.answer) return String(opts[i].text || '').trim();
  }
  return '';
}

/** 把词拆成首音 + 词族（ram → r / am），双辅音开头时首音取两个字母。 */
function onsetRime(word) {
  var doubles = ['bl', 'br', 'cl', 'cr', 'dr', 'fl', 'fr', 'gl', 'gr',
                 'pl', 'pr', 'sc', 'sk', 'sl', 'sm', 'sn', 'sp', 'st',
                 'sw', 'tr', 'tw', 'sh', 'ch', 'th', 'wh'];
  for (var i = 0; i < doubles.length; i++) {
    if (word.indexOf(doubles[i]) === 0 && word.length > doubles[i].length + 1) {
      return { onset: doubles[i], rime: word.slice(doubles[i].length) };
    }
  }
  return { onset: word.slice(0, 1), rime: word.slice(1) };
}

/** 字母卡片：delay 用于「依次高亮」，一个字母一次，不是循环呼吸。 */
function letters(word, step) {
  var out = [];
  for (var i = 0; i < word.length; i++) {
    out.push({ i: i, ch: word.charAt(i), delay: (i * (step || 0.12)).toFixed(2) });
  }
  return out;
}

/** 音位格子：只表示「有几个音」，不表示字母，答题前不泄题。 */
function slots(n) {
  var out = [];
  for (var i = 0; i < n; i++) {
    out.push({ i: i, delay: (i * 0.14).toFixed(2) });
  }
  return out;
}

/** 从 en.yam / en.question 这类音频 id 里取出词，只用来决定格子数量。 */
function wordFromAudioId(id) {
  if (!id || id.indexOf('en.') !== 0) return '';
  return id.slice(3);
}

function forQuestion(q, enabled) {
  if (enabled === false) return null;
  if (!q || q.subject !== 'english') return null;

  var stem = q.stem || {};
  var text = String(stem.text || '').trim();
  var ans = answerText(q);
  if (!WORD_RE.test(ans)) return null;   // 答案是大写字母的题不走这套演示

  var before = null;
  var audioId = stem.audio || '';

  var m = BLEND_RE.exec(text);
  if (m && hasTag(q, '拼合 CVC')) {
    before = { type: 'split', onset: m[1], rime: m[2], label: '拼起来' };
  } else if (!m) {
    var r = RHYME_RE.exec(text);
    if (r && hasTag(q, '押韵配对')) {
      var parts = onsetRime(r[1]);
      before = { type: 'split', onset: parts.onset, rime: parts.rime, label: '结尾音' };
    }
  }

  if (!before && audioId) {
    var w = wordFromAudioId(audioId);
    // 3~5 个格子就够表达节奏；question / umbrella 这类长词不必画满，
    // 否则一排格子反而把注意力从「听」上拽走。
    before = { type: 'slots', slots: slots(Math.max(3, Math.min(5, w.length || 3))) };
  }

  if (!before) return null;

  return {
    kind: 'english',
    before: before,
    after: {
      word: ans,
      letters: letters(ans, 0.12)
    },
    audioId: audioId
  };
}

module.exports = {
  forQuestion: forQuestion,
  onsetRime: onsetRime,
  letters: letters,
  wordFromAudioId: wordFromAudioId
};
