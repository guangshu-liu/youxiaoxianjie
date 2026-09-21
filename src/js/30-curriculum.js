/* 30-curriculum.js — OPW2 课程表、解锁、干扰项生成、加权抽题
 *
 * 英语模块教学质量的核心。两个设计约束：
 *   1. 解锁由家长控制，不由游戏自动解锁 —— 游戏进度和课外班进度是两回事
 *   2. 范围之内按「新鲜度 × 薄弱度 × 冷却」加权，不均匀随机 ——
 *      均匀随机会让 -ag 这类低频词族永远得不到练习，而孩子已熟的在浪费时间
 */
(function (window) {
  'use strict';

  var G = window.G;

  var cur = null;                    // curriculum.json 内容
  var questions = { chinese: [], math: [], english: [] };
  var wordsByFamily = {};            // { family: [word] }
  var allWords = {};                 // { word: family } 全局词表，用于最小对立判断

  /* ---------- 加载 ---------- */

  function init(data) {
    cur = data.curriculum || (window.G.CURRICULUM_DATA);
    questions.chinese = (data.chinese || []).slice();
    questions.math = (data.math || []).slice();
    questions.english = (data.english || []).slice();

    if (!cur) throw new Error('缺少 curriculum 数据');

    wordsByFamily = {};
    allWords = {};
    Object.keys(cur.families).forEach(function (fam) {
      var ws = cur.families[fam].words || [];
      wordsByFamily[fam] = ws;
      ws.forEach(function (w) { allWords[w] = fam; });
    });

    G.log('课程已加载', Object.keys(cur.families).length, '个词族,',
          questions.chinese.length, questions.math.length, questions.english.length, '道题');
  }

  function curriculum() { return cur; }

  function unitById(id) {
    return cur.units.filter(function (u) { return u.id === id; })[0] || null;
  }

  /* ---------- 解锁 ---------- */

  /**
   * 家长在面板里选「孩子课上到哪了」，游戏只在这个范围内出题。
   * 若游戏自动解锁，孩子天赋好就会解锁到 U6 而老师才教到 U3 ——
   * 做 U6 全靠猜，会形成错误的拼读直觉。
   */
  function unlockedUnitIds(save) {
    var through = save.settings.englishUnlockedThrough || 'U2';
    var out = [];
    for (var i = 0; i < cur.units.length; i++) {
      out.push(cur.units[i].id);
      if (cur.units[i].id === through) break;
    }
    return out;
  }

  function unlockedFamilies(save) {
    var units = unlockedUnitIds(save);
    var out = [];
    units.forEach(function (uid) {
      var u = unitById(uid);
      if (u) out = out.concat(u.families);
    });
    return out;
  }

  function familyInUnit(family, unitId) {
    var u = unitById(unitId);
    return !!(u && u.families.indexOf(family) >= 0);
  }

  /* ---------- 英语加权 ---------- */

  var COOLDOWN_MS = 5 * 60 * 1000;   // 同一词族 5 分钟内刚出现过就大幅降权

  function familyWeight(family, save, recentFamilies) {
    var st = save.progress.english.familyStats[family] || { seen: 0, correct: 0, lastSeen: 0 };
    var units = unlockedUnitIds(save);
    var latest = units[units.length - 1];

    // 最近学的单元占大头（×2.5）
    var freshness = familyInUnit(family, latest) ? 1.0 : 0.4;

    // 错得多的多出
    var wrongRate = st.seen > 0 ? 1 - (st.correct / st.seen) : 0.5;
    var weakness = 1 + 0.5 * wrongRate;

    // 本局内已经用过该词族 → 降权，避免一局 3 道英语题全是 -an
    var used = (recentFamilies || []).indexOf(family) >= 0;

    // 刚做过 → 降权
    var cooled = st.lastSeen && (Date.now() - st.lastSeen < COOLDOWN_MS);

    var w = freshness * weakness * (used ? 0.05 : 1) * (cooled ? 0.2 : 1);
    return Math.max(w, 0.01);
  }

  function pickFamily(save, rng, recentFamilies) {
    var fams = unlockedFamilies(save);
    var weights = fams.map(function (f) { return familyWeight(f, save, recentFamilies); });
    var total = G.sum(weights);
    var r = rng() * total;
    for (var i = 0; i < fams.length; i++) {
      r -= weights[i];
      if (r <= 0) return fams[i];
    }
    return fams[fams.length - 1];
  }

  /* ---------- 干扰项生成 ----------
   * 100 道英语题手工写选项必然出错，而且很容易写出「孩子不用听就能排除」的废题
   * （比如 fan vs box）。所以干扰项必须程序化生成，且必须是最小对立对。
   */

  /**
   * 拆词：fan → {onset:'f', vowel:'a', coda:'n'}
   * 只处理 CVC（含 -ix 这类 CC 结尾）。
   */
  function split(word) {
    var m = word.match(/^([bcdfghjklmnpqrstvwyz]*)([aeiou])(.*)$/);
    if (!m) return null;
    return { onset: m[1], vowel: m[2], coda: m[3] };
  }

  /**
   * 最小对立干扰项。优先级：
   *   1. vowel-contrast  —— 换元音（OPW2 的核心考点）
   *   2. minimal-pair-initial —— 同词族换首音
   *   3. same-coda       —— 同尾不同元音
   * 全部要求是真实存在的词（用全局词表判断），否则孩子会靠「这词没见过」来排除。
   */
  function makeDistractors(word, family, unlockedFams, count) {
    count = count || 2;
    var parts = split(word);
    if (!parts) return [];

    var vowelOrder = (cur.minimalPairs.vowelSwaps[parts.vowel] || []).slice();
    var out = [];
    var seen = {};
    seen[word] = true;

    function add(w, kind) {
      if (!w || seen[w] || out.length >= count) return;
      seen[w] = true;
      out.push({ text: w, kind: kind });
    }

    // 1. 换元音，保持首音和尾音（fan → fin / fun）—— 最能考查短元音辨析
    vowelOrder.forEach(function (v) {
      var cand = parts.onset + v + parts.coda;
      if (allWords[cand]) add(cand, 'vowel-contrast');
    });

    // 2. 同词族换首音（fan → man / pan）
    var famWords = wordsByFamily[family] || [];
    G.shuffle(famWords, Math.random).forEach(function (w) {
      if (w !== word && split(w) && split(w).vowel === parts.vowel) {
        add(w, 'minimal-pair-initial');
      }
    });

    // 3. 同尾音不同元音，跨词族（兜底，保证一定凑够 count 个）
    if (out.length < count) {
      Object.keys(allWords).forEach(function (w) {
        if (out.length >= count) return;
        var p = split(w);
        if (p && p.coda === parts.coda && p.vowel !== parts.vowel && p.onset === parts.onset) {
          add(w, 'same-coda');
        }
      });
    }

    // 4. 仍不够就从已解锁词族里随便补真实词（宁可削弱区分度，也不能有假词选项）
    if (out.length < count) {
      var pool = [];
      unlockedFams.forEach(function (f) {
        pool = pool.concat(wordsByFamily[f] || []);
      });
      G.shuffle(pool, Math.random).forEach(function (w) { add(w, 'filler'); });
    }

    return out;
  }

  /**
   * 组装一道 listen 题的选项：1 个正确答案 + N 个最小对立干扰项，打乱。
   */
  function buildListenOptions(answerWord, family, unlockedFams, rng) {
    var n = 2;                                   // 6 岁工作记忆有限，3 个选项足够
    var ds = makeDistractors(answerWord, family, unlockedFams, n);
    var opts = [{ text: answerWord, kind: 'answer' }].concat(ds);
    opts = G.shuffle(opts, rng);
    return opts.map(function (o, i) {
      return { id: String.fromCharCode(97 + i), text: o.text, _kind: o.kind };
    });
  }

  /* ---------- 程序化生成题（数学） ----------
   * JSON 里只写模板，运行时用固定种子展开。投入产出比最高的一处。
   */

  function instantiateGenerator(q, rng) {
    var g = q.generator;
    var out = JSON.parse(JSON.stringify(q));
    out._generated = true;

    if (g.kind === 'add' || g.kind === 'sub') {
      var a, b, ans, guard = 0;
      do {
        a = G.randInt(rng, g.a[0], g.a[1]);
        b = G.randInt(rng, g.b[0], g.b[1]);
        guard++;
      } while (guard < 200 && !evalConstraint(g.constraint, a, b));

      if (g.kind === 'add') {
        ans = a + b;
        out.stem.text = g.missing === 'b'
          ? (a + ' + ? = ' + ans)          // 填加数，比直接算和难一档
          : (a + ' + ' + b + ' = ?');
      } else {
        ans = a - b;
        out.stem.text = g.missing === 'b'
          ? (a + ' − ? = ' + ans)
          : (a + ' − ' + b + ' = ?');
      }

      // 干扰项 = 正确答案 ±1/±2，都是「算错会得到的数」，比随机数有区分度得多
      var wrongs = nearMiss(ans, g.optionRule);
      out.options = makeNumericOptions(ans, wrongs, rng);
      out.answer = out.options.filter(function (o) { return o.text === String(ans); })[0].id;
      out.explain = buildExplain(g.kind, a, b, ans, g.missing);
      out._meta = { a: a, b: b, ans: ans };
    }

    else if (g.kind === 'compare') {
      var x, y, guard2 = 0;
      do {
        x = G.randInt(rng, g.a[0], g.a[1]);
        y = G.randInt(rng, g.b[0], g.b[1]);
        guard2++;
      } while (guard2 < 200 && !evalConstraint(g.constraint, x, y));

      var big = Math.max(x, y);
      var small = Math.min(x, y);
      // 3 个选项，避免 50% 蒙对率
      var third = small > 1 ? small - 1 : big + 1;
      out.stem.text = x + ' 和 ' + y + '，哪个大？';
      out.options = makeNumericOptions(big, [small, third], rng);
      out.answer = out.options.filter(function (o) { return o.text === String(big); })[0].id;
      out.explain = big + ' 比 ' + Math.min(x, y) + ' 大。';
      out._meta = { a: x, b: y, ans: big };
    }

    else if (g.kind === 'count') {
      // 数一数：随机撒几个图形，让孩子点数
      var n = G.randInt(rng, g.n[0], g.n[1]);
      var shapes = ['🍎', '⭐', '🐟', '🌸', '🎈'];
      var shape = G.pick(shapes, rng);
      var line = [];
      for (var i = 0; i < n; i++) line.push(shape);

      out.stem.text = line.join(' ') + '\n一共有几个？';
      out.stem.layout = 'count';
      out.options = makeNumericOptions(n, nearMiss(n, g.optionRule), rng);
      out.answer = out.options.filter(function (o) { return o.text === String(n); })[0].id;
      out.explain = '数一数，一共 ' + n + ' 个。';
      out._meta = { ans: n };
    }

    return out;
  }

  function makeNumericOptions(ans, wrongs, rng) {
    var vals = [ans].concat(wrongs);
    // 去重 + 去负
    var seen = {};
    vals = vals.filter(function (v) {
      if (v < 0 || seen[v]) return false;
      seen[v] = true;
      return true;
    });
    var opts = G.shuffle(vals, rng).map(function (v, i) {
      return { id: String.fromCharCode(97 + i), text: String(v) };
    });
    return opts;
  }

  function buildExplain(kind, a, b, ans, missing) {
    if (kind === 'add') {
      if (missing === 'b') return a + ' 再加 ' + b + ' 才是 ' + ans + '。';
      return a + ' 和 ' + b + ' 合起来是 ' + ans + '。';
    }
    if (missing === 'b') return a + ' 拿走 ' + b + ' 还剩 ' + ans + '。';
    return a + ' 拿走 ' + b + ' 还剩 ' + ans + '。';
  }

  function evalConstraint(expr, a, b) {
    if (!expr) return true;
    try {
      /* jshint evil:true */
      return !!(new Function('a', 'b', 'return (' + expr + ');'))(a, b);
    } catch (e) { return true; }
  }

  function nearMiss(ans, rule) {
    if (rule === 'near-miss') {
      var cands = [ans + 1, ans - 1, ans + 2, ans - 2, ans + 10, ans - 10]
        .filter(function (v) { return v >= 0 && v !== ans; });
      return cands.slice(0, 3);
    }
    return [ans + 1, ans - 1, ans + 2];
  }

  /* ---------- 抽题 ---------- */

  function poolFor(subject) {
    return questions[subject] || [];
  }

  /**
   * 从某科目抽一题。rng 决定生成题的展开结果，所以同一天同一种子得到同一道题。
   */
  function drawOne(subject, save, dateSeed, excludeIds) {
    var pool = poolFor(subject);
    if (!pool.length) return null;

    var rng = G.rngFrom(dateSeed + '|' + subject + '|' + (excludeIds || []).length + '|' + Math.floor(Math.random() * 1e9));

    var avail = pool.filter(function (q) {
      if ((excludeIds || []).indexOf(q.id) >= 0) return false;
      if (subject === 'english') {
        if (!familyUnlocked(q.family, save)) return false;
      }
      return true;
    });
    if (!avail.length) avail = pool;

    var picked = weightedPickQuestion(avail, save, rng);
    if (picked.generator) return instantiateGenerator(picked, rng);

    // 英语 listen 题的选项每次现生成，避免固定选项被记住
    if (picked.type === 'listen') {
      var out = JSON.parse(JSON.stringify(picked));
      var fams = unlockedFamilies(save);
      var opts = buildListenOptions(out.answerWord, out.family, fams, rng);
      out.options = opts;
      out.answer = opts.filter(function (o) { return o.text === out.answerWord; })[0].id;
      return out;
    }

    return JSON.parse(JSON.stringify(picked));
  }

  function familyUnlocked(family, save) {
    if (!family) return false;
    return unlockedFamilies(save).indexOf(family) >= 0;
  }

  /**
   * 题型加权：错题本里的题加权重出，已 cleared 的降权。
   */
  function weightedPickQuestion(pool, save, rng) {
    var wrongIndex = {};
    save.wrongBook.forEach(function (w) { wrongIndex[w.qid] = w; });

    var weights = pool.map(function (q) {
      var w = 1;
      var rec = wrongIndex[q.id];
      if (rec && !rec.cleared) w += 1.5 * rec.wrongCount;   // 错题重出
      if (rec && rec.cleared) w *= 0.4;                      // 已掌握 → 降权
      return w;
    });

    var total = G.sum(weights);
    var r = rng() * total;
    for (var i = 0; i < pool.length; i++) {
      r -= weights[i];
      if (r <= 0) return pool[i];
    }
    return pool[pool.length - 1];
  }

  /**
   * 挑一局英语题：锁定同一词族的「听 → 拼 → 用」固定教学序列。
   * 这不是「3 个随机题型」——自然拼读的标准教学顺序是 hear it → build it → use it，
   * 随机化会破坏它。而且 OPW2 每单元就是围绕 2-4 个词族展开，一节课教一个词族，
   * 3 道题都围绕 -an 才是「这节课我们在学 -an」的体验。6 岁孩子需要聚焦，不是覆盖。
   */
  function buildEnglishSequence(save, dateSeed, recentFamilies) {
    var rng = G.rngFrom(dateSeed + '|english-seq|' + Math.floor(Math.random() * 1e9));
    var family = pickFamily(save, rng, recentFamilies);

    // sort / realword 可能覆盖多个词族，所以同时认 family 和 families 两个字段
    var pick = function (type, mode) {
      var pool = questions.english.filter(function (q) {
        if (q.type !== type) return false;
        if (mode && q.mode !== mode) return false;
        var fams = q.families || (q.family ? [q.family] : []);
        return fams.indexOf(family) >= 0;
      });
      if (!pool.length) return null;
      return pool[Math.floor(rng() * pool.length)];
    };

    var seq = [];
    var listen = pick('listen');
    if (listen) seq.push(materialize(listen, save, rng, 'listen'));

    var blend = pick('blend', 'vowel-gap') || pick('blend');
    if (blend) seq.push(materialize(blend, save, rng, 'blend'));

    // 第 3 槽 sort / realword 交替
    var useSort = (save.sessions.length % 2) === 0;
    var third = useSort ? pick('sort') : pick('realword');
    if (!third) third = pick('sort') || pick('realword');
    if (third) seq.push(materialize(third, save, rng, third.type));

    return { family: family, questions: seq.filter(Boolean) };
  }

  function materialize(q, save, rng, type) {
    var out = JSON.parse(JSON.stringify(q));
    delete out._familyPool;

    if (type === 'listen') {
      var fams = unlockedFamilies(save);
      var opts = buildListenOptions(out.answerWord, out.family, fams, rng);
      out.options = opts;
      out.answer = opts.filter(function (o) { return o.text === out.answerWord; })[0].id;
    }
    return out;
  }

  G.Curriculum = {
    init: init,
    curriculum: curriculum,
    unitById: unitById,
    unlockedUnitIds: unlockedUnitIds,
    unlockedFamilies: unlockedFamilies,
    familyInUnit: familyInUnit,
    familyWeight: familyWeight,
    pickFamily: pickFamily,
    makeDistractors: makeDistractors,
    buildListenOptions: buildListenOptions,
    instantiateGenerator: instantiateGenerator,
    drawOne: drawOne,
    buildEnglishSequence: buildEnglishSequence,
    split: split,
    wordsByFamily: function () { return wordsByFamily; },
    allWords: function () { return allWords; }
  };

})(window);
