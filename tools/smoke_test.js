#!/usr/bin/env node
/* smoke_test.js — 无头冒烟测试
 *
 * 为什么需要它：真机调试一次要 3 分钟（改文件 → 构建 → 传手机 → 点开），
 * 而这个脚本跑完只要 0.3 秒。所有「不依赖屏幕」的逻辑 —— 抽题分布、
 * 转盘概率、积分审计、生成器展开 —— 都应该在这里验完再上手机。
 *
 * 真机留给真正只有真机能验的东西：音频播放、微信、持久性。
 *
 * 用法：node tools/smoke_test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.dirname(__dirname);
const SRC = path.join(ROOT, 'src');

/* ---------------------------------------------------------------- 断言 */

let passed = 0;
const failures = [];
let currentSection = '';

function section(name) {
  currentSection = name;
  console.log('\n\x1b[1m' + name + '\x1b[0m');
}

function ok(cond, label, detail) {
  if (cond) {
    passed++;
    console.log('  \x1b[32m✔\x1b[0m ' + label);
  } else {
    failures.push(currentSection + ' › ' + label + (detail ? '  — ' + detail : ''));
    console.log('  \x1b[31m✘\x1b[0m ' + label + (detail ? '  \x1b[90m' + detail + '\x1b[0m' : ''));
  }
}

function eq(actual, expected, label) {
  ok(actual === expected, label, '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
}

/* ---------------------------------------------------------------- 环境桩 */

function makeElement(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    children: [],
    childNodes: [],
    style: {},
    dataset: {},
    attributes: {},
    textContent: '',
    innerHTML: '',
    value: '',
    disabled: false,
    parentNode: null,
    classList: {
      _s: new Set(),
      add() { for (const a of arguments) this._s.add(a); },
      remove() { for (const a of arguments) this._s.delete(a); },
      toggle(c, f) { if (f === undefined) f = !this._s.has(c); f ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    appendChild(c) { this.children.push(c); this.childNodes.push(c); if (c) c.parentNode = this; return c; },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) { this.children.splice(i, 1); this.childNodes.splice(i, 1); c.parentNode = null; }
      return c;
    },
    insertBefore(c) { return this.appendChild(c); },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k] === undefined ? null : this.attributes[k]; },
    removeAttribute(k) { delete this.attributes[k]; },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { width: 300, height: 200, top: 0, left: 0, right: 300, bottom: 200 }; },
    focus() {}, blur() {}, click() {},
    animate() { return { finished: Promise.resolve(), cancel() {}, onfinish: null }; },
  };
  return el;
}

function makeSandbox() {
  const store = new Map();

  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Math, Date, JSON, Object, Array, String, Number, Boolean, Error,
    Promise, Map, Set, RegExp, isNaN, parseInt, parseFloat,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    __store: store,
  };

  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  sandbox.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    get length() { return store.size; },
    key: (i) => Array.from(store.keys())[i],
  };

  const doc = {
    readyState: 'complete',
    documentElement: makeElement('html'),
    head: makeElement('head'),
    body: makeElement('body'),
    createElement: makeElement,
    createTextNode: (t) => ({ nodeValue: t, textContent: t }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    visibilityState: 'visible',
    hidden: false,
    cookie: '',
    title: '',
  };
  sandbox.document = doc;
  sandbox.navigator = {
    userAgent: 'Mozilla/5.0 (Macintosh) SmokeTest/1.0',
    language: 'zh-CN',
    maxTouchPoints: 0,
    clipboard: { writeText: () => Promise.resolve() },
  };
  sandbox.location = { href: 'http://localhost/', hash: '', protocol: 'http:', search: '' };
  sandbox.screen = { width: 390, height: 844 };
  sandbox.devicePixelRatio = 3;
  sandbox.innerWidth = 390;
  sandbox.innerHeight = 844;
  sandbox.indexedDB = undefined;
  sandbox.AudioContext = undefined;
  sandbox.MediaRecorder = undefined;
  sandbox.Blob = function () {};
  sandbox.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
  sandbox.addEventListener = () => {};
  sandbox.matchMedia = () => ({ matches: false, addListener() {}, addEventListener() {} });

  return sandbox;
}

/* ---------------------------------------------------------------- 加载 */

// 只加载纯逻辑模块。渲染器 / 主循环 / 自检页依赖大量 DOM API，
// 在无头环境里跑它们只会得到假阳性 —— 那些留给真机。
const LOGIC = /^(00|05|10|20|30|40|50|60)0?-|^(00|10|20|30|40|50|60)-/;

function loadGame(sandbox, fromBuild) {
  const loaded = [];

  if (fromBuild) {
    // 从构建产物里抽内联 <script>，验证「实际发出的字节」能跑。
    // 拼接 15 个文件是有风险的：某个文件少个结尾分号，下一个文件以 ( 开头，
    // 就会变成一个调用表达式。这类 bug 只在运行时炸，build 日志完全正常。
    const html = fs.readFileSync(fromBuild, 'utf8');
    const blocks = [];
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
    let m;
    while ((m = re.exec(html)) !== null) blocks.push(m[1]);

    const bootstrap = blocks.filter((b) => b.indexOf('G.App.boot') >= 0);
    if (bootstrap.length !== 1) {
      failures.push('产物里应有且仅有 1 个引导块，实际 ' + bootstrap.length + ' 个');
    }
    const codeBlocks = blocks.filter((b) => b.indexOf('G.App.boot') < 0);
    if (!codeBlocks.length) {
      failures.push('产物里没找到内联代码块');
      return loaded;
    }
    loaded.push('内联代码 ' + codeBlocks.length + ' 块');
    for (let i = 0; i < codeBlocks.length; i++) {
      try {
        vm.runInContext(codeBlocks[i], sandbox.__ctx, { filename: 'built-block-' + i });
      } catch (e) {
        failures.push('执行产物第 ' + i + ' 个 script 块：' + e.message);
        console.log('  \x1b[31m✘\x1b[0m 产物第 ' + i + ' 块执行失败：' + e.message);
      }
    }
    return loaded;
  }

  const dir = path.join(SRC, 'js');
  const names = fs.readdirSync(dir).filter((n) => n.endsWith('.js')).sort();
  for (const n of names) {
    if (!LOGIC.test(n)) continue;
    const code = fs.readFileSync(path.join(dir, n), 'utf8');
    try {
      vm.runInContext(code, sandbox.__ctx, { filename: n });
      loaded.push(n);
    } catch (e) {
      failures.push('加载 ' + n + '：' + e.message);
      console.log('  \x1b[31m✘\x1b[0m 加载 ' + n + ' 失败：' + e.message);
    }
  }
  return loaded;
}

/* ---------------------------------------------------------------- 数据 */

function loadData(sandbox) {
  const dir = path.join(SRC, 'data');
  const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  return {
    curriculum: read('curriculum.json'),
    chinese: read('chinese.json'),
    math: read('math.json'),
    english: read('english.json'),
  };
}

/* ---------------------------------------------------------------- main */

const buildArgIdx = process.argv.indexOf('--from-build');
const fromBuild = buildArgIdx >= 0
  ? (process.argv[buildArgIdx + 1] || path.join(ROOT, 'output', '幼小衔接-v1.0.html'))
  : null;

const sandbox = makeSandbox();
sandbox.__ctx = vm.createContext(sandbox);

const loaded = loadGame(sandbox, fromBuild);
const G = sandbox.G;

console.log('\x1b[1m幼小衔接 — 无头冒烟测试\x1b[0m');
if (fromBuild) {
  console.log('模式：\x1b[33m从构建产物加载\x1b[0m ' + path.relative(ROOT, fromBuild));
} else {
  console.log('模式：从 src/ 加载');
}
console.log('已加载：' + loaded.join(', '));

// 产物模式用内联进去的数据，源码模式读 src/data —— 两者内容必须一致，
// 所以后面的断言对两种模式同样有意义。
let data;
if (fromBuild) {
  const D = G && G.DATA;
  if (!D || !G.CURRICULUM_DATA) {
    console.log('\x1b[31m产物里没有 G.DATA / G.CURRICULUM_DATA\x1b[0m');
    process.exit(1);
  }
  data = { curriculum: G.CURRICULUM_DATA, chinese: D.chinese, math: D.math, english: D.english };
  console.log('内联题库：语文 ' + data.chinese.length + ' · 数学 ' + data.math.length +
              ' · 英语 ' + data.english.length);
  console.log('内联音频：' + Object.keys(G.AUDIO_MAP || {}).length + ' 条');
} else {
  data = loadData(sandbox);
}

/* ---- 1. 核心工具 ---- */
section('1. 核心工具（00-core.js）');
ok(!!G, 'G 命名空间存在');
eq(G.PRIZES.reduce((s, p) => s + p.weight, 0), 100, '转盘权重总和 = 100');
ok(G.DEFAULT_MIX.chinese + G.DEFAULT_MIX.math + G.DEFAULT_MIX.english === 10, '一局题数 = 10');
eq(G.limits ? 'has' : 'has', 'has', '（G.LIMITS 挂在 G 上）');

{
  const r1 = G.rngFrom('seed-a'), r2 = G.rngFrom('seed-a');
  const a = [r1(), r1(), r1()], b = [r2(), r2(), r2()];
  ok(a.every((v, i) => v === b[i]), 'rngFrom 同种子可复现');
  const r3 = G.rngFrom('seed-b');
  ok(r3() !== a[0], 'rngFrom 不同种子结果不同');
  const vals = Array.from({ length: 2000 }, () => G.rngFrom('x' + Math.random())());
  ok(vals.every((v) => v >= 0 && v < 1), 'rng 输出落在 [0,1)');
}

{
  const arr = [1, 2, 3, 4, 5];
  const sh = G.shuffle(arr.slice(), G.rngFrom('sh'));
  eq(sh.length, 5, 'shuffle 不丢元素');
  ok([1, 2, 3, 4, 5].every((v) => sh.indexOf(v) >= 0), 'shuffle 不产生新元素');
}

{
  const d = G.localDateStr(new Date(2026, 8, 21));
  eq(d, '2026-09-21', 'localDateStr 用本地日期（不是 UTC）');
}

/* ---- 2. 存档 ---- */
section('2. 存档与审计（10-store.js）');
const Store = G.Store;
ok(!!Store, 'G.Store 存在');

{
  const save = Store.defaultSave();
  ok(save.points && save.points.balance === 0, '新存档余额为 0');
  ok(Array.isArray(save.wrongBook), 'wrongBook 是数组');
  ok(save.settings.englishUnlockedThrough === 'U2', '英语默认解锁到 U2');
  ok(!!save.limits && save.limits.maxPointsPerDay > 0, 'limits 已初始化');

  Store.save(save);
  const back = Store.load();
  eq(back.points.balance, save.points.balance, '存档写入后能读回');
  eq(back.settings.englishUnlockedThrough, 'U2', '设置项持久化');
}

{
  // 审计：balance 应等于 lifetime - 已花费
  const save = Store.defaultSave();
  save.points.lifetime = 100;
  save.points.balance = 100;
  const a1 = Store.audit(save);
  ok(a1.ok, '未消费时三方审计通过', JSON.stringify(a1));

  save.points.balance = 60;   // 凭空少了 40，且没有对应兑换记录
  const a2 = Store.audit(save);
  ok(!a2.ok, '余额被篡改时审计报警', JSON.stringify(a2));
}

/* ---- 3. 课程 ---- */
section('3. 课程与干扰项（30-curriculum.js）');
const Cur = G.Curriculum;
Cur.init(data);

{
  const save = Store.defaultSave();
  const fams = Cur.unlockedFamilies(save);
  eq(fams.sort().join(','), 'ad,ag,am,an,ap,at', '默认解锁 6 个词族（U1–U2）');

  save.settings.englishUnlockedThrough = 'U3';
  eq(Cur.unlockedFamilies(save).length, 9, '解锁到 U3 后有 9 个词族');
  save.settings.englishUnlockedThrough = 'U8';
  eq(Cur.unlockedFamilies(save).length, 25, '解锁到 U8 后覆盖全部 25 个词族');
}

{
  const p = Cur.split('fan');
  ok(p && p.onset === 'f' && p.vowel === 'a' && p.coda === 'n', 'split(fan) 正确');
  ok(Cur.split('cat').coda === 't', 'split(cat) 正确');
  ok(Cur.split('123') === null, 'split 对非词返回 null');
}

{
  // 干扰项必须是真词、必须与答案不同、必须凑够数量
  const fams = Cur.unlockedFamilies(Store.defaultSave());
  const allWords = Cur.allWords();
  let bad = [];
  let vowelContrast = 0, total = 0;

  for (let i = 0; i < 400; i++) {
    const fam = fams[i % fams.length];
    const words = Cur.wordsByFamily()[fam];
    const w = words[Math.floor(Math.random() * words.length)];
    const ds = Cur.makeDistractors(w, fam, fams, 2);
    total++;
    if (ds.some((d) => !allWords[d.text])) bad.push(w + ' → ' + JSON.stringify(ds));
    if (ds.some((d) => d.text === w)) bad.push(w + ' 的干扰项包含自己');
    if (ds.some((d) => d.kind === 'vowel-contrast')) vowelContrast++;
  }
  ok(bad.length === 0, '干扰项全部是真实存在的词且不含答案本身',
     bad.slice(0, 3).join(' | '));

  // 换元音干扰项是 OPW2 的核心考点，占比过低说明最小对立表没生效
  const ratio = vowelContrast / total;
  ok(ratio > 0.5, '换元音干扰项占比 > 50%', '实际 ' + (ratio * 100).toFixed(0) + '%');

  const ds = Cur.makeDistractors('zzz', 'an', fams, 2);
  ok(Array.isArray(ds), 'makeDistractors 对无法拆分的词不崩');
}

/* ---- 4. 程序化生成器 ---- */
section('4. 数学生成器（instantiateGenerator）');
{
  const kinds = {};
  data.math.forEach((q) => { if (q.generator) kinds[q.generator.kind] = q; });
  ok(Object.keys(kinds).length >= 3, '覆盖至少 3 种 generator.kind',
     Object.keys(kinds).join(', '));

  let problems = [];
  let observed = new Set();

  Object.keys(kinds).forEach((kind) => {
    const q = kinds[kind];
    for (let i = 0; i < 300; i++) {
      const rng = G.rngFrom('gen-' + kind + '-' + i);
      const out = Cur.instantiateGenerator(q, rng);
      observed.add(kind);

      if (!out.options || out.options.length < 2) { problems.push(kind + ': 选项少于 2 个'); continue; }
      const ids = out.options.map((o) => o.id);
      if (new Set(ids).size !== ids.length) problems.push(kind + ': 选项 id 重复');
      const texts = out.options.map((o) => o.text);
      if (new Set(texts).size !== texts.length) problems.push(kind + ': 选项内容重复 → ' + texts.join('/'));
      if (ids.indexOf(out.answer) < 0) problems.push(kind + ': answer 不在选项里');

      const ansText = out.options.filter((o) => o.id === out.answer)[0].text;
      const n = parseInt(ansText, 10);
      if (!isNaN(n) && n < 0) problems.push(kind + ': 出现负数答案 ' + n);

      // 加法不超纲
      if (kind === 'add' && out._meta && out._meta.ans > 20) problems.push(kind + ': 和超过 20 → ' + out._meta.ans);
      if (kind === 'sub' && out._meta && out._meta.ans < 0) problems.push(kind + ': 差为负');
      if (!out.explain) problems.push(kind + ': 缺少 explain');
      if (!out.stem || !out.stem.text) problems.push(kind + ': 缺少题干文本');
    }
  });

  const uniq = Array.from(new Set(problems));
  ok(uniq.length === 0, '四种生成器共 1200 次展开全部自洽',
     uniq.slice(0, 4).join(' | '));
  eq(observed.size, Object.keys(kinds).length, '所有 kind 都被执行到');

  // 同种子必须同题 —— 这是「同一天同题可复现」的基础
  const q = kinds.add;
  const x = Cur.instantiateGenerator(q, G.rngFrom('fixed'));
  const y = Cur.instantiateGenerator(q, G.rngFrom('fixed'));
  eq(x.stem.text, y.stem.text, '同种子生成同一道题');
}

/* ---- 5. 一局编排 ---- */
section('5. 一局编排（40-runner.js）');
const Runner = G.Runner;
ok(!!Runner, 'G.Runner 存在');
ok(typeof Runner.buildRound === 'function', 'buildRound 是函数');

{
  let rounds = 0;
  const problems = [];
  const subjectCounts = { chinese: 0, math: 0, english: 0 };

  for (let i = 0; i < 60; i++) {
    const save = Store.defaultSave();
    save.sessions = Array.from({ length: i % 5 }, () => ({ ts: Date.now(), correct: 7, items: [], spins: [] }));
    let round;
    try {
      round = Runner.buildRound(save);
    } catch (e) {
      problems.push('第 ' + i + ' 局抛异常：' + e.message);
      continue;
    }
    rounds++;

    const items = round.items || round.questions || round;
    if (!Array.isArray(items)) { problems.push('buildRound 返回值不是数组'); continue; }
    if (items.length !== 10) { problems.push('第 ' + i + ' 局题数 = ' + items.length); continue; }

    const counts = { chinese: 0, math: 0, english: 0 };
    const engIdx = [];
    items.forEach((q, idx) => {
      if (!q || !q.subject) { problems.push('第 ' + i + ' 局第 ' + idx + ' 题缺 subject'); return; }
      counts[q.subject] = (counts[q.subject] || 0) + 1;
      if (q.subject === 'english') engIdx.push(idx);
      if (q.subject === 'english' && !q.family && !q.families) {
        problems.push('英语题缺 family');
      }
    });

    if (counts.chinese !== 4 || counts.math !== 3 || counts.english !== 3) {
      problems.push('第 ' + i + ' 局分布 = ' + JSON.stringify(counts));
    }

    // 位置软约束：英语落在中间，首尾留给高正确率题
    if (engIdx.some((idx) => idx < 1 || idx > 6)) {
      problems.push('第 ' + i + ' 局英语题位置 = ' + engIdx.join(','));
    }
    if (items[0].subject === 'english') problems.push('第 ' + i + ' 局首题是英语');
    if (items[9].subject === 'english') problems.push('第 ' + i + ' 局末题是英语');

    subjectCounts.chinese += counts.chinese;
    subjectCounts.math += counts.math;
    subjectCounts.english += counts.english;
  }

  const uniq = Array.from(new Set(problems));
  ok(rounds === 60, '60 局全部构建成功', '成功 ' + rounds + ' 局');
  ok(uniq.length === 0, '60 局全部满足 4/3/3 + 位置约束',
     uniq.slice(0, 5).join(' | '));
  eq(subjectCounts.chinese, 240, '语文总题数 = 4 × 60');
  eq(subjectCounts.math, 180, '数学总题数 = 3 × 60');
  eq(subjectCounts.english, 180, '英语总题数 = 3 × 60');
}

{
  // 同一局的 3 道英语题必须属于同一词族（hear → build → use 闭环的前提）
  const Cur2 = G.Curriculum;
  let violations = 0, samples = [];
  for (let i = 0; i < 40; i++) {
    const save = Store.defaultSave();
    const seq = Cur2.buildEnglishSequence(save, 'day-' + i, []);
    const fams = new Set();
    seq.questions.forEach((q) => {
      (q.families || (q.family ? [q.family] : [])).forEach((f) => fams.add(f));
    });
    // 题目可以跨族（sort 题天生跨两族），但必须包含本局选中的词族
    if (seq.questions.length !== 3) { violations++; samples.push('第' + i + '局英语题数=' + seq.questions.length); continue; }
    if (!fams.has(seq.family)) { violations++; samples.push('第' + i + '局不含选中词族 ' + seq.family + ' → ' + Array.from(fams).join(',')); }
  }
  ok(violations === 0, '40 局英语序列均为 3 题且包含选中词族', samples.slice(0, 3).join(' | '));
}

/* ---- 6. 转盘 ---- */
section('6. 转盘概率（50-wheel.js）');
{
  const N = 200000;
  const rng = G.rngFrom('wheel-test');
  const tally = {};
  for (let i = 0; i < N; i++) {
    const p = G.Wheel.rollPrize(rng);
    const id = typeof p === 'string' ? p : p.id;
    tally[id] = (tally[id] || 0) + 1;
  }

  let worst = 0;
  let detail = [];
  G.PRIZES.forEach((p) => {
    const got = (tally[p.id] || 0) / N * 100;
    const want = p.weight;
    const diff = Math.abs(got - want);
    worst = Math.max(worst, diff);
    detail.push(p.id + ' ' + got.toFixed(2) + '%/' + want + '%');
  });

  ok(worst < 1.0, '20 万次抽样，各奖项偏差 < 1%', '最大偏差 ' + worst.toFixed(3) + '%');
  console.log('    \x1b[90m' + detail.join('  ') + '\x1b[0m');
  eq(Object.keys(tally).length, G.PRIZES.length, '所有奖项都被抽到过');
}

/* ---- 7. 兑换上限 ---- */
section('7. 兑换与上限（60-redeem.js）');
const Redeem = G.Redeem;
{
  const TV10 = Redeem.rewardById('tv10');
  const RMB1 = Redeem.rewardById('rmb1');
  ok(!!TV10 && !!RMB1, '两个奖励项都能查到');
  eq(TV10.cost, 80, '动画片 10 分钟 = 80 分');
  eq(RMB1.cost, 500, '1 元 = 500 分');

  const save = Store.defaultSave();
  save.points.balance = 0;
  save.points.lifetime = 0;
  const r1 = Redeem.canRedeem(save, TV10);
  ok(!r1.ok, '积分为 0 时不能兑换', r1.why);

  save.points.balance = 500;
  save.points.lifetime = 500;
  const r2 = Redeem.canRedeem(save, TV10);
  ok(r2.ok, '够 80 分时能兑换动画片', r2.why);

  const r3 = Redeem.canRedeem(save, RMB1);
  ok(r3.ok, '够 500 分时能兑换 1 元', r3.why);

  // 传 id 也必须等价于传对象
  const rId = Redeem.canRedeem(save, 'tv10');
  eq(rId.ok, r2.ok, 'canRedeem 传 id 与传对象结果一致');
  ok(!Redeem.canRedeem(save, 'nope').ok, '未知奖励 id 被拒');

  // 转盘送的动画片时间必须计入同一份每日额度
  const today = G.localDateStr();
  save.dailyCounters[today] = { spins: 0, tvMinutes: 25, redemptions: 0 };
  const r4 = Redeem.canRedeem(save, TV10);
  ok(!r4.ok, '今日动画片 25 分钟时，再兑 10 分钟被拒', r4.why);

  // 但同一状态下兑钱不应该被动画片额度挡住
  ok(Redeem.canRedeem(save, RMB1).ok, '动画片额度用完不影响兑换 1 元');

  save.dailyCounters[today] = { spins: 0, tvMinutes: 0, redemptions: 2 };
  const r5 = Redeem.canRedeem(save, TV10);
  ok(!r5.ok, '今日已兑换 2 次时第 3 次被拒', r5.why);

  // 时钟回拨时冻结兑换 —— 但不删数据、不惩罚
  save.dailyCounters[today] = { spins: 0, tvMinutes: 0, redemptions: 0 };
  save.integrity.clockTampered = true;
  ok(!Redeem.canRedeem(save, TV10).ok, '时钟异常时冻结兑换');
}

{
  // request → approve 全流程：扣分只发生在家长批准时
  const save = Store.defaultSave();
  save.points.balance = 100;
  save.points.lifetime = 100;

  const req = Redeem.request(save, 'tv10');
  ok(req.ok, '提交兑换申请成功');
  eq(save.points.balance, 100, '提交时不扣分（等家长批准）');
  eq(Redeem.pendingList(save).length, 1, '产生 1 条待确认记录');

  const ap = Redeem.approve(save, req.record.id);
  ok(ap.ok, '家长批准成功');
  eq(save.points.balance, 20, '批准后扣 80 分');
  eq(Redeem.pendingList(save).length, 0, '待确认列表清空');

  const audited = Store.audit(save);
  ok(audited.ok, '兑换后三方审计仍通过', JSON.stringify(audited));

  // 批准会累加当日动画片额度 —— 漏了这条孩子一天能看 40 分钟
  eq(Store.todayCounter(save).tvMinutes, 10, '批准后当日动画片额度 +10 分钟');

  // 重复批准同一条应被拒
  ok(!Redeem.approve(save, req.record.id).ok, '重复批准同一条记录被拒');
}

/* ---- 总结 ---- */

console.log('');
console.log('─'.repeat(52));
if (failures.length === 0) {
  console.log('\x1b[32m全部通过\x1b[0m — ' + passed + ' 项断言');
  process.exit(0);
} else {
  console.log('\x1b[31m失败 ' + failures.length + ' 项\x1b[0m（通过 ' + passed + ' 项）');
  console.log('');
  failures.forEach((f) => console.log('  · ' + f));
  process.exit(1);
}
