/* visual.js — 内容型演示的统一入口
 *
 * play 页只需要认识这一个模块。四个 kind 各返回自己那套数据，
 * WXML 按 kind 选模板；解析全是纯函数，不读存档、不碰题库、不碰音频。
 *
 * 共同纪律（写新 kind 时照抄）：
 *   1. 只从题干字符串和正确选项解析，不给题库加字段
 *   2. 答题前不显示任何能直接推出答案的东西
 *   3. 动画只在换题 / 揭晓结果时各播一次，无循环、无背景动效
 *   4. 解析不出来就返回 null，静默退回原来的纯文字题目
 *   5. **forQuestion() 返回的对象里不许有答案**（1.2.13）。得数积木、
 *      正确词、未知块的 solved 一律由 reveal() 在作答后返回，play 页再
 *      合并进 visual。以前靠 WXML 的 revealed 挡着，模板改错一行就泄题；
 *      现在答题前的数据层根本不存在这些字段。
 *
 * steps（进位 / 借位 / 凑十的过程帧）是「怎么算」的讲解数据，不是写好的
 * 得数，而且只在 `answered` 之后渲染，所以留在答题前那半边 —— 切题窗口
 * 要在进题时就知道这题有没有分步，不能等作答后才拿到。
 */
'use strict';

var math = require('./visual-math.js');
var english = require('./visual-english.js');
var chinese = require('./visual-chinese.js');

/** 一眼就是答案的字段。新增 kind 时若也写了得数，要加进这张表。 */
var ANSWER_KEYS = ['result', 'answer', 'after'];

/** 内部用的完整解析结果。不导出 —— 页面代码不该有拿到答案的入口。 */
function full(q, enabled) {
  if (enabled === false || !q) return null;
  if (q.subject === 'math') {
    // 计算题优先；拆数题是另一种题干格式，互斥。
    return math.forQuestion(q, enabled) || math.forSplitQuestion(q, enabled);
  }
  if (q.subject === 'english') return english.forQuestion(q, enabled);
  if (q.subject === 'chinese') return chinese.forQuestion(q, enabled);
  return null;
}

function own(obj, k) {
  return Object.prototype.hasOwnProperty.call(obj, k);
}

function copyWithout(obj, keys) {
  var out = {}, k;
  for (k in obj) if (own(obj, k) && keys.indexOf(k) < 0) out[k] = obj[k];
  return out;
}

/** 进题时调用：只有题干里本来就有的信息，没有任何答案字段。 */
function forQuestion(q, enabled) {
  var v = full(q, enabled);
  if (!v) return null;
  var safe = copyWithout(v, ANSWER_KEYS);
  if (v.parts) {
    safe.parts = v.parts.map(function (p) {
      return (p && p.solved) ? copyWithout(p, ['solved']) : p;
    });
  }
  return safe;
}

/** 作答后调用：只给答案字段，由 play 页合并回 visual。 */
function reveal(q, enabled) {
  var v = full(q, enabled);
  if (!v) return null;
  var out = {}, i;
  for (i = 0; i < ANSWER_KEYS.length; i++) {
    if (v[ANSWER_KEYS[i]] !== undefined) out[ANSWER_KEYS[i]] = v[ANSWER_KEYS[i]];
  }
  // parts 里 unknown 卡片的 solved 也要还原，覆盖答题前剥过的那份。
  if (v.parts) out.parts = v.parts;
  return out;
}

/** 浅合并，避免依赖 Object.assign（老基础库不一定有）。 */
function merge(before, answer) {
  if (!before || !answer) return before;
  var out = {}, k;
  for (k in before) if (own(before, k)) out[k] = before[k];
  for (k in answer) if (own(answer, k)) out[k] = answer[k];
  return out;
}

module.exports = {
  forQuestion: forQuestion,
  reveal: reveal,
  merge: merge,
  ANSWER_KEYS: ANSWER_KEYS,
  math: math,
  english: english,
  chinese: chinese
};
