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
    var used = [];
    var picked = [];

    // **按科目配额抽满，而不是一起抽再按比例挑。**
    // 一起抽的话，科目分布是概率结果不是配额：英语 120 道本来就比语文的
    // 90 道更容易被抽中，再叠上错题加权，一局很可能 8 道英语 1 道语文。
    // 「一局里三科各出几道」是产品要求，得用配额保证。
    G.SUBJECTS.forEach(function (s) {
      var want = G.DEFAULT_MIX[s] || 0;
      for (var i = 0; i < want; i++) {
        var q = G.Bank.drawOne(save, s, used);
        if (!q) break;
        used.push(q.id);
        picked.push(q);
      }
    });

    // 兜底。正常抽不到这一步（每科至少 90 道 >> 一局要的 3~4 道），
    // 只有题库被裁剪到一局以内才会走到：那时允许重复 ——
    // 宁可出现重题，也不要让一局变成半局。
    while (picked.length < G.ROUND_SIZE) {
      var extra = null;
      for (var k = 0; k < G.SUBJECTS.length && !extra; k++) {
        extra = G.Bank.drawOne(save, G.SUBJECTS[k], used);
      }
      if (!extra) break;
      used.push(extra.id);
      picked.push(extra);
    }

    return {
      questions: arrange(picked, save),
      startedAt: Date.now()
    };
  }

  /**
   * 组一局**单科**的题（小程序用：选一科，10 题）。
   *
   * 和 buildRound 的差别只有「从几科抽」：抽题、排位、错题加权、兜底
   * 全部复用同一套代码，所以两端的题目质量不会各自漂移。
   * 网页版继续用 buildRound（3:3:4 混合局），这个函数对它没有影响。
   */
  function buildSubjectRound(save, subject, size) {
    var want = size || G.ROUND_SIZE;
    var used = [];
    var picked = [];

    for (var i = 0; i < want; i++) {
      var q = G.Bank.drawOne(save, subject, used);
      if (!q) break;
      used.push(q.id);
      picked.push(q);
    }

    // 兜底：题库不够时允许重复 —— 宁可重题，也不要让一局变成半局。
    while (picked.length < want) {
      var extra = G.Bank.drawOne(save, subject, used);
      if (!extra) break;
      used.push(extra.id);
      picked.push(extra);
    }

    return {
      questions: arrange(picked, save),
      startedAt: Date.now(),
      subject: subject
    };
  }

  /**
   * 挑出这一局复习**真正能出的题** —— 组局和按钮报数的唯一真相源。
   *
   * 1.2.19：以前按钮按 wrongBook 里未 cleared 的**条数**截断到 10，
   * buildReviewRound 却要拿 qid 反查题库；题库改版后旧 qid 查不到就跳过，
   * 于是「报 10 题、实际只出 6 题」，全部失效时还会开一局空的。另外
   * 老存档 / 备份导入可能带重复 qid，会让按钮多算、同一题出一局两次。
   * 现在把挑题逻辑收在这里：去重 → 反查题库 → 按上限截断，两边都调它，
   * 数字不可能再对不上。
   *
   * size 显式传 0（或负数 / 非数字）时返回空数组：延续 1.2.18 的
   * 「0 题就是空局」语义，不再用 `size || ROUND_SIZE` 把 0 当省略。
   */
  function reviewPicks(save, size) {
    var want = (size === undefined || size === null)
      ? G.ROUND_SIZE : Math.floor(Number(size) || 0);
    if (want <= 0) return [];
    var recs = ((save && save.wrongBook) || [])
      .filter(function (w) { return w && !w.cleared; })
      .sort(function (a, b) {
        return ((b.wrongCount || 0) - (a.wrongCount || 0)) ||
               ((b.lastWrongAt || 0) - (a.lastWrongAt || 0));
      });

    var seen = Object.create(null);
    var picked = [];
    for (var i = 0; i < recs.length && picked.length < want; i++) {
      var id = recs[i].qid;
      if (!id || seen[id]) continue;   // 老存档 / 备份里的重复 qid 只算一次
      seen[id] = true;
      var q = G.Bank.byId(id);
      if (q) picked.push(q);           // 题库更新后旧 qid 查不到，跳过
    }
    return picked;
  }

  /** 这一局真正能出几道题：首页 / 结算页按钮、空局判断都用它。 */
  function reviewRoundSize(save, size) {
    return reviewPicks(save, size).length;
  }

  /**
   * 组一局**错题复习**（小程序用）。
   *
   * 只从错题本里还没 cleared 的题抽，错得最多的排前面；不足一局就出
   * 几道算几道，不用普通题凑数 —— 复习局的意义就是「只练不会的」。
   * 仍然走 arrange()：第 1 题和最后 1 题给孩子最可能答对的，避免
   * 一上来连错两道就把人劝退。
   */
  function buildReviewRound(save, size) {
    return {
      questions: arrange(reviewPicks(save, size), save),
      startedAt: Date.now(),
      review: true
    };
  }

  /**
   * 排位置：
   *   1. 最可能答对的两道，分给第 1 题和第 10 题
   *   2. 剩下的打散，且相邻两题尽量不同科、同科内尽量不同题型
   */
  function arrange(questions, save) {
    if (questions.length <= 2) return questions.slice();

    var ranked = questions.slice().sort(function (a, b) {
      return successProb(b, save) - successProb(a, save);
    });

    var first = ranked[0];
    var last = ranked[1];
    var middle = spread(ranked.slice(2), first, last);

    return [first].concat(middle, [last]);
  }

  function tagOf(q) {
    return (q.tags && q.tags[0]) || q.type || '';
  }

  /**
   * 把中间几道排开：每次从剩下的题里挑一道最「不重样」的放进去。
   *
   * 为什么要重排而不是直接打散：
   *   一局 10 道是 3 语文 + 3 数学 + 4 英语。纯随机打散的话，出现
   *   「连着 3 道英语」甚至「连着 4 道英语」的概率相当高 —— 一局 10 道里
   *   连着刷 4 道英语，孩子感觉就是「这局全是英语」。
   *
   * 打分是字典序的，优先级从高到低：
   *   ① 科目和上一题不同     ② 题型和上一题不同
   *   ③ 科目不和末题撞       ④ 题型不和末题撞（只有剩最后一道时才起作用）
   *   ⑤ 该科目剩下最多       ⑥ 该题型剩下最多
   * 前四条是「别挨着」，后两条是经典的「先消耗大堆」—— 不先消耗大堆，
   * 小堆会剩到最后被迫相邻，前面白排了。
   *
   * 这是软约束：真到了只剩同一科的地步，①拿不到分，就按⑤⑥继续排下去，
   * 不为了满足约束把题目弄丢。
   */
  function spread(items, head, tail) {
    var pool = G.shuffle(items.slice(), Math.random);
    var out = [];
    var prevSub = head.subject;
    var prevTag = tagOf(head);
    var tailSub = tail.subject;
    var tailTag = tagOf(tail);

    while (pool.length) {
      var bySub = {};
      var bySubTag = {};
      pool.forEach(function (q) {
        bySub[q.subject] = (bySub[q.subject] || 0) + 1;
        var k = q.subject + '/' + tagOf(q);
        bySubTag[k] = (bySubTag[k] || 0) + 1;
      });

      var isLast = (pool.length === 1);
      var pick = 0;
      var best = null;

      for (var i = 0; i < pool.length; i++) {
        var q = pool[i];
        var t = tagOf(q);
        var score = [
          q.subject === prevSub ? 0 : 1,
          t === prevTag ? 0 : 1,
          (isLast && q.subject === tailSub) ? 0 : 1,
          (isLast && t === tailTag) ? 0 : 1,
          bySub[q.subject] || 0,
          bySubTag[q.subject + '/' + t] || 0
        ];
        if (best === null || lexGreater(score, best)) { best = score; pick = i; }
      }

      var chosen = pool.splice(pick, 1)[0];
      prevSub = chosen.subject;
      prevTag = tagOf(chosen);
      out.push(chosen);
    }
    return out;
  }

  /** 字典序比较：从前往后，第一个不相等的分量决定胜负。 */
  function lexGreater(a, b) {
    for (var i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] > b[i];
    }
    return false;
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
    // 记到自己那一科下面。三科的题型名天然不重叠（归类 / 拆数 / 听音选字母），
    // 但分开记才看得出「数学应用题弱、语文笔画弱」这种分科结论。
    var prog = save.progress[q.subject] || (save.progress[q.subject] = { byTag: {} });
    var bucket = prog.byTag;
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
      spins: spins,
      // 复习局专挑错题，正确率天然偏低，不能拿去评估难度档。
      // levelDetailOf() 会跳过带这个标记的局；普通局为 false，老存档
      // 没这个字段时是 undefined，同样按普通局处理，兼容。
      review: !!round.review
    };
    save.sessions.push(session);
    while (save.sessions.length > 30) save.sessions.shift();   // 只留最近 30 局
    G.Store.pruneCounters(save);
    G.Store.save(save);
    return session;
  }

  /**
   * 中途退出：把已答题记成一条「未完成」局，不发星星。
   *
   * 为什么不直接回滚：recordAnswer 在每道题 advance() 时就已经写进
   * wrongBook 和 progress 了，精确撤销要存快照，成本高且容易漏。
   * 记一条 aborted 局更诚实 —— 难度评估（levelOf 读 sessions.items）
   * 和家长页统计能认这些作答，账目又完全不受影响（pointsEarned = 0）。
   * 一题都没答就退出时不写，避免往 sessions 里塞垃圾。
   */
  function abandonSession(save, round, items) {
    if (!items || !items.length) return null;

    var session = {
      id: 's_' + round.startedAt,
      ts: Date.now(),
      correct: items.filter(function (x) { return x.correct; }).length,
      total: items.length,
      pointsEarned: 0,
      items: items,
      spins: [],
      aborted: true,
      review: !!round.review
    };
    save.sessions.push(session);
    while (save.sessions.length > 30) save.sessions.shift();
    G.Store.pruneCounters(save);
    G.Store.save(save);
    return session;
  }

  G.Runner = {
    buildRound: buildRound,
    buildSubjectRound: buildSubjectRound,
    buildReviewRound: buildReviewRound,
    reviewRoundSize: reviewRoundSize,
    successProb: successProb,
    recordAnswer: recordAnswer,
    awardPoints: awardPoints,
    awardTvMinutes: awardTvMinutes,
    finishSession: finishSession,
    abandonSession: abandonSession
  };

})(window);
