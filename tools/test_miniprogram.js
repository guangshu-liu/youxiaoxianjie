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

  createInnerAudioContext: () => ({
    src: '',
    play() {}, stop() {}, destroy() {},
    onEnded() {}, onError() {}
  }),

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
