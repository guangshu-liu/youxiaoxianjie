/* visual-math.js — 数学计算题的「十进制积木」图形演示
 *
 * 为什么做：算式题题干是纯数字和符号，孩子认字少，而 22-tts-text.js 对
 * 公式题直接 skip（TTS 会把 +、= 念错），所以「66 + 4 = ?」对他就是一串
 * 看不懂的记号。这里把抽象数字换成看得见的数量：一根十棒 = 10，
 * 一个圆点 = 1，顺带把位值概念带出来。
 *
 * 为什么不用改题库：100 道计算题的题干 100% 是 `A + B = ?` / `A - B = ?`，
 * 直接解析字符串即可。不用给 stem 加 visual 字段，生成器、题库 JSON、
 * 网页版产物全都不动 —— 两端题库保持一致，主包只多这一个纯函数文件。
 *
 * 防泄题：答题前只画两个操作数，不画结果、不做合并；作答后才出现结果
 * 积木，那时正确答案已经在选项里标绿了，图形只是复核讲解。
 *
 * 注意力：动画只在换题 / 揭晓结果时各播一次，短促、无循环、无背景动效。
 * 家长可在面板里整个关掉。
 */
'use strict';

var CALC_RE = /^(\d{1,3})\s*([+\-])\s*(\d{1,3})\s*=\s*\?$/;
var NUM_RE = /^\d{1,3}$/;

/** wx:for 要的是数组；顺便给每个块排好错峰入场的延时。 */
function list(n, base) {
  var out = [];
  for (var i = 0; i < n; i++) {
    out.push({ i: i, delay: (base + i * 0.035).toFixed(2) });
  }
  return out;
}

/** 把一个 0~99 的数画成「十棒 + 圆点」。 */
function blocks(n, base) {
  var tens = Math.floor(n / 10);
  var ones = n % 10;
  var from = base || 0;
  return {
    value: n,
    label: String(n),
    bars: list(tens, from),
    dots: list(ones, from + tens * 0.035),
    empty: n === 0
  };
}

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

/**
 * 返回可视化数据，或 null（这题不演示）。
 * enabled === false 才关；老存档没有该字段时调用方按「默认开」传 true。
 */
function forQuestion(q, enabled) {
  if (enabled === false) return null;
  if (!q || q.subject !== 'math' || !hasTag(q, '计算')) return null;

  var text = (q.stem && q.stem.text) ? String(q.stem.text).trim() : '';
  var m = CALC_RE.exec(text);
  if (!m) return null;

  var a = parseInt(m[1], 10);
  var b = parseInt(m[3], 10);
  var op = m[2];
  var ans = answerText(q);
  if (!NUM_RE.test(ans)) return null;
  var r = parseInt(ans, 10);

  // 只覆盖题库实际范围：两位数加减、结果 0~99。超出就别画，
  // 免得积木多到刷屏；同时校验得数，题库数据错乱时宁可不演示。
  if (a > 99 || b > 99 || r > 99 || r < 0) return null;
  if (op === '-' && a < b) return null;
  if (op === '+' && a + b !== r) return null;
  if (op === '-' && a - b !== r) return null;

  return {
    kind: 'math-calc',
    op: op,
    opLabel: op === '+' ? '+' : '−',
    left: blocks(a, 0),
    right: blocks(b, 0.14),
    result: blocks(r, 0),
    // 进位 / 借位是这批题的真正难点，结果行给一次轻微提示，不加文字。
    carry: op === '+' && (a % 10) + (b % 10) >= 10,
    borrow: op === '-' && (a % 10) < (b % 10),
    regroup: (op === '+' && (a % 10) + (b % 10) >= 10) ||
             (op === '-' && (a % 10) < (b % 10)),
    steps: calcSteps(a, b, op)
  };
}

/* ---------- 进位 / 借位 / 凑十：分步过程帧（1.2.12） ----------
 *
 * 之前进位题只有结果行一次底色提示，孩子看到的是「66 + 4」和「70」两个
 * 静止状态，中间「4 个补上去凑成十棒」这一步完全没演。这里补两个中间态：
 *
 *   进位 66 + 4    ① 6 点 + 4 个要搬的点   ② 4 个点凑成一根新十棒
 *   借位 94 - 7    ① 9 根棒里有一根要拆开  ② 从 14 个点里划掉 7 个
 *   凑十 8+8=8+2+? ① 8 里拿出 2 个、剩 6  ② 2 个凑成十棒、还剩 6
 *
 * 第三步就是原有的结果行 / 问号原位翻答案，不重复画一遍得数。
 * 全部只在作答后渲染：答题前这些帧连 WXML 节点都不进，一个得数都不露。
 *
 * 节奏由 play.js 单独安排：有帧的题切题窗口 620ms → 1900ms，三个时刻
 * 依次点亮；家长可以在面板里只关掉分步、保留积木图，节奏立刻恢复原样。
 */

/** wx:for 用的块；cls 由数据层算好，WXML 不拼字符串。 */
function toneDots(n, tone, from) {
  var out = [], i;
  for (i = 0; i < n; i++) out.push({ i: from + i, cls: tone ? 'v-dot-' + tone : '' });
  return out;
}

function toneBars(n, tone, from) {
  var out = [], i;
  for (i = 0; i < n; i++) out.push({ i: from + i, cls: tone ? 'v-bar-' + tone : '' });
  return out;
}

function frame(i, bars, dots) {
  return { i: i, bars: bars, dots: dots };
}

/** 进位 / 借位；不进位、不用借位的题返回 null，节奏保持原样。 */
function calcSteps(a, b, op) {
  if (op === '+') {
    var need = 10 - (a % 10);      // 补满个位需要几个
    if (need <= 0 || need > b) return null;
    // 进位和凑十题是同一个动作：从第二个数里拿 need 个去凑十，
    // 剩下的就是得数的个位。上面的题干积木已经画了完整的两个数，
    // 这里只画「参与搬运」的那几个，别把 14 个点挤进一张小卡片。
    return makeTenSteps(b, need, b - need);
  }

  if (a % 10 >= b) return null;    // 个位够减，不用借位
  var bars = Math.floor(a / 10);
  if (bars < 1) return null;       // 没有十棒可拆
  var ones = a % 10 + 10;         // 拆一根棒后一共有几个点
  return {
    frames: [
      // ① 原来的棒里有一根标成「要拆开」，个位还是原来那几个
      frame(0, toneBars(bars - 1, '', 0).concat(toneBars(1, 'break', bars - 1)),
               toneDots(a % 10, '', 0)),
      // ② 拆开后划掉要减的点，剩下的就是得数的个位
      frame(1, toneBars(bars - 1, '', 0),
               toneDots(b, 'cut', 0).concat(toneDots(ones - b, '', b)))
    ],
    need: b,
    rest: ones - b
  };
}

/** 凑十：a + c = 10，b 拆成 c 和答案，先凑十、再数剩下的。 */
function makeTenSteps(b, c, ans) {
  return {
    frames: [
      frame(0, [], toneDots(c, 'take', 0).concat(toneDots(ans, 'rest', c))),
      frame(1, toneBars(1, 'new', 0), toneDots(ans, 'rest', 0))
    ],
    need: c,
    rest: ans
  };
}

/* ---------- 拆数 / 凑十（28 道，四种题干格式） ----------
 *
 * 统一画成「积木方程」：上面是原数，下面是拆开的几块，其中一块是 `?`。
 * 答题前 `?` 就是个问号；作答后同一位置翻出正确积木 —— 孩子看到的是
 * 「这里应该填几」，而不是凭空多出一行答案。
 *
 * 凑十题（`8 + 8 = 8 + 2 + ?`）额外给一条提示：8 + 2 → 一根十棒。
 * 这两个数题干里已经写了，不算泄答案；真正要算的 `?` 仍然盖着。
 */

var PLACE_KNOWN_RE   = /^(\d{1,2})\s*=\s*(\d{1,2})\s*\+\s*\?$/;
var PLACE_UNKNOWN_RE = /^(\d{1,2})\s*=\s*\?\s*\+\s*(\d{1,2})$/;
var MAKE_TEN_RE      = /^(\d)\s*\+\s*(\d)\s*=\s*(\d)\s*\+\s*(\d)\s*\+\s*\?$/;
var COUNT_RE         = /^(\d{1,2})\s*里面有\s*(\d)\s*个十和几个一？$/;

function card(n, i) {
  var b = blocks(n, 0);
  b.i = i;                 // WXML 的 wx:key 要用
  b.unknown = false;
  b.delay = (i * 0.09).toFixed(2);
  return b;
}

function unknownCard(i, solved) {
  return {
    i: i,
    label: '?',
    unknown: true,
    solved: solved,          // 作答后由 WXML 在原位翻出，不新增一行
    bars: [], dots: [], empty: false,
    delay: (i * 0.09).toFixed(2)
  };
}

function numAnswer(q) {
  var opts = (q && q.options) || [];
  for (var i = 0; i < opts.length; i++) {
    if (opts[i].id === q.answer) {
      var t = String(opts[i].text || '').trim();
      if (/^\d{1,3}$/.test(t)) return parseInt(t, 10);
    }
  }
  return -1;
}

function splitResult(mode, top, parts, solved, hint, steps) {
  return {
    kind: 'math-split',
    mode: mode,
    top: top,
    parts: parts,
    answer: solved,
    hint: hint,
    steps: steps || null
  };
}

function forSplitQuestion(q, enabled) {
  if (enabled === false) return null;
  if (!q || q.subject !== 'math' || !hasTag(q, '拆数')) return null;

  var text = (q.stem && q.stem.text) ? String(q.stem.text).trim() : '';
  var ans = numAnswer(q);
  if (ans < 0 || ans > 99) return null;
  var solved = blocks(ans, 0);
  var m, n, k;

  // 13 = 10 + ?
  m = PLACE_KNOWN_RE.exec(text);
  if (m) {
    n = +m[1]; k = +m[2];
    if (n > 99 || k + ans !== n) return null;
    return splitResult('place', card(n, 0),
      [card(k, 0), unknownCard(1, solved)], solved, null);
  }

  // 66 = ? + 6
  m = PLACE_UNKNOWN_RE.exec(text);
  if (m) {
    n = +m[1]; k = +m[2];
    if (n > 99 || ans + k !== n) return null;
    return splitResult('place', card(n, 0),
      [unknownCard(0, solved), card(k, 1)], solved, null);
  }

  // 8 + 8 = 8 + 2 + ?  —— 先凑十，再算剩下几个
  m = MAKE_TEN_RE.exec(text);
  if (m) {
    var a = +m[1], b = +m[2], a2 = +m[3], c = +m[4];
    if (a !== a2 || a + c !== 10 || c + ans !== b) return null;
    return splitResult('make-ten', null,
      [card(a, 0), card(c, 1), unknownCard(2, solved)],
      solved, { a: a, c: c }, makeTenSteps(b, c, ans));
  }

  // 34 里面有 3 个十和几个一？
  m = COUNT_RE.exec(text);
  if (m) {
    n = +m[1]; var tens = +m[2];
    if (n > 99 || Math.floor(n / 10) !== tens || ans !== n % 10) return null;
    return splitResult('count', card(n, 0),
      [card(tens * 10, 0), unknownCard(1, solved)], solved, null);
  }

  return null;
}

module.exports = {
  forQuestion: forQuestion,
  forSplitQuestion: forSplitQuestion,
  blocks: blocks,
  calcSteps: calcSteps,
  makeTenSteps: makeTenSteps,
  CALC_RE: CALC_RE
};
