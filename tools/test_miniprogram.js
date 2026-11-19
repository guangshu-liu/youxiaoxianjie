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

  // 关键：答题前只画两个操作数，结果行靠 WXML 的 answered 关着。
  const cfg = loadPage('pages/play/play.js');
  const page = makeInstance(cfg);
  page.onLoad({ subject: 'math' });
  page.round.questions[page.idx] = sample;
  page.renderQuestion();
  ok(!!page.data.visual, '数学计算题进题带积木数据');
  eq(page.data.visual.left.value, /^(\d+)/.exec(sample.stem.text)[1] * 1,
     '左侧积木对应算式第一个数');
  eq(page.data.answered, false, '答题前结果行不显示，不提前泄答案');
  ok(!!page.data.visual.result, '得数数据已备好，作答后直接揭晓');

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
  eq(p2.data.visual, null, '语文题不出现积木');
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
