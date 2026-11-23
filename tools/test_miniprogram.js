#!/usr/bin/env node
/* test_miniprogram.js — 小程序侧的无头测试
 *
 * 微信开发者工具没法在 CI 里跑，但小程序的**逻辑**是纯 JS：
 *   · app.js 的启动顺序
 *   · play 页的答题状态机（走完一整局）
 *   · 存档读写、星星规则、徽章阈值
 * 这些都能在 Node 里用 wx 桩跑起来，而它们恰恰是最容易在移植时写错的部分。
 *
 * 真正的 UI（WXML 布局、音频、真机手势）仍然只能在开发者工具/真机上验。
 *
 * 用法：node tools/test_miniprogram.js
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
const MP = path.join(ROOT, 'miniprogram');

let pass = 0;
const failures = [];

function ok(cond, name, detail) {
  if (cond) { pass++; return; }
  failures.push(name + (detail ? '  —  ' + detail : ''));
}

function eq(a, b, name, detail) {
  ok(a === b, name, detail || ('期望 ' + b + '，实际 ' + a));
}

/* ---------------------------------------------------------------- wx 桩 */

const storage = new Map();

const wx = {
  getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k, v) => { storage.set(k, v); },
  removeStorageSync: (k) => { storage.delete(k); },

  createInnerAudioContext: function () {
    const ctx = {
      src: '',
      play() {
        // 只记题干朗读（主包 ttsAudio/）；英文单词音频走 /generated/audio/，不混进来。
        if (typeof ctx.src === 'string' && ctx.src.indexOf('/ttsAudio/') === 0) {
          global.__ttsPlays.push(ctx.src);
        }
      },
      stop() {}, destroy() {}, onEnded() {}, onError() {}, onPlay() {}
    };
    return ctx;
  },
  loadSubpackage: function (o) {
    global.__subpackageCalls.push(o && o.name);
    if (o && o.success) o.success();
  },

  // 故意不提供 createWebAudioContext：验证「拿不到音频上下文时退化成震动」，
  // 这条分支在低版本基础库上真的会走到。
  vibrateShort() {},

  setInnerAudioOption() {},
  setNavigationBarTitle() {},
  showToast() {},
  showModal() {},
  setClipboardData(o) { if (o && o.success) o.success(); },
  navigateBack() {},
  navigateTo() {},
  redirectTo(o) { wx.__lastNav = o; },
  reLaunch(o) { wx.__lastNav = o; }
};

global.wx = wx;

// 题干朗读改用主包 ttsAudio/ 内的预生成音频：记录实际播放的路径，用来断言
// 「只念题干、不念选项」「听音题/算式题不朗读」「家长关掉后不再播放」。
// __subpackageCalls 故意留着：任何一次分包加载都说明朗读又退回异步前置条件，
// 真机上会重现「喇叭在但没声音」。
global.__ttsPlays = [];
global.__subpackageCalls = [];

global.Page = function (cfg) { global.__lastPage = cfg; };
global.App = function (cfg) { global.__lastApp = cfg; };

// 定时器立刻执行：一局 10 道题的推进不用真的等 620/1500ms。
// 递归深度只有 10 层，安全。
global.setTimeout = (fn) => { fn(); return 0; };
global.clearTimeout = () => {};

/* ---------------------------------------------------------------- 启动 */

let app;

function boot() {
  require(path.join(MP, 'app.js'));
  app = Object.assign({}, global.__lastApp);
  app.onLaunch();
  global.getApp = () => app;
}

function loadPage(rel) {
  const p = path.join(MP, rel);
  // 同一个页面要加载两次（一局全对、一局全错），必须清掉 require 缓存，
  // 否则模块不会重新执行，Page() 也不会再被调用。
  delete require.cache[require.resolve(p)];
  global.__lastPage = null;
  require(p);
  return global.__lastPage;
}

function makeInstance(cfg) {
  const inst = Object.assign({}, cfg);
  inst.data = JSON.parse(JSON.stringify(cfg.data || {}));
  inst.setData = function (patch) {
    Object.keys(patch).forEach((k) => { this.data[k] = patch[k]; });
  };
  return inst;
}

/* ---------------------------------------------------------------- 断言 */

console.log('\n小程序无头测试');
console.log('='.repeat(46));

/* ---- 1. 产物与启动 ---- */
boot();

const G = app.globalData.G;
const bank = require(path.join(MP, 'generated/data/bank.js'));
const stars = require(path.join(MP, 'lib/stars.js'));

ok(!!G, '生成的 game.js 能 require，且 window 垫片完整');
eq(G.env.isWeChat, true, 'G.env 识别为微信环境');
eq(G.env.isIOS, true, 'G.env 识别为 iOS（UA 垫片生效）');
eq(G.SUBJECTS.join(','), 'chinese,math,english', '三科名称');
eq(G.DEFAULT_MIX.chinese + ':' + G.DEFAULT_MIX.math + ':' + G.DEFAULT_MIX.english,
   '3:3:4', '配比来自 bank.mix');
eq(G.ROUND_SIZE, 10, '一局 10 题');
eq(G.Bank.all().length, 600, '题库 600 道');
eq(G.Bank.of('chinese').length, 200, '语文 200 道');
eq(G.Bank.of('math').length, 200, '数学 200 道');
eq(G.Bank.of('english').length, 200, '英语 200 道');
ok(!!G.Bank.zibiao() && G.Bank.zibiao().chars.length === 136, '字表 136 字');

/* ---- 2. 存档 ---- */
{
  const save = G.Store.load();
  save.points.balance = 7;
  save.points.lifetime = 7;
  ok(G.Store.save(save), '存档写入成功');

  const raw = wx.getStorageSync('yxjx.save.v1');
  const parsed = JSON.parse(raw);
  eq(parsed.points.balance, 7, '存档真的落到了 wx storage');
  eq(parsed.schema, 1, '存档 schema 不变');
  ok(parsed.integrity.bootId >= 1, 'bootId 已自增（时钟检测的输入）');
}

/* ---- 3. 组局 ---- */
{
  const save = G.Store.load();
  const round = G.Runner.buildRound(save);
  const bySubject = {};
  round.questions.forEach((q) => { bySubject[q.subject] = (bySubject[q.subject] || 0) + 1; });

  eq(round.questions.length, 10, '混合局 10 题');
  eq(bySubject.chinese, 3, '混合局语文 3 题');
  eq(bySubject.math, 3, '混合局数学 3 题');
  eq(bySubject.english, 4, '混合局英语 4 题');
  eq(new Set(round.questions.map((q) => q.id)).size, 10, '混合局内不重题');
}

/* ---- 3b. 单科局（小程序实际用的） ---- */
{
  const save = G.Store.load();
  G.SUBJECTS.forEach((subject) => {
    const round = G.Runner.buildSubjectRound(save, subject, 10);
    eq(round.questions.length, 10, subject + ' 单科局 10 题');
    eq(round.questions.filter((q) => q.subject === subject).length, 10,
       subject + ' 单科局只出这一科');
    eq(new Set(round.questions.map((q) => q.id)).size, 10,
       subject + ' 单科局内不重题');
  });
}

/* ---- 3c. 难度分档（生成产物里同样生效） ---- */
{
  // 深拷贝：Store.load() 与 app.globalData.save 是同一个对象，直接 push
  // 会污染后面「play 页走完一整局」断言的 sessions 长度。
  const save = JSON.parse(JSON.stringify(G.Store.load()));
  eq(G.Bank.levelOf(save, 'math'), 1, '新存档只出基础档');
  const round = G.Runner.buildSubjectRound(save, 'math', 10);
  eq(round.questions.filter((q) => (q.difficulty || 1) === 1).length, 10,
     '新手的单科局 10 题全是难度 1');

  const pro = JSON.parse(JSON.stringify(G.Store.load()));
  pro.sessions.push({
    items: Array.from({ length: 20 }, () => ({
      qid: G.Bank.of('math')[0].id, correct: true,
    })),
  });
  eq(G.Bank.levelOf(pro, 'math'), 2, '全对历史解锁进阶档');
}

/* ---- 4. 星星规则 ---- */
{
  // 阈值 9 / 6：做对 9 题才 3 星，6 题才 2 星，其余 1 星保底。
  const cases = [[0, 1], [5, 1], [6, 2], [8, 2], [9, 3], [10, 3]];
  G.SUBJECTS.forEach((subject) => {
    cases.forEach(([correct, want]) => {
      eq(stars.forCorrect(correct, subject), want,
         subject + ' 答对 ' + correct + ' 题 → ' + want + ' 星');
    });
  });

  const names = stars.badgeState(100).map((b) => b.name).join(',');
  eq(names, '薯条,布鲁克,动画片,超市', '四个徽章');
  eq(stars.badgeState(29).filter((b) => b.got).length, 1, '29 星只解锁 1 个徽章');
  eq(stars.badgeState(30).filter((b) => b.got).length, 2, '30 星解锁 2 个徽章');
  eq(stars.badgeState(49).filter((b) => b.got).length, 2, '49 星还没解锁动画片');
  eq(stars.badgeState(50).filter((b) => b.got).length, 3, '50 星解锁动画片');
  eq(stars.nextBadge(100), null, '100 星后没有下一个徽章');
  eq(stars.progressPct(0), 0, '0 星进度 0%');
  eq(stars.progressPct(100), 100, '满徽章进度 100%');
}

/* ---- 5. play 页走完一整局 ---- */
{
  const cfg = loadPage('pages/play/play.js');
  ok(!!cfg && typeof cfg.onLoad === 'function', 'play 页能加载');

  const page = makeInstance(cfg);
  page.onLoad({ subject: 'chinese' });

  eq(page.data.total, 10, 'play 页读到 10 道题');
  eq(page.data.subjectLabel, '语文', 'play 页显示科目名');
  eq(page.data.options.length, 4, '第一题 4 个选项');
  eq(page.data.dots.length, 10, '进度点 10 个');
  eq(page.data.dots[0].state, 'now', '第一个点是当前题');

  // 全部答对
  for (let i = 0; i < 10; i++) {
    const q = page.round.questions[page.idx];
    page.onOption({ currentTarget: { dataset: { id: q.answer } } });
  }

  const result = app.globalData.lastResult;
  ok(!!result, '整局结束后写入了 lastResult');
  eq(result.correct, 10, '全对');
  eq(result.nominal, 3, '全对拿 3 星');
  ok(result.stars >= 0 && result.stars <= 3, '实际到账不超过名义值');
  ok(wx.__lastNav && wx.__lastNav.url === '/pages/result/result',
     '结算后跳到 result 页');

  const save = app.globalData.save;
  eq(save.sessions.length, 1, '多了一条对局记录');
  eq(save.sessions[0].correct, 10, '对局记录的对题数正确');
  eq(save.points.lifetime, 7 + result.stars, '累计星星 = 原有 + 本局到账');

  const audit = G.Store.audit(save);
  ok(audit.ok, '账目自洽（余额 = 累计 − 消耗）');
  // 这条才是结算顺序的哨兵：sessionOk 比对「本局记的入账」和「累计值的增量」。
  // 先 finishSession(名义 3 星) 再 awardPoints（被每日上限削成 0）时，
  // audit.ok 仍然是 true，只有 sessionOk 会变 false —— 实测过。
  ok(audit.sessionOk, '本局入账与累计增量一致（awardPoints 在 finishSession 之前）');
}

/* ---- 6. play 页全错也能结算 ---- */
{
  const cfg = loadPage('pages/play/play.js');
  const page = makeInstance(cfg);
  page.onLoad({ subject: 'math' });

  for (let i = 0; i < 10; i++) {
    const q = page.round.questions[page.idx];
    const wrong = q.options.filter((o) => o.id !== q.answer)[0];
    page.onOption({ currentTarget: { dataset: { id: wrong.id } } });
  }

  const result = app.globalData.lastResult;
  eq(result.correct, 0, '全错');
  eq(result.nominal, 1, '全错也有 1 星保底');
}

/* ---- 7. result 页 ---- */
{
  const cfg = loadPage('pages/result/result.js');
  const page = makeInstance(cfg);
  page.onLoad();
  ok(!!page.data.score, 'result 页渲染了分数');
  eq(page.data.badges.length, 4, 'result 页展示四个徽章');
}

/* ---- 8. 家长页 ---- */
{
  const cfg = loadPage('pages/parent/parent.js');
  eq(cfg.data.unlocked, false, '家长页默认锁着');
  const page = makeInstance(cfg);
  page.onLoad();
  eq(page.data.gateQuestion, G.PARENT_GATE.question, '门禁题目来自 G.PARENT_GATE');

  page.setData({ gateInput: String(G.PARENT_GATE.answer) });
  page.onGateSubmit();
  eq(page.data.unlocked, true, '答对后解锁');
  ok(page.data.zibiao.chars.length === 136, '字表渲染了 136 字');
  ok(page.data.bySubject.length > 0, '按题型统计有内容');
}

/* ---- 8b. 题干朗读（lib/tts.js + game.js 里的 TTSText） ---- */
{
  const tts = require(path.join(MP, 'lib/tts.js'));
  const MAP = require(path.join(MP, 'generated/data/tts-map.js'));
  ok(!!G.TTSText && typeof G.TTSText.forQuestion === 'function',
     'game.js 带上了和网页版共用的朗读规则');
  ok(tts.available(), '主包题干音频映射齐全，喇叭可以显示');
  eq(global.__subpackageCalls.length, 0, '朗读不依赖分包预下载（进题即播，无排队）');
  ok(Object.keys(MAP).every((t) => MAP[t].indexOf('/ttsAudio/') === 0),
     '所有映射都指向主包内的音频路径');

  // 题库里每一条需要朗读的文本都必须有对应音频，否则那道题的喇叭点了没声音
  const missingAudio = [];
  ['chinese', 'math', 'english'].forEach((s) => {
    G.Bank.of(s).forEach((q) => {
      const t = G.TTSText.forQuestion(q).text;
      if (t && !MAP[t]) missingAudio.push(q.id + ':' + t);
    });
  });
  eq(missingAudio.length, 0, '需朗读的题干全部有主包音频', missingAudio.slice(0, 3).join(' | '));

  // 算式题的题干全是数字和符号，不识字也不影响看题，不朗读也不生成音频
  const formula = G.Bank.of('math').filter((q) => !/[\u3400-\u9fff]/.test(q.stem.text));
  ok(formula.length > 0 && formula.every((q) => G.TTSText.forQuestion(q).why === 'formula'),
     '纯算式题不朗读（省体积，171 条才装得进主包）', formula.length + ' 道');

  ok(tts.has('题库里不存在的题干') === false && tts.speak('题库里不存在的题干') === false,
     '查不到映射的文本不会被播放');

  global.__ttsPlays.length = 0;
  const cfg = loadPage('pages/play/play.js');
  const page = makeInstance(cfg);
  page.onLoad({ subject: 'chinese' });

  const q0 = page.round.questions[0];
  const want = G.TTSText.forQuestion(q0).text;
  eq(page.data.canRead, true, '语文题出现读题按钮');
  eq(page.data.readText, want, '读题文本来自共用规则');
  ok(!!want && !!MAP[want] && global.__ttsPlays.indexOf(MAP[want]) >= 0,
     '进题自动播放了一次题干音频（走主包映射）');
  page.onReadStem();
  eq(global.__ttsPlays.filter((p) => p === MAP[want]).length, 2,
     '点读题喇叭能重播一次');
  ok(q0.options.every((o) => want !== o.text),
     '朗读文本不是某个选项（不会把答案念出来）');
  ok(page.data.options.every((o) => o.readText === undefined),
     '朗读文本没有塞进选项里（选项不可朗读）');

  // 听音题有自带英文音频，不该再念一句中文提示抢喇叭
  const listen = G.Bank.of('english').filter((q) => q.stem.audio)[0];
  ok(!!listen && G.TTSText.forQuestion(listen).skip,
     '听音题不朗读的规则在小程序产物里同样生效');

  // 家长关掉开关：按钮消失、不再播放音频
  const save = app.globalData.save;
  save.settings.readStem = false;
  global.__ttsPlays.length = 0;
  const cfg2 = loadPage('pages/play/play.js');
  const page2 = makeInstance(cfg2);
  page2.onLoad({ subject: 'chinese' });
  eq(page2.data.canRead, false, '关掉朗读后不出现读题按钮');
  eq(global.__ttsPlays.length, 0, '关掉朗读后不再播放题干音频');
  save.settings.readStem = true;      // 恢复，别污染后面的备份测试

  // 家长页开关要真的写进存档
  const pcfg = loadPage('pages/parent/parent.js');
  const ppage = makeInstance(pcfg);
  ppage.onLoad();
  ppage.setData({ gateInput: String(G.PARENT_GATE.answer) });
  ppage.onGateSubmit();
  eq(ppage.data.readStem, true, '家长页显示朗读为开启');
  ppage.onToggleReadStem({ detail: { value: false } });
  eq(G.Store.load().settings.readStem, false, '家长页开关写进存档');
  G.Store.load().settings.readStem = true;
}

/* ---- 8c. 音频停止 / 中途退出 / 错题复习 / 听音题指令 ---- */
{
  // 单词音频必须能显式停：切题和退出靠它，否则上一题的词会漏进下一题。
  const audio = require(path.join(MP, 'lib/audio.js'));
  eq(typeof audio.stop, 'function', '单词音频提供 stop()，切题/退出可掐断');

  // 中途退出把已答题记成未完成局，不发星、不重复记、不破坏账目。
  const save = app.globalData.save;
  const round = G.Runner.buildSubjectRound(save, 'math', 10);
  const items = round.questions.slice(0, 3).map((q) => ({
    qid: q.id, subject: q.subject, type: q.type, tags: q.tags || [],
    correct: true, ms: 900
  }));
  const s = G.Runner.abandonSession(save, round, items);
  ok(!!s && s.aborted === true, '中途退出记成 aborted 局');
  eq(s.pointsEarned, 0, '未完成局不发星星');
  eq(s.items.length, 3, '未完成局带上已答的 3 题（难度评估能认）');
  ok(save.sessions[save.sessions.length - 1] === s, '未完成局写进 sessions 末尾');
  ok(save.sessions.length <= 30, 'sessions 仍只保留最近 30 局');
  eq(G.Runner.abandonSession(save, round, []), null, '一题没答时不写垃圾局');
  eq(G.Store.audit(save).ok, true, '未完成局不破坏三方审计');

  // 错题复习局：只出未掌握的错题，cleared 和失效 qid 都跳过。
  const rs = G.Store.defaultSave();
  const pool = G.Bank.of('chinese');
  const now = Date.now();
  rs.wrongBook = [
    { qid: pool[0].id, cleared: false, wrongCount: 5, lastWrongAt: now },
    { qid: pool[1].id, cleared: false, wrongCount: 2, lastWrongAt: now },
    { qid: pool[2].id, cleared: true,  wrongCount: 9, lastWrongAt: now },
    { qid: 'gone-999', cleared: false, wrongCount: 8, lastWrongAt: now }
  ];
  const rr = G.Runner.buildReviewRound(rs, 10);
  eq(rr.questions.length, 2, '复习局只出未掌握的错题，跳过 cleared 和失效 qid');
  eq(rr.questions[0].id, pool[0].id, '错得最多的排在最前');

  // 听音题固定中文指令：三种题型各一句，且都已在主包音频映射里。
  const MAP = require(path.join(MP, 'generated/data/tts-map.js'));
  ['听音选字母', '听音选词', '辨短元音'].forEach((tag) => {
    const q = G.Bank.of('english')
      .filter((x) => (x.tags || [])[0] === tag && x.stem.audio)[0];
    const ins = G.TTSText.instructionFor(q);
    ok(!!q && !!ins, tag + ' 有中文指令');
    ok(!!MAP[ins], tag + ' 的指令有主包音频');
    eq(G.TTSText.forQuestion(q).skip, true, tag + ' 仍不朗读题干（不抢喇叭）');
  });
  eq(G.TTSText.instructionFor(pool[0]), '', '非听音题没有指令');

  // 难度档与权重：档位语义不变，进阶题渐进放开，错题权重封顶。
  eq(G.Bank.levelDetailOf(save, 'chinese').level, G.Bank.levelOf(save, 'chinese'),
     'levelOf 与 levelDetailOf 档位一致');
  const w = G.Bank.weightOf(pool[0], {
    [pool[0].id]: { wrongCount: 20, cleared: false, lastWrongAt: now }
  });
  ok(w <= 4, '错题权重封顶 4 倍（连错 20 次也不会变成 30 倍）', '实际 ' + w);
}

/* ---- 8d. 动态展示（只做反馈型，不碰账目） ---- */
{
  const confetti = require(path.join(MP, 'lib/confetti.js'));
  ok(confetti.pieces(18, 0.06).every((p) => +p.delay <= 0.06),
     '答题页彩纸的随机延迟压进 620ms 窗口');
  ok(confetti.pieces(18).every((p) => +p.delay <= 0.25),
     '结算页彩纸仍用 0.25s 上限，停留时间长可以完整下落');

  const cfg = loadPage('pages/play/play.js');
  const page = makeInstance(cfg);
  page.onLoad({ subject: 'chinese' });
  const flag0 = page.data.enterFlag;
  page.renderQuestion();
  ok(page.data.enterFlag !== flag0, '切题交替 class，入场动画会重播');
  ok(page.data.options.every((o) => o.delay !== undefined),
     '每个选项都带错峰延迟');
  eq(page.data.roundCorrect, 0, '本局答对数从 0 开始');

  const save = app.globalData.save;
  const before = save.points.balance;
  const q = page.round.questions[page.idx];
  // 测试桩把 later() 做成同步执行，620ms 后会立刻 advance 到下一题。
  // 要看「作答那一瞬间」的状态，先临时冻住自动推进。
  const realLater = page.later;
  page.later = function () {};
  page.onOption({ currentTarget: { dataset: { id: q.answer } } });
  eq(page.data.roundCorrect, 1, '答对后本局答对数 +1');
  eq(page.data.starPop, true, '答对弹出 +1 提示');
  eq(save.points.balance, before, '过程中的即时反馈不动真星星账目');
  ok(page.data.options.every((o) => o.delay === 0),
     '作答后清掉入场延迟，反馈动画立即播');
  page.later = realLater;
  page.renderQuestion();
  eq(page.data.starPop, false, '换题清掉 +1 提示');
}

/* ---- 8e. 数学题图形演示（P1 试点） ---- */
{
  const fs = require('fs');
  const vm = require(path.join(MP, 'lib/visual-math.js'));
  const allMath = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/math.json'), 'utf8'));
  const calc = allMath.filter((q) => q.tags.indexOf('计算') >= 0);

  const b = vm.blocks(66);
  eq(b.bars.length, 6, '66 画成 6 根十棒');
  eq(b.dots.length, 6, '66 画成 6 个圆点');
  eq(b.label, '66', '积木上方保留阿拉伯数字标签');
  ok(vm.blocks(0).empty, '0 有专门的空占位');

  let parsed = 0, carry = 0, borrow = 0;
  const bad = [];
  calc.forEach((q) => {
    const v = vm.forQuestion(q, true);
    if (!v) { bad.push(q.id + ':未解析'); return; }
    parsed++;
    if (v.carry) carry++;
    if (v.borrow) borrow++;
    const m = /^(\d+)\s*([+-])\s*(\d+)/.exec(q.stem.text);
    const expect = m[2] === '+' ? +m[1] + +m[3] : +m[1] - +m[3];
    if (v.result.value !== expect) bad.push(q.id + ':得数不符');
    if (v.left.value !== +m[1] || v.right.value !== +m[3]) bad.push(q.id + ':操作数不符');
    if (v.left.bars.length + v.left.dots.length > 18) bad.push(q.id + ':积木过量');
  });
  eq(calc.length, 100, '题库里正好 100 道计算题');
  eq(parsed, 100, '100 道计算题题干 100% 可解析，不用改题库');
  eq(bad.length, 0, '积木数量与算式、得数全部一致', bad.join(' '));
  ok(carry > 0 && borrow > 0, '进位题和借位题都被识别出来');

  const sample = calc[0];
  const nonCalc = allMath.filter((q) => q.tags.indexOf('计算') < 0)[0];
  eq(vm.forQuestion(sample, false), null, '家长关掉开关时整块演示不渲染');
  eq(vm.forQuestion(nonCalc, true), null, '非计算题不演示');
  eq(vm.forQuestion(Object.assign({}, sample, { subject: 'chinese' }), true), null,
     '非数学题不演示');
  eq(vm.forQuestion(Object.assign({}, sample, { stem: { text: '3 + 8 = 3 + 7 + ?' } }), true), null,
     '拆数题超出试点范围，静默跳过');
  eq(vm.forQuestion(Object.assign({}, sample, {
    stem: { text: '99 + 99 = ?' },
    options: [{ id: 'a', text: '198' }], answer: 'a'
  }), true), null, '结果超过 99 时不演示，避免积木刷屏');
  eq(vm.forQuestion({
    subject: 'math', tags: ['计算'], stem: { text: '12 + 4 = ?' },
    options: [{ id: 'a', text: '99' }], answer: 'a'
  }, true), null, '题库得数与算式不符时拒绝演示，不画错图形');

  // 关键（1.2.13）：答题前数据层就不存在得数，不是靠 WXML 的 answered 挡着。
  const V8e = require(path.join(MP, 'lib/visual.js'));
  const cfg = loadPage('pages/play/play.js');
  const page = makeInstance(cfg);
  page.onLoad({ subject: 'math' });
  page.round.questions[page.idx] = sample;
  page.renderQuestion();
  ok(!!page.data.visual, '数学计算题进题带积木数据');
  eq(page.data.visual.left.value, /^(\d+)/.exec(sample.stem.text)[1] * 1,
     '左侧积木对应算式第一个数');
  eq(page.data.answered, false, '答题前结果行不显示，不提前泄答案');
  eq(page.data.visual.result, undefined, '答题前页面数据里没有得数积木');
  ok(!!V8e.reveal(sample, true).result, '得数改由 reveal() 在作答后返回');
  ok(!!V8e.merge(page.data.visual, V8e.reveal(sample, true)).result,
     'merge 后 visual 才补上得数');

  const save = app.globalData.save;
  save.settings.visualMath = false;
  G.Store.save(save);
  page.renderQuestion();
  eq(page.data.visual, null, '家长关闭后切题不再出现积木');
  const dumped = Array.from(storage.keys()).map((k) => {
    const v = storage.get(k);
    return typeof v === 'string' ? v : JSON.stringify(v);
  }).join('');
  ok(dumped.indexOf('visualMath') >= 0, '开关写进存档并能被序列化');
  const storeSrc = fs.readFileSync(path.join(ROOT, 'src/js/10-store.js'), 'utf8');
  ok(/Object\.keys\(def\.settings\)\.forEach/.test(storeSrc),
     '共用 Store 的 migrate 只补默认键，不删 visualMath（网页版产物零改动）');
  save.settings.visualMath = true;
  G.Store.save(save);
  page.renderQuestion();
  ok(!!page.data.visual, '重新打开开关后恢复演示');

  const cfg2 = loadPage('pages/play/play.js');
  const p2 = makeInstance(cfg2);
  p2.onLoad({ subject: 'chinese' });
  // 1.2.11 起语文的「看拼音选字」也会出图形，但不能串进数学积木模板。
  ok(!p2.data.visual || p2.data.visual.kind === 'pinyin',
     '语文题即使出图形也只会是拼音拆合，不会串进积木');
}

/* ---- 8f. 三科内容型演示（1.2.11） ---- */
{
  const fs = require('fs');
  const V = require(path.join(MP, 'lib/visual.js'));
  const loadBank = (f) => JSON.parse(
    fs.readFileSync(path.join(ROOT, 'src/data/' + f + '.json'), 'utf8'));
  const math = loadBank('math');
  const ch = loadBank('chinese');
  const en = loadBank('english');

  // 全题库覆盖：解析不出来的题必须静默退回纯文字，不能抛错。
  const cover = { 'math-calc': 0, 'math-split': 0, english: 0, pinyin: 0, none: 0 };
  [math, ch, en].forEach((d) => d.forEach((q) => {
    const v = V.forQuestion(q, true);
    cover[v ? v.kind : 'none']++;
  }));
  eq(cover['math-calc'], 100, '数学计算题 100 道全部可演示');
  eq(cover['math-split'], 28, '数学拆数题 28 道全部可演示');
  eq(cover.english, 84, '英语 84 道可演示（听音选词/辨短元音/押韵/拼合 CVC）');
  eq(cover.pinyin, 45, '语文 45 道看拼音选字可演示，2 道零声母跳过');
  eq(cover.none, 343, '其余 343 道静默跳过');

  // 1.2.13：答案字段在数据结构上就不进答题前的 visual。
  let leaked = 0;
  [math, ch, en].forEach((d) => d.forEach((q) => {
    const v = V.forQuestion(q, true);
    if (!v) return;
    if (V.ANSWER_KEYS.some((k) => v[k] !== undefined)) leaked++;
    if ((v.parts || []).some((p) => p && p.solved)) leaked++;
  }));
  eq(leaked, 0, '全 600 道题：forQuestion 返回的对象里不存在任何答案字段');
  eq(V.reveal(en.find((q) => q.tags[0] === '听音选词'), false), null,
     '家长关掉开关后 reveal 也返回 null，不会绕过开关塞答案');

  // 拆数 / 凑十：四种题干格式，每种只有一个未知块。答案不再塞在
  // parts[].solved 里跟着进题，改由 reveal() 作答后返回。
  const modes = {};
  math.filter((q) => q.tags[0] === '拆数').forEach((q) => {
    const v = V.forQuestion(q, true);
    if (!v) return;
    modes[v.mode] = (modes[v.mode] || 0) + 1;
    const unknowns = v.parts.filter((p) => p.unknown);
    eq(unknowns.length, 1, '每道拆数题只有一个未知块：' + q.stem.text);
    eq(unknowns[0].solved, undefined,
       '答题前的未知块里没有得数：' + q.stem.text);
    const ans = q.options.find((o) => o.id === q.answer).text;
    const revealedParts = V.reveal(q, true).parts;
    eq(revealedParts.filter((p) => p.unknown)[0].solved.label, ans,
       '作答后 reveal 才给出正确答案：' + q.stem.text);
  });
  eq(modes.place, 14, '位值拆分 14 道');
  eq(modes['make-ten'], 7, '凑十 7 道');
  eq(modes.count, 7, '数一数 7 道');

  const tenQ = math.find((q) => q.stem.text === '8 + 8 = 8 + 2 + ?');
  const ten = V.forQuestion(tenQ, true);
  eq(ten.mode, 'make-ten', '凑十题识别为 make-ten');
  eq(ten.hint.a + ten.hint.c, 10, '凑十提示的两个数正好凑成十');
  eq(ten.parts.filter((p) => p.unknown)[0].solved, undefined,
     '凑十题答题前的问号里没有得数');
  eq(V.reveal(tenQ, true).parts.filter((p) => p.unknown)[0].solved.label, '6',
     '凑十题得数 6 由 reveal 在作答后给出');
  eq(ten.top, null, '凑十题不画总量积木，避免把 16 直接摆出来');
  eq(V.math.forSplitQuestion(Object.assign({}, tenQ,
    { stem: { text: '8 + 8 = 8 + 3 + ?' } }), true), null,
     '凑十题数据不自洽时拒绝演示');

  // 拼音：zh/ch/sh 最长匹配优先，声调留在韵母里，拆完能还原。
  eq(V.chinese.split('shēng').sheng, 'sh', 'zh/ch/sh 最长匹配优先');
  eq(V.chinese.split('hóng').yun, 'óng', '韵母保留声调');
  eq(V.forQuestion(ch.find((q) => q.stem.text.indexOf('「èr」') >= 0), true), null,
     '零声母拼音（èr / ěr）没有可拆的两块，静默跳过');
  const py = V.forQuestion(ch.find((q) => q.stem.text.indexOf('「xué」') >= 0), true);
  eq(py.sheng + py.yun, py.full, '拼音拆完能还原成原串');
  ok(ch.filter((q) => q.tags[0] === '看拼音选字').every((q) => {
    const v = V.forQuestion(q, true);
    return !v || v.sheng + v.yun === v.full;
  }), '45 道拼音拆合全部自洽');

  // 英语：答题前绝不显示答案词，作答后才给字母。
  const blendQ = en.find((q) => q.tags[0] === '拼合 CVC');
  const blend = V.forQuestion(blendQ, true);
  eq(blend.before.type, 'split', '拼合 CVC 题画词族两块');
  ok(!blend.before.word, '拼合题答题前不显示合并后的答案词');
  eq(blend.after, undefined, '答题前 visual 里没有 after（正确词字段不存在）');
  eq(V.reveal(blendQ, true).after.word, 'dam', '作答后 reveal 才揭晓正确词');
  const listenQ = en.find((q) => q.tags[0] === '听音选词');
  const listen = V.forQuestion(listenQ, true);
  eq(listen.before.type, 'slots', '听音题答题前只画音位格子');
  ok(listen.before.slots.length >= 3 && listen.before.slots.length <= 5,
     '音位格子 3~5 个，长词不画满');
  ok(!listen.before.slots.some((s) => s.ch), '格子里没有字母，答题前不泄答案');
  eq(listen.after, undefined, '听音题答题前没有 after，数据层不泄答案词');
  const listenReveal = V.reveal(listenQ, true);
  eq(listenReveal.after.word, 'yam', '作答后 reveal 才给正确词');
  eq(listen.audioId, 'en.yam', '答错重播用的音频 id 保留在答题前数据里');
  ok(listenReveal.after.letters.every((L, i) => L.delay === (i * 0.12).toFixed(2)),
     '字母卡片依次高亮，各差 120ms');
  const rhyme = V.forQuestion(en.find((q) => q.tags[0] === '押韵配对'), true);
  eq(rhyme.before.rime, 'am', 'ram 拆出词族 am，把「结尾音」摆出来');
  eq(V.forQuestion(blendQ, false), null, '家长关掉开关后三科都不演示');

  // WXML 四个模板齐全，缺一个就会静默白屏。
  const wxml = fs.readFileSync(path.join(MP, 'pages/play/play.wxml'), 'utf8');
  ['math-calc', 'math-split', 'english', 'pinyin'].forEach((k) => {
    ok(wxml.indexOf("visual.kind === '" + k + "'") >= 0, 'WXML 有 ' + k + ' 模板');
  });

  // play 页：拆数题走对应模板；答题前问号不翻答案。
  const cfg = loadPage('pages/play/play.js');
  const page = makeInstance(cfg);
  page.onLoad({ subject: 'math' });
  page.round.questions[page.idx] = tenQ;
  page.renderQuestion();
  eq(page.data.visual.kind, 'math-split', '拆数题进题走 math-split 模板');
  eq(page.data.answered, false, '答题前问号不翻答案');
  ok(page.data.visual.parts.some((p) => p.unknown), '未知块存在');

  // 音频开播那一刻才挂脉冲 class，格子才会跟着声音依次亮。
  page.playWord('en.yam');
  ok(/^v-slots-pulse-[ab]$/.test(page.data.slotsClass), '音频开播时挂上格子脉冲 class');
  ok(/^v-letters-pulse-[ab]$/.test(page.data.lettersClass), '字母卡片也用同一脉冲重播');

  // 英语听音题：答错重播单词让高亮跟声音走，答对不重播（620ms 窗口 + 防串音）。
  function englishPage() {
    const p = makeInstance(loadPage('pages/play/play.js'));
    p.onLoad({ subject: 'english' });
    p.round.questions[p.idx] = listenQ;
    p.renderQuestion();
    return p;
  }
  const wrongPage = englishPage();
  let replayed = null;
  wrongPage.playWord = (id) => { replayed = id; };
  wrongPage.later = () => {};
  const wrongOpt = listenQ.options.find((o) => o.id !== listenQ.answer).id;
  wrongPage.onOption({ currentTarget: { dataset: { id: wrongOpt } } });
  eq(replayed, 'en.yam', '英语听音题答错时重播单词，字母高亮跟着声音');
  const rightPage = englishPage();
  let replayed2 = null;
  rightPage.playWord = (id) => { replayed2 = id; };
  rightPage.later = () => {};
  rightPage.onOption({ currentTarget: { dataset: { id: listenQ.answer } } });
  eq(replayed2, null, '答对不重播音频，避免 620ms 窗口内串音');
}

/* ---- 8g. 分步讲解：进位 / 借位 / 凑十（1.2.12） ---- */
{
  const fs = require('fs');
  const V = require(path.join(MP, 'lib/visual.js'));
  const vm = V.math;
  const math = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/math.json'), 'utf8'));
  const findQ = (t) => math.find((q) => q.stem.text === t);
  const answerOf = (q) => q.options.find((o) => o.id === q.answer).id;

  // 全题库：只有进位 / 借位 / 凑十挂 steps，其余 551 道题节奏必须完全不变。
  let withSteps = 0, carry = 0, borrow = 0, ten = 0;
  const bad = [];
  math.forEach((q) => {
    const v = V.forQuestion(q, true);
    if (!v || !v.steps) return;
    withSteps++;
    if (v.kind === 'math-calc' && v.carry) carry++;
    if (v.kind === 'math-calc' && v.borrow) borrow++;
    if (v.mode === 'make-ten') ten++;
    if (v.steps.frames.length !== 2) bad.push(q.stem.text + ':帧数');
    v.steps.frames.forEach((f) => {
      if (f.bars.length + f.dots.length > 25) bad.push(q.stem.text + ':帧过大');
      if (f.bars.some((b) => typeof b.cls !== 'string') ||
          f.dots.some((d) => typeof d.cls !== 'string')) bad.push(q.stem.text + ':cls 缺失');
    });
  });
  eq(withSteps, 49, '全题库 49 道题有分步（进位 21 + 借位 21 + 凑十 7）');
  eq(carry, 21, '进位 21 道');
  eq(borrow, 21, '借位 21 道');
  eq(ten, 7, '凑十 7 道');
  eq(bad.length, 0, '所有过程帧 2 帧、积木不过量、class 齐备', bad.join(' '));

  const carryQ = findQ('66 + 4 = ?');
  const borrowQ = findQ('94 - 7 = ?');
  const tenQ = findQ('8 + 8 = 8 + 2 + ?');
  const plainQ = findQ('12 + 4 = ?');

  const cs = V.forQuestion(carryQ, true).steps;
  eq(cs.need, 4, '66 + 4 要搬 4 个点');
  eq(cs.rest, 0, '66 + 4 补完十不剩点');
  eq(cs.frames[0].dots.filter((d) => d.cls === 'v-dot-take').length, 4,
     '进位帧① 4 个橙色要搬点');
  eq(cs.frames[1].bars.filter((b) => b.cls === 'v-bar-new').length, 1,
     '进位帧② 出现一根新十棒');

  const bs = V.forQuestion(borrowQ, true).steps;
  eq(bs.need, 7, '94 - 7 要减 7 个点');
  eq(bs.rest, 7, '94 - 7 拆棒后剩 7 个点');
  eq(bs.frames[0].bars.filter((b) => b.cls === 'v-bar-break').length, 1,
     '借位帧① 一根十棒标成要拆开');
  eq(bs.frames[1].bars.length, 8, '借位帧② 少了一根棒');
  eq(bs.frames[1].dots.filter((d) => d.cls === 'v-dot-cut').length, 7,
     '借位帧② 划掉 7 个点');

  const ts = V.forQuestion(tenQ, true).steps;
  eq(ts.need, 2, '凑十题拿 2 个去补');
  eq(ts.rest, 6, '凑十题剩 6 个，就是问号的答案');
  eq(ts.frames[0].dots.length, 8, '凑十帧① 画的是题干里的第二个 8');
  eq(ts.frames[1].bars.filter((b) => b.cls === 'v-bar-new').length, 1,
     '凑十帧② 2 个凑成一根十棒');

  eq(V.forQuestion(plainQ, true).steps, null, '不进位题没有分步帧，节奏不变');
  eq(vm.forQuestion(carryQ, false), null, '总开关关掉时不解析');
  eq(vm.makeTenSteps(8, 2, 6).rest, 6, '凑十帧生成器可直接复用');
  eq(vm.calcSteps(12, 4, '+'), null, '个位相加不满十不分步');
  eq(vm.calcSteps(94, 3, '-'), null, '个位够减不用借位');

  // WXML / WXSS：过程帧只在作答后渲染，得数改由 revealed 控制。
  const wxml = fs.readFileSync(path.join(MP, 'pages/play/play.wxml'), 'utf8');
  ok(/wx:if="\{\{answered && visual\.steps\}\}"/.test(wxml),
     '过程帧只在作答后渲染，答题前一个得数都不露');
  ok(/wx:if="\{\{revealed && visual\.kind === 'math-calc'\}\}"/.test(wxml),
     '得数行由 revealed 控制，可延后到分步最后一步');
  ok(/wx:if="\{\{!revealed\}\}" class="v-q"/.test(wxml),
     '拆数题问号也由 revealed 控制');
  ok(/stepNow >= fr\.i/.test(wxml), '过程帧按 stepNow 依次点亮');
  ok(/explainLong \? 'explain-timer-long'/.test(wxml), '分步题倒计时条走长时');
  const wxss = fs.readFileSync(path.join(MP, 'app.wxss'), 'utf8');
  const stepCss = wxss.slice(wxss.indexOf('/* ---------- 分步讲解'),
                             wxss.indexOf('/* ---------- 英语词族'));
  ok(stepCss.length > 0 && stepCss.indexOf('infinite') < 0,
     '分步样式是一次性动画，没有循环');
  ok(/explain-timer-long \{ animation-duration: 1\.9s/.test(wxss),
     '1.9s 倒计时有对应样式');

  // play 页状态机：有分步时作答瞬间盖着得数，走完两帧才揭晓。
  const save = app.globalData.save;
  save.settings.visualMath = true;
  save.settings.visualSteps = true;
  G.Store.save(save);

  function stepPage(q) {
    const p = makeInstance(loadPage('pages/play/play.js'));
    p.onLoad({ subject: 'math' });
    p.round.questions[p.idx] = q;
    p.renderQuestion();
    return p;
  }

  const p = stepPage(carryQ);
  ok(!!p.data.visual.steps, '进位题进题带分步数据');
  eq(p.data.answered, false, '答题前未作答');
  eq(p.data.revealed, false, '答题前得数盖着');
  eq(p.data.stepNow, -1, '答题前没有点亮任何过程帧');

  const calls = [];
  p.later = (ms) => { calls.push(ms); };
  p.onOption({ currentTarget: { dataset: { id: answerOf(carryQ) } } });
  eq(p.data.answered, true, '作答后进入已作答态');
  ok(!!p.data.visual.result, '作答后 reveal 把得数合并进 visual（同一次 setData）');
  eq(p.data.revealed, false, '分步题作答瞬间仍不揭晓得数');
  eq(p.data.stepNow, -1, '分步帧等定时器依次点亮');
  eq(p.data.explainLong, true, '分步题倒计时条标记为长时');
  eq(Math.max.apply(null, calls), 1900, '分步题切题窗口延长到 1900ms');
  ok(calls.indexOf(120) >= 0 && calls.indexOf(600) >= 0 && calls.indexOf(1080) >= 0,
     '三个时刻 120 / 600 / 1080ms 依次排好');

  p.setStep(0, false);
  eq(p.data.stepNow, 0, '点亮第一帧');
  eq(p.data.revealed, false, '第一帧还不揭晓得数');
  p.setStep(1, false);
  eq(p.data.stepNow, 1, '点亮第二帧');
  eq(p.data.revealed, false, '第二帧仍不揭晓得数');
  p.setStep(2, true);
  eq(p.data.revealed, true, '第三步才揭晓得数');

  // 定时器必须全部登记在册，切题 / 退出时一次性清掉。
  // 桩里的 setTimeout 为「跑完整局」会立刻执行回调（见文件头），所以这里
  // 把 later 换成只登记、不触发的版本，专测登记与清理。
  const timerPage = stepPage(carryQ);
  timerPage.later = function (ms) { this._timers.push(ms); return 0; };
  timerPage.onOption({ currentTarget: { dataset: { id: answerOf(carryQ) } } });
  eq(timerPage._timers.length, 4, '分步 3 个定时器 + 切题 1 个都登记在册');
  eq(timerPage._timers[3], 1900, '切题窗口排在分步之后，不会提前翻页');
  eq(timerPage.data.revealed, false, '分步期间得数一直盖着');
  timerPage.clearTimers();
  eq(timerPage._timers.length, 0, '一次性清空，不会把揭晓漏到下一题');

  // 桩的 setTimeout 立刻执行：三步回调全部跑完也必须落到「已揭晓」，
  // 不能因为中间某帧异常而把得数永远盖住。
  const seqPage = stepPage(carryQ);
  seqPage.setData({ answered: true, revealed: false, stepNow: -1 });
  seqPage.runSteps();
  eq(seqPage.data.stepNow, 2, '三步走完停在第 2 帧之后');
  eq(seqPage.data.revealed, true, '最后一步必定揭晓得数，不会卡住');

  // 无分步题 / 关掉开关：作答即揭晓，窗口恢复原样。
  const plain = stepPage(plainQ);
  const plainCalls = [];
  plain.later = (ms) => { plainCalls.push(ms); };
  plain.onOption({ currentTarget: { dataset: { id: answerOf(plainQ) } } });
  eq(plain.data.revealed, true, '无分步题作答即揭晓，和旧版一致');
  eq(Math.max.apply(null, plainCalls), 620, '无分步题窗口仍是 620ms');

  save.settings.visualSteps = false;
  G.Store.save(save);
  const off = stepPage(carryQ);
  const offCalls = [];
  off.later = (ms) => { offCalls.push(ms); };
  off.onOption({ currentTarget: { dataset: { id: answerOf(carryQ) } } });
  eq(off.data.revealed, true, '家长关掉分步后作答即揭晓');
  eq(Math.max.apply(null, offCalls), 620, '关掉分步后节奏恢复 620ms');
  ok(!!off.data.visual, '关掉分步不影响积木图');

  // 家长页开关：默认开、能往返、能序列化、总开关关掉时禁用。
  const parent = makeInstance(loadPage('pages/parent/parent.js'));
  parent.onLoad();
  parent.buildPanel();
  eq(parent.data.visualSteps, false, '家长页分步开关反映当前存档值');
  parent.onToggleVisualSteps({ detail: { value: true } });
  eq(parent.data.visualSteps, true, '家长页可重新打开分步');
  eq(save.settings.visualSteps, true, '开关写进 save.settings');
  parent.onToggleVisualSteps({ detail: { value: false } });
  parent.onToggleVisualSteps({ detail: { value: true } });
  eq(parent.data.visualSteps, true, '开关往返后状态正确');
  const dumped = Array.from(storage.keys()).map((k) => {
    const v = storage.get(k);
    return typeof v === 'string' ? v : JSON.stringify(v);
  }).join('');
  ok(dumped.indexOf('visualSteps') >= 0, 'visualSteps 能随存档序列化');
  const pWxml = fs.readFileSync(path.join(MP, 'pages/parent/parent.wxml'), 'utf8');
  ok(/disabled="\{\{!visualMath\}\}"/.test(pWxml), '总开关关掉时分步开关禁用');
  ok(/bindchange="onToggleVisualSteps"/.test(pWxml), '分步开关绑到对应处理函数');

  save.settings.visualSteps = true;
  G.Store.save(save);
}

/* ---- 8h. 1.2.13：星星折算 / 复习局语义 / 音位 / 降码率 / 体检缓存 ---- */
{
  const fs = require('fs');
  const stars8 = require(path.join(MP, 'lib/stars.js'));
  const VE = require(path.join(MP, 'lib/visual-english.js'));

  // 按正确率判档：普通局逐档与旧版一致，短复习局不再吃亏。
  eq(stars8.forCorrect(9, 'chinese', 10), 3, '标准局 9/10 仍是 3 星');
  eq(stars8.forCorrect(6, 'chinese', 10), 2, '标准局 6/10 仍是 2 星');
  eq(stars8.forCorrect(5, 'chinese', 10), 1, '标准局 5/10 仍是 1 星');
  eq(stars8.forCorrect(0, 'chinese', 10), 1, '全错仍有 1 星保底');
  eq(stars8.forCorrect(9, 'chinese'), 3, '省略 total 时按标准 10 题，兼容旧调用');
  eq(stars8.forCorrect(3, 'chinese', 3), 3, '3 题复习局全对拿 3 星（修复前只有 1 星）');
  eq(stars8.forCorrect(5, 'chinese', 5), 3, '5 题复习局全对拿 3 星');
  eq(stars8.forCorrect(8, 'chinese', 8), 3, '8 题复习局全对拿 3 星');
  eq(stars8.forCorrect(4, 'chinese', 5), 2, '5 题对 4 道按 80% 给 2 星');
  eq(stars8.forCorrect(2, 'chinese', 3), 2, '3 题对 2 道按 67% 给 2 星');
  eq(stars8.forCorrect(2, 'chinese', 2), 1, '不足 3 题的极短局固定 1 星，防刷');
  eq(stars8.forCorrect(1, 'chinese', 1), 1, '单题局固定 1 星');

  const finishSrc = fs.readFileSync(path.join(MP, 'pages/play/play.js'), 'utf8');
  ok(/forCorrect\(correct, this\.subject \|\| 'chinese', total\)/.test(finishSrc),
     '结算传入本局题数，复习局不再套绝对阈值');

  // 复习局独立语义：写进 session，难度评估跳过。
  const runnerSrc = fs.readFileSync(path.join(ROOT, 'src/js/40-runner.js'), 'utf8');
  eq((runnerSrc.match(/review: !!round\.review/g) || []).length, 2,
     '完成局和中途退出局都写 review 标记');
  const bankSrc = fs.readFileSync(path.join(ROOT, 'src/js/30-bank.js'), 'utf8');
  ok(/sessions\[i\]\.review\) continue/.test(bankSrc), '难度评估跳过复习局');

  const s8 = app.globalData.save;
  const sessionsBak = s8.sessions;
  const math8 = G.Bank.of('math');
  const mkItems = (ok) => math8.slice(0, 6).map((q) => ({ qid: q.id, correct: ok }));
  s8.sessions = [
    { items: mkItems(true), total: 6 },
    { items: mkItems(false), total: 6, review: true }
  ];
  eq(G.Bank.levelOf(s8, 'math'), 2, '复习局全错不把难度档拉回基础档');
  s8.sessions = [
    { items: mkItems(true), total: 6 },
    { items: mkItems(false), total: 6 }
  ];
  eq(G.Bank.levelOf(s8, 'math'), 1, '普通局全错仍如实降档');
  s8.sessions = sessionsBak;

  // 音位格子按音素，不按字母。
  eq(VE.phonemeCount('six'), 4, 'six 是 4 个音 /s/ /ɪ/ /k/ /s/，不是 3 格');
  eq(VE.phonemeCount('fix'), 4, 'fix 的 x 算两个音');
  eq(VE.phonemeCount('mix'), 4, 'mix 的 x 算两个音');
  eq(VE.phonemeCount('cat'), 3, '普通 CVC 仍是 3 格');
  eq(VE.phonemeCount('yam'), 3, 'yam 仍是 3 格');
  eq(VE.phonemeCount('shop'), 3, 'sh 双字母单音');
  eq(VE.phonemeCount('ball'), 3, 'ball 的 ll 叠字母算一个音');

  // 首页按钮报本局题数，不再报「复习错题（37）」却只做 10 道。
  const homeSrc = fs.readFileSync(path.join(MP, 'pages/home/home.js'), 'utf8');
  ok(/reviewRoundSize: Math\.min\(reviewCount, G\.ROUND_SIZE\)/.test(homeSrc),
     '首页算出本局实际题数（上限 10）');
  const homeWxml = fs.readFileSync(path.join(MP, 'pages/home/home.wxml'), 'utf8');
  ok(/本局 \{\{reviewRoundSize\}\} 题/.test(homeWxml), '按钮文案报本局题数');
  ok(!/复习错题（\{\{reviewCount\}\}）/.test(homeWxml), '不再直接展示错题总数');

  // 音频降码率：清单、生成器、一致性校验三处都要改到位。
  const spec8 = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'src/data/tts_audio.json'), 'utf8'));
  eq(spec8.entries.length, 174, '174 条题干音频');
  ok(/16000Hz \/ 12kbps/.test(spec8.format), '清单记录 16kHz / 12kbps');
  const genSrc = fs.readFileSync(path.join(ROOT, 'tools/gen_tts_audio.py'), 'utf8');
  ok(/aac@16000.*12000/.test(genSrc), '生成器确实用 16kHz / 12kbps');
  ok(/spec\.get\('format'\)/.test(genSrc),
     '清单编码与生成器不一致时会被体检拦住，不能只改参数不重生成');
  ok(/os\.replace\(staged, dest\)/.test(genSrc),
     '重生成走临时文件原子覆盖，不批量删除已有音频');

  // 体检缓存：键要能感知文件变化，且缓存文件不进 git。
  const caSrc = fs.readFileSync(path.join(ROOT, 'tools/check_audio.py'), 'utf8');
  ok(/CACHE_VERSION/.test(caSrc) && /--no-cache/.test(caSrc),
     '体检支持缓存且能强制全量重解码');
  ok(/mtime_ns/.test(caSrc), '缓存键含 mtime_ns，重生成音频立刻失效');
  ok(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
       .indexOf('.audio_health_cache.json') >= 0, '缓存文件不进 git');
}

/* ---- 9. 备份 ---- */
{
  G.Store.exportAll().then(() => {
    ok(true, 'exportAll 在 wx 桩下不抛错');
    finish();
  }).catch((e) => {
    ok(false, 'exportAll 在 wx 桩下不抛错', e && e.message);
    finish();
  });
}

/* ---------------------------------------------------------------- 汇总 */

function finish() {
  console.log('');
  if (failures.length) {
    failures.forEach((f) => console.log('  ✘ ' + f));
    console.log('');
    console.log('失败 ' + failures.length + ' 项（通过 ' + pass + ' 项）');
    process.exitCode = 1;
    return;
  }
  console.log('全部通过 — ' + pass + ' 项断言');
  console.log('');
}
