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
    chinese: read('chinese.json'),
    zibiao: read('zi_grade12.json'),
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
  if (!D || !D.chinese || !D.zibiao) {
    console.log('\x1b[31m产物里没有 G.DATA.chinese / G.DATA.zibiao\x1b[0m');
    process.exit(1);
  }
  data = { chinese: D.chinese, zibiao: D.zibiao };
  console.log('内联题库：识字 ' + data.chinese.length + ' 道 · 字表 ' +
              data.zibiao.chars.length + ' 字');
  console.log('内联音频：' + Object.keys(G.AUDIO_MAP || {}).length + ' 条');
} else {
  data = loadData(sandbox);
}

/* ---- 1. 核心工具 ---- */
section('1. 核心工具（00-core.js）');
ok(!!G, 'G 命名空间存在');
eq(G.PRIZES.reduce((s, p) => s + p.weight, 0), 100, '转盘权重总和 = 100');
eq(G.DEFAULT_MIX.chinese, G.ROUND_SIZE, '一局题数 = 10');
eq(G.SUBJECTS.join(','), 'chinese', '只有识字一科');

{
  // 空奖必须是真空白：不重转、不兜底送分，也不带任何「再来一次」的痕迹
  const none = G.PRIZES.filter((p) => p.kind === 'none');
  eq(none.length, 1, '有且只有一个空奖项');
  eq(none[0].points, 0, '空奖不给分');
  ok(!/再来/.test(none[0].label), '盘面上的空奖不写「再来一次」', none[0].label);
  ok(/无奖励/.test(G.NO_PRIZE_TEXT), '结算条写明无奖励', G.NO_PRIZE_TEXT);
  ok(!('maxRespinsPerQuestion' in G.LIMITS), '重转次数上限已从 limits 移除');
}

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
  ok(!!save.progress.chinese.byTag, 'progress 里只有识字一科的统计');
  ok(save.settings.englishUnlockedThrough === undefined, '英语解锁设置已移除');
  ok(!!save.limits && save.limits.maxPointsPerDay > 0, 'limits 已初始化');

  Store.save(save);
  const back = Store.load();
  eq(back.points.balance, save.points.balance, '存档写入后能读回');
  eq(back.settings.mix.chinese, G.DEFAULT_MIX.chinese, '设置项持久化');
}

{
  // 老存档（三科时代）读进来不能崩：progress 是嵌套的，浅拷贝补不到里层
  const legacy = Store.defaultSave();
  legacy.progress = { english: { familyStats: {}, typeStats: {} } };
  legacy.settings.englishUnlockedThrough = 'U8';
  Store._setCache(null);
  Store.save(legacy);

  const raw = JSON.parse(sandbox.localStorage.getItem(Store.KEY));
  ok(raw.progress.chinese === undefined, '（构造出一份没有识字统计的老存档）');

  const loaded = Store.load();
  ok(!!loaded.progress.chinese.byTag, '老存档读入后补上了 progress.chinese.byTag');
  Store._setCache(null);
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

/* ---- 3. 字表与题库 ---- */
section('3. 字表与题库（30-bank.js）');
const Bank = G.Bank;
ok(!!Bank, 'G.Bank 存在');
Bank.init(data);

// 选项里出现的是偏旁而不是汉字的题型，字表范围检查对它们豁免
const RADICAL_TAGS = new Set(['部首', '偏旁']);

const ZI = Bank.zibiao();
ok(!!ZI && Array.isArray(ZI.chars), '字表已载入');
ok(ZI.chars.length > 0, '字表非空', ZI.chars.length + ' 字');

{
  const all = Bank.all();
  eq(all.length, data.chinese.length, 'Bank.all() 与题库等长');
  ok(all.length <= 300, '题量在上限 300 以内', all.length + ' 道');

  const chars = new Set(ZI.chars.map((c) => c.char));
  eq(chars.size, ZI.chars.length, '字表内没有重复的字');

  const grades = new Set(ZI.chars.map((c) => c.grade));
  ok([...grades].every((g) => g === 1 || g === 2), '字表只含一、二年级', [...grades].join(','));

  // 字表每一条都要有拼音，否则看拼音选字会指向空气。
  // 拼音带声调符号（yī、wàn）而不是数字 —— 那是给孩子看的。
  // 判定方式：把声调符号规范化掉之后，剩下的应该全是 a-z。
  const hasPinyin = (c) => {
    if (!c.pinyin) return false;
    const bare = c.pinyin.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return /^[a-z]+$/.test(bare);
  };
  const noPinyin = ZI.chars.filter((c) => !hasPinyin(c));
  ok(noPinyin.length === 0, '每个字都有合法拼音',
     noPinyin.slice(0, 3).map((c) => c.char + '=' + c.pinyin).join(' '));
}

{
  // 题库的结构约束。生成器（gen_ziku.py）已经断言过一遍，这里是拿**实际
  // 落到产物里的字节**再验一次 —— 生成器和构建之间还有一道序列化。
  const all = Bank.all();
  const problems = [];
  const ids = new Set();
  const byTag = {};

  all.forEach((q) => {
    if (ids.has(q.id)) problems.push(q.id + '：id 重复');
    ids.add(q.id);

    if (q.subject !== 'chinese') problems.push(q.id + '：subject=' + q.subject);
    if (q.type !== 'choice') problems.push(q.id + '：type=' + q.type);
    if (!q.options || q.options.length !== 4) problems.push(q.id + '：选项不是 4 个');

    const optIds = (q.options || []).map((o) => o.id);
    if (new Set(optIds).size !== optIds.length) problems.push(q.id + '：选项 id 重复');
    if (optIds.indexOf(q.answer) < 0) problems.push(q.id + '：answer 不在选项里');

    const texts = (q.options || []).map((o) => o.text);
    if (new Set(texts).size !== texts.length) problems.push(q.id + '：选项内容重复 ' + texts.join('/'));

    if (!q.explain) problems.push(q.id + '：缺少 explain');
    if (!q.stem || !q.stem.text) problems.push(q.id + '：缺少题干文本');

    const tag = (q.tags || [])[0];
    if (!tag) problems.push(q.id + '：缺少 tags');
    else byTag[tag] = (byTag[tag] || 0) + 1;
  });

  const uniq = [...new Set(problems)];
  ok(uniq.length === 0, all.length + ' 道题结构自洽', uniq.slice(0, 4).join(' | '));
  console.log('    \x1b[90m' + Object.keys(byTag).sort()
    .map((t) => t + '(' + byTag[t] + ')').join('  ') + '\x1b[0m');

  eq(Object.keys(byTag).length, 8, '覆盖 8 种题型');
}

{
  // 「字的范围」—— 这是需求里唯一一条能被机器验证的约束，也是最容易
  // 悄悄破掉的一条：干扰项里混进三年级的字，孩子照样能玩，没人会发现。
  const chars = new Set(ZI.chars.map((c) => c.char));
  const offenders = [];

  Bank.all().forEach((q) => {
    if (RADICAL_TAGS.has((q.tags || [])[0])) return;
    (q.options || []).forEach((o) => {
      for (const c of (o.text || '')) {
        if (c >= '一' && c <= '鿿' && !chars.has(c)) {
          offenders.push(q.id + ' 的选项「' + o.text + '」含表外字「' + c + '」');
        }
      }
    });
  });

  ok(offenders.length === 0, '所有选项里的汉字都在字表内',
     offenders.slice(0, 3).join(' | '));

  // 答案本身也必须表内 —— 上一条只查了选项，这条独立复核。
  // 部首题的答案是偏旁（亻 氵 讠），它们落在汉字码位里但不是能单独用的字，
  // 同样豁免。
  const outside = Bank.all().filter((q) => {
    if (RADICAL_TAGS.has((q.tags || [])[0])) return false;
    const opt = (q.options || []).filter((o) => o.id === q.answer)[0];
    const t = ((opt && opt.text) || '').trim();
    return t.length === 1 && t >= '一' && t <= '鿿' && !chars.has(t);
  });
  ok(outside.length === 0, '所有「答案是一个字」的题，那个字都在字表内',
     outside.slice(0, 3).map((q) => q.id).join(' '));
}

/* ---- 4. 抽题权重 ---- */
section('4. 加权抽题（Bank.drawOne）');
{
  const q0 = Bank.all()[0];
  const save = Store.defaultSave();

  eq(Bank.weightOf(q0, {}), 1, '没做过的题权重 = 1');
  ok(Bank.weightOf(q0, { [q0.id]: { wrongCount: 3, cleared: false } }) > 1,
     '错过的题权重更高');
  ok(Bank.weightOf(q0, { [q0.id]: { wrongCount: 3, cleared: true } }) < 1,
     '连对两次后权重降低');
}

{
  // 抽题分布：给 40 道题记上错题，它们出现的频率应当明显高于其余 256 道
  const all = Bank.all();
  const marked = all.slice(0, 40);
  const save = Store.defaultSave();
  marked.forEach((q, i) => {
    save.wrongBook.push({
      qid: q.id, subject: 'chinese', seen: 1, correct: 0,
      wrongCount: 1 + (i % 2), rightStreak: 0, lastWrongAt: Date.now(), cleared: false,
    });
  });

  const rng = G.rngFrom('draw-dist');
  const tally = {};
  const N = 40000;
  for (let i = 0; i < N; i++) {
    const q = Bank.drawOne(save, [], rng);
    tally[q.id] = (tally[q.id] || 0) + 1;
  }

  const markedIds = new Set(marked.map((q) => q.id));
  let markedHits = 0;
  Object.keys(tally).forEach((id) => { if (markedIds.has(id)) markedHits += tally[id]; });
  const markedRate = markedHits / N;
  const fairRate = marked.length / all.length;   // 均匀随机下应得的比例

  ok(markedRate > fairRate * 1.8, '错题被抽中的频率明显高于均匀随机',
     (markedRate * 100).toFixed(1) + '% vs 均匀 ' + (fairRate * 100).toFixed(1) + '%');

  // 权重不是「只出错题」—— 没做过的题仍然占大头，否则孩子一开局就被
  // 历史错题淹没，会觉得这个游戏变难了
  ok(markedRate < 0.6, '错题没有淹没题库', (markedRate * 100).toFixed(1) + '%');
}

{
  const save = Store.defaultSave();
  const rng = G.rngFrom('draw-exclude');
  const used = Bank.all().slice(0, 50).map((q) => q.id);
  let bad = 0;
  for (let i = 0; i < 3000; i++) {
    const q = Bank.drawOne(save, used, rng);
    if (used.indexOf(q.id) >= 0) bad++;
  }
  eq(bad, 0, 'excludeIds 内的题不会被抽到');

  // 题库被抽空时不能崩，也不能返回 null
  const allIds = Bank.all().map((q) => q.id);
  const q2 = Bank.drawOne(save, allIds, G.rngFrom('draw-empty'));
  ok(!!q2 && allIds.indexOf(q2.id) >= 0, '题库被抽空时兜底返回一道题');

  eq(Bank.byId(allIds[0]).id, allIds[0], 'byId 能查到题');
  eq(Bank.byId('不存在'), null, 'byId 查不到时返回 null');
}

/* ---- 5. 一局编排 ---- */
section('5. 一局编排（40-runner.js）');
const Runner = G.Runner;
ok(!!Runner, 'G.Runner 存在');
ok(typeof Runner.buildRound === 'function', 'buildRound 是函数');

{
  const problems = [];
  let rounds = 0;
  let tagAdjacent = 0, tagPairs = 0;
  let baseAdjacent = 0, basePairs = 0;   // 同一批题随机打散的对照

  for (let i = 0; i < 60; i++) {
    const save = Store.defaultSave();
    // 造一点历史：每局都有几道题做错过
    Bank.all().slice(i * 7, i * 7 + 5).forEach((q) => {
      save.wrongBook.push({
        qid: q.id, subject: 'chinese', seen: 2, correct: 0,
        wrongCount: 2, rightStreak: 0, lastWrongAt: Date.now(), cleared: false,
      });
    });

    let round;
    try {
      round = Runner.buildRound(save);
    } catch (e) {
      problems.push('第 ' + i + ' 局抛异常：' + e.message);
      continue;
    }
    rounds++;

    const items = round.questions;
    if (!Array.isArray(items)) { problems.push('buildRound 没返回 questions 数组'); continue; }
    if (items.length !== 10) { problems.push('第 ' + i + ' 局题数 = ' + items.length); continue; }

    const seen = new Set();
    items.forEach((q, idx) => {
      if (!q || !q.id) { problems.push('第 ' + i + ' 局第 ' + idx + ' 题没有 id'); return; }
      if (q.subject !== 'chinese') problems.push('第 ' + i + ' 局第 ' + idx + ' 题不是识字题');
      if (seen.has(q.id)) problems.push('第 ' + i + ' 局出现重复题 ' + q.id);
      seen.add(q.id);

      // 位置软约束：首尾必须是这一局里最可能答对的两道
      const prob = Runner.successProb(q, save);
      if (idx > 0 && idx < 9 && prob > Runner.successProb(items[9], save) + 1e-9) {
        problems.push('第 ' + i + ' 局中间题的成功率高于末题');
      }
    });

    const p0 = Runner.successProb(items[0], save);
    const p9 = Runner.successProb(items[9], save);
    const midMax = Math.max(...items.slice(1, 9).map((q) => Runner.successProb(q, save)));
    if (Math.min(p0, p9) < midMax - 1e-9) {
      problems.push('第 ' + i + ' 局首/末题不是成功率最高的两道');
    }

    for (let k = 1; k < items.length; k++) {
      tagPairs++;
      const a = (items[k - 1].tags || [])[0], b = (items[k].tags || [])[0];
      if (a === b) tagAdjacent++;
    }

    // 对照：同样这 10 道题，单纯打散会怎样。题型分布很不均（看拼音选字
    // 占三分之一），所以对照不能假设「8 种题型各 1/8」。
    const ctrl = G.shuffle(items.slice(), G.rngFrom('ctrl-' + i));
    for (let k = 1; k < ctrl.length; k++) {
      basePairs++;
      const a = (ctrl[k - 1].tags || [])[0], b = (ctrl[k].tags || [])[0];
      if (a === b) baseAdjacent++;
    }
  }

  const uniq = [...new Set(problems)];
  ok(rounds === 60, '60 局全部构建成功', '成功 ' + rounds + ' 局');
  ok(uniq.length === 0, '60 局均为 10 道不重复的识字题，且首尾留给最有把握的题',
     uniq.slice(0, 4).join(' | '));

  // 同一题型不挨着。orderByTag 是软约束，不要求做到 0，
  // 但必须比「原样打散」明显好 —— 拿同一批题的随机排列当对照。
  const rate = tagAdjacent / tagPairs;
  const base = baseAdjacent / basePairs;
  ok(rate < base * 0.4, '同题型相邻的比例远低于随机排列',
     (rate * 100).toFixed(1) + '% vs 随机 ' + (base * 100).toFixed(1) + '%');
}

{
  // 答题结算写进存档的哪几个字段
  const save = Store.defaultSave();
  const q = Bank.all()[0];

  const rec = Runner.recordAnswer(save, q, false, 1200);
  eq(rec.wrongCount, 1, '答错记进错题本');
  ok(!rec.cleared, '答错后未标记为已掌握');

  Runner.recordAnswer(save, q, true, 900);
  Runner.recordAnswer(save, q, true, 800);
  eq(rec.rightStreak, 2, '连对两次');
  ok(rec.cleared, '连对两次才算真会了');

  const tag = (q.tags || [])[0];
  ok(save.progress.chinese.byTag[tag], '按题型统计已写入 progress.chinese.byTag');
  eq(save.progress.chinese.byTag[tag].seen, 3, '题型统计记了 3 次');
  eq(save.progress.chinese.byTag[tag].correct, 2, '其中答对 2 次');
}

{
  // 积分与每日上限
  const save = Store.defaultSave();
  eq(Runner.awardPoints(save, 5).awarded, 5, '正常得分全额入账');
  eq(save.points.balance, 5, '余额跟着涨');
  eq(save.points.lifetime, 5, '累计积分跟着涨');

  eq(Runner.awardPoints(save, 0).awarded, 0, '空奖入账 0 分');

  const r = Runner.awardPoints(save, 999);
  eq(r.awarded, save.limits.maxPointsPerDay - 5, '单日得分封顶在 maxPointsPerDay');
  ok(r.capped, '触顶时标记 capped');
  eq(save.points.balance, save.limits.maxPointsPerDay, '封顶后余额 = 每日上限');
}

{
  // 一局的存档记录：sessions 里要能看到这一局的题和转盘结果
  const save = Store.defaultSave();
  const round = Runner.buildRound(save);
  const items = round.questions.slice(0, 10).map((q) => ({ qid: q.id, correct: true, ms: 900 }));
  const session = Runner.finishSession(save, round, items, [{ prize: 'none', ts: Date.now() }], 0);

  eq(save.sessions.length, 1, 'sessions 里多了一条');
  eq(session.correct, 10, '本局 10 题全对');
  eq(session.pointsEarned, 0, '空奖一局的得分为 0');
  ok(save.sessions[0].spins.length === 1, '转盘结果一并存档');

  // 只保留最近 30 局
  for (let i = 0; i < 40; i++) Runner.finishSession(save, round, items, [], 0);
  eq(save.sessions.length, 30, 'sessions 滚动保留最近 30 局');
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
