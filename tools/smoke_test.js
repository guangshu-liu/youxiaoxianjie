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
    // className 和 classList 必须是**同一份数据**。真实的 DOM 里
    // `el.className = 'a b'` 之后 `el.classList.contains('a')` 就是 true；
    // G.el 正是用 className 赋值的。早先这个桩让 classList 自己抱一个 Set，
    // className 写进去的类名 classList 永远看不见 —— 渲染器的断言会静默地
    // 「通过」得毫无意义。下面用一对访问器把两者接到同一个 Set 上。
    get className() { return [...this.classList._s].join(' '); },
    set className(v) { this.classList._s = new Set(String(v || '').split(/\s+/).filter(Boolean)); },
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
    // 记下来而不是丢掉：渲染器把「点了选项之后会发生什么」全写在 handler 里，
    // 不记就测不到那一段（喇叭按钮答完才放出来、解释条答错才显示）。
    _listeners: {},
    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const l = this._listeners[type];
      if (l) this._listeners[type] = l.filter((f) => f !== fn);
    },
    dispatch(type) {
      (this._listeners[type] || []).slice().forEach((fn) => fn({ type, target: this }));
    },
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
    createTextNode: (t) => {
      const n = makeElement('#text');
      n.nodeValue = t;
      n.textContent = t;
      return n;
    },
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

// 只加载能在无头环境里真实执行的模块。主循环（70/90/99）依赖大量
// 浏览器 API，跑它们只会得到假阳性 —— 那些留给真机。
//
// 41-render-choice.js 曾经也在这个名单外，理由是「渲染器离不开 DOM」。
// 但渲染器真正的风险不是崩溃，是**该画的东西没画出来**（stem.audio 那条
// if/else if 让英语题的文字题干全都不显示，就是这么漏的）。桩只要
// 把 className/classList 和事件监听做真，这一整类 bug 是能在无头环境里
// 抓住的，所以 41 加进来了。
const LOGIC = /^(00|05|10|20|21|30|40|41|50|60)0?-|^(00|10|20|21|30|40|41|50|60)-/;

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
  const d = { zibiao: read('zi_grade1.json') };
  // 三科按目录里实际存在的文件读 —— 写死三个名字的话，加一科要改两处，
  // 而漏改的那处表现成「新科目题库是空的」，不是「测试报错」。
  fs.readdirSync(dir).filter((f) => f.endsWith('.json')).forEach((f) => {
    const name = f.replace(/\.json$/, '');
    if (name === 'zi_grade1' || name === 'english_audio') return;
    d[name] = read(f);
  });
  return d;
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
  if (!D || !D.zibiao || !D.chinese || !D.math || !D.english) {
    console.log('\x1b[31m产物里没有 G.DATA 的三科题库 / 字表\x1b[0m');
    process.exit(1);
  }
  data = D;
  console.log('内联题库：' + G.SUBJECTS.map((s) => D[s].length).join(' / ') +
              ' 道（' + G.SUBJECTS.join(' · ') + '）· 字表 ' + D.zibiao.chars.length + ' 字');
  console.log('内联音频：' + Object.keys(G.AUDIO_MAP || {}).length + ' 条');
} else {
  data = loadData(sandbox);
}

// 配比是 build.py 从 qbank.py 的 SUBJECT_MIX 内联进来的（G.DATA.mix）。
// 源码模式下 src/data/ 里没有这个值，G.DATA 也没人赋值，跑的是
// 00-core.js 里的兜底配比 —— 兜底值和真值本来就该一致，下面第 1 节
// 会直接断言这一点，所以源码模式仍然测得到配比是否漂移。
if (!fromBuild) G.applyMix((G.DATA && G.DATA.mix) || null);

/* ---- 8. 选择题渲染 ---- */
/* 放在最后：这一段会调用渲染器，桩上的事件监听/类名会被真实写入，
 * 前面那些纯数据断言不该受影响。 */
function testRenderer() {
  section('8. 选择题渲染（41-render-choice.js）');

  // 源码模式下 G.DATA 没有三科题库（build.py 才把它内联进产物），
  // 所以统一从 src/data 读 —— 两种模式测的是同一份题。
  const dir = path.join(SRC, 'data');
  const all = [];
  ['chinese', 'math', 'english'].forEach((s) => {
    const f = path.join(dir, s + '.json');
    if (fs.existsSync(f)) all.push(...JSON.parse(fs.readFileSync(f, 'utf8')));
  });
  if (!all.length) { ok(false, '题库为空，渲染器测不了'); return; }

  /** 渲染一道题，返回根节点和全部后代。 */
  function render(q) {
    const root = makeElement('div');
    G.Renderers.choice(root, q, { onAnswer() {} });
    const nodes = [];
    (function walk(n) { nodes.push(n); n.children.forEach(walk); })(root);
    return { root, nodes, of: (c) => nodes.filter((n) => n.classList.contains(c)) };
  }

  const withAudio = all.filter((q) => q.stem && q.stem.audio);
  const silent = all.filter((q) => !(q.stem && q.stem.audio));
  // 只有听音题才带音频。英语改版后听音题从「听音选字母」一种扩到三种
  // （OPW1 听音选字母 / OPW2 听音选词 / 辨短元音），题数写死 70 会挡住
  // 正常的内容更新，所以这里改成按题型反推。
  const AUDIO_TAGS = ['听音选字母', '听音选词', '辨短元音'];
  const listenQs = all.filter((q) => AUDIO_TAGS.indexOf((q.tags || [])[0]) >= 0);
  ok(listenQs.length > 0, '题库里有听音题', listenQs.length + ' 道');
  ok(withAudio.length === listenQs.length,
     '带音频的题正好是三种听音题（' + listenQs.length + ' 道）',
     '带音频 ' + withAudio.length);
  ok(listenQs.every((q) => !!(q.stem && q.stem.audio)),
     '每道听音题都有音频（不然那道题全部信息都没了）');
  ok(withAudio.every((q) => AUDIO_TAGS.indexOf((q.tags || [])[0]) >= 0),
     '拼合 / 归类 / 找真词不带音频（音频会念出答案）');

  // ---- 带音频的题：题干文字必须渲染出来 ----
  // 这里曾经是 if (audio) … else if (text) …，英语题的文字题干全都不显示，
  // 只留下一个没有说明的喇叭，孩子不知道要他干什么。
  let noText = [], noSpeaker = [], hiddenSpk = [];
  withAudio.forEach((q) => {
    const r = render(q);
    if (!r.of('stem-text').length) noText.push(q.id);
    const spk = r.of('speaker')[0];
    if (!spk) { noSpeaker.push(q.id); return; }
    // 听音题的音频念的就是这道题要听的东西，答题前就该能点 —— 藏起来的话
    // 这道题就没有任何信息了。
    if (spk.classList.contains('hidden')) hiddenSpk.push(q.id);
  });

  eq(noText.length, 0, '带音频的题，题干文字都渲染出来了', noText.slice(0, 4).join(' '));
  eq(noSpeaker.length, 0, '带音频的题都有喇叭按钮', noSpeaker.slice(0, 4).join(' '));
  eq(hiddenSpk.length, 0, '听音题的喇叭答题前就能点', hiddenSpk.slice(0, 4).join(' '));

  // ---- 答错时解释条要出来 ----
  {
    const q = withAudio[0];
    const r = render(q);
    const wrong = r.nodes.find((n) => n.classList.contains('option')
      && n.getAttribute('data-id') !== q.answer);
    ok(!!wrong, '选项按钮上挂着 click 处理器');
    if (wrong) {
      wrong.dispatch('click');
      ok(r.of('explain').some((n) => !n.classList.contains('hidden')),
         '答错时解释条显示出来');
    }
  }

  // ---- 没有音频的题不该凭空多一个喇叭 ----
  let straySpeaker = 0;
  silent.forEach((q) => { if (render(q).of('speaker').length) straySpeaker++; });
  eq(straySpeaker, 0, '没有音频的题不会出现喇叭按钮');
}

/* ---- 1. 核心工具 ---- */
section('1. 核心工具（00-core.js）');
ok(!!G, 'G 命名空间存在');
eq(G.PRIZES.reduce((s, p) => s + p.weight, 0), 100, '转盘权重总和 = 100');
eq(G.SUBJECTS.join(','), 'chinese,math,english', '三科：语文 / 数学 / 英语');
eq(G.ROUND_SIZE, 10, '一局题数 = 10');
eq(G.sum(G.SUBJECTS.map((s) => G.DEFAULT_MIX[s])), G.ROUND_SIZE, '一局题数 = 三科配额之和');
eq(G.SUBJECTS.map((s) => G.DEFAULT_MIX[s]).join(':'), '3:3:4', '一局构成 3:3:4');

{
  // 盘面上的奖名。六个扇区的角度差 6 倍（18°~108°），完整说法在窄扇区里
  // 排不下，所以每个奖项都要有 face（盘面用）和 label（结算条用）两份文字。
  const noFace = G.PRIZES.filter((p) => !p.face);
  ok(noFace.length === 0, '每个奖项都有盘面文字 face',
     noFace.map((p) => p.id).join(' '));

  // face 是给盘面用的，必须比 label 短 —— 不然盘面上还是排不下。
  // 最窄的扇区在标签半径处只有不到 30px 弧长，超过 6 个字的都危险。
  const tooLong = G.PRIZES.filter((p) => p.face.replace(/[^一-鿿0-9]/g, '').length > 5);
  ok(tooLong.length === 0, '盘面文字都够短（≤5 个汉字/数字）',
     tooLong.map((p) => p.id + '=' + p.face).join(' '));
}

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
  G.SUBJECTS.forEach((s) => {
    ok(!!(save.progress[s] && save.progress[s].byTag), 'progress 里有 ' + s + ' 的题型统计');
  });
  ok(save.settings.englishUnlockedThrough === undefined, '英语解锁设置已移除');
  ok(!!save.limits && save.limits.maxPointsPerDay > 0, 'limits 已初始化');

  // 配比不存档。它是 tools/qbank.py 的 SUBJECT_MIX，经 build.py 内联成
  // G.DATA.mix。存档里再存一份，就会出现「改了配比，老用户还是旧配比」。
  ok(save.settings.mix === undefined, '配比不再存进 settings');

  Store.save(save);
  const back = Store.load();
  eq(back.points.balance, save.points.balance, '存档写入后能读回');
  eq(back.settings.audioEnabled, true, '设置项持久化');
}

{
  // 老存档（识字一科时代，或者更早的三科时代）读进来不能崩：
  // progress 是嵌套的，上面那层浅拷贝补不到里层。
  const legacy = Store.defaultSave();
  legacy.progress = { chinese: { byTag: { 归类: { seen: 3, correct: 2 } } } };
  legacy.settings.englishUnlockedThrough = 'U8';
  Store._setCache(null);
  Store.save(legacy);

  const raw = JSON.parse(sandbox.localStorage.getItem(Store.KEY));
  ok(raw.progress.math === undefined, '（构造出一份缺数学/英语统计的老存档）');

  const loaded = Store.load();
  G.SUBJECTS.forEach((s) => {
    ok(!!loaded.progress[s].byTag, '老存档读入后补上了 progress.' + s + '.byTag');
  });
  // 补的时候不能把已有的统计冲掉
  eq(loaded.progress.chinese.byTag['归类'].seen, 3, '老存档里已有的统计没有被覆盖');
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
  const sum = G.SUBJECTS.reduce((n, s) => n + data[s].length, 0);
  eq(all.length, sum, 'Bank.all() 与三科题库总和等长');
  ok(all.length <= 600, '题量在上限 600 以内', all.length + ' 道');

  // 三科等量：各 200 道。
  // 注意这和「一局 3:3:4」是两件事 —— 题库配比是等量的，一局的构成
  // 仍然由 G.DEFAULT_MIX 决定（见下面单独一条）。
  const want = { chinese: 200, math: 200, english: 200 };
  G.SUBJECTS.forEach((s) => {
    ok(data[s].length === want[s],
       s + ' 题量 ' + want[s] + ' 道', data[s].length + ' 道');
  });

  const chars = new Set(ZI.chars.map((c) => c.char));
  eq(chars.size, ZI.chars.length, '字表内没有重复的字');

  // 字表是「一年级」的 —— 需求第 1 条把范围从一二年级收到了小学一年级。
  // 这条如果破了，超纲的字会静默混进选项，靠人是查不出来的。
  const grades = new Set(ZI.chars.map((c) => c.grade));
  ok([...grades].every((g) => g === 1), '字表只含一年级', [...grades].join(','));
  ok(ZI.chars.every((c) => c.grade !== undefined), '字表每一条都标了年级（不然上面那条是空的）');

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
  // 题库的结构约束。三个生成器（gen_ziku / gen_shuxue / gen_yingyu）各自
  // 已经断言过一遍，这里是拿**实际落到产物里的字节**再验一次 ——
  // 生成器和构建之间还有一道序列化，而序列化是会丢字段的。
  const all = Bank.all();
  const problems = [];
  const ids = new Set();
  const bySubjectTag = {};

  all.forEach((q) => {
    if (ids.has(q.id)) problems.push(q.id + '：id 重复');
    ids.add(q.id);

    if (G.SUBJECTS.indexOf(q.subject) < 0) problems.push(q.id + '：subject=' + q.subject);
    if (q.type !== 'choice') problems.push(q.id + '：type=' + q.type);
    if (!q.options || q.options.length !== 4) problems.push(q.id + '：选项不是 4 个');

    const optIds = (q.options || []).map((o) => o.id);
    if (new Set(optIds).size !== optIds.length) problems.push(q.id + '：选项 id 重复');
    if (optIds.indexOf(q.answer) < 0) problems.push(q.id + '：answer 不在选项里');

    const texts = (q.options || []).map((o) => o.text);
    if (new Set(texts).size !== texts.length) problems.push(q.id + '：选项内容重复 ' + texts.join('/'));

    if (!q.explain) problems.push(q.id + '：缺少 explain');
    if (!q.stem || (!q.stem.text && !q.stem.audio)) problems.push(q.id + '：题干既没有文字也没有音频');
    // 渲染器把题干文字和喇叭按钮都画出来，所以只有音频的题干会变成
    // 一个没有说明的喇叭。这一条曾经漏掉了英语题的文字题干。
    if (q.stem && q.stem.audio && !q.stem.text) problems.push(q.id + '：有音频却没有文字题干');
    // 布局必须显式写出来：渲染器给根节点挂 q-layout-<layout>，
    // 缺了会挂上 q-layout-undefined，CSS 里就没有任何一条规则命中。
    if (!q.stem || !q.stem.layout) problems.push(q.id + '：题干缺少 layout');

    const tag = (q.tags || [])[0];
    if (!tag) problems.push(q.id + '：缺少 tags');
    else {
      const k = q.subject + '/' + tag;
      bySubjectTag[k] = (bySubjectTag[k] || 0) + 1;
    }
  });

  const uniq = [...new Set(problems)];
  ok(uniq.length === 0, all.length + ' 道题结构自洽', uniq.slice(0, 4).join(' | '));
  console.log('    \x1b[90m' + Object.keys(bySubjectTag).sort()
    .map((t) => t + '(' + bySubjectTag[t] + ')').join('  ') + '\x1b[0m');

  // 每科至少要有 4 种题型。类型太单一的话，一局里同科的 3~4 道题
  // 会长得一模一样，孩子会觉得「怎么又是这种」。
  G.SUBJECTS.forEach((s) => {
    const tags = Object.keys(bySubjectTag).filter((k) => k.indexOf(s + '/') === 0);
    ok(tags.length >= 4, s + ' 覆盖至少 4 种题型', tags.length + ' 种：' + tags.join(' '));
  });
}

{
  // ---- 拼音只允许出现在拼音题里 ----
  // 上一版是「全库禁拼音」。一年级上册第一单元就是拼音，幼小衔接绕不开，
  // 所以现在放开两类题（看拼音选字 / 声母韵母）。其余题型仍然一个字都
  // 不许有 —— 字形题混进拼音，孩子做的就不是同一件事了。
  const LATIN = /[A-Za-zÀ-ɏḀ-ỿ]/;
  const PINYIN_TAGS = new Set(['看拼音选字', '声母韵母']);
  const withPinyin = [];
  Bank.all().forEach((q) => {
    if (q.subject === 'english') return;
    if (PINYIN_TAGS.has((q.tags || [])[0])) return;
    const parts = [q.stem && q.stem.text, q.explain]
      .concat((q.options || []).map((o) => o.text));
    parts.forEach((t) => {
      if (t && LATIN.test(t)) withPinyin.push(q.id + '：' + t);
    });
  });
  ok(withPinyin.length === 0, '拼音只出现在拼音题里',
     withPinyin.slice(0, 4).join(' | '));

  // 反过来：拼音题必须真的有拼音，否则那两类等于白设。
  const pinyinQs = Bank.all().filter((q) => PINYIN_TAGS.has((q.tags || [])[0]));
  ok(pinyinQs.length > 0, '存在拼音题', pinyinQs.length + ' 道');
}

{
  // 「字的范围」—— 这是需求里唯一一条能被机器验证的约束，也是最容易
  // 悄悄破掉的一条：干扰项里混进三年级的字，孩子照样能玩，没人会发现。
  const chars = new Set(ZI.chars.map((c) => c.char));
  const offenders = [];

  // 只管语文。数学的选项是数字、英语的是单词，都不受字表约束。
  Bank.of('chinese').forEach((q) => {
    if (RADICAL_TAGS.has((q.tags || [])[0])) return;
    (q.options || []).forEach((o) => {
      for (const c of (o.text || '')) {
        if (c >= '一' && c <= '鿿' && !chars.has(c)) {
          offenders.push(q.id + ' 的选项「' + o.text + '」含表外字「' + c + '」');
        }
      }
    });
  });

  ok(offenders.length === 0, '语文所有选项里的汉字都在字表内',
     offenders.slice(0, 3).join(' | '));

  // 答案本身也必须表内 —— 上一条只查了选项，这条独立复核。
  // 部首题的答案是偏旁（亻 氵 讠），它们落在汉字码位里但不是能单独用的字，
  // 同样豁免。
  const outside = Bank.of('chinese').filter((q) => {
    if (RADICAL_TAGS.has((q.tags || [])[0])) return false;
    const opt = (q.options || []).filter((o) => o.id === q.answer)[0];
    const t = ((opt && opt.text) || '').trim();
    return t.length === 1 && t >= '一' && t <= '鿿' && !chars.has(t);
  });
  ok(outside.length === 0, '语文所有「答案是一个字」的题，那个字都在字表内',
     outside.slice(0, 3).map((q) => q.id).join(' '));
}

{
  // ---- 英语的语音引用 ----
  // 三种听音题的题干都带一段语音；audio id 指向 G.AUDIO_MAP 里的一条文件。
  // id 写错的话，题目能正常显示、选项也能选，只是**永远没有声音** ——
  // 而那道题的全部信息都在声音里。这是最典型的「静默失败」。
  const audio = Object.keys((G.DATA && G.DATA.audioMap) || G.AUDIO_MAP || {});
  const hasMap = audio.length > 0;
  const refs = [];
  const LISTEN_TAGS = ['听音选字母', '听音选词', '辨短元音'];
  Bank.of('english').forEach((q) => {
    const id = q.stem && q.stem.audio;
    if (id) refs.push([q.id, id]);
    else if (LISTEN_TAGS.indexOf((q.tags || [])[0]) >= 0) {
      ok(false, q.id + ' 是听音题却没有 stem.audio');
    }
  });

  ok(refs.length > 0, '英语有带语音的题', refs.length + ' 道');
  if (hasMap) {
    const missing = refs.filter(([, id]) => audio.indexOf(id) < 0);
    ok(missing.length === 0, '每道听音题的语音 id 都能在 AUDIO_MAP 里找到',
       missing.slice(0, 4).map(([q, a]) => q + '→' + a).join(' '));
  } else {
    console.log('    \x1b[90m（源码模式没有 G.AUDIO_MAP，跳过语音 id 存在性检查；' +
                '用 --from-build 跑才查得到）\x1b[0m');
  }
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
  // 抽题分布：给语文里一部分题记上错题，它们出现的频率应当明显高于其余。
  // 按科目抽，所以对照组也只在语文内部比。
  //
  // 错题数量按**真实错题本的规模**取（约 13.5%），不是随手取一个整数：
  // 如果标 40/90（44%），加权后的命中率会到 72%，看着像「错题淹没了题库」，
  // 但那是测试自己造的假数据造成的，不是抽题逻辑的问题。
  const pool = Bank.of('chinese');
  const marked = pool.slice(0, Math.round(pool.length * 0.135));
  const save = Store.defaultSave();
  // 本段测的是错题加权，不是难度选档。被标记的 27 道全是难度 2，
  // 新手存档会被门控挡住，所以先造一段全对历史放行全部题。
  save.sessions.push({
    items: Array.from({ length: 20 }, () => ({
      qid: pool[0].id, subject: 'chinese', correct: true,
    })),
  });
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
    const q = Bank.drawOne(save, 'chinese', [], rng);
    tally[q.id] = (tally[q.id] || 0) + 1;
  }

  const markedIds = new Set(marked.map((q) => q.id));
  let markedHits = 0;
  Object.keys(tally).forEach((id) => { if (markedIds.has(id)) markedHits += tally[id]; });
  const markedRate = markedHits / N;
  const fairRate = marked.length / pool.length;   // 均匀随机下应得的比例

  ok(markedRate > fairRate * 1.8, '错题被抽中的频率明显高于均匀随机',
     (markedRate * 100).toFixed(1) + '% vs 均匀 ' + (fairRate * 100).toFixed(1) + '%');

  // 权重不是「只出错题」—— 没做过的题仍然占大头，否则孩子一开局就被
  // 历史错题淹没，会觉得这个游戏变难了
  ok(markedRate < 0.6, '错题没有淹没题库', (markedRate * 100).toFixed(1) + '%');
}

{
  const save = Store.defaultSave();
  const rng = G.rngFrom('draw-exclude');

  // 按科目抽的核心保证：抽出来的题一定属于请求的那一科
  let wrongSubject = 0;
  for (let i = 0; i < 3000; i++) {
    G.SUBJECTS.forEach((s) => {
      if (Bank.drawOne(save, s, [], rng).subject !== s) wrongSubject++;
    });
  }
  eq(wrongSubject, 0, 'drawOne(s) 只会抽到 s 这一科的题');

  const used = Bank.of('chinese').slice(0, 50).map((q) => q.id);
  let bad = 0;
  for (let i = 0; i < 3000; i++) {
    const q = Bank.drawOne(save, 'chinese', used, rng);
    if (used.indexOf(q.id) >= 0) bad++;
  }
  eq(bad, 0, 'excludeIds 内的题不会被抽到');

  // 科目内被抽空时不能崩，也不能返回 null
  const allIds = Bank.of('chinese').map((q) => q.id);
  const q2 = Bank.drawOne(save, 'chinese', allIds, G.rngFrom('draw-empty'));
  ok(!!q2 && allIds.indexOf(q2.id) >= 0, '本科目被抽空时兜底返回一道题');

  eq(Bank.byId(allIds[0]).id, allIds[0], 'byId 能查到题');
  eq(Bank.byId('不存在'), null, 'byId 查不到时返回 null');

  // 三科的题都要能查到 —— 家长页的错题本用 byId 回查题干，
  // 只索引语文的话，数学错题会显示成一串 ma-00xx
  eq(G.SUBJECTS.filter((s) => Bank.byId(Bank.of(s)[0].id)).length, 3,
     'byId 三科通查');
  eq(Bank.subjectOf(allIds[0]), 'chinese', 'subjectOf 返回题目所属科目');
}

{
  // 难度分档：零基础孩子不该一上来就撞 100 以内进位加
  const rng = G.rngFrom('draw-level');
  const fresh = Store.defaultSave();
  let bad = 0;
  for (let i = 0; i < 1500; i++) {
    G.SUBJECTS.forEach((s) => {
      const q = Bank.drawOne(fresh, s, [], rng);
      if ((q.difficulty || 1) > 1) bad++;
    });
  }
  eq(bad, 0, '新手存档只抽到难度 1 的题');
  eq(Bank.levelOf(fresh, 'math'), 1, '无历史时难度档 = 1');

  const pro = Store.defaultSave();
  pro.sessions.push({
    items: Array.from({ length: 20 }, () => ({
      qid: Bank.of('math')[0].id, subject: 'math', correct: true,
    })),
  });
  eq(Bank.levelOf(pro, 'math'), 2, '最近 20 题全对 → 解锁难度 2');
  eq(Bank.levelOf(pro, 'english'), 1, '数学满分不会让英语一起升档');

  let got2 = 0;
  for (let i = 0; i < 1500; i++) {
    if ((Bank.drawOne(pro, 'math', [], rng).difficulty || 1) === 2) got2++;
  }
  ok(got2 > 0, '解锁后难度 2 的题能被抽到', got2 + ' / 1500');

  const weak = Store.defaultSave();
  weak.sessions.push({
    items: Array.from({ length: 20 }, (_, i) => ({
      qid: Bank.of('math')[0].id, subject: 'math', correct: i < 5,
    })),
  });
  eq(Bank.levelOf(weak, 'math'), 1, '正确率不达标时留在难度 1');
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
  let subAdjacent = 0, subSame = 0;      // 科目相邻

  for (let i = 0; i < 60; i++) {
    const save = Store.defaultSave();
    // 造一点历史：每局都有几道题做错过，三科都撒一些
    G.SUBJECTS.forEach((s) => {
      Bank.of(s).slice(i * 7, i * 7 + 3).forEach((q) => {
        save.wrongBook.push({
          qid: q.id, subject: s, seen: 2, correct: 0,
          wrongCount: 2, rightStreak: 0, lastWrongAt: Date.now(), cleared: false,
        });
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
    if (items.length !== G.ROUND_SIZE) {
      problems.push('第 ' + i + ' 局题数 = ' + items.length + '，应为 ' + G.ROUND_SIZE);
      continue;
    }

    // ---- 一局的科目构成必须是配额，不是概率 ----
    // 这是「3:3:4」这条需求在运行时的落地。抽成什么比例都行的话，
    // 孩子可能一连几局都刷不到数学。
    const bySub = {};
    G.SUBJECTS.forEach((s) => { bySub[s] = 0; });
    const seen = new Set();
    items.forEach((q, idx) => {
      if (!q || !q.id) { problems.push('第 ' + i + ' 局第 ' + idx + ' 题没有 id'); return; }
      if (G.SUBJECTS.indexOf(q.subject) < 0) {
        problems.push('第 ' + i + ' 局第 ' + idx + ' 题科目非法：' + q.subject);
      } else {
        bySub[q.subject]++;
      }
      if (seen.has(q.id)) problems.push('第 ' + i + ' 局出现重复题 ' + q.id);
      seen.add(q.id);
    });
    G.SUBJECTS.forEach((s) => {
      if (bySub[s] !== G.DEFAULT_MIX[s]) {
        problems.push('第 ' + i + ' 局 ' + s + ' 出了 ' + bySub[s] + ' 道，应为 ' + G.DEFAULT_MIX[s]);
      }
    });

    // 位置软约束：首尾必须是这一局里最可能答对的两道
    const p0 = Runner.successProb(items[0], save);
    const pN = Runner.successProb(items[items.length - 1], save);
    const midMax = Math.max(...items.slice(1, -1).map((q) => Runner.successProb(q, save)));
    if (Math.min(p0, pN) < midMax - 1e-9) {
      problems.push('第 ' + i + ' 局首/末题不是成功率最高的两道');
    }

    for (let k = 1; k < items.length; k++) {
      tagPairs++;
      if ((items[k - 1].tags || [])[0] === (items[k].tags || [])[0]) tagAdjacent++;

      subSame++;
      if (items[k - 1].subject === items[k].subject) subAdjacent++;
    }

    // 对照：同样这 10 道题，单纯打散会怎样。题型和科目分布都不均
    // （英语 4 道、其余各 3 道），所以对照不能假设「均匀」。
    const ctrl = G.shuffle(items.slice(), G.rngFrom('ctrl-' + i));
    for (let k = 1; k < ctrl.length; k++) {
      basePairs++;
      if ((ctrl[k - 1].tags || [])[0] === (ctrl[k].tags || [])[0]) baseAdjacent++;
    }
  }

  const uniq = [...new Set(problems)];
  ok(rounds === 60, '60 局全部构建成功', '成功 ' + rounds + ' 局');
  ok(uniq.length === 0,
     '60 局均为 10 道不重复的题、每局 3:3:4、首尾留给最有把握的题',
     uniq.slice(0, 4).join(' | '));

  // 同一题型不挨着。spread 是软约束，不要求做到 0，
  // 但必须比「原样打散」明显好 —— 拿同一批题的随机排列当对照。
  const rate = tagAdjacent / tagPairs;
  const base = baseAdjacent / basePairs;
  ok(rate < base * 0.4, '同题型相邻的比例远低于随机排列',
     (rate * 100).toFixed(1) + '% vs 随机 ' + (base * 100).toFixed(1) + '%');

  console.log('    \x1b[90m同科目相邻 ' + (subAdjacent / subSame * 100).toFixed(1) +
              '%（纯随机约 32%）\x1b[0m');
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

  // 统计必须记到自己那一科下面。记错科的话家长面板会显示
  // 「数学 · 归类」，而家长会以为孩子数学的归类题有问题。
  const mq = Bank.of('math')[0];
  Runner.recordAnswer(save, mq, true, 900);
  ok(save.progress.math.byTag[(mq.tags || [])[0]], '数学题记进 progress.math.byTag');
  ok(!save.progress.chinese.byTag[(mq.tags || [])[0]] ||
     save.progress.chinese.byTag[(mq.tags || [])[0]].seen === 3,
     '数学题不会记进语文的统计里');
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

/* ---- 8. 渲染 ---- */
// 放最后：这一段会真的调用渲染器，桩上的类名和事件监听会被写脏，
// 前面那些纯数据断言不该受影响。
testRenderer();

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
