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
 * 讲究三：**难度按孩子水平解锁**。
 *   题库里难度 1 是 20 以内不进位加减、字表内的字、字母启蒙；难度 2 是
 *   100 以内进位 / 退位、部首笔画、字母顺序。均匀随机的话，零基础孩子
 *   分科一局 10 道数学能撞上 8 道进位加，玩两次就不玩了。所以先看最近
 *   20 次本科目作答：没数据或正确率低就只出难度 1，≥ 80% 才解锁难度 2。
 *
 * 干扰项不在这里生成。所有科目的选项都是内容问题，已经在构建期由
 * tools/gen_*.py 算好写进题库 —— 运行时不猜。
 */
(function (window) {
  'use strict';

  var G = window.G;

  var banks = {};        // { chinese: [q, ...], math: [...], english: [...] }
  var byIdMap = {};      // id -> q，给 byId 和难度分档回查科目用
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

    byIdMap = {};
    G.SUBJECTS.forEach(function (s) {
      banks[s].forEach(function (q) { byIdMap[q.id] = q; });
    });

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

  function byId(id) { return byIdMap[id] || null; }

  function zibiaoData() { return zibiao; }

  /** 某道题是哪一科的 —— 家长页按科目分组统计时要用。 */
  function subjectOf(id) {
    var q = byId(id);
    return q ? q.subject : null;
  }

  /* ---------- 加权 ---------- */

  /**
   * 一道题的抽取权重。
   *   - 错过的题优先重出，但**封顶 4 倍**：以前 w = 1 + 1.5 × 错次，
   *     连错 6 次就是 10 倍，跨局反复撞同一道题；cleared 后再错一次又
   *     立刻弹回 10 倍，孩子会觉得「怎么老是我不会的那道」。
   *   - 距上次答错越久，权重越低（10 天降到 0.35 倍封底），老错题
   *     不该永远霸占抽题池。
   *   - 连对两次（cleared）降到 0.4 —— 不是不出，是少出。
   */
  function weightOf(q, wrongIndex) {
    var w = 1;
    var rec = wrongIndex[q.id];
    if (rec && !rec.cleared) {
      var days = rec.lastWrongAt
        ? Math.max(0, (Date.now() - rec.lastWrongAt) / 86400000) : 0;
      var decay = Math.max(0.35, 1 - days * 0.1);
      w = Math.min(4, 1 + 1.5 * (rec.wrongCount || 0)) * decay;
    }
    if (rec && rec.cleared) w *= 0.4;
    return w;
  }

  function wrongIndexOf(save) {
    var idx = {};
    (save.wrongBook || []).forEach(function (w) { idx[w.qid] = w; });
    return idx;
  }

  /**
   * 孩子当前该做哪一档题（1 = 基础，2 = 进阶）。
   *
   * 只看最近 20 次**本科目**作答：英语全对不该让数学跟着升档。存档里
   * 只留有 qid 和 correct，所以用 byIdMap 回查科目；题库换过之后旧 qid
   * 查不到就跳过，不拿失效记录充数。
   *
   * 样本不足 6 次（新用户 / 刚清了存档 / 题库更新）一律留在基础档；
   * 返回 { level, acc, seen }。acc 供 drawOne 决定进阶题的混入比例：
   * 以前 ≥0.8 就从「20 以内不进位」整局跳到「100 以内进位」，
   * 掉回 0.79 又立刻打回原地，跨度太硬且来回震荡。现在档位仍是
   * 1/2 两级，但进阶题按比例渐进放开（见 drawOne）。
   */
  function levelDetailOf(save, subject) {
    var sessions = (save && save.sessions) || [];
    var seen = 0, correct = 0;

    for (var i = sessions.length - 1; i >= 0 && seen < 20; i--) {
      var items = (sessions[i] && sessions[i].items) || [];
      for (var j = items.length - 1; j >= 0 && seen < 20; j--) {
        var it = items[j];
        var q = byIdMap[it.qid];
        if (!q || q.subject !== subject) continue;
        seen++;
        if (it.correct) correct++;
      }
    }

    if (seen < 6) return { level: 1, acc: 0, seen: seen };
    var acc = correct / seen;
    return { level: acc >= 0.8 ? 2 : 1, acc: acc, seen: seen };
  }

  /** 对外只暴露档位，语义不变（1 = 基础，2 = 进阶）。 */
  function levelOf(save, subject) {
    return levelDetailOf(save, subject).level;
  }

  /** 把字符串确定性地映射到 [0,1)。用题目 id 划分进阶题，不消耗注入的 rng。 */
  function stableUnit(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return (h >>> 0) / 4294967296;
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

    var detail = levelDetailOf(save, subject);
    var level = detail.level;
    // 刚跨过 80% 只放 25% 的进阶题，越熟练放得越多，全对才全放开。
    // 这样「升档」不再是一夜之间整局换难度，也不会因为一局失手在
    // 两档之间反复横跳。划分用题目 id 的确定性哈希，不额外调用 rng ——
    // 否则固定随机种子的测试断言会整体位移。
    var d2Ratio = level === 2
      ? G.clamp((detail.acc - 0.75) / 0.2, 0.25, 1) : 0;
    var inLevel = function (q) {
      var d = q.difficulty || 1;
      if (d <= 1) return true;
      return d2Ratio > 0 && stableUnit(q.id) < d2Ratio;
    };
    var avail = pool.filter(function (q) {
      return !excluded[q.id] && inLevel(q);
    });
    // 本档的题被这一局抽光时，允许本档重题，也不让一局短题；
    // 更重要的是**不借这个机会把超纲题放进来**。
    if (!avail.length) {
      avail = pool.filter(inLevel);
    }
    // 极端兜底：题库里连本档都没有（裁剪过的测试题库）时才退回全池。
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
    levelOf: levelOf,
    levelDetailOf: levelDetailOf,
    drawOne: drawOne
  };

})(window);
