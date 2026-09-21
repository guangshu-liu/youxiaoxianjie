/* 30-bank.js — 识字题库：加权抽题
 *
 * 这个文件以前是 30-curriculum.js，装的是 OPW2 自然拼读课程表、词族解锁、
 * 最小对立对干扰项生成。英语模块下线后，真正还需要留下的只有一件事：
 * 从题库里挑题，且挑得有讲究。
 *
 * 挑题的讲究只有一条 —— **不均匀随机**。均匀随机会让孩子已经滚瓜烂熟的字
 * 反复出现（浪费时间），而总写错的字永远轮不到（得不到练习）。所以按
 * 错题本加权：没掌握的加权重出，连对两次的降权。
 *
 * 干扰项不在这里生成。识字题的选项是「同音字 / 形近字」，属于内容问题，
 * 已经由 tools/gen_ziku.py 在构建期算好并写进题库 —— 运行时不猜。
 */
(function (window) {
  'use strict';

  var G = window.G;

  var questions = [];
  var zibiao = null;

  /* ---------- 加载 ---------- */

  function init(data) {
    questions = (data.chinese || []).slice();
    zibiao = data.zibiao || null;

    if (!questions.length) throw new Error('缺少识字题库（src/data/chinese.json）');

    G.log('识字题库已加载', questions.length, '道题',
          zibiao ? ('，字表 ' + zibiao.chars.length + ' 字') : '');
  }

  function all() { return questions; }
  function zibiaoData() { return zibiao; }

  function byId(id) {
    for (var i = 0; i < questions.length; i++) {
      if (questions[i].id === id) return questions[i];
    }
    return null;
  }

  /* ---------- 加权 ---------- */

  /**
   * 一道题的抽取权重。
   *   - 错过的题，错得越多权重越高（+1.5 × 错误次数）
   *   - 连对两次（cleared）的题降到 0.4 —— 不是不出，是少出
   *   - 没做过的题权重 1
   */
  function weightOf(q, wrongIndex) {
    var w = 1;
    var rec = wrongIndex[q.id];
    if (rec && !rec.cleared) w += 1.5 * rec.wrongCount;
    if (rec && rec.cleared) w *= 0.4;
    return w;
  }

  function wrongIndexOf(save) {
    var idx = {};
    (save.wrongBook || []).forEach(function (w) { idx[w.qid] = w; });
    return idx;
  }

  /**
   * 抽一道题。excludeIds 用来保证一局之内不重复。
   * @param {object} save
   * @param {string[]} excludeIds
   * @param {function} rng  可选，注入固定随机源便于测试
   */
  function drawOne(save, excludeIds, rng) {
    rng = rng || Math.random;
    var excluded = {};
    (excludeIds || []).forEach(function (id) { excluded[id] = true; });

    var avail = questions.filter(function (q) { return !excluded[q.id]; });
    // 兜底：题库被抽空时允许重复，也不让一局短题
    if (!avail.length) avail = questions;
    if (!avail.length) return null;

    var wrongIndex = wrongIndexOf(save);
    var weights = avail.map(function (q) { return weightOf(q, wrongIndex); });
    var total = G.sum(weights);
    if (total <= 0) return avail[Math.floor(rng() * avail.length)];

    var r = rng() * total;
    for (var i = 0; i < avail.length; i++) {
      r -= weights[i];
      if (r <= 0) return avail[i];
    }
    return avail[avail.length - 1];
  }

  G.Bank = {
    init: init,
    all: all,
    byId: byId,
    zibiao: zibiaoData,
    weightOf: weightOf,
    drawOne: drawOne
  };

})(window);
