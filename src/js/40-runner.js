/* 40-runner.js — 一局的编排：4/3/3 配比 + 位置软约束 + 答题结算
 *
 * 位置软约束是这里最重要的设计：
 *   第 1 题和第 10 题必来自孩子正确率最高的池。
 *   6 岁孩子最后一题的成败，直接决定他明天还想不想玩。
 */
(function (window) {
  'use strict';

  var G = window.G;

  /* ---------- 成功概率估计 ---------- */

  /**
   * 估计孩子答对某题的概率。有历史用历史，没历史用难度 + 是否刚学过做代理。
   * 只用来排位置，不参与计分。
   */
  function successProb(q, save) {
    var rec = null;
    save.wrongBook.forEach(function (w) { if (w.qid === q.id) rec = w; });
    if (rec && rec.seen > 0) return rec.correct / rec.seen;

    // 无历史：难度 1 → 0.9, 难度 2 → 0.75, 难度 3 → 0.6
    var byDiff = { 1: 0.9, 2: 0.75, 3: 0.6 }[q.difficulty || 1] || 0.75;

    // 英语：最新学过的单元更熟
    if (q.subject === 'english' && q.family) {
      var units = G.Curriculum.unlockedUnitIds(save);
      var latest = units[units.length - 1];
      if (G.Curriculum.familyInUnit(q.family, latest)) byDiff += 0.05;
    }
    return G.clamp(byDiff, 0.1, 0.98);
  }

  /* ---------- 组局 ---------- */

  function buildRound(save) {
    var mix = save.settings.mix || G.DEFAULT_MIX;
    var total = mix.chinese + mix.math + mix.english;
    var dateSeed = G.localDateStr();

    var rng = G.rngFrom(dateSeed + '|round|' + save.sessions.length + '|' + Math.floor(Math.random() * 1e9));
    var used = [];

    // 语文、数学各自抽
    var cn = [], ma = [];
    for (var i = 0; i < mix.chinese; i++) {
      var q1 = G.Curriculum.drawOne('chinese', save, dateSeed, used);
      if (q1) { cn.push(q1); used.push(q1.id); }
    }
    for (var j = 0; j < mix.math; j++) {
      var q2 = G.Curriculum.drawOne('math', save, dateSeed, used);
      if (q2) { ma.push(q2); used.push(q2.id); }
    }

    // 英语：同一词族的固定序列
    var enSeq = G.Curriculum.buildEnglishSequence(save, dateSeed, []);
    var en = enSeq.questions.slice(0, mix.english);

    G.log('本局英语词族 =', enSeq.family, '题数 =', en.length);

    // ---- 位置安排 ----
    var slots = new Array(total).fill(null);

    // 1. 英语 3 题落在位置 2–7（1-based）→ index 1..6
    var enSlots = G.shuffle([1, 2, 3, 4, 5, 6], rng).slice(0, en.length).sort(function (a, b) { return a - b; });
    en.forEach(function (q, i) {
      if (enSlots[i] !== undefined) slots[enSlots[i]] = q;
    });

    // 2. 剩余位置放语文数学
    var rest = cn.concat(ma);
    var freeIdx = [];
    for (var k = 0; k < total; k++) if (!slots[k]) freeIdx.push(k);

    // 语数交替铺开，避免连着 4 道数学
    rest = interleave(cn, ma);

    freeIdx.forEach(function (idx, i) {
      slots[idx] = rest[i] || null;
    });

    // 3. 第 1 题和第 10 题换成高正确率池里的题（位置上原有的题退回候补）
    var filled = slots.filter(Boolean);
    swapForEasy(slots, 0, filled, save, q => q.subject !== 'english');
    swapForEasy(slots, total - 1, filled, save, q => q.subject !== 'english');

    var out = slots.filter(Boolean);

    // 兜底：万一某科目题量不足导致槽位空缺
    while (out.length < total) {
      var extra = G.Curriculum.drawOne('chinese', save, dateSeed, out.map(function (q) { return q.id; }));
      if (!extra) break;
      out.push(extra);
    }

    return {
      family: enSeq.family,
      questions: out,
      startedAt: Date.now()
    };
  }

  function interleave(a, b) {
    var out = [], i = 0, j = 0;
    var takeA = true;
    while (i < a.length || j < b.length) {
      if (takeA && i < a.length) out.push(a[i++]);
      else if (!takeA && j < b.length) out.push(b[j++]);
      else if (i < a.length) out.push(a[i++]);
      else if (j < b.length) out.push(b[j++]);
      takeA = !takeA;
    }
    return out;
  }

  /**
   * 把指定位置换成「孩子最可能答对」的题。
   * 只在非英语题里换 —— 英语题的顺序有教学意义（听→拼→用），不能动。
   */
  function swapForEasy(slots, idx, filled, save, filterFn) {
    var current = slots[idx];
    if (!current) return;

    var candidates = filled.filter(function (q) {
      return q !== current && filterFn(q) && slots.indexOf(q) < 0;
    });
    if (!candidates.length) return;

    // 从候补里找一道比当前题更容易的
    var better = candidates
      .map(function (q) { return { q: q, p: successProb(q, save) }; })
      .filter(function (x) { return x.p > successProb(current, save) + 0.05; })
      .sort(function (a, b) { return b.p - a.p; })[0];

    if (better) {
      var oldIdx = slots.indexOf(better.q);
      slots[idx] = better.q;
      if (oldIdx >= 0) slots[oldIdx] = current;   // 换下来的题回填到原位置
    }
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
        qid: q.id, subject: q.subject, family: q.family || null,
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

    // --- 分项统计 ---
    if (q.subject === 'english') {
      if (q.family) {
        var fs = save.progress.english.familyStats[q.family] ||
                 (save.progress.english.familyStats[q.family] = { seen: 0, correct: 0, lastSeen: 0 });
        fs.seen++; if (correct) fs.correct++;
        fs.lastSeen = now;
      }
      var ts = save.progress.english.typeStats[q.type] ||
               (save.progress.english.typeStats[q.type] = { seen: 0, correct: 0 });
      ts.seen++; if (correct) ts.correct++;
    } else {
      var bucket = save.progress[q.subject].byTag;
      (q.tags || []).forEach(function (tag) {
        var t = bucket[tag] || (bucket[tag] = { seen: 0, correct: 0 });
        t.seen++; if (correct) t.correct++;
      });
    }

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
      family: round.family || null,
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
