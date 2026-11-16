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

var BADGES = [
  { need: 10,  emoji: '🌱', name: '小苗' },
  { need: 30,  emoji: '🌟', name: '小星' },
  { need: 60,  emoji: '🚀', name: '火箭' },
  { need: 100, emoji: '👑', name: '大王' }
];

/**
 * 每科一套星星阈值。
 *
 * 现在三科都是 9 / 6，留成一张表是为了**以后能单独调**：数学一局 10 题里
 * 有 8 成是难度 2（计算、应用题、找规律），如果实际玩下来 3 星太少，
 * 把 math 的 three 改成 8 就行，不用动逻辑。
 *
 * 阈值不再是 8 / 5：旧阈值下「1 星」几乎不会出现（中等水平约 0.4%），
 * 等于白设一档；9 / 6 之后三科都能真的掉到 1 星，3 星也要做对 9 题
 * 才拿得到，梯度才是活的。
 */
var RULES = {
  chinese: { three: 9, two: 6 },
  math:    { three: 9, two: 6 },
  english: { three: 9, two: 6 }
};

/**
 * 一局该给几颗星。只看答对题数，不掺随机。
 *
 * 1 星是保底 —— 全错也给。这个游戏的前提是「答错不卡住」，
 * 结算时给 0 星等于把「答错」变成惩罚，和整个设计相反。
 */
function forCorrect(correct, subject) {
  var r = RULES[subject] || RULES.chinese;
  if (correct >= r.three) return 3;
  if (correct >= r.two) return 2;
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
  forCorrect: forCorrect,
  badgeState: badgeState,
  nextBadge: nextBadge,
  progressPct: progressPct
};
