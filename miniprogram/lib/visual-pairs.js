/* visual-pairs.js — 「已知项 → 要找什么 → ?」通用对照卡（1.2.16）
 *
 * 补覆盖的思路：题库里有一大批题，题干只给了一个已知的字 / 字母，问的是
 * 它的反义词、部首、笔画、小写、上一个字母……这些题以前完全没有图形
 * 演示，孩子只能靠读题干（认字少）或听朗读。这里把「题干里已经写着的
 * 那个已知项」摆成一张大卡片，中间写清问的是什么，右边留一个问号。
 *
 * 为什么不泄题：left 和 op 全部来自题干字符串，答案只在 reveal() 之后
 * 由 visual.js 合并进 answer.label，原位把 ? 翻掉。答题前的数据层里
 * 根本不存在正确答案，和 1.2.13 定下的纪律一致。
 *
 * 为什么用一张规则表：这些题型题干格式高度统一（同一 tag 下几乎一模一样），
 * 一条正则就能精确覆盖一整类。匹配不上就返回 null，静默退回纯文字题目，
 * 不给题库加字段、不改生成器、不碰网页版产物。
 */
'use strict';

var RULES = [
  { tag: '反义词',     re: /^「([^」]+)」的反义词是哪个字？$/,       op: '反义词' },
  { tag: '加一笔',     re: /^「([^」]+)」加一笔，变成下面哪个字？$/, op: '加一笔' },
  { tag: '减一笔',     re: /^「([^」]+)」减一笔，变成下面哪个字？$/, op: '减一笔' },
  { tag: '笔画',       re: /^「([^」]+)」一共有几笔？$/,             op: '几笔' },
  { tag: '部首',       re: /^「([^」]+)」的部首是什么？$/,           op: '部首' },
  { tag: '偏旁',       re: /^下面哪个字是「([^」]+)」字旁？$/,       op: '字旁' },
  { tag: '大小写配对', re: /^大写 ([A-Z]) 的小写是哪个？$/,           op: '小写' },
  { tag: '大小写配对', re: /^小写 ([a-z]) 的大写是哪个？$/,           op: '大写' },
  { tag: '字母顺序',   re: /^字母 ([A-Z]) 的(下一个|上一个)字母是哪个？$/, op: '上一个字母' }
];

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

/** 字母顺序题的「下一个 / 上一个」要跟着题干走，不能写死。 */
function opOf(rule, m) {
  if (rule.tag === '字母顺序') return m[2] + '字母';
  return rule.op;
}

function forQuestion(q, enabled) {
  if (enabled === false || !q) return null;
  var text = (q.stem && q.stem.text) ? String(q.stem.text).trim() : '';
  var ans = answerText(q);
  if (!text || !ans || ans.length > 6) return null;

  for (var i = 0; i < RULES.length; i++) {
    var rule = RULES[i];
    if (!hasTag(q, rule.tag)) continue;
    var m = rule.re.exec(text);
    if (!m || !m[1]) continue;
    return {
      kind: 'pair',
      left: m[1],
      op: opOf(rule, m),
      // 单个汉字 / 字母放大；「4 笔」这类答案保持常规字号。
      big: /^(?:[一-龥]|[A-Za-z])$/.test(m[1]),
      answer: { label: ans }
    };
  }
  return null;
}

module.exports = {
  RULES: RULES,
  forQuestion: forQuestion
};
