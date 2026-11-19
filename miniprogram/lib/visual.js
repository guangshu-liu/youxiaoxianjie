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
 */
'use strict';

var math = require('./visual-math.js');
var english = require('./visual-english.js');
var chinese = require('./visual-chinese.js');

function forQuestion(q, enabled) {
  if (enabled === false || !q) return null;

  if (q.subject === 'math') {
    // 计算题优先；拆数题是另一种题干格式，互斥。
    return math.forQuestion(q, enabled) || math.forSplitQuestion(q, enabled);
  }
  if (q.subject === 'english') return english.forQuestion(q, enabled);
  if (q.subject === 'chinese') return chinese.forQuestion(q, enabled);
  return null;
}

module.exports = {
  forQuestion: forQuestion,
  math: math,
  english: english,
  chinese: chinese
};
