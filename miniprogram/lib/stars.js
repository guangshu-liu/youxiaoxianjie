/* stars.js — 星星与徽章
 *
 * 网页版每答对一题转一次抽奖盘；小程序这一版把随机奖励整个拿掉了
 * （抽奖是微信审核的明确红线，而且随机奖励对 6 岁孩子也不是好设计）。
 * 换成确定性的结算：答得越好，这一局的星星越多。
 *
 * 星星**直接存在 save.points 里**，不新增字段：
 *   balance  = 当前可用星星
 *   lifetime = 累计获得（徽章按它算，不会因为将来引入消耗而倒退）
 * 于是存档结构、迁移、三方审计、备份格式全部不用改，网页版的备份
 * 也能直接导入。
 */

/* 徽章换成孩子真正想要的东西：攒够星星换实物/活动奖励。
 * 图标用 emoji 近似 —— 布鲁克是积木人偶（🤖），超市用购物车（🛒）。
 * 阈值不动，存档里只存累计星星数，改名字和图标不影响老存档。 */
var BADGES = [
  { need: 10,  emoji: '🍟', name: '薯条' },
  { need: 30,  emoji: '🤖', name: '布鲁克' },
  { need: 50,  emoji: '📺', name: '动画片' },
  { need: 100, emoji: '🛒', name: '超市' }
];

/**
 * 每科一套星星阈值，外加复习局独立一档。
 *
 * 现在都是 9 / 6，留成一张表是为了**以后能单独调**：数学一局 10 题里
 * 有 8 成是难度 2（计算、应用题、找规律），如果实际玩下来 3 星太少，
 * 把 math 的 three 改成 8 就行，不用动逻辑。
 *
 * review 单独一档是必须的：复习局跨科混合、没有 subject，以前靠
 * `this.subject || 'chinese'` 悄悄落到语文档 —— 现在三科同阈值看不出
 * 问题，一旦真把 math 改成 8/5，复习局会继续按语文算，而且从结算数字
 * 上完全看不出来。play 页显式传 'review'，调单科阈值就不会连带改到它。
 *
 * 阈值不再是 8 / 5：旧阈值下「1 星」几乎不会出现（中等水平约 0.4%），
 * 等于白设一档；9 / 6 之后三科都能真的掉到 1 星，3 星也要做对 9 题
 * 才拿得到，梯度才是活的。
 */
var RULES = {
  chinese: { three: 9, two: 6 },
  math:    { three: 9, two: 6 },
  english: { three: 9, two: 6 },
  review:  { three: 9, two: 6 }
};

/**
 * 一局该给几颗星。不掺随机，按**正确率**判档。
 *
 * 阈值 RULES 是按标准局 10 题定的（9 题 3 星 / 6 题 2 星），这里换算成
 * 0.9 / 0.6。不换算的话错题复习局会吃亏 —— 复习局「不足一局就出几道算
 * 几道」，3 道题全对在绝对阈值下只能拿 1 星，孩子会觉得全对了也没奖励。
 *
 * total 省略（undefined / null）时按 10 题标准局，普通局行为与旧版逐档
 * 一致（9→3、6→2）。少于 3 题的局固定 1 星：2 道题全对拿 3 星太容易刷；
 * 每日 60 星上限和错题 cleared 机制只兜住长局，兜不住这种极短局。
 *
 * 1 星是保底 —— 全错也给。这个游戏的前提是「答错不卡住」，
 * 结算时给 0 星等于把「答错」变成惩罚，和整个设计相反。
 *
 * 1.2.18 的空局边界：只有「没传 total」才算省略。显式传 0（或负数 /
 * NaN）是一题都没答的空局，返回 0 星 —— 它不是「答错」，不该吃保底，
 * 更不该被旧写法 `total || 10` 当成省略值，让 9 道对题在 0 题局里
 * 算出 3 星。另外把脏数据里超过题数的 correct 夹回 n，避免除出 >100%
 * 的正确率白拿高星。
 */
function forCorrect(correct, subject, total) {
  var r = RULES[subject] || RULES.chinese;
  var n;
  if (total === undefined || total === null) {
    n = 10;                              // 省略：兼容旧调用，按标准局
  } else {
    n = Number(total);
    if (!isFinite(n) || n < 1) return 0;  // 显式 0 / 负数 / NaN → 空局不发星
    n = Math.floor(n);
  }
  if (n < 3 || !correct || correct <= 0) return 1;
  var c = Number(correct);
  if (!isFinite(c)) return 1;
  if (c > n) c = n;                     // 答对数不可能比题数还多
  var pct = c / n;
  if (pct >= r.three / 10) return 3;
  if (pct >= r.two / 10) return 2;
  return 1;
}

/** 徽章列表 + 是否已解锁。 */
function badgeState(lifetime) {
  return BADGES.map(function (b) {
    return { need: b.need, emoji: b.emoji, name: b.name, got: lifetime >= b.need };
  });
}

/** 下一个还没拿到的徽章。全拿到了返回 null。 */
function nextBadge(lifetime) {
  for (var i = 0; i < BADGES.length; i++) {
    if (lifetime < BADGES[i].need) {
      return {
        need: BADGES[i].need,
        left: BADGES[i].need - lifetime,
        name: BADGES[i].name,
        emoji: BADGES[i].emoji
      };
    }
  }
  return null;
}

/** 当前这一档的进度百分比（0–100），用于首页进度条。 */
function progressPct(lifetime) {
  var nx = nextBadge(lifetime);
  if (!nx) return 100;
  var from = 0;
  for (var i = 0; i < BADGES.length; i++) {
    if (BADGES[i].need <= lifetime) from = BADGES[i].need;
  }
  var span = nx.need - from;
  if (span <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round((lifetime - from) / span * 100)));
}

module.exports = {
  BADGES: BADGES,
  // 导出只为回归测试能临时改 math 档，验证复习局不受单科调整影响；
  // 运行时不要在业务代码里改这张表。
  RULES: RULES,
  forCorrect: forCorrect,
  badgeState: badgeState,
  nextBadge: nextBadge,
  progressPct: progressPct
};
