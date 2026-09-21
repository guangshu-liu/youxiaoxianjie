/* 30-bank.js — 题库：三科分仓 + 加权抽题
 *
 * 从 300 道题里挑一局 10 道，挑得有讲究。
 *
 * 讲究一：**三科分开抽，不混在一起抽**。
 *   如果按 3:3:4 的比例做一张 300 道的加权表然后连抽 10 次，抽出来的
 *   科目分布会随题库大小和权重浮动 —— 语文 90 道、英语 120 道，均匀抽的话
 *   英语天然就多，再叠上错题加权，很可能一局里 8 道英语、1 道语文。
 *   「一局里三科各出几道」是产品要求，不是概率结果，所以按科目配额抽满为止。
 *
 * 讲究二：**科目内不均匀随机**（这部分和以前一样）。
 *   均匀随机会让孩子已经滚瓜烂熟的字反复出现（浪费时间），而总写错的字
 *   永远轮不到（得不到练习）。所以按错题本加权：没掌握的加权重出，
 *   连对两次的降权。
 *
 * 干扰项不在这里生成。所有科目的选项都是内容问题，已经在构建期由
 * tools/gen_*.py 算好写进题库 —— 运行时不猜。
 */
(function (window) {
  'use strict';

  var G = window.G;

  var banks = {};        // { chinese: [q, ...], math: [...], english: [...] }
  var zibiao = null;

  /* ---------- 加载 ---------- */

  function init(data) {
    banks = {};
    var missing = [];

    G.SUBJECTS.forEach(function (s) {
      var list = (data[s] || []).slice();
      if (!list.length) missing.push(G.SUBJECT_LABEL[s] || s);
      banks[s] = list;
    });

    zibiao = data.zibiao || null;

    // 缺一科就让构建期挡住，运行时不带病上线。
    // 少一科的后果不是「少几道题」——是那一局的 10 个坑里空出 3 个，
    // 表现成一局只出 7 道题，而且不报错。
    if (missing.length) {
      throw new Error('缺少题库：' + missing.join('、') + '（跑一次 npm run qbank）');
    }

    G.log('题库已加载',
          G.SUBJECTS.map(function (s) {
            return (G.SUBJECT_LABEL[s] || s) + ' ' + banks[s].length;
          }).join(' · '),
          zibiao ? ('，字表 ' + zibiao.chars.length + ' 字') : '');
  }

  function of(subject) { return banks[subject] || []; }

  /** 全部题目，三科拼一起。给家长页做统计用。 */
  function all() {
    return G.SUBJECTS.reduce(function (acc, s) { return acc.concat(banks[s] || []); }, []);
  }

  function byId(id) {
    for (var i = 0; i < G.SUBJECTS.length; i++) {
      var list = banks[G.SUBJECTS[i]] || [];
      for (var j = 0; j < list.length; j++) {
        if (list[j].id === id) return list[j];
      }
    }
    return null;
  }

  function zibiaoData() { return zibiao; }

  /** 某道题是哪一科的 —— 家长页按科目分组统计时要用。 */
  function subjectOf(id) {
    var q = byId(id);
    return q ? q.subject : null;
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
   * 从指定科目抽一道题。excludeIds 用来保证一局之内不重复。
   * @param {object} save
   * @param {string} subject
   * @param {string[]} excludeIds
   * @param {function} rng  可选，注入固定随机源便于测试
   */
  function drawOne(save, subject, excludeIds, rng) {
    rng = rng || Math.random;
    var pool = banks[subject] || [];
    if (!pool.length) return null;

    var excluded = {};
    (excludeIds || []).forEach(function (id) { excluded[id] = true; });

    var avail = pool.filter(function (q) { return !excluded[q.id]; });
    // 兜底：本科目的题被抽空时允许重复，也不让一局短题。
    // 一局只要 3~4 道，而每个科目至少 90 道，正常永远走不到这里；
    // 但题库被裁剪成十几道时就会 —— 那时候「重复一道」也比「少一道」好。
    if (!avail.length) avail = pool;

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
    of: of,
    all: all,
    byId: byId,
    subjectOf: subjectOf,
    zibiao: zibiaoData,
    weightOf: weightOf,
    drawOne: drawOne
  };

})(window);
