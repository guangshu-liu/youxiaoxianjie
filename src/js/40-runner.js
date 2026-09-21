/* 40-runner.js — 一局的编排：抽题、排位、答题结算
 *
 * 排位是这里最重要的设计：
 *   第 1 题和第 10 题必来自孩子正确率最高的池。
 *   6 岁孩子最后一题的成败，直接决定他明天还想不想玩。
 *
 * 第二重要的是「同一题型不连着出」：题库里 8 种题型（看拼音选字、
 * 数笔画、反义词…）均匀抽，但连续三道「数笔画」会让一局显得很单调。
 */
(function (window) {
  'use strict';

  var G = window.G;

  /* ---------- 成功概率估计 ---------- */

  /**
   * 估计孩子答对某题的概率。有历史用历史，没历史用难度做代理。
   * 只用来排位置，不参与计分。
   */
  function successProb(q, save) {
    var rec = null;
    save.wrongBook.forEach(function (w) { if (w.qid === q.id) rec = w; });
    if (rec && rec.seen > 0) return rec.correct / rec.seen;

    // 无历史：难度 1 → 0.9, 难度 2 → 0.75, 难度 3 → 0.6
    return G.clamp({ 1: 0.9, 2: 0.75, 3: 0.6 }[q.difficulty || 1] || 0.75, 0.1, 0.98);
  }

  /* ---------- 组局 ---------- */

  /**
   * 组一局。
   *
   * 抽题**不用固定种子**（数学时代用过「同一天同一局」的日种子，那是为了
   * 生成的算式可复现 —— 家长想再讲一遍时题目别变）。这里反过来：同一局
   * 重玩应该换一批字，否则孩子第二遍是背答案而不是认字。错题本的加权
   * 也依赖「刚答错的题立刻变得更常出」，日种子会把这条反馈延迟到明天。
   */
  function buildRound(save) {
    var total = G.DEFAULT_MIX.chinese || G.ROUND_SIZE;
    var used = [];
    var picked = [];

    for (var i = 0; i < total; i++) {
      var q = G.Bank.drawOne(save, used);
      if (!q) break;
      used.push(q.id);
      picked.push(q);
    }

    // 兜底。正常抽不到这一步（296 道题 >> 10），只有题库被改小到一局以内
    // 才会走到：那时先试着再抽一道没出过的，实在没有才允许重复 ——
    // 宁可出现重题，也不要让一局变成半局。
    while (picked.length < total) {
      var extra = G.Bank.drawOne(save, used);
      if (!extra) break;
      if (used.indexOf(extra.id) >= 0) extra = G.Bank.drawOne(save, []);
      else used.push(extra.id);
      if (!extra) break;
      picked.push(extra);
    }

    return {
      questions: arrange(picked, save),
      startedAt: Date.now()
    };
  }

  /**
   * 排位置：
   *   1. 最可能答对的两道，分给第 1 题和第 10 题
   *   2. 剩下的打散，且不让同一题型挨着
   */
  function arrange(questions, save) {
    if (questions.length <= 2) return questions.slice();

    var ranked = questions.slice().sort(function (a, b) {
      return successProb(b, save) - successProb(a, save);
    });

    var first = ranked[0];
    var last = ranked[1];
    var middle = G.shuffle(ranked.slice(2), Math.random);

    return [first].concat(orderByTag(middle, tagOf(first), tagOf(last)), [last]);
  }

  function tagOf(q) {
    return (q.tags && q.tags[0]) || q.type || '';
  }

  /**
   * 按题型交错排列：每次从剩下的题里挑一道和上一题**不同题型**的，并且优先
   * 挑剩余数量最多的那个题型 —— 先把大堆消耗掉，小堆才不会剩到最后被迫相邻。
   *
   * 「看拼音选字」占了题库的三分之一，一局 10 题里通常有 3 道；不做这一步，
   * 它们会以相当高的概率挨在一起，一局看起来就像只有两种题。
   *
   * 这是软约束，不是排序目标：某个题型一旦过半（现在没有），相邻就躲不掉，
   * 那时按原样排下去，不为了满足约束把题目弄丢。
   */
  function orderByTag(items, prevTag, tailTag) {
    var pool = items.slice();
    var out = [];

    while (pool.length) {
      var count = {};
      pool.forEach(function (q) {
        var t = tagOf(q);
        count[t] = (count[t] || 0) + 1;
      });

      var pick = -1;
      var best = -1;
      for (var i = 0; i < pool.length; i++) {
        var t = tagOf(pool[i]);
        if (t === prevTag) continue;
        // 最后一道还要避开末题的题型，否则会在末尾撞上
        if (pool.length === 1 && t === tailTag) continue;
        if (count[t] > best) { best = count[t]; pick = i; }
      }
      if (pick < 0) pick = 0;               // 只剩同题型了，认了

      prevTag = tagOf(pool[pick]);
      out.push(pool.splice(pick, 1)[0]);
    }
    return out;
  }

  /* ---------- 答题结算 ---------- */

  /**
   * 记录一次作答。更新错题本、分项统计、局内记录。
   */
  function recordAnswer(save, q, correct, ms) {
    var now = Date.now();

    // --- 错题本（唯一真相源）---
    var rec = null;
    save.wrongBook.forEach(function (w) { if (w.qid === q.id) rec = w; });
    if (!rec) {
      rec = {
        qid: q.id, subject: q.subject, family: null,
        seen: 0, correct: 0, wrongCount: 0, rightStreak: 0,
        lastWrongAt: 0, cleared: false
      };
      save.wrongBook.push(rec);
    }
    rec.seen++;
    if (correct) {
      rec.correct++;
      rec.rightStreak++;
      if (rec.rightStreak >= 2) rec.cleared = true;   // 连对两次才算真会了
    } else {
      rec.wrongCount++;
      rec.rightStreak = 0;
      rec.cleared = false;
      rec.lastWrongAt = now;
    }

    // --- 按知识点统计（家长面板用）---
    var bucket = save.progress.chinese.byTag;
    (q.tags || []).forEach(function (tag) {
      var t = bucket[tag] || (bucket[tag] = { seen: 0, correct: 0 });
      t.seen++; if (correct) t.correct++;
    });

    return rec;
  }

  /**
   * 累计积分，并受每日上限约束。
   * 注意：转盘中奖的 tv10 也要累加 tvMinutes —— 转盘免费送的和 80 分兑换的
   * 是同一份「动画片时间」，家长关心的是总时长。
   */
  function awardPoints(save, points) {
    if (points <= 0) return { awarded: 0, capped: false };

    var dc = G.Store.todayCounter(save);
    var limit = save.limits.maxPointsPerDay;
    var room = Math.max(0, limit - dc.pointsEarned);
    var awarded = Math.min(points, room);

    dc.pointsEarned += awarded;
    save.points.balance += awarded;
    save.points.lifetime += awarded;

    return { awarded: awarded, capped: awarded < points };
  }

  function awardTvMinutes(save, minutes) {
    var dc = G.Store.todayCounter(save);
    dc.tvMinutes += minutes;
    return dc.tvMinutes;
  }

  function finishSession(save, round, items, spins, pointsEarned) {
    var session = {
      id: 's_' + round.startedAt,
      ts: Date.now(),
      correct: items.filter(function (x) { return x.correct; }).length,
      total: items.length,
      pointsEarned: pointsEarned,
      items: items,
      spins: spins
    };
    save.sessions.push(session);
    while (save.sessions.length > 30) save.sessions.shift();   // 只留最近 30 局
    G.Store.pruneCounters(save);
    G.Store.save(save);
    return session;
  }

  G.Runner = {
    buildRound: buildRound,
    successProb: successProb,
    recordAnswer: recordAnswer,
    awardPoints: awardPoints,
    awardTvMinutes: awardTvMinutes,
    finishSession: finishSession
  };

})(window);
