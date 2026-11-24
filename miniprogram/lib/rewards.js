/* rewards.js — 1.2.15 第一批「让攒星有终点」的三个小组件，数据层
 *
 * 全部是纯读函数：只读 save，不写存档、不碰 wx，页面负责写。
 * 刻意只放小程序端、不进 src/js/ —— 网页版产物哈希保持零改动。
 *
 *   1. badgeList   徽章除了「解锁」，再补一个「家长已兑现」的状态
 *   2. goalState   今天玩了几局的小目标，只打勾、绝不发星
 *   3. monstersOf  错题本里没掌握的题 → 带血量的小怪物
 *
 * 三个都不碰 points / redemptions / sessions：星星账目仍是整局结算时唯一
 * 入口，家长页三方审计和每日 60 星上限不受影响。
 */
var G = require('../generated/lib/game.js');

var GOAL = 2;              // 每天 2 局
var MONSTER_LIMIT = 5;     // 首页最多摆 5 只，多了挤
var HP = 2;                // 与 recordAnswer 的 rightStreak >= 2 → cleared 对齐

/**
 * 今天完成的局数。中途退出、0 题空局都不算；口径与家长页「今日局数」
 * 完全一致，和折线一样不会把 0 题空局算成一局。
 *
 * 1.2.18：这里用「total 缺失 或 > 0」而不是简单的 `s.total > 0` ——
 * 老存档 / 精简备份里的 session 可能没有 total 字段，那些仍算完成局，
 * 只有明确标成 0 题（或脏数据里的负数 / NaN）才排除。折线必须要求
 * total > 0（它要拿 total 当分母），所以只在「显式 0 题」这一点上同口径。
 */
function roundsToday(save) {
  var today = G.localDateStr();
  return (save.sessions || []).filter(function (s) {
    return !s.aborted
      && (s.total === undefined || s.total > 0)
      && G.localDateStr(new Date(s.ts)) === today;
  }).length;
}

/**
 * 小目标只打勾、不发星：逐题或按目标加星会和每日上限、家长页审计对不上
 * （1.2.9 的动画边界里也明确写了「过程中不改星星账目」）。
 */
function goalState(save) {
  var n = roundsToday(save);
  return {
    done: Math.min(n, GOAL),
    target: GOAL,
    reached: n >= GOAL,
    text: n >= GOAL
      ? '今天 ' + n + ' 局，目标完成'
      : '今天 ' + n + ' / ' + GOAL + ' 局'
  };
}

function claimsOf(save) {
  return (save && save.badgeClaims) || {};
}

/**
 * 徽章列表补 claimed。key 用徽章的 need（10/30/50/100）而不是名字或 emoji ——
 * 以后换图标、改名字，老存档里的兑现记录仍然对得上。
 * 老存档没有 badgeClaims 时全部按「未兑现」，migrate() 不会删未知字段，
 * 所以小程序写入的记录能随备份导出 / 导入正常带走。
 */
function badgeList(save, badges) {
  var claims = claimsOf(save);
  return (badges || []).map(function (b) {
    var at = claims[b.need] || '';
    return {
      need: b.need,
      emoji: b.emoji,
      name: b.name,
      got: b.got,
      claimed: !!at,
      claimedAt: at,
      label: b.emoji + ' ' + b.name + (at ? ' · ' + at : '')
    };
  });
}

/**
 * 还没掌握的错题 → 小怪物。rightStreak 每 +1 掉一格血，连对两次被 cleared
 * 收服（这道题就从首页消失）。排序与 buildReviewRound 同源：错得最多、
 * 最近错的排前面，孩子一眼看到的就是下一局会先练的那几道。
 */
function monstersOf(save, limit) {
  var max = limit || MONSTER_LIMIT;
  var book = (save && save.wrongBook) || [];
  // 1.2.20：失效 qid（题库改版 / 导入老备份）以前会留一只永远收服不了的
  // 小怪物 —— 复习局反查不到它，连对两次也清不掉。和 reviewPicks 一样
  // 先反查题库：只有还能组进复习局的题才摆到首页。家长页 wrongTotal 仍
  // 是错题本真实条数（含失效项），那个口径是「待巩固的题」，不动。
  var list = (Array.isArray(book) ? book : [])
    .filter(function (w) { return w && !w.cleared && G.Bank.byId(w.qid); })
    .sort(function (a, b) {
      return ((b.wrongCount || 0) - (a.wrongCount || 0)) ||
             ((b.lastWrongAt || 0) - (a.lastWrongAt || 0));
    });
  return {
    total: list.length,
    shown: list.slice(0, max).map(function (w, i) {
      var streak = Math.max(0, Math.min(HP, w.rightStreak || 0));
      return {
        id: w.qid,
        hp: HP - streak,
        tone: i % 3,
        subject: G.SUBJECT_LABEL[w.subject] || ''
      };
    })
  };
}

module.exports = {
  GOAL: GOAL,
  MONSTER_LIMIT: MONSTER_LIMIT,
  HP: HP,
  roundsToday: roundsToday,
  goalState: goalState,
  claimsOf: claimsOf,
  badgeList: badgeList,
  monstersOf: monstersOf
};
