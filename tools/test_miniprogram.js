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

// 1.2.20 家长门禁的冷却倒计时要起 setInterval。桩里只登记回调，
// 不让 Node 进程被一个永远不结束的定时器挂住；断言可手动推进回调。
global.__intervals = [];
global.setInterval = (fn) => {
  global.__intervals.push(fn);
  return global.__intervals.length;
};
global.clearInterval = (id) => {
  if (id > 0 && id <= global.__intervals.length) global.__intervals[id - 1] = null;
};

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
  // 1.2.11 起语文的「看拼音选字」也会出图形，1.2.16 起反义词 / 笔画
  // 等题走通用对照卡；两者都不能串进数学积木或算式模板。
  ok(!p2.data.visual ||
     ['pinyin', 'pair'].indexOf(p2.data.visual.kind) >= 0,
     '语文题的图形只会是拼音拆合或对照卡，不会串进积木');
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
  // 1.2.16 补覆盖后从 257/600 涨到 446/600，新增的 kind 是
  // math-sequence（找规律）和 pair（语文词语 / 英语字母对照卡）。
  const cover = {
    'math-calc': 0, 'math-split': 0, 'math-sequence': 0,
    english: 0, pinyin: 0, pair: 0, none: 0
  };
  [math, ch, en].forEach((d) => d.forEach((q) => {
    const v = V.forQuestion(q, true);
    cover[v ? v.kind : 'none']++;
  }));
  eq(cover['math-calc'], 120, '数学计算 100 + 应用题 20 都走积木模板');
  eq(cover['math-split'], 28, '数学拆数题 28 道全部可演示');
  eq(cover['math-sequence'], 20, '找规律 20 道全部可演示');
  eq(cover.english, 110, '英语 84 + 听音选字母 26 道可演示');
  eq(cover.pinyin, 45, '语文 45 道看拼音选字可演示，2 道零声母跳过');
  eq(cover.pair, 123, '语文 93 + 英语 30 道走通用对照卡');
  eq(cover.none, 154, '其余 154 道静默跳过');

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
    // 1.2.20：过程帧可以留在答题前，得数字段 rest 不行。
    if ('rest' in v.steps) bad.push(q.stem.text + ':rest 泄题');
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
  eq(cs.rest, undefined, '1.2.20：66 + 4 的得数不再藏在 steps.rest');
  eq(cs.frames[0].dots.filter((d) => d.cls === 'v-dot-take').length, 4,
     '进位帧① 4 个橙色要搬点');
  eq(cs.frames[1].bars.filter((b) => b.cls === 'v-bar-new').length, 1,
     '进位帧② 出现一根新十棒');

  const bs = V.forQuestion(borrowQ, true).steps;
  eq(bs.need, 7, '94 - 7 要减 7 个点');
  eq(bs.rest, undefined, '1.2.20：94 - 7 的得数个位不再藏在 steps.rest');
  eq(bs.frames[0].bars.filter((b) => b.cls === 'v-bar-break').length, 1,
     '借位帧① 一根十棒标成要拆开');
  eq(bs.frames[1].bars.length, 8, '借位帧② 少了一根棒');
  eq(bs.frames[1].dots.filter((d) => d.cls === 'v-dot-cut').length, 7,
     '借位帧② 划掉 7 个点');

  const ts = V.forQuestion(tenQ, true).steps;
  eq(ts.need, 2, '凑十题拿 2 个去补');
  eq(ts.rest, undefined, '1.2.20：凑十题问号的答案不再藏在 steps.rest');
  eq(ts.frames[0].dots.length, 8, '凑十帧① 画的是题干里的第二个 8');
  eq(ts.frames[1].bars.filter((b) => b.cls === 'v-bar-new').length, 1,
     '凑十帧② 2 个凑成一根十棒');

  eq(V.forQuestion(plainQ, true).steps, null, '不进位题没有分步帧，节奏不变');
  eq(vm.forQuestion(carryQ, false), null, '总开关关掉时不解析');
  eq(vm.makeTenSteps(8, 2, 6).rest, 6, '内部帧生成器仍带 rest（页面拿不到）');
  ok(V.STEP_ANSWER_KEYS.indexOf('rest') >= 0, '得数字段清单对外可查');
  eq(vm.calcSteps(12, 4, '+'), null, '个位相加不满十不分步');
  eq(vm.calcSteps(94, 3, '-'), null, '个位够减不用借位');

  // WXML / WXSS：过程帧只在作答后渲染，得数改由 revealed 控制。
  const wxml = fs.readFileSync(path.join(MP, 'pages/play/play.wxml'), 'utf8');
  ok(/wx:if="\{\{answered && showSteps && visual\.steps\}\}"/.test(wxml),
     '过程帧只在作答后且分步开关打开时渲染，答题前一个得数都不露');
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
  ok(/stars\.forCorrect\(correct, rule, total\)/.test(finishSrc)
     && /this\.review \? 'review'/.test(finishSrc),
     '结算传入本局题数，复习局显式走 review 档，不再套语文阈值');

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
  // 1.2.19 起不再自己 Math.min(条数)：与 buildReviewRound 共用 reviewPicks()。
  const homeSrc = fs.readFileSync(path.join(MP, 'pages/home/home.js'), 'utf8');
  ok(/G\.Runner\.reviewRoundSize\(save\)/.test(homeSrc)
     && /reviewRoundSize: reviewRoundSize/.test(homeSrc),
     '首页按共用抽题逻辑报本局实际题数');
  const homeWxml = fs.readFileSync(path.join(MP, 'pages/home/home.wxml'), 'utf8');
  ok(/本局 \{\{reviewRoundSize\}\} 题/.test(homeWxml), '按钮文案报本局题数');
  ok(!/复习错题（\{\{reviewCount\}\}）/.test(homeWxml), '不再直接展示错题总数');
  ok(/wx:if="\{\{reviewRoundSize >= 3\}\}"/.test(homeWxml),
     '按可出题数决定摆不摆按钮，不再按错题条数');

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

/* ---- 8i. 1.2.14：结算页复习入口 / 哑巴喇叭 / 复习局独立阈值 ---- */
{
  const fs = require('fs');
  const resultSrc = fs.readFileSync(path.join(MP, 'pages/result/result.js'), 'utf8');
  const resultWxml = fs.readFileSync(path.join(MP, 'pages/result/result.wxml'), 'utf8');
  const playSrc = fs.readFileSync(path.join(MP, 'pages/play/play.js'), 'utf8');
  const starsSrc = fs.readFileSync(path.join(MP, 'lib/stars.js'), 'utf8');
  const stars9 = require(path.join(MP, 'lib/stars.js'));

  // 复习局有独立一档：临时把数学改成 8/5，复习局也不该跟着变。
  ok(/review:\s*\{ three: 9, two: 6 \}/.test(starsSrc),
     '星星规则表里有独立的 review 档');
  ok(/this\.review \? 'review'/.test(playSrc), '结算显式传 review，不再落到语文');
  const mathBak = stars9.RULES.math;
  stars9.RULES.math = { three: 8, two: 5 };
  eq(stars9.forCorrect(8, 'review', 10), 2,
     '把数学调成 8/5 后，复习局仍按 review 的 9/6 给 2 星');
  eq(stars9.forCorrect(8, 'math', 10), 3, '数学本局确实按新阈值升到 3 星');
  stars9.RULES.math = mathBak;
  eq(stars9.forCorrect(8, 'chinese', 10), 2, '恢复后普通语文局不受影响');
  eq(stars9.forCorrect(3, 'review', 3), 3, '3 题复习局全对仍给 3 星');

  // 喇叭不能只看「映射表非空」，还要查这句题干有没有对应音频。
  ok(/tts\.available\(\)\s*&&\s*tts\.has\(readInfo\.text\)/.test(playSrc),
     '读题按钮同时检查映射表与这句题干的音频');
  const MAP9 = require(path.join(MP, 'generated/data/tts-map.js'));
  const tts9 = require(path.join(MP, 'lib/tts.js'));
  const anyText = Object.keys(MAP9)[0];
  const anySrc = MAP9[anyText];
  delete MAP9[anyText];
  eq(tts9.has(anyText), false, '映射表少一句时 has() 立刻返回 false');
  eq(tts9.speak(anyText), false, '缺音频的文本不会被静默排队播放');
  MAP9[anyText] = anySrc;

  // 端到端：模拟「题库加了新题型、忘了重跑 tts:audio」。
  const stemBak = app.globalData.save.settings.readStem;
  app.globalData.save.settings.readStem = true;
  const origForQuestion = G.TTSText.forQuestion;
  G.TTSText.forQuestion = function () {
    return { text: '__本地新题型_没有音频__', skip: false };
  };
  const p9 = makeInstance(loadPage('pages/play/play.js'));
  p9.onLoad({ subject: 'chinese' });
  eq(p9.data.canRead, false, '新增题型没生成音频时不画哑巴喇叭');
  eq(p9.data.readText, '', '喇叭不出现时也不留朗读文本');
  G.TTSText.forQuestion = origForQuestion;
  app.globalData.save.settings.readStem = stemBak;

  // 结算页按钮：只有「普通局 + 有错题 + 错题本够 3 题」才出现。
  ok(/bindtap="onReview"/.test(resultWxml) &&
     /wx:if="\{\{reviewRoundSize >= 3\}\}"/.test(resultWxml),
     '结算页按错题数决定是否摆复习入口（与首页同阈值）');
  ok(/复习错题（本局 \{\{reviewRoundSize\}\} 题）/.test(resultWxml),
     '按钮只报即将开的一局有几题，不承诺全是刚错的题');
  ok(/wx\.redirectTo\(\{ url: '\/pages\/play\/play\?mode=review' \}\)/.test(resultSrc),
     '复习按钮用 redirectTo 跳复习局，不堆页面栈');
  ok(/r\.correct < r\.total && !this\.review/.test(resultSrc),
     '全对局和复习局都不重复摆复习入口');
  // 1.2.19：截断与去重 / 失效过滤都收进共用 reviewRoundSize()，
  // 结算页不再自己 Math.min(条数)。
  ok(/reviewRoundSize = G\.Runner\.reviewRoundSize\(getApp\(\)\.globalData\.save\)/.test(resultSrc),
     '结算页与首页、组局共用同一份本局题数');

  const save9 = app.globalData.save;
  const wrongBak = save9.wrongBook;
  const mkResult = (correct, review) => ({
    subject: 'math', review: review, correct: correct, total: 10,
    stars: 2, nominal: 2, capped: false,
    lifetime: save9.points.lifetime, lifetimeBefore: save9.points.lifetime
  });
  // 1.2.19：换成真实题库 id。以前用 'fake-N' 假 qid 造错题本，
  // 按钮报数按条数算照样能过，一旦口径改成「反查题库」就全露馅 ——
  // 1.2.16 的关卡地图正是被这种假数据漏掉真 bug 的。
  const mathIds9 = G.Bank.of('math').map((q) => q.id);
  const mkWrong = (n) => Array.from({ length: n }, (_, i) => ({
    qid: mathIds9[i], wrongCount: 1, lastWrongAt: i, cleared: false
  }));

  save9.wrongBook = mkWrong(4);
  app.globalData.lastResult = mkResult(6, false);
  wx.__lastNav = null;
  const rp = makeInstance(loadPage('pages/result/result.js'));
  rp.onLoad();
  eq(rp.data.reviewRoundSize, 4, '错 4 题时结算页报「本局 4 题」');
  rp.onReview();
  ok(!!wx.__lastNav && wx.__lastNav.url === '/pages/play/play?mode=review',
     '点复习按钮直接进复习局');

  app.globalData.lastResult = mkResult(10, false);
  const rp2 = makeInstance(loadPage('pages/result/result.js'));
  rp2.onLoad();
  eq(rp2.data.reviewRoundSize, 0, '全对局不摆复习按钮');

  app.globalData.lastResult = mkResult(6, true);
  const rp3 = makeInstance(loadPage('pages/result/result.js'));
  rp3.onLoad();
  eq(rp3.data.reviewRoundSize, 0, '复习局结算不摆第二个重复的复习入口');

  save9.wrongBook = mkWrong(12);
  app.globalData.lastResult = mkResult(7, false);
  const rp4 = makeInstance(loadPage('pages/result/result.js'));
  rp4.onLoad();
  eq(rp4.data.reviewRoundSize, 10, '错题超过一局上限时报 10 题');
  const appWxss = fs.readFileSync(path.join(MP, 'app.wxss'), 'utf8');
  ok(/\.btn-review\s*\{/.test(appWxss), '复习按钮有区别于主按钮的暖色描边样式');

  save9.wrongBook = wrongBak;
}

/* ---- 8j. 1.2.15：徽章兑现 / 错题小怪物 / 每日小目标 ---- */
{
  const fs = require('fs');
  const R = require(path.join(MP, 'lib/rewards.js'));
  const homeWxml = fs.readFileSync(path.join(MP, 'pages/home/home.wxml'), 'utf8');
  const parentWxml = fs.readFileSync(path.join(MP, 'pages/parent/parent.wxml'), 'utf8');
  const parentSrc = fs.readFileSync(path.join(MP, 'pages/parent/parent.js'), 'utf8');
  const appWxss9 = fs.readFileSync(path.join(MP, 'app.wxss'), 'utf8');
  const rewardsSrc = fs.readFileSync(path.join(MP, 'lib/rewards.js'), 'utf8');
  const saveB = app.globalData.save;

  // 备份，别污染后面的备份导出测试
  const sessionsB = saveB.sessions;
  const wrongB = saveB.wrongBook;
  const claimsB = saveB.badgeClaims;
  const lifetimeB = saveB.points.lifetime;
  const balanceB = saveB.points.balance;
  const monstersB = saveB.settings.monsters;
  const dailyGoalB = saveB.settings.dailyGoal;

  const now = Date.now();
  const mkSession = (ts, extra) => Object.assign({ ts: ts }, extra || {});

  // --- 今日局数口径：与家长页「今日局数」同源 ---
  saveB.sessions = [
    mkSession(now),
    mkSession(now, { aborted: true }),
    mkSession(now - 86400000),
    mkSession(now, { review: true })
  ];
  eq(R.roundsToday(saveB), 2, '今天 2 局：中途退出和昨天的都不算，复习局算');
  eq(R.GOAL, 2, '每日小目标是 2 局');
  eq(R.goalState(saveB).reached, true, '2 局达成目标');
  ok(/目标完成/.test(R.goalState(saveB).text), '达成文案');
  saveB.sessions = [mkSession(now)];
  eq(R.goalState(saveB).reached, false, '1 局未达成');
  ok(/今天 1 \/ 2 局/.test(R.goalState(saveB).text), '未达成文案报进度');
  eq(R.goalState(saveB).done, 1, 'done 是实际完成局数');
  saveB.sessions = [];
  eq(R.roundsToday(saveB), 0, '没玩过是 0 局');
  eq(R.goalState(saveB).reached, false, '0 局没达成');

  // --- 小怪物：血量跟着 rightStreak，cleared 即被收服 ---
  // 1.2.19：同样换成真实题库 id，让「复习按钮报数」的断言走真实链路。
  const idsB = G.Bank.of('math').slice(0, 4).map((q) => q.id);
  saveB.wrongBook = [
    { qid: idsB[0], subject: 'math', wrongCount: 5, rightStreak: 0, cleared: false, lastWrongAt: 3 },
    { qid: idsB[1], subject: 'chinese', wrongCount: 3, rightStreak: 1, cleared: false, lastWrongAt: 2 },
    { qid: idsB[2], subject: 'english', wrongCount: 1, rightStreak: 0, cleared: false, lastWrongAt: 1 },
    { qid: idsB[3], subject: 'math', wrongCount: 9, rightStreak: 2, cleared: true, lastWrongAt: 9 }
  ];
  const mon = R.monstersOf(saveB);
  eq(mon.total, 3, 'cleared 的题已收服，不再出现在首页');
  eq(mon.shown.length, 3, '3 只全部显示');
  eq(mon.shown[0].id, idsB[0], '错得最多的排最前，和复习局同源');
  eq(mon.shown[0].hp, 2, 'rightStreak=0 是满血 2 格');
  eq(mon.shown[1].hp, 1, '连对 1 次掉 1 格血');
  eq(mon.shown[0].subject, '数学', '怪物带科目标签');
  eq(mon.shown[0].tone, 0, '颜色按位置轮换');
  eq(R.monstersOf(saveB, 2).shown.length, 2, '首页最多摆几只可控');
  eq(R.HP, 2, '血量与 cleared 的 rightStreak >= 2 对齐');
  eq(R.MONSTER_LIMIT, 5, '默认最多 5 只，不挤爆首页');

  // --- 徽章兑现：老存档兼容 ---
  delete saveB.badgeClaims;
  eq(Object.keys(R.claimsOf(saveB)).length, 0, '老存档没有 badgeClaims 时按未兑现');
  const bs0 = R.badgeList(saveB, stars.badgeState(100));
  eq(bs0.length, 4, '四个徽章都列出');
  ok(bs0.every((b) => b.got && !b.claimed), '老存档里四枚都解锁、都没兑现');
  eq(bs0[0].claimedAt, '', '未兑现没有日期');
  eq(R.badgeList({ badgeClaims: { 10: '2026-11-23' } }, stars.badgeState(100))[0].claimed,
     true, '按 need 取兑现记录，换图标改名也不丢');

  // --- 家长页：写入 / 撤销 / 未解锁不能勾 / 不动账目 ---
  const pcfg9 = loadPage('pages/parent/parent.js');
  const pp9 = makeInstance(pcfg9);
  pp9.onLoad();
  pp9.setData({ gateInput: String(G.PARENT_GATE.answer) });
  pp9.onGateSubmit();
  eq(pp9.data.unlocked, true, '门禁通过后进面板');
  saveB.points.lifetime = 100;
  pp9.buildPanel();
  eq(pp9.data.badges.length, 4, '家长页列出四枚徽章');
  pp9.onToggleBadgeClaim({ detail: { value: true }, currentTarget: { dataset: { need: '10' } } });
  eq(saveB.badgeClaims[10], G.localDateStr(), '勾选写入兑现日期');
  ok(pp9.data.badges[0].claimed, '面板立刻刷新为已兑现');
  const raw9 = storage.get(G.Store.KEY);
  ok(!!raw9 && JSON.parse(raw9).badgeClaims[10] === G.localDateStr(),
     '兑现记录真的写进存储，备份导出也带得走');
  eq(saveB.points.balance, balanceB, '兑现不扣当前星星');
  eq(saveB.points.lifetime, 100, '兑现不改累计星星');
  eq(saveB.sessions.length, 0, '兑现不写 sessions');
  eq(saveB.redemptions.length, 0, '兑现不写现金兑换记录');
  pp9.onToggleBadgeClaim({ detail: { value: false }, currentTarget: { dataset: { need: '10' } } });
  eq(saveB.badgeClaims[10], undefined, '误勾可以取消');
  saveB.points.lifetime = 5;
  pp9.buildPanel();
  pp9.onToggleBadgeClaim({ detail: { value: true }, currentTarget: { dataset: { need: '50' } } });
  eq(!!saveB.badgeClaims[50], false, '没解锁的徽章不能标记兑现');
  saveB.points.lifetime = lifetimeB;

  // --- 两个家长开关 ---
  pp9.onToggleMonsters({ detail: { value: false } });
  eq(saveB.settings.monsters, false, '小怪物开关写进存档');
  eq(pp9.data.monsters, false, '面板状态同步');
  pp9.onToggleDailyGoal({ detail: { value: false } });
  eq(saveB.settings.dailyGoal, false, '小目标开关写进存档');
  eq(pp9.data.dailyGoal, false, '面板状态同步');
  eq(pp9.data.today.sessions, R.roundsToday(saveB), '家长页今日局数与首页同口径');

  // --- 首页：开关、副标题、复习入口不受显示开关影响 ---
  saveB.settings.monsters = true;
  saveB.settings.dailyGoal = true;
  saveB.badgeClaims = { 10: '2026-11-23' };
  saveB.points.lifetime = 100;
  saveB.sessions = [mkSession(now)];
  const hp9 = makeInstance(loadPage('pages/home/home.js'));
  hp9.onShow();
  eq(hp9.data.monsters.length, 3, '首页渲染 3 只小怪物（第 4 只已收服）');
  eq(hp9.data.monsterTotal, 3, '总数与错题本一致');
  ok(hp9.data.badges[0].claimed, '已兑现徽章带 claimed 角标数据');
  ok(/今天 1 \/ 2 局/.test(hp9.data.subTitle), '副标题带今日小目标，不新增一行');
  eq(hp9.data.goalReached, false, '1 局未达成，不变色');
  eq(hp9.data.reviewRoundSize, 3, '复习按钮仍按真实错题数');

  saveB.sessions = [mkSession(now), mkSession(now)];
  hp9.onShow();
  eq(hp9.data.goalReached, true, '2 局达成后变色');
  ok(/目标完成/.test(hp9.data.subTitle), '达成文案出现在副标题');

  saveB.settings.monsters = false;
  saveB.settings.dailyGoal = false;
  hp9.onShow();
  eq(hp9.data.monsters.length, 0, '关掉开关后首页不渲染小怪物');
  ok(!/今天/.test(hp9.data.subTitle), '关掉开关后副标题恢复原文案');
  eq(hp9.data.reviewRoundSize, 3, '显示开关绝不影响复习入口');

  // --- 静态结构 ---
  // 1.2.24 首页收成极简版后，角标与小怪物行不再摆在首页；兑现记录、开关、
  // 数据层都还在（下面 4 条 + 上面的 data 断言共同兜住，不是把功能删了）。
  ok(!/badge-claimed/.test(homeWxml), '首页极简版不摆「已换」角标');
  ok(!/monster-row/.test(homeWxml), '首页极简版不摆小怪物行');
  ok(/checked="\{\{item\.claimed\}\}"/.test(parentWxml), '兑现记录仍在家长页可见可改');
  ok(/function badgeList/.test(rewardsSrc) && /claimed:\s*!!at/.test(rewardsSrc),
     'badgeList 仍产出 claimed，首页随时能恢复角标');
  ok(/bindchange="onToggleBadgeClaim"/.test(parentWxml) &&
     /data-need="\{\{item\.need\}\}"/.test(parentWxml), '家长页兑现开关按 need 绑定');
  ok(/disabled="\{\{!item\.got\}\}"/.test(parentWxml), '未解锁的开关禁用');
  ok(/bindchange="onToggleMonsters"/.test(parentWxml) &&
     /bindchange="onToggleDailyGoal"/.test(parentWxml), '两个家长开关都在面板里');
  ok(/rewards\.roundsToday\(save\)/.test(parentSrc), '家长页复用同一份今日局数口径');
  ok(/\.badge-strip\s*\{/.test(appWxss9) && /\.badge-name\s*\{/.test(appWxss9),
     '结算页复用的徽章样式没被一起删掉');
  ok(!/\.monster-face/.test(appWxss9) && !/\.badge-claimed/.test(appWxss9),
     '首页专属死规则清干净');
  ok(!/require\([^)]*\bsrc\//.test(rewardsSrc),
     '新模块不引用共用 src/ 逻辑，网页版产物零改动');

  // 恢复现场
  saveB.sessions = sessionsB;
  saveB.wrongBook = wrongB;
  if (claimsB === undefined) delete saveB.badgeClaims;
  else saveB.badgeClaims = claimsB;
  saveB.points.lifetime = lifetimeB;
  saveB.points.balance = balanceB;
  saveB.settings.monsters = monstersB;
  saveB.settings.dailyGoal = dailyGoalB;
  G.Store.save(saveB);
}

/* ---- 8k. 1.2.16：关卡地图 / 视觉补覆盖 / 大字模式 / 正确率折线 ---- */
{
  const fs = require('fs');
  const P = require(path.join(MP, 'lib/progress.js'));
  const V = require(path.join(MP, 'lib/visual.js'));
  const homeWxmlK = fs.readFileSync(path.join(MP, 'pages/home/home.wxml'), 'utf8');
  const playWxmlK = fs.readFileSync(path.join(MP, 'pages/play/play.wxml'), 'utf8');
  const resultWxmlK = fs.readFileSync(path.join(MP, 'pages/result/result.wxml'), 'utf8');
  const parentWxmlK = fs.readFileSync(path.join(MP, 'pages/parent/parent.wxml'), 'utf8');
  const parentWxssK = fs.readFileSync(path.join(MP, 'pages/parent/parent.wxss'), 'utf8');
  const parentSrcK = fs.readFileSync(path.join(MP, 'pages/parent/parent.js'), 'utf8');
  const appWxssK = fs.readFileSync(path.join(MP, 'app.wxss'), 'utf8');
  const progressSrc = fs.readFileSync(path.join(MP, 'lib/progress.js'), 'utf8');
  const pairsSrc = fs.readFileSync(path.join(MP, 'lib/visual-pairs.js'), 'utf8');

  const saveK = app.globalData.save;
  const sessionsK = saveK.sessions;
  // 1.2.21：累计计数器是独立真相源，清空 sessions 也不会归零。
  // 这一段的「没玩过」断言要把它一起隔离，否则会被前面测试段写过的
  // 计数器带偏；段尾照原样还原。
  const roundsK = saveK.rounds;
  saveK.rounds = {};
  const levelMapK = saveK.settings.levelMap;
  const bigTextK = saveK.settings.bigText;
  const lastResultK = app.globalData.lastResult;

  const mkS = (subject, extra) => Object.assign(
    { ts: Date.now(), subject: subject, correct: 8, total: 10 }, extra || {});
  const loadBankK = (f) => JSON.parse(
    fs.readFileSync(path.join(ROOT, 'src/data/' + f + '.json'), 'utf8'));
  const bankK = [].concat(loadBankK('math'), loadBankK('chinese'), loadBankK('english'));
  const byTag = (t) => bankK.filter((q) => (q.tags || [])[0] === t);

  // --- 关卡地图：累计局数、轮次、边界 ---
  eq(P.LAP, 6, '每 6 关一轮');
  saveK.sessions = [];
  let lm = P.levelMap(saveK);
  eq(lm.length, 3, '三科各一条地图');
  eq(lm[0].cleared, 0, '没玩过时一格都不亮');
  eq(lm[0].nodes.filter((n) => n.done).length, 0, '没玩过时没有已过关节点');
  eq(lm[0].nodes[0].now, true, '第 1 关标成「下一关」');
  ok(/第 1 关/.test(lm[0].title), '标题是第 1 关');

  saveK.sessions = [mkS('math'), mkS('math'), mkS('math')];
  const mathRow = P.levelMapBySubject(saveK).math;
  eq(mathRow.cleared, 3, '玩 3 局点亮 3 格');
  eq(mathRow.nodes[3].now, true, '下一关是第 4 关');
  eq(P.levelMapBySubject(saveK).chinese.cleared, 0, '数学的点不会串到语文');
  ok(!!P.levelMapBySubject(saveK).english, '按科目取，不依赖数组下标');

  saveK.sessions = [];
  for (let i = 0; i < 6; i++) saveK.sessions.push(mkS('math'));
  const fullRow = P.levelMapBySubject(saveK).math;
  eq(fullRow.cleared, 6, '刚走满一轮仍是 6 格全亮，不立刻清零');
  eq(fullRow.justFinished, true, '刚通关标记');
  ok(/通关/.test(fullRow.title), '通关文案');
  saveK.sessions.push(mkS('math'));
  const nextRow = P.levelMapBySubject(saveK).math;
  eq(nextRow.cleared, 1, '第 7 局开新一轮回到第 1 格');
  ok(/第 2 轮/.test(nextRow.lapText), '轮次 +1，孩子看到的是新地图不是倒退');

  saveK.sessions = [mkS('math'), mkS('math', { aborted: true }),
                    mkS(undefined, { review: true }), mkS('chinese')];
  eq(P.roundsOf(saveK, 'math'), 1, '中途退出不算一关');
  eq(P.roundsOf(saveK, 'english'), 0, '复习局没有 subject，不计入任何一科');
  eq(P.roundsOf(saveK, 'chinese'), 1, '语文按自己的局数走');

  // --- 正确率折线：坐标、角度、脏数据、上限 ---
  saveK.sessions = [
    { ts: 1, correct: 5, total: 10, subject: 'math' },
    { ts: 2, correct: 10, total: 10, subject: 'math' },
    { ts: 3, correct: 0, total: 10, subject: 'math', aborted: true },
    { ts: 4, correct: 10, total: 0, subject: 'math' }
  ];
  let tr = P.trend(saveK);
  eq(tr.count, 2, '排除中途退出和 0 题的局');
  eq(tr.avg, 75, '平均正确率 75%');
  eq(tr.points.length, 2, '两个点');
  eq(tr.segments.length, 1, '两点一段线');
  eq(tr.points[0].y, 75, '50% 落在 18 + 57 的 rpx 坐标');
  eq(tr.points[1].y, 132, '100% 落在绘图区顶');
  ok(tr.segments[0].deg < 0, '正确率上升时线段向上，角度为负');
  eq(tr.segments[0].x, 30, '线段从左点起');

  saveK.sessions = [{ ts: 1, correct: 7, total: 10 }, { ts: 2, correct: 7, total: 10 }];
  eq(P.trend(saveK).segments[0].deg, 0, '两点一样高时是水平线');
  saveK.sessions = [{ ts: 1, correct: 7, total: 10 }];
  tr = P.trend(saveK);
  eq(tr.segments.length, 0, '只有一局时不画线');
  eq(tr.points[0].x, 300, '单个点居中');
  saveK.sessions = [];
  for (let i = 0; i < 12; i++) saveK.sessions.push({ ts: i, correct: 7, total: 10 });
  eq(P.trend(saveK).count, 10, '默认只取最近 10 局');
  eq(P.trend(saveK, 3).count, 3, '上限可传参');
  eq(P.trend(saveK, 3).segments.length, 2, '3 个点 2 段线');

  // --- 大字模式口径 ---
  ok(!P.bigTextOf({}), '老存档（没有 settings）默认关');
  ok(!P.bigTextOf({ settings: {} }), '有 settings 但没这个键也默认关');
  ok(P.bigTextOf({ settings: { bigText: true } }), '显式打开才放大');
  ok(!P.bigTextOf({ settings: { bigText: false } }), '关掉就不放大');

  // --- 首页：两个新开关、默认开、不影响复习入口 ---
  delete saveK.settings.levelMap;
  delete saveK.settings.bigText;
  saveK.sessions = [mkS('math'), mkS('math')];
  const hpK = makeInstance(loadPage('pages/home/home.js'));
  hpK.onShow();
  ok(!!hpK.data.levels, '关卡地图默认开');
  eq(hpK.data.levels.math.cleared, 2, '首页地图读到 2 局');
  eq(hpK.data.bigText, false, '大字模式默认关');
  saveK.settings.levelMap = false;
  hpK.onShow();
  eq(hpK.data.levels, null, '关掉后首页不渲染关卡点');
  eq(hpK.data.reviewRoundSize, G.Runner.reviewRoundSize(saveK),
     '显示开关不影响复习入口，且报数与组局同源');
  saveK.settings.bigText = true;
  hpK.onShow();
  eq(hpK.data.bigText, true, '首页读到大字模式');

  // --- 家长页：新开关写存档、折线数据进面板 ---
  const ppK = makeInstance(loadPage('pages/parent/parent.js'));
  ppK.onLoad();
  ppK.setData({ gateInput: String(G.PARENT_GATE.answer) });
  ppK.onGateSubmit();
  eq(ppK.data.unlocked, true, '门禁通过');
  ppK.buildPanel();
  ok(!!ppK.data.trend && ppK.data.trend.count >= 1, '面板拿到折线数据');
  eq(ppK.data.levelMap, false, '面板同步地图开关状态');
  const lifetimeK0 = saveK.points.lifetime;
  const balanceK0 = saveK.points.balance;
  const redemptionsK0 = saveK.redemptions.length;
  ppK.onToggleLevelMap({ detail: { value: true } });
  eq(saveK.settings.levelMap, true, '地图开关写进存档');
  eq(ppK.data.levelMap, true, '面板状态同步');
  ppK.onToggleBigText({ detail: { value: false } });
  eq(saveK.settings.bigText, false, '大字开关写进存档');
  eq(ppK.data.bigText, false, '面板状态同步');
  eq(saveK.points.lifetime, lifetimeK0, '两个新开关不碰累计星星');
  eq(saveK.points.balance, balanceK0, '两个新开关不碰当前星星');
  eq(saveK.redemptions.length, redemptionsK0, '两个新开关不写兑换记录');

  // --- play 页：大字模式不影响组局 ---
  saveK.settings.bigText = true;
  const plK = makeInstance(loadPage('pages/play/play.js'));
  plK.onLoad({ subject: 'math' });
  eq(plK.data.bigText, true, '答题页读到大字模式');
  ok(plK.data.total > 0, '大字模式照样正常组局');
  saveK.settings.bigText = false;
  const plK2 = makeInstance(loadPage('pages/play/play.js'));
  plK2.onLoad({ subject: 'math' });
  eq(plK2.data.bigText, false, '关掉后恢复原字号');

  // --- 视觉演示补覆盖 ---
  const wordQ = byTag('应用题')[0];                  // 74 + 6 = 80
  let vK = V.forQuestion(wordQ, true);
  eq(vK.kind, 'math-calc', '应用题复用积木模板，零 WXML 改动');
  eq(vK.op, '+', '正确答案反推出加法');
  eq(vK.story, true, '带上应用题标记');
  eq(vK.steps, null, '应用题不拉长切题窗口');
  eq(vK.left.label, '74', '左操作数是题干第一个数');
  eq(vK.right.label, '6', '右操作数是题干第二个数');
  eq(vK.result, undefined, '答题前没有得数积木');
  eq(V.reveal(wordQ, true).result.label, '80', '作答后才揭晓得数');
  const minusQ = byTag('应用题').filter((q) => /吃了/.test(q.stem.text))[0];
  eq(V.forQuestion(minusQ, true).op, '-', '减法应用题也能反推');
  const badWord = JSON.parse(JSON.stringify(wordQ));
  badWord.options.forEach((o) => { if (o.id === badWord.answer) o.text = '999'; });
  eq(V.forQuestion(badWord, true), null, '得数对不上就不演示，绝不画错图');

  const seqQ = byTag('找规律')[0];                  // 14、17、20、（ ）= 23
  vK = V.forQuestion(seqQ, true);
  eq(vK.kind, 'math-sequence', '找规律走新模板');
  eq(vK.items.length, 3, '题干三个数摆成三张卡');
  eq(vK.items[0].gap, '+3', '差值是解题过程，只在 revealed 后渲染');
  eq(vK.answer, undefined, '答题前没有答案字段');
  eq(V.reveal(seqQ, true).answer.label, '23', '作答后原位翻出得数');

  const antiQ = byTag('反义词')[0];                 // 「大」→「小」
  vK = V.forQuestion(antiQ, true);
  eq(vK.kind, 'pair', '反义词走通用对照卡');
  eq(vK.left, '大', '已知项来自题干');
  eq(vK.op, '反义词', '问什么写清楚');
  eq(vK.big, true, '单字放大');
  eq(vK.answer, undefined, '对照卡答题前没有答案');
  eq(V.reveal(antiQ, true).answer.label, '小', '作答后才翻出正确字');
  eq(V.forQuestion(byTag('笔画')[0], true).op, '几笔', '笔画题也进对照卡');
  eq(V.forQuestion(byTag('偏旁')[0], true).op, '字旁', '偏旁题也进对照卡');
  eq(V.forQuestion(byTag('大小写配对').filter((q) => /^小写/.test(q.stem.text))[0], true).op,
     '大写', '小写找大写的反向题也覆盖');
  const orderQ = byTag('字母顺序').filter((q) => /下一个/.test(q.stem.text))[0];
  eq(V.forQuestion(orderQ, true).op, '下一个字母', '字母顺序跟着题干走，不写死');

  const iniQ = byTag('听音选字母')[0];              // en.ant → A
  vK = V.forQuestion(iniQ, true);
  eq(vK.kind, 'english', '听音选字母复用英语模板');
  eq(vK.before.type, 'slots', '答题前只有音位格子');
  ok(vK.before.slots.length >= 3, '格子按音素数给');
  eq(vK.after, undefined, '答题前没有单词');
  const iniReveal = V.reveal(iniQ, true);
  eq(iniReveal.after.word, 'ant', '作答后显示音频里的整词');
  eq(iniReveal.after.letters[0].cls, 'v-letter-lead', '开头字母高亮');
  eq(iniReveal.after.letters[1].cls, '', '其余字母不高亮');
  eq(V.forQuestion(byTag('听音选词')[0], true).after, undefined,
     '老的听音选词题行为不变');

  eq(V.forQuestion(wordQ, false), null, '家长关掉演示后应用题也不画');
  eq(V.forQuestion(seqQ, false), null, '关掉后找规律也不画');
  eq(V.forQuestion(antiQ, false), null, '关掉后对照卡也不画');
  eq(V.forQuestion(iniQ, false), null, '关掉后听音选字母也不画');

  let leakK = 0;
  bankK.forEach((q) => {
    const v = V.forQuestion(q, true);
    if (v && V.ANSWER_KEYS.some((k) => v[k] !== undefined)) leakK++;
  });
  eq(leakK, 0, '补覆盖后全题库答题前仍一个答案字段都没有');

  // --- 静态结构：只在小程序端，网页版产物零改动 ---
  ok(/visual\.kind === 'math-sequence'/.test(playWxmlK) &&
     /visual\.kind === 'pair'/.test(playWxmlK), '答题页两个新模板分支都在');
  ok(/class="v-letter \{\{L\.cls\}\}"/.test(playWxmlK), '字母卡片支持首字母高亮');
  ok(/\.level-inline/.test(appWxssK) && /levels\.math\.nodes/.test(homeWxmlK),
     '关卡点挂在三科按钮内部，不新增一行');
  ok(/big-text/.test(homeWxmlK) && /big-text/.test(playWxmlK) &&
     /big-text/.test(resultWxmlK), '三个孩子可见页面都挂大字 class');
  ok(/\.big-text \.stem-text/.test(appWxssK) &&
     /\.big-text \.option-text/.test(appWxssK), '大字规则覆盖题干和选项');
  ok(/bindchange="onToggleLevelMap"/.test(parentWxmlK) &&
     /bindchange="onToggleBigText"/.test(parentWxmlK), '两个新家长开关都在面板里');
  ok(/progress\.trend\(save\)/.test(parentSrcK), '折线数据走纯函数');
  ok(/transform:rotate\(\{\{item\.deg\}\}deg\)/.test(parentWxmlK) &&
     /\.trend-seg/.test(parentWxssK), '折线由绝对定位的线段和点组成，无 canvas');
  ok(!/require\([^)]*\bsrc\//.test(progressSrc) &&
     !/require\([^)]*\bsrc\//.test(pairsSrc), '新模块不引用共用 src/ 逻辑');

  // --- 恢复现场，别污染备份导出测试 ---
  saveK.sessions = sessionsK;
  if (roundsK === undefined) delete saveK.rounds;
  else saveK.rounds = roundsK;
  if (levelMapK === undefined) delete saveK.settings.levelMap;
  else saveK.settings.levelMap = levelMapK;
  if (bigTextK === undefined) delete saveK.settings.bigText;
  else saveK.settings.bigText = bigTextK;
  app.globalData.lastResult = lastResultK;
  G.Store.save(saveK);
}

/* ---- 8L. 1.2.17：七个真机可复现 bug 的回归 ---- */
{
  const fs = require('fs');
  const P17 = require(path.join(MP, 'lib/progress.js'));
  const V17 = require(path.join(MP, 'lib/visual.js'));
  const playWxml17 = fs.readFileSync(path.join(MP, 'pages/play/play.wxml'), 'utf8');
  const playSrc17 = fs.readFileSync(path.join(MP, 'pages/play/play.js'), 'utf8');
  const parentSrc17 = fs.readFileSync(path.join(MP, 'pages/parent/parent.js'), 'utf8');
  const homeSrc17 = fs.readFileSync(path.join(MP, 'pages/home/home.js'), 'utf8');
  const runnerSrc17 = fs.readFileSync(path.join(ROOT, 'src/js/40-runner.js'), 'utf8');

  /* ① 关卡地图：必须走「真正打完一局」的链路，不喂手工造的假 sessions。
   *    1.2.16 的断言全是 mkS('math') 手工对象（自带 subject），所以
   *    finishSession 根本没存 subject 这件事被完整漏掉了。 */
  const saveFix = G.Store.defaultSave();
  const roundFix = G.Runner.buildSubjectRound(saveFix, 'math', G.ROUND_SIZE);
  ok(roundFix.questions.length > 0, '真实题库组出了一局数学题');
  const itemsFix = roundFix.questions.map((q) => ({
    qid: q.id, subject: q.subject, correct: true, ms: 700
  }));
  G.Runner.finishSession(saveFix, roundFix, itemsFix, [], 0);
  const sessFix = saveFix.sessions[saveFix.sessions.length - 1];
  eq(sessFix.subject, undefined, '共用 Runner 写的 session 仍没有 subject');
  ok(sessFix.items.length > 0 && !!sessFix.items[0].subject,
     '但每题的 items 都带科目，够用来推断');
  eq(P17.roundsOf(saveFix, 'math'), 1, '真实完成局能被关卡地图数到');
  eq(P17.levelMapBySubject(saveFix).math.cleared, 1, '打完一局真的点亮一格');
  eq(P17.levelMapBySubject(saveFix).math.fullTitle, '第 2 关', '关卡文案跟着前进');
  eq(P17.levelMapBySubject(saveFix).chinese.cleared, 0, '数学的局不会串到语文');
  G.Store.save(app.globalData.save);   // finishSession 写过盘，把测试现场还原

  ok(!/subject:\s*round\.subject/.test(runnerSrc17),
     '修关卡地图没有动共用 Runner，网页版产物零改动');
  eq(P17.subjectOf({ subject: 'math' }), 'math', '新存档若带 subject 直接采用');
  eq(P17.subjectOf({ items: [{ subject: 'math' }, { subject: 'math' }] }), 'math',
     '老存档从 items 推断单科局');
  eq(P17.subjectOf({ items: [{ subject: 'math' }, { subject: 'chinese' }] }), '',
     '复习局/混合科目局不归任何一科');
  eq(P17.subjectOf({ subject: 'math', review: true }), '', '复习局明确排除');
  eq(P17.subjectOf({ subject: 'math', aborted: true }), '', '中途退出明确排除');

  /* ⑦ 轮次文案：刚通关时不能一边 6 格全亮一边写「第 2 轮」。 */
  const lapSave17 = { wrongBook: [], sessions: [] };
  for (let i = 0; i < 6; i++) lapSave17.sessions.push({ ts: Date.now(), subject: 'math' });
  const lap6 = P17.levelMapBySubject(lapSave17).math;
  eq(lap6.cleared, 6, '刚通关仍是 6 格全亮');
  eq(lap6.fullTitle, '第 1 轮 · 通关', '刚通关属于第 1 轮，不自相矛盾');
  ok(!/第 2 轮/.test(lap6.fullTitle), '刚通关不提前宣布第 2 轮');
  lapSave17.sessions.push({ ts: Date.now(), subject: 'math' });
  eq(P17.levelMapBySubject(lapSave17).math.fullTitle, '第 2 轮 · 第 2 关',
     '第 7 局才开第 2 轮');

  /* ② 备份恢复：importAll 的同步 throw 必须给出提示。 */
  const toastFix = [];
  const origToast17 = wx.showToast;
  wx.showToast = (o) => { toastFix.push(o && o.title); };
  const pp17 = makeInstance(loadPage('pages/parent/parent.js'));
  pp17.onLoad();
  toastFix.length = 0;
  const saveRef17 = app.globalData.save;
  pp17.setData({ importText: '{}' });
  pp17.onImport();
  eq(toastFix.length, 1, '粘贴非备份 JSON 时有一次失败提示');
  ok(/恢复失败/.test(toastFix[0] || ''), '提示写明恢复失败');
  eq(app.globalData.save, saveRef17, '导入失败不换存档引用');
  toastFix.length = 0;
  pp17.setData({ importText: JSON.stringify({ kind: 'yxjx-backup', save: {} }) });
  pp17.onImport();
  ok(/恢复失败/.test(toastFix[0] || ''), '缺 schema 的备份同样有提示');
  ok(/try \{[\s\S]{0,220}G\.Store\.importAll\(payload\)/.test(parentSrc17),
     '同步 throw 由 try/catch 接住');
  ok(/\.catch\(function \(e\)/.test(parentSrc17), '异步失败仍走 .catch，两条路都在');
  wx.showToast = origToast17;

  /* ③ 退出确认框：弹窗前掐定时器，取消后按原节奏重放。 */
  const pcfg17 = loadPage('pages/play/play.js');
  const laterSpy17 = [];
  function mkExit17(answered, correct, withSteps) {
    const p = Object.assign({}, pcfg17, {
      data: JSON.parse(JSON.stringify(pcfg17.data)),
      setData: function (patch) {
        Object.keys(patch).forEach((k) => { this.data[k] = patch[k]; });
      },
      _timers: [11, 22], _answered: answered, _lastCorrect: correct,
      _closed: false, _exitResume: null,
      save: { settings: {} },
      laterCalls: [], clearCalls: 0, stepCalls: 0,
      advanceCalls: [], closeCalls: 0, wordCalls: 0
    });
    p.setData({
      audioId: '',
      // 故意先摆成「已揭晓」：取消弹窗后分步重演必须把它重新盖回去，
      // 否则这条断言会因为默认值恰好是 false 而假通过。
      revealed: true,
      visual: withSteps ? { steps: { frames: [{}, {}] } } : null
    });
    p.later = function (ms, fn) { this.laterCalls.push({ ms: ms, fn: fn }); return 0; };
    p.clearTimers = function () { this.clearCalls++; this._timers = []; };
    p.runSteps = function () { this.stepCalls++; };
    p.advance = function (c) { this.advanceCalls.push(c); };
    p.closeRound = function () { this.closeCalls++; };
    p.playWord = function () { this.wordCalls++; };
    return p;
  }
  const origModal17 = wx.showModal;
  let modalRes17 = { confirm: false };
  wx.showModal = (o) => { if (o.success) o.success(modalRes17); };

  modalRes17 = { confirm: false };
  const ep1 = mkExit17(true, true, false);
  ep1.onExit();
  eq(ep1.clearCalls, 1, '弹窗前先掐掉切题定时器，读文案时题目不会自己翻页');
  eq(ep1.laterCalls.length, 1, '点「继续玩」重排一次推进');
  eq(ep1.laterCalls[0].ms, 620, '答对仍是 620ms 窗口');
  eq(ep1.advanceCalls.length, 0, '重排的是定时器，不会立刻结算');

  const ep2 = mkExit17(true, false, true);
  ep2.onExit();
  eq(ep2.stepCalls, 1, '分步题取消后把过程帧从头重演');
  eq(ep2.laterCalls[0].ms, 1900, '分步题恢复 1900ms 窗口');
  eq(ep2.data.revealed, false, '重演前得数重新盖住');

  const ep4 = mkExit17(false, false, false);
  ep4.setData({ audioId: 'en.ant' });
  ep4.onExit();
  eq(ep4.wordCalls, 1, '未作答时补播被掐掉的进题音频');
  eq(ep4.laterCalls.length, 0, '未作答不排切题定时器');

  modalRes17 = { confirm: true };
  const ep3 = mkExit17(true, true, false);
  ep3.onExit();
  eq(ep3.closeCalls, 1, '确认退出照旧记未完成局');
  eq(ep3.laterCalls.length, 0, '确认退出不重排推进，不会先结算发星星');
  wx.showModal = origModal17;
  ok(/this\.clearTimers\(\);[\s\S]{0,160}wx\.showModal/.test(playSrc17),
     'clearTimers 在 showModal 之前，不是只写在确认回调里');

  /* ④ 关掉分步讲解后不能留一排永不点亮的空过程帧。 */
  ok(/wx:if="\{\{answered && showSteps && visual\.steps\}\}"/.test(playWxml17),
     '过程帧同时受 answered 与分步开关控制');
  eq(pcfg17.data.showSteps, false, '新题默认不渲染过程帧');
  ok(/showSteps: false/.test(playSrc17) && /showSteps: stepsOn/.test(playSrc17),
     '换题归零、作答时按开关赋值');
  const math17 = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/math.json'), 'utf8'));
  const stepQ17 = math17.filter((q) => {
    const v = V17.forQuestion(q, true);
    return v && v.steps;
  })[0];
  ok(!!stepQ17, '找到一道带过程帧的题用于开关回归');
  function mkOption17(stepsOff) {
    const p = Object.assign({}, pcfg17, {
      data: JSON.parse(JSON.stringify(pcfg17.data)),
      setData: function (patch) {
        Object.keys(patch).forEach((k) => { this.data[k] = patch[k]; });
      }
    });
    p.save = { settings: stepsOff ? { visualSteps: false } : {}, points: { balance: 0 } };
    p.round = { questions: [stepQ17] };
    p.idx = 0; p.results = [null]; p.items = []; p.qStartAt = Date.now();
    p._answered = false;
    p.later = function () {};
    p.playWord = function () {};
    p.setData({
      options: stepQ17.options.map((o) => ({
        id: o.id, text: o.text, single: false, state: '', delay: 0
      })),
      visual: V17.forQuestion(stepQ17, true),
      roundCorrect: 0, pulse: 'a'
    });
    return p;
  }
  const op1 = mkOption17(false);
  op1.onOption({ currentTarget: { dataset: { id: stepQ17.answer } } });
  eq(op1.data.showSteps, true, '分步开着时过程帧正常渲染');
  const op2 = mkOption17(true);
  op2.onOption({ currentTarget: { dataset: { id: stepQ17.answer } } });
  eq(op2.data.showSteps, false, '家长关掉分步后不再残留半透明空卡片');
  eq(op2.data.revealed, true, '关掉分步仍是作答即揭晓');

  /* ⑤ 首页「上次」只认完整完成的局。 */
  ok(/filter\(function \(s\) \{ return s && !s\.aborted; \}\)/.test(homeSrc17),
     '首页排除中途退出的局');
  const saveHome17 = app.globalData.save;
  const sessionsBak17 = saveHome17.sessions;
  saveHome17.sessions = [
    { ts: Date.now(), correct: 9, total: 10, items: [] },
    { ts: Date.now(), correct: 2, total: 3, items: [], aborted: true }
  ];
  const hp17 = makeInstance(loadPage('pages/home/home.js'));
  hp17.onShow();
  eq(hp17.data.lastText, '上次：9 / 10 题', '中途退出的局不当成上次成绩');
  saveHome17.sessions = sessionsBak17;

  /* ⑥ 听音选字母：高亮的首字母要和正确答案一样是大写。 */
  const en17 = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/english.json'), 'utf8'));
  const initialQs17 = en17.filter((q) => (q.tags || [])[0] === '听音选字母');
  eq(initialQs17.length, 26, '26 道听音选字母题');
  let bad17 = 0, leaked17 = 0;
  initialQs17.forEach((q) => {
    const before = V17.forQuestion(q, true);
    if (before && before.after) leaked17++;
    const merged = V17.merge(before, V17.reveal(q, true));
    const ansText = q.options.filter((o) => o.id === q.answer)
      .map((o) => o.text)[0];
    if (!merged.after || merged.after.letters[0].ch !== ansText) bad17++;
  });
  eq(bad17, 0, '26 道题高亮首字母与正确答案（大写）完全一致');
  eq(leaked17, 0, '答题前仍不显示整词/首字母');
  const sample17 = initialQs17[0];
  const merged17 = V17.merge(V17.forQuestion(sample17, true), V17.reveal(sample17, true));
  eq(merged17.after.word, 'ant', '整词仍按音频原名小写保存，不影响别的字段');
  eq(merged17.after.letters[0].ch, 'A', '展示成 Ant，高亮的 A 与选项一致');
}

/* ---- 8M. 1.2.18：0 题空局边界（第三批第 1 项） ---- */
{
  const fs = require('fs');
  const S18 = require(path.join(MP, 'lib/stars.js'));
  const R18 = require(path.join(MP, 'lib/rewards.js'));
  const starsSrc18 = fs.readFileSync(path.join(MP, 'lib/stars.js'), 'utf8');
  const playSrc18 = fs.readFileSync(path.join(MP, 'pages/play/play.js'), 'utf8');
  const resultSrc18 = fs.readFileSync(path.join(MP, 'pages/result/result.js'), 'utf8');

  /* ① 纯函数：显式 0 题不再被 `total || 10` 当成「省略」。 */
  G.SUBJECTS.concat(['review']).forEach((s) => {
    eq(S18.forCorrect(9, s, 0), 0, s + ' 9 对题但 0 题局不给星');
    eq(S18.forCorrect(0, s, 0), 0, s + ' 0 题局连保底 1 星也不发');
  });
  eq(S18.forCorrect(9, 'math', -1), 0, '负数题数按空局处理');
  eq(S18.forCorrect(9, 'math', NaN), 0, 'NaN 题数按空局处理');
  eq(S18.forCorrect(9, 'math', '0'), 0, '字符串 0 也按空局处理');
  eq(S18.forCorrect(9, 'math', undefined), 3, '省略 total 仍按 10 题标准局');
  eq(S18.forCorrect(9, 'math', null), 3, 'null 视作省略，兼容旧调用');
  eq(S18.forCorrect(9, 'math', 10), 3, '正常 9/10 仍是 3 星');
  eq(S18.forCorrect(0, 'math', 10), 1, '答了但全错仍保底 1 星（空局 ≠ 全错）');
  eq(S18.forCorrect(20, 'math', 10), 3, '脏数据 correct > total 被夹回题数');
  eq(S18.forCorrect(3, 'review', 3), 3, '3 题复习局全对仍 3 星');
  ok(!/var n = total \|\| 10/.test(starsSrc18)
     && /if \(total === undefined/.test(starsSrc18),
     '不再用 total || 10 把 0 当省略');

  /* ② 结算入口：0 题局不发星、不写 session、不进结算页。 */
  const cfg18 = loadPage('pages/play/play.js');
  const p18 = makeInstance(cfg18);
  const fresh18 = G.Store.defaultSave();
  p18.round = { questions: [], startedAt: Date.now() };
  p18.results = [];
  p18.items = [];
  p18.save = fresh18;
  p18.review = false;
  p18.subject = 'math';
  p18.clearTimers = function () { this.clearCalls = (this.clearCalls || 0) + 1; };
  const life18Before = fresh18.points.lifetime;
  const prevResult18 = app.globalData.lastResult;
  const prevNav18 = wx.__lastNav;
  let toast18 = '', back18 = 0;
  const origToast18 = wx.showToast, origBack18 = wx.navigateBack;
  wx.showToast = (o) => { toast18 = (o && o.title) || ''; };
  wx.navigateBack = () => { back18++; };

  p18.finish();
  eq(fresh18.points.lifetime, life18Before, '0 题局没发星星');
  eq(fresh18.sessions.length, 0, '0 题局不写 sessions');
  eq(app.globalData.lastResult, prevResult18, '0 题局不写 lastResult');
  eq(wx.__lastNav, prevNav18, '0 题局不跳结算页');
  eq(back18, 1, '0 题局退回上一页');
  ok(/这一局没有题目/.test(toast18), '0 题局有明确提示，不会静默卡住');
  eq(p18.clearCalls, 1, '0 题局掐掉定时器');

  // 同一实例换成正常 10 题局，确认第二道闸没误伤正常结算。
  p18.results = [true, true, true, true, true, true, true, true, true, false];
  p18.items = p18.results.map((c, i) => ({ qid: 'q' + i, subject: 'math', correct: c, ms: 100 }));
  p18.round = { questions: p18.results.map(() => ({})), startedAt: Date.now() };
  p18.finish();
  eq(app.globalData.lastResult.total, 10, '正常局仍能结算 10 题');
  eq(app.globalData.lastResult.nominal, 3, '正常局 9 对仍拿 3 星');
  eq(fresh18.sessions.length, 1, '正常局照常写一条 session');
  wx.showToast = origToast18;
  wx.navigateBack = origBack18;
  wx.__lastNav = prevNav18;
  app.globalData.lastResult = prevResult18;
  ok(/if \(!total\) \{[\s\S]{0,320}wx\.navigateBack/.test(playSrc18),
     '结算页入口有 0 题第二道闸，且在算星之前');

  /* ③ 结算展示：0 题结算页不出现 NaN。 */
  app.globalData.lastResult = {
    subject: 'math', review: false, correct: 0, total: 0,
    stars: 0, nominal: 0, capped: false,
    lifetime: app.globalData.save.points.lifetime, lifetimeBefore: 0
  };
  const rp18 = makeInstance(loadPage('pages/result/result.js'));
  rp18.onLoad();
  eq(rp18.data.score, '0 / 0', '0 题结算显示 0 / 0');
  eq(rp18.data.emoji, '💪', '0 题按 0% 给鼓励表情，不是 NaN 分支');
  eq(rp18.data.confetti, false, '0 题不撒彩纸');
  eq(rp18.data.reviewRoundSize, 0, '0 题局不摆复习按钮');
  ok(!/NaN/.test(JSON.stringify(rp18.data)), '结算数据里没有 NaN');
  ok(/var pct = r\.total > 0 \?/.test(resultSrc18), '结算页百分比不再除零');
  app.globalData.lastResult = prevResult18;

  /* ④ 今日局数：0 题空局不算「玩了一局」，老存档缺 total 仍算。 */
  const save18 = app.globalData.save;
  const sessions18Bak = save18.sessions;
  const now18 = Date.now();
  save18.sessions = [
    { ts: now18, total: 0 },
    { ts: now18 },
    { ts: now18, total: 10 },
    { ts: now18, total: 0, aborted: true },
    { ts: now18 - 86400000, total: 10 }
  ];
  eq(R18.roundsToday(save18), 2, '0 题局不算今日局数，缺 total 的老 session 仍算');
  eq(R18.goalState(save18).reached, true, '2 局仍达成今日小目标');
  save18.sessions = sessions18Bak;
}

/* ---- 8N. 1.2.19：复习按钮题数口径与 buildReviewRound 同源 ---- */
{
  const fs = require('fs');
  const runnerSrc19 = fs.readFileSync(path.join(ROOT, 'src/js/40-runner.js'), 'utf8');
  const homeSrc19 = fs.readFileSync(path.join(MP, 'pages/home/home.js'), 'utf8');
  const homeWxml19 = fs.readFileSync(path.join(MP, 'pages/home/home.wxml'), 'utf8');
  const resultSrc19 = fs.readFileSync(path.join(MP, 'pages/result/result.js'), 'utf8');

  ok(typeof G.Runner.reviewRoundSize === 'function',
     '共用逻辑导出「本局真正能出几题」');
  ok(/function reviewPicks\(save, size\)/.test(runnerSrc19)
     && /arrange\(reviewPicks\(save, size\), save\)/.test(runnerSrc19)
     && /return reviewPicks\(save, size\)\.length/.test(runnerSrc19),
     '组局与报数共用同一个挑题函数，逻辑不可能漂移');
  const picksFn19 = runnerSrc19.slice(
    runnerSrc19.indexOf('function reviewPicks'),
    runnerSrc19.indexOf('function buildReviewRound'));
  ok(!/size \|\| G\.ROUND_SIZE/.test(picksFn19)
     && /size === undefined \|\| size === null/.test(picksFn19),
     'reviewPicks 不再把显式 0 当省略（其它组局函数的默认值不动）');
  ok(/seen\[id\]/.test(runnerSrc19), '重复 qid 去重');
  ok(/G\.Runner\.reviewRoundSize\(save\)/.test(homeSrc19)
     && /reviewRoundSize = G\.Runner\.reviewRoundSize\(/.test(resultSrc19),
     '首页与结算页都调共用函数，不再自己 Math.min 条数');
  ok(/wx:if="\{\{reviewRoundSize >= 3\}\}"/.test(homeWxml19),
     '首页按可出题数决定摆不摆按钮');

  const pool19 = G.Bank.of('math').slice(0, 15).map((q) => q.id);
  const mk19 = (id, n, extra) => Object.assign(
    { qid: id, wrongCount: n, lastWrongAt: n, cleared: false }, extra || {});
  const case19 = (wrong, size) => {
    const s = G.Store.defaultSave();
    s.wrongBook = wrong;
    return {
      save: s,
      reported: G.Runner.reviewRoundSize(s, size),
      actual: G.Runner.buildReviewRound(s, size === undefined ? 10 : size).questions
    };
  };
  const same19 = (c, name) => eq(c.reported, c.actual.length, name);

  // 常规：超过一局上限截断到 10。
  const full19 = case19(pool19.slice(0, 12).map((id, i) => mk19(id, i + 1)));
  eq(full19.reported, 10, '12 道真实错题报「本局 10 题」');
  same19(full19, '12 道真实错题报数与实际完全一致');

  // 核心回归：权重最高的前几条 qid 失效（题库改版 / 导入老备份）。
  const mixed19 = ['gone-a', 'gone-b', 'gone-c'].concat(pool19.slice(0, 6))
    .map((id, i) => mk19(id, 10 - i));
  const mix19 = case19(mixed19);
  eq(mix19.reported, 6, '9 条未掌握但 3 条失效时，按钮只报能出的 6 题');
  same19(mix19, '失效 qid 场景下报数 = 组局实际题数');
  eq(mix19.actual[0].id, pool19[0], '失效 qid 跳过后，错得最多的真实题排第一');

  // 老存档 / 备份里的重复 qid：不多算、不在一局里出两遍。
  const dup19 = case19(
    [pool19[0], pool19[0], pool19[1], pool19[1], pool19[2], pool19[3]]
      .map((id, i) => mk19(id, i + 1)));
  eq(dup19.reported, 4, '6 条错题里只有 4 个不同 qid，按钮报 4 题');
  same19(dup19, '重复 qid 场景报数 = 组局实际题数');
  eq(new Set(dup19.actual.map((q) => q.id)).size, dup19.actual.length,
     '一局里不会把同一道题出两次');

  // 全部失效 / 全 cleared / 老存档无字段 / 显式 0 / 省略。
  const dead19 = case19(['x1', 'x2', 'x3', 'x4'].map((id, i) => mk19(id, i + 1)));
  eq(dead19.reported, 0, '全部失效时不摆复习入口，也不开空局');
  same19(dead19, '全部失效时仍与组局一致');
  const cleared19 = case19(pool19.slice(0, 3)
    .map((id, i) => mk19(id, i + 1, { cleared: i === 0 })));
  eq(cleared19.reported, 2, 'cleared 的题不计入');
  same19(cleared19, 'cleared 场景报数 = 组局实际题数');
  eq(G.Runner.reviewRoundSize({}), 0, '老存档缺 wrongBook 不抛错，返回 0');
  eq(G.Runner.reviewRoundSize(G.Store.defaultSave(), 0), 0,
     '显式 size=0 是空局，不再被当成省略');
  eq(G.Runner.reviewRoundSize(G.Store.defaultSave(), -3), 0, '负数 size 按空局');
  eq(G.Runner.reviewRoundSize(G.Store.defaultSave(), NaN), 0, 'NaN size 按空局');
  eq(G.Runner.reviewRoundSize(G.Store.defaultSave()), 0,
     '省略 size 时按标准局上限，没错题仍是 0');

  // 页面端到端：按钮读到的就是共用函数算出来的数。
  const save19 = app.globalData.save;
  const wrongBak19 = save19.wrongBook;
  const resultBak19 = app.globalData.lastResult;
  save19.wrongBook = mixed19;
  const hp19 = makeInstance(loadPage('pages/home/home.js'));
  hp19.onShow();
  eq(hp19.data.reviewRoundSize, 6, '首页按钮报 6 题，与组局一致');
  eq(hp19.data.reviewRoundSize, G.Runner.reviewRoundSize(save19),
     '首页报数与共用函数同源');
  eq(hp19.data.reviewCount, 9, '错题本真实条数仍保留给家长口径');
  save19.wrongBook = dead19.save.wrongBook;
  hp19.onShow();
  eq(hp19.data.reviewRoundSize, 0, '全部失效时首页不摆「本局 0 题」的按钮');

  save19.wrongBook = mixed19;
  app.globalData.lastResult = {
    subject: 'math', review: false, correct: 6, total: 10,
    stars: 2, nominal: 2, capped: false,
    lifetime: save19.points.lifetime, lifetimeBefore: save19.points.lifetime
  };
  const rp19 = makeInstance(loadPage('pages/result/result.js'));
  rp19.onLoad();
  eq(rp19.data.reviewRoundSize, 6, '结算页按钮也报 6 题，不再报 9 题');
  eq(rp19.data.reviewRoundSize, G.Runner.reviewRoundSize(save19),
     '结算页报数与共用函数同源');
  save19.wrongBook = wrongBak19;
  app.globalData.lastResult = resultBak19;
}

/* ---- 8O. 1.2.20：第三批收尾（叠音 / 折线 / 门禁 / 泄题 / 小怪物 / 工具） ---- */
{
  const fs = require('fs');
  const playSrc20 = fs.readFileSync(path.join(MP, 'pages/play/play.js'), 'utf8');
  const parentSrc20 = fs.readFileSync(path.join(MP, 'pages/parent/parent.js'), 'utf8');
  const visualSrc20 = fs.readFileSync(path.join(MP, 'lib/visual.js'), 'utf8');
  const audioTool20 = fs.readFileSync(path.join(ROOT, 'tools/check_audio.py'), 'utf8');
  const pkg20 = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const rewards20 = require(path.join(MP, 'lib/rewards.js'));
  const progress20 = require(path.join(MP, 'lib/progress.js'));
  const tts20 = require(path.join(MP, 'lib/tts.js'));

  /* ① 英语答错重播：掐掉中文指令 + 350ms 自动播，只留一次单词音频。 */
  ok(/playWord: function \(id\) \{[\s\S]{0,420}this\.cancelAutoPlay\(\);[\s\S]{0,160}tts\.stop\(\);/.test(playSrc20),
     'playWord 是所有重播入口的统一闸门');
  ok(/this\._autoPlayTimer = this\.later\(350/.test(playSrc20),
     '无中文指令时记下自动播定时器');
  ok(/clearTimers: function \(\) \{[\s\S]{0,160}this\._autoPlayTimer = null/.test(playSrc20),
     '换题不会留一个失效的定时器 id');

  const en20 = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/english.json'), 'utf8'));
  const listenQ20 = en20.find((q) => q.tags[0] === '听音选词');
  const cfg20 = loadPage('pages/play/play.js');
  const p20 = makeInstance(cfg20);
  p20.onLoad({ subject: 'english' });
  const stemSettings20 = p20.save.settings;
  const hadStem20 = Object.prototype.hasOwnProperty.call(stemSettings20, 'readStem');
  const stemBak20 = stemSettings20.readStem;
  stemSettings20.readStem = false;      // 强制走「无中文指令」的 350ms 自动播分支
  p20.round.questions[p20.idx] = listenQ20;

  let tid20 = 1000;
  const pending20 = [];
  p20.later = function (ms, fn) {
    const id = ++tid20;
    pending20.push({ id: id, ms: ms, fn: fn });
    if (!this._timers) this._timers = [];
    this._timers.push(id);
    return id;
  };
  const origStop20 = tts20.stop;
  const origClear20 = global.clearTimeout;
  let stopCalls20 = 0;
  const cleared20 = [];
  tts20.stop = function () { stopCalls20++; return origStop20.apply(this, arguments); };
  global.clearTimeout = (id) => { cleared20.push(id); };

  p20.renderQuestion();
  const autoId20 = p20._autoPlayTimer;
  ok(autoId20 > 0, '进题记下自动播定时器 id');
  eq(pending20.length, 1, '无中文指令时只有一条自动播');
  eq(pending20[0].ms, 350, '自动播仍是 350ms');
  const wrong20 = listenQ20.options.find((o) => o.id !== listenQ20.answer).id;
  p20.onOption({ currentTarget: { dataset: { id: wrong20 } } });
  eq(p20._autoPlayTimer, null, '答错重播时掐掉还没触发的自动播');
  ok(cleared20.indexOf(autoId20) >= 0, '自动播定时器真的被 clearTimeout');
  ok(p20._timers.indexOf(autoId20) < 0, '自动播定时器从待清列表里移除');
  ok(stopCalls20 >= 1, '重播前掐掉中文指令 / 题干朗读，不再叠音');

  tts20.stop = origStop20;
  global.clearTimeout = origClear20;
  if (hadStem20) stemSettings20.readStem = stemBak20;
  else delete stemSettings20.readStem;

  /* ② 折线：脏数据、排序、复习局口径、上限边界。 */
  const now20 = Date.now();
  const row20 = (correct, total, ts, extra) =>
    Object.assign({ correct: correct, total: total, ts: ts }, extra || {});
  const sessions20 = [
    row20(10, 10, now20 - 1000),                       // 最新：100%
    row20(5, 10, now20 - 4000),                        // 最旧：50%
    row20(99, 10, now20 - 3000),                       // 脏：correct > total
    row20(5, 10, now20 + 999999),                      // 未来日期
    row20(5, 10, NaN),                                 // 缺 ts
    row20('9', 10, now20 - 2000),                      // 字符串 correct
    row20(5, 10, now20 - 2500, { review: true }),      // 复习局
    row20(5, 10, now20 - 2600, { aborted: true }),     // 中途退出
    row20(5, 0, now20 - 2700),                         // 0 题
    row20(5, NaN, now20 - 2800)                        // NaN 题数
  ];
  const tr20 = progress20.trend({ sessions: sessions20 });
  eq(tr20.count, 3, '脏数据 / 未来 / 复习局 / 退出 / 0 题全部排除');
  eq(tr20.points[0].label, '5/10', '按时间从旧到新排，不再看数组顺序');
  eq(tr20.points[1].pct, 100, 'correct > total 夹回 100%，坐标不越界');
  ok(!/NaN|Infinity/.test(JSON.stringify(tr20)), '折线数据里没有 NaN / Infinity');
  eq(progress20.trend({ sessions: 'oops' }).count, 0, 'sessions 非数组不抛错');
  eq(progress20.trend({ sessions: sessions20 }, 0).count, 0, '显式 0 个点不是省略');
  eq(progress20.trend({ sessions: sessions20 }, NaN).count, 0, 'NaN 上限按 0 个点');
  eq(progress20.trend({ sessions: sessions20 }, -3).count, 0, '负数上限按 0 个点');
  ok(/s\.review/.test(fs.readFileSync(path.join(MP, 'lib/progress.js'), 'utf8')),
     '复习局与难度评估同口径，不拉低折线');

  const saveP20 = app.globalData.save;
  const sessBak20 = saveP20.sessions;
  saveP20.sessions = sessions20;
  const pp20 = makeInstance(loadPage('pages/parent/parent.js'));
  pp20.buildPanel();
  eq(pp20.data.trend.count, 3, '家长页折线端到端用新口径');
  saveP20.sessions = sessBak20;

  /* ③ 家长门禁：冷却秒数自己走，到点自动放开。 */
  const COOL20 = 'yxjx.parent.cooldown', FAIL20 = 'yxjx.parent.fails';
  const coolBak20 = storage.get(COOL20), failBak20 = storage.get(FAIL20);
  storage.set(COOL20, String(Date.now() + 30000));
  storage.set(FAIL20, '0');
  const pg20 = makeInstance(loadPage('pages/parent/parent.js'));
  pg20.onLoad();
  ok(/请等 \d+ 秒后再试/.test(pg20.data.gateErr), '进页面按剩余秒数提示');
  const timerId20 = pg20._gateTimer;
  ok(timerId20 > 0 && typeof global.__intervals[timerId20 - 1] === 'function',
     '冷却期间起了倒计时');
  storage.set(COOL20, String(Date.now() + 29000));
  global.__intervals[timerId20 - 1]();
  ok(/请等 (28|29) 秒后再试/.test(pg20.data.gateErr), '秒数自己递减，不用再点按钮');
  storage.set(COOL20, String(Date.now() - 1));
  global.__intervals[timerId20 - 1]();
  eq(pg20.data.gateErr, '现在可以再试了', '冷却结束自动放开');
  eq(global.__intervals[timerId20 - 1], null, '到点后定时器被清掉');
  eq(pg20.data.gateFocus, true, '冷却结束把焦点还给输入框');

  storage.delete(COOL20);
  storage.delete(FAIL20);
  const pg20b = makeInstance(loadPage('pages/parent/parent.js'));
  pg20b.onLoad();
  for (let i = 0; i < 3; i++) {
    pg20b.setData({ gateInput: '999999' });
    pg20b.onGateSubmit();
  }
  ok(/请等 \d+ 秒后再试/.test(pg20b.data.gateErr),
     '第三次错显示真实剩余秒数，不再是写死的「30 秒」');
  ok(pg20b._gateTimer > 0, '触发冷却时起倒计时');
  pg20b.setData({ gateInput: String(G.PARENT_GATE.answer) });
  pg20b.onGateSubmit();
  eq(pg20b.data.unlocked, false, '冷却期间输对也进不去');
  storage.delete(COOL20);
  pg20b.onGateSubmit();
  eq(pg20b.data.unlocked, true, '冷却结束后正确口令可进入');
  eq(pg20b._gateTimer, null, '解锁后倒计时被清掉');

  storage.set(COOL20, String(Date.now() + 30000));
  const pg20c = makeInstance(loadPage('pages/parent/parent.js'));
  pg20c.onLoad();
  const tid20c = pg20c._gateTimer;
  pg20c.onUnload();
  eq(global.__intervals[tid20c - 1], null, '离开页面时倒计时被清掉');
  if (coolBak20 === undefined) storage.delete(COOL20); else storage.set(COOL20, coolBak20);
  if (failBak20 === undefined) storage.delete(FAIL20); else storage.set(FAIL20, failBak20);

  /* ④ 答题前数据层不带得数：统一入口剥 steps.rest。 */
  ok(/STEP_ANSWER_KEYS = \['rest'\]/.test(visualSrc20)
     && /safe\.steps = copyWithout\(v\.steps, STEP_ANSWER_KEYS\)/.test(visualSrc20),
     'steps.rest 在 forQuestion 统一剥掉');

  /* ⑤ 小怪物：失效 qid 不再留一只永远收服不了的怪物。 */
  const ids20 = G.Bank.of('math').slice(0, 3).map((q) => q.id);
  const saveM20 = { wrongBook: [
    { qid: 'gone-20', wrongCount: 99, lastWrongAt: 99, cleared: false, subject: 'math' },
    { qid: ids20[0], wrongCount: 5, lastWrongAt: 5, cleared: false, subject: 'math' },
    { qid: ids20[1], wrongCount: 4, lastWrongAt: 4, cleared: true, subject: 'math' },
    { qid: ids20[2], wrongCount: 3, lastWrongAt: 3, cleared: false, subject: 'math' }
  ] };
  const mon20 = rewards20.monstersOf(saveM20);
  eq(mon20.total, 2, '失效 qid 不占小怪物名额');
  eq(mon20.shown[0].id, ids20[0], '失效项权重再高也不会排第一');
  eq(rewards20.monstersOf({ wrongBook: 'oops' }).total, 0, 'wrongBook 非数组不抛错');

  /* ⑥ 工具链：缓存 key 含内容哈希，verify 纳入产物一致性检查。 */
  ok(/CACHE_VERSION = 2/.test(audioTool20)
     && /sha1\(path\)\[:16\]/.test(audioTool20)
     && /%d-%s/.test(audioTool20),
     '音频体检缓存 key 加内容哈希且版本已升');
  ok(/npm run mp:check/.test(pkg20.scripts.verify), 'verify 纳入 mp:check');
}

/* ---- 8P. 1.2.21：关卡地图累计计数器（30 局窗口边界） ---- */
{
  const fs = require('fs');
  const P21 = require(path.join(MP, 'lib/progress.js'));
  const runnerSrc21 = fs.readFileSync(path.join(ROOT, 'src/js/40-runner.js'), 'utf8');
  const playSrc21 = fs.readFileSync(path.join(MP, 'pages/play/play.js'), 'utf8');
  const swSrc21 = fs.readFileSync(path.join(ROOT, 'docs/sw.js'), 'utf8');
  const storeSrc21 = fs.readFileSync(path.join(ROOT, 'src/js/10-store.js'), 'utf8');
  const appSrc21 = fs.readFileSync(path.join(MP, 'app.js'), 'utf8');

  // 复刻 play.finish() 的顺序：先 recordRound，再 finishSession(push+shift)。
  // 不喂手工假 sessions —— 1.2.16 就是被假数据漏掉真 bug 的。
  const oneRound = (save, subject, review) => {
    const round = review
      ? G.Runner.buildReviewRound(save, G.ROUND_SIZE)
      : G.Runner.buildSubjectRound(save, subject, G.ROUND_SIZE);
    const items = round.questions.map((q) => ({
      qid: q.id, subject: q.subject, correct: true, ms: 700
    }));
    if (!items.length) return false;
    P21.recordRound(save, { review: !!review, aborted: false, items: items });
    G.Runner.finishSession(save, round, items, [], 0);
    return true;
  };
  const seedWrong = (save) => {
    save.wrongBook = G.Bank.of('math').slice(0, 3).map((q, i) => ({
      qid: q.id, subject: 'math', wrongCount: 3,
      lastWrongAt: Date.now() - i, cleared: false
    }));
  };

  /* ① 新存档连打 35 局：旧算法会卡在 30，新计数器必须继续涨。 */
  const saveA = G.Store.defaultSave();
  let playedA = 0;
  for (let i = 0; i < 35; i++) if (oneRound(saveA, 'math', false)) playedA++;
  eq(playedA, 35, '35 局数学全部走完真实结算链路');
  eq(saveA.sessions.length, 30, '共用 Runner 仍只留 30 局');
  eq(P21.windowRounds(saveA, 'math'), 30, '窗口推导值封顶 30，正是老 bug 的根因');
  eq(saveA.rounds.math, 35, '累计计数器落在存档里且不受裁剪影响');
  eq(P21.roundsOf(saveA, 'math'), 35, '地图读到 35 局，不再卡在 30');
  ok(/第 6 轮/.test(P21.levelMapBySubject(saveA).math.lapText),
     '35 局后地图走到第 6 轮，不再定格第 5 轮');

  /* 真实结算页端到端：确认 play.finish() 接线生效，不是只在测试里复刻。 */
  const p21 = makeInstance(loadPage('pages/play/play.js'));
  const saveE2E = G.Store.defaultSave();
  p21.save = saveE2E;
  p21.review = false;
  p21.subject = 'math';
  p21.clearTimers = function () {};
  const lastResult21 = app.globalData.lastResult;
  const nav21 = wx.__lastNav;
  for (let i = 0; i < 32; i++) {
    p21.results = [true, true, true, true, true, true, true, true, true, false];
    p21.items = p21.results.map((c, j) => ({
      qid: 'e2e' + i + '_' + j, subject: 'math', correct: c, ms: 100
    }));
    p21.round = { questions: p21.results.map(() => ({})), startedAt: Date.now() + i };
    p21.finish();
  }
  eq(saveE2E.sessions.length, 30, '真实结算页同样只留 30 局');
  eq(saveE2E.rounds.math, 32, '真实结算页把 32 局都记进计数器');
  eq(P21.roundsOf(saveE2E, 'math'), 32, '真实结算页的地图不封顶');
  app.globalData.lastResult = lastResult21;
  wx.__lastNav = nav21;

  /* ② 5 局复习局把普通局挤出窗口：窗口值掉到 25，地图不倒退。 */
  seedWrong(saveA);
  let reviewsA = 0;
  for (let i = 0; i < 5; i++) if (oneRound(saveA, '', true)) reviewsA++;
  eq(reviewsA, 5, '5 局复习局都能组出题');
  eq(P21.windowRounds(saveA, 'math'), 25, '窗口里被挤掉 5 条普通局');
  eq(saveA.rounds.math, 35, '复习局不给任何科目 +1');
  eq(P21.roundsOf(saveA, 'math'), 35, '复习局挤出后地图不倒退');
  eq(saveA.rounds.chinese, undefined, '数学的局不串到语文');

  /* 冷启动固化：升级后第一局就是复习局，也不能再倒退一次。 */
  const saveB = G.Store.defaultSave();
  for (let i = 0; i < 30; i++) {
    saveB.sessions.push({ ts: Date.now(), items: [{ subject: 'math' }] });
  }
  eq(saveB.rounds, undefined, '升级前存档没有计数器');
  eq(P21.ensureRounds(saveB), true, '冷启动为老存档补出计数器');
  eq(saveB.rounds.math, 30, '起点取窗口值，升级这一刻不跳也不退');
  eq(saveB.rounds.chinese, 0, '没打过的科目从 0 起算');
  eq(P21.ensureRounds(saveB), false, '已初始化的存档不重复写');
  seedWrong(saveB);
  for (let i = 0; i < 5; i++) oneRound(saveB, '', true);
  eq(P21.windowRounds(saveB, 'math'), 25, '复习局照样挤掉 5 条普通局');
  eq(P21.roundsOf(saveB, 'math'), 30, '升级后立刻锁住，第一局是复习局也不倒退');
  oneRound(saveB, 'math', false);
  eq(P21.roundsOf(saveB, 'math'), 31, '锁住之后普通局继续正常前进');
  const sBad = { sessions: [{ items: [{ subject: 'math' }] }], rounds: [] };
  eq(P21.ensureRounds(sBad), true, '脏 rounds 被重建');
  eq(sBad.rounds.math, 1, '重建时按窗口值补齐');
  ok(/progress\.ensureRounds\(save\)/.test(appSrc21), 'app.onLaunch 里真的调用了固化');
  ok(appSrc21.indexOf('progress.ensureRounds(save)') < appSrc21.indexOf('G.Store.save(save)'),
     '固化在启动那次落盘之前');

  /* ③ 老存档兜底：精确复现用户实测的「30 局 → 第 5 轮·通关」。 */
  const saveC = G.Store.defaultSave();
  for (let i = 0; i < 30; i++) {
    saveC.sessions.push({ ts: Date.now(), items: [{ subject: 'math' }] });
  }
  eq(saveC.rounds, undefined, '老存档没有计数器');
  eq(P21.roundsOf(saveC, 'math'), 30, '无计数器时按窗口值兜底');
  eq(P21.levelMapBySubject(saveC).math.fullTitle, '第 5 轮 · 通关',
     '复现实测：30 局数学显示第 5 轮 · 通关');
  oneRound(saveC, 'math', false);
  eq(P21.roundsOf(saveC, 'math'), 31, '升级后第 31 局真的前进（不是拿窗口值起步又卡住）');
  seedWrong(saveC);
  for (let i = 0; i < 5; i++) oneRound(saveC, '', true);
  eq(P21.windowRounds(saveC, 'math'), 25,
     '旧算法此刻会退回第 5 轮 · 第 2 关（用户实测的倒退）');
  eq(P21.roundsOf(saveC, 'math'), 31, '新算法把轮次钉在累计值，不再倒退');
  ok(/第 6 轮/.test(P21.levelMapBySubject(saveC).math.lapText),
     '升级后继续前进到第 6 轮');

  /* ④ 脏计数器：导入旧备份 / 手改存档不能把 NaN 交给 WXML。 */
  [NaN, -5, 'oops', Infinity, null, [], {}, true, 2.9].forEach((v) => {
    const sd = {
      sessions: [{ items: [{ subject: 'math' }] }, { items: [{ subject: 'math' }] }],
      rounds: { math: v }
    };
    eq(P21.roundsOf(sd, 'math'), 2, '脏计数器回落窗口值：' + String(v));
    P21.recordRound(sd, { items: [{ subject: 'math' }] });
    ok(typeof sd.rounds.math === 'number' && isFinite(sd.rounds.math)
       && sd.rounds.math === 3, '脏计数器写入后仍是有限整数：' + String(v));
  });
  eq(P21.roundsOf({ sessions: 'oops', rounds: { math: 7 } }, 'math'), 7,
     'sessions 非数组时仍认计数器');
  ok(!/NaN|Infinity/.test(JSON.stringify(P21.levelMap({ rounds: { math: NaN }, sessions: [] }))),
     '地图数据里没有 NaN / Infinity');

  /* ⑤ 不计入口径：和 subjectOf / 真实 session 完全一致。 */
  const sF = G.Store.defaultSave();
  eq(P21.recordRound(sF, { review: true, items: [{ subject: 'math' }] }), false,
     '复习局不 +1');
  eq(P21.recordRound(sF, { aborted: true, items: [{ subject: 'math' }] }), false,
     '中途退出不 +1');
  eq(P21.recordRound(sF, { items: [{ subject: 'math' }, { subject: 'chinese' }] }), false,
     '混合科目局不 +1');
  eq(P21.recordRound(sF, { items: [] }), false, '0 题局不 +1');
  eq(P21.recordRound(sF, { items: [{ subject: 'nope' }] }), false, '未知科目不 +1');
  eq(sF.rounds, undefined, '以上都不在存档里建字段');
  eq(P21.recordRound(sF, { items: [{ subject: 'math' }] }), true, '正常单科局写入');
  eq(sF.rounds.math, 1, '第一局从 1 起算');
  eq(P21.roundsOf(sF, 'chinese'), 0, '不串科');
  eq(P21.roundsOf(sF, 'english'), 0, '第三科也不串');

  /* ⑥ 备份往返 + 网页版零改动。 */
  const roundTrip21 = JSON.parse(JSON.stringify(saveA));
  eq(roundTrip21.rounds.math, 35, '导出再导入的 JSON 往返保留累计局数');
  ok(/save:\s*s\b/.test(storeSrc21), 'exportAll 全量带存档，不列字段白名单');
  ok(/_cache = migrate\(payload\.save\)/.test(storeSrc21), 'importAll 走 migrate');
  ok(!/delete save\[/.test(storeSrc21), 'migrate 不删未知字段，rounds 不会被抹掉');
  ok(!/save\.rounds|recordRound/.test(runnerSrc21), '共用 Runner 没被改');
  ok(/progress\.recordRound\(this\.save/.test(playSrc21), '计数器只在小程序结算页写入');
  const idxRec21 = playSrc21.indexOf('progress.recordRound(this.save');
  const idxFin21 = playSrc21.indexOf('G.Runner.finishSession(this.save');
  ok(idxRec21 > 0 && idxFin21 > idxRec21,
     '计数器写在 finishSession 之前，蹭同一次落盘');
  ok(/yxjx-6ee740ece2/.test(swSrc21), 'docs/sw.js 缓存哈希不变，网页版不用重新部署');
}

/* ---- 8Q. 1.2.22：首页选课按钮去掉「第几关」文字，只留小圆点 ---- */
{
  const fs = require('fs');
  const homeWxml22 = fs.readFileSync(path.join(MP, 'pages/home/home.wxml'), 'utf8');
  const homeSrc22 = fs.readFileSync(path.join(MP, 'pages/home/home.js'), 'utf8');
  const wxss22 = fs.readFileSync(path.join(MP, 'app.wxss'), 'utf8');
  const progressSrc22 = fs.readFileSync(path.join(MP, 'lib/progress.js'), 'utf8');

  ok(!/level-title/.test(homeWxml22), '首页不再渲染「第几关」文字标签');
  ok(!/fullTitle/.test(homeWxml22), '首页不取 fullTitle，长文案不再挤占按钮');
  ok(!/\.level-title\s*\{/.test(wxss22), '对应样式一起删掉，不留死规则');
  eq((homeWxml22.match(/class="level-inline"/g) || []).length, 3,
     '三科按钮仍各有一组关卡点');
  ['chinese', 'math', 'english'].forEach((s) => {
    ok(new RegExp('levels\\.' + s + '\\.nodes').test(homeWxml22),
       s + ' 的 6 个关卡点还在');
  });
  ok(/<button[^>]*subject-btn[\s\S]{0,420}class="level-inline"/.test(homeWxml22),
     '关卡点仍挂在按钮内部，没有新增一行');
  ok(/width: 10px/.test(wxss22) && /gap: 4px/.test(wxss22),
     '圆点和间距收小一格，选课行更轻');
  ok(!/flex-direction: column/.test(wxss22.slice(wxss22.indexOf('.level-inline'),
     wxss22.indexOf('.level-track'))), '去掉文字后不再需要纵向排布');
  ok(/levels: mapOn \? progress\.levelMapBySubject\(save\) : null/.test(homeSrc22),
     '首页仍传关卡数据，家长页开关照常生效');
  ok(/fullTitle:/.test(progressSrc22) && /lapText:/.test(progressSrc22),
     '数据层文案与累计进度保留，随时能恢复显示');
}

/* ---- 8R. 1.2.23：首页按参考图改成卡片式版式 ---- */
{
  const fs = require('fs');
  const wxml23 = fs.readFileSync(path.join(MP, 'pages/home/home.wxml'), 'utf8');
  const wxss23 = fs.readFileSync(path.join(MP, 'app.wxss'), 'utf8');
  const sw23 = fs.readFileSync(path.join(ROOT, 'docs/sw.js'), 'utf8');

  /* 三科横排大卡片 */
  const listBlock23 = wxss23.slice(wxss23.indexOf('.subject-list {'),
                                   wxss23.indexOf('.subject-btn {'));
  ok(/flex-direction:\s*row/.test(listBlock23), '三科入口从三条横条改成横排');
  const cardBlock23 = wxss23.slice(wxss23.indexOf('.subject-btn {'),
                                   wxss23.indexOf('.subject-cn '));
  ok(/height:\s*176px/.test(cardBlock23) && /border-radius:\s*28px/.test(cardBlock23),
     '选课按钮是大圆角卡片');
  ok(/\.subject-btn::after\s*\{\s*border:\s*none/.test(wxss23),
     '去掉小程序 button 默认的 ::after 描边');
  ['subject-cn', 'subject-ma', 'subject-en'].forEach((c) => {
    ok(wxml23.indexOf('class="subject-btn ' + c + '"') >= 0, c + ' 保留自己的配色');
  });
  eq((wxml23.match(/<view class="subject-name">/g) || []).length, 3, '三科科名都在');
  const nameBlock23 = wxss23.slice(wxss23.indexOf('.subject-name {'),
                                   wxss23.indexOf('.subject-name text'));
  ok(/flex-direction:\s*column/.test(nameBlock23), '科名竖排两字');
  ok(/<view class="subject-name"><text>语<\/text><text>文<\/text><\/view>/.test(wxml23),
     '语文拆成竖排两字');

  /* 关卡点落在卡片底部，仍不新增一行 */
  const inlineBlock23 = wxss23.slice(wxss23.indexOf('.level-inline {'),
                                     wxss23.indexOf('.level-track'));
  ok(/position:\s*absolute/.test(inlineBlock23) && /bottom:\s*14px/.test(inlineBlock23),
     '关卡点绝对定位到卡片底部');
  eq((wxml23.match(/class="level-inline"/g) || []).length, 3,
     '仍是每组一排在按钮内部');

  /* 底部两个大按钮。顶部信息区在 1.2.24 又收成极简胶囊，见 8S。 */
  eq((wxml23.match(/home-action/g) || []).length, 2, '复习与家长两个按钮改成大卡片');
  ok(/min-height:\s*92px/.test(wxss23), '底部按钮加高');
  ok(/本局 \{\{reviewRoundSize\}\} 题/.test(wxml23), '复习按钮仍报本局题数');
  ok(/\{\{stars\}\}/.test(wxml23), '星星数仍显示');
  ok(/\.big-text \.subject-name \{ font-size: 50px; \}/.test(wxss23),
     '大字模式跟着放大，不会反而缩回 36px');
  ok(/yxjx-6ee740ece2/.test(sw23), 'docs/sw.js 哈希不变，网页版不用重新部署');
}

/* ---- 8S. 1.2.24：首页顶部收成极简版 ---- */
{
  const fs = require('fs');
  const wxml24 = fs.readFileSync(path.join(MP, 'pages/home/home.wxml'), 'utf8');
  const homeSrc24 = fs.readFileSync(path.join(MP, 'pages/home/home.js'), 'utf8');
  const wxss24 = fs.readFileSync(path.join(MP, 'app.wxss'), 'utf8');
  const result24 = fs.readFileSync(path.join(MP, 'pages/result/result.wxml'), 'utf8');
  const parent24 = fs.readFileSync(path.join(MP, 'pages/parent/parent.wxml'), 'utf8');
  const sw24 = fs.readFileSync(path.join(ROOT, 'docs/sw.js'), 'utf8');

  /* 原来顶部 5 行 + 底部 1 行全部收净，一个绑定都不留。 */
  ['home-head', 'home-title', 'home-sub', 'home-progress-row', 'home-stats',
   'home-points', 'badge-strip', 'badge-progress', 'home-next', 'monster-row',
   'home-last', '{{subTitle}}', '{{progressPct}}', '{{nextBadge}}',
   '{{lastText}}', '{{monsters.length}}'].forEach((c) => {
    ok(wxml24.indexOf(c) < 0, c + ' 已从首页收掉');
  });

  /* 右上角一枚胶囊：星星 + 四枚小徽章，绝对定位不占布局高度。 */
  eq((wxml24.match(/class="home-mini"/g) || []).length, 1, '只剩一枚状态胶囊');
  ok(/⭐ \{\{stars\}\}/.test(wxml24), '胶囊里仍是真实星星数');
  ok(/wx:for="\{\{badges\}\}"/.test(wxml24) &&
     /item\.got \? 'is-got'/.test(wxml24), '徽章解锁状态仍在胶囊里可辨');
  const miniBlock24 = wxss24.slice(wxss24.indexOf('.home-mini {'),
                                   wxss24.indexOf('.home-mini-stars'));
  ok(/position:\s*absolute/.test(miniBlock24) && /top:\s*12px/.test(miniBlock24),
     '胶囊绝对定位，不占文档流、不把首页顶出小屏');
  ok(/\.big-text \.home-mini-stars/.test(wxss24), '大字模式同步放大胶囊');

  /* 首页专属死规则清掉，结算页复用的徽章样式必须保留。 */
  ['.home-title {', '.home-sub {', '.home-last', '.home-next',
   '.badge-progress', '.badge-claimed', '.monster-face', '.hp-dot'].forEach((c) => {
    ok(wxss24.indexOf(c) < 0, '不留死规则 ' + c);
  });
  ok(/\.badge-strip\s*\{/.test(wxss24) && /\.badge-name\s*\{/.test(wxss24),
     '结算页仍在用的徽章样式保留');
  ok(/class="badge-strip"/.test(result24), '结算页确实还摆徽章条');

  /* 三科卡片与两个入口一个不少。 */
  eq((wxml24.match(/class="subject-btn /g) || []).length, 3, '三科卡片仍在');
  eq((wxml24.match(/class="level-inline"/g) || []).length, 3, '三科关卡点仍在');
  eq((wxml24.match(/home-action/g) || []).length, 2, '复习与家长入口仍在');
  ok(/wx:if="\{\{reviewRoundSize >= 3\}\}"/.test(wxml24), '复习入口门槛照旧');
  ok(/height:\s*176px/.test(wxss24), '卡片尺寸没被顺手改掉');

  /* 关键：home.js 一行没动，被收掉的只是展示层，数据随时能接回来。 */
  ['stars:', 'subTitle:', 'badges:', 'progressPct:', 'nextBadge:',
   'lastText:', 'monsters:', 'goalReached:', 'levels:', 'bigText:'].forEach((k) => {
    ok(homeSrc24.indexOf(k) >= 0, 'home.js 仍产出数据 ' + k);
  });
  ok(/rewards\.badgeList\(save/.test(homeSrc24) &&
     /rewards\.monstersOf\(save\)/.test(homeSrc24), '徽章与小怪物数据仍在算');
  ok(/bindchange="onToggleBadgeClaim"/.test(parent24) &&
     /当前星星/.test(parent24), '账目与徽章在家长页照常可见');
  ok(/yxjx-6ee740ece2/.test(sw24), 'docs/sw.js 哈希不变，网页版不用重新部署');
}

/* ---- 8T. 1.2.25：正式版新代码包主动提示重启 ---- */
{
  const fs = require('fs');
  const appSrc25 = fs.readFileSync(path.join(MP, 'app.js'), 'utf8');
  const sw25 = fs.readFileSync(path.join(ROOT, 'docs/sw.js'), 'utf8');
  const umBlock25 = appSrc25.slice(appSrc25.indexOf('// 1.2.25'));

  /* 静态：能力检测、三个回调、可取消、失败给出可操作出路。 */
  ok(/typeof wx\.getUpdateManager === 'function'/.test(umBlock25),
     '先做能力检测，低版本基础库不炸');
  ok(/try \{/.test(umBlock25) && /catch \(e\)/.test(umBlock25),
     '整段包在 try/catch 里');
  ['onCheckForUpdate', 'onUpdateReady', 'onUpdateFailed', 'applyUpdate'].forEach((k) => {
    ok(umBlock25.indexOf(k) >= 0, '注册 ' + k);
  });
  ok(/cancelText:\s*'稍后再说'/.test(umBlock25), '可以稍后再说，不打断正在答的题');
  ok(/r && r\.confirm/.test(umBlock25), '只有点确认才重启');
  ok(/showCancel:\s*false/.test(umBlock25), '下载失败时只给一个「知道了」');
  ok(/删掉这个小程序/.test(umBlock25), '失败提示给出删掉重进的操作路径');
  ok(appSrc25.indexOf('// 1.2.25') > appSrc25.indexOf('setInnerAudioOption'),
     '更新检查排在启动主链路之后，抛错也不影响存档与音频');
  ok(/yxjx-6ee740ece2/.test(sw25), 'docs/sw.js 哈希不变，网页版不用重新部署');

  /* 动态：默认 wx 桩没有这个 API —— 前面所有断言都跑在低版本路径上。 */
  eq(typeof wx.getUpdateManager, 'undefined', '默认桩模拟低版本基础库');

  const handlers25 = {};
  const modals25 = [];
  let applied25 = 0;
  let confirm25 = true;
  const origGetUM25 = wx.getUpdateManager;
  const origModal25 = wx.showModal;
  const origInfo25 = console.info;
  const origWarn25 = console.warn;

  // 桩里故意触发的「抛错」会打一整段堆栈，容易被误读成测试失败。
  console.info = () => {};
  console.warn = () => {};

  wx.getUpdateManager = function () {
    return {
      onCheckForUpdate: (cb) => { handlers25.check = cb; },
      onUpdateReady: (cb) => { handlers25.ready = cb; },
      onUpdateFailed: (cb) => { handlers25.failed = cb; },
      applyUpdate: () => { applied25++; }
    };
  };
  wx.showModal = function (o) {
    modals25.push(o);
    if (o && o.success) o.success({ confirm: confirm25, cancel: !confirm25 });
  };

  try {
    app.onLaunch();
    ['check', 'ready', 'failed'].forEach((k) => {
      eq(typeof handlers25[k], 'function', 'onLaunch 注册了 ' + k);
    });

    handlers25.check({ hasUpdate: false });
    handlers25.check({ hasUpdate: true });
    eq(modals25.length, 0, '仅检查到新版本不弹窗，等下载完成才提示');

    handlers25.ready();
    eq(modals25.length, 1, '新包下载完成弹一次重启提示');
    ok(/重启/.test(modals25[0].confirmText), '确认按钮是「立即重启」');
    eq(modals25[0].cancelText, '稍后再说', '取消按钮是「稍后再说」');
    eq(applied25, 1, '点确认才 applyUpdate');

    confirm25 = false;
    handlers25.ready();
    eq(modals25.length, 2, '稍后分支也只弹一次');
    eq(applied25, 1, '点稍后再说不重启，孩子能接着答完这局');

    confirm25 = true;
    handlers25.failed();
    eq(modals25.length, 3, '下载失败也给提示');
    eq(modals25[2].showCancel, false, '失败提示只有一个按钮');
    ok(/删掉这个小程序/.test(modals25[2].content), '失败文案给得出路');
    eq(applied25, 1, '失败时不会误重启');

    /* 基础库 API 抛错也不能拖垮启动。 */
    wx.getUpdateManager = function () { throw new Error('mock SDK'); };
    let threw25 = false;
    try { app.onLaunch(); } catch (e) { threw25 = true; }
    eq(threw25, false, 'getUpdateManager 抛错时 onLaunch 仍然正常返回');
  } finally {
    wx.showModal = origModal25;
    console.info = origInfo25;
    console.warn = origWarn25;
    if (origGetUM25 === undefined) delete wx.getUpdateManager;
    else wx.getUpdateManager = origGetUM25;
  }
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
