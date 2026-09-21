/* 90-main.js — 启动、路由、一局的游戏循环 */
(function (window) {
  'use strict';

  var G = window.G;

  var root = null;
  var save = null;
  var round = null;          // {family, questions, startedAt}
  var idx = 0;
  var results = [];          // [true|false|null]
  var items = [];            // 逐题记录
  var spins = [];
  var roundPoints = 0;
  var respinCount = 0;
  var qStartAt = 0;

  /* ---------- 启动 ---------- */

  function boot(data) {
    root = G.$('#app');
    save = G.Store.load();

    G.Curriculum.init(data);
    G.Audio.init();

    save.integrity.bootId = (save.integrity.bootId || 0) + 1;
    G.Store.checkClock(save);
    G.Store.save(save);

    checkEnvironment();
    showHome();

    // 页面隐藏时落盘，防止 iOS 直接杀进程丢进度
    window.addEventListener('pagehide', function () { G.Store.save(save); });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) G.Store.save(save);
    });
  }

  function checkEnvironment() {
    if (!G.StorageAvailable) { /* 兼容旧调用 */ }
    if (!G.storageAvailable()) {
      G.banner('进度无法保存（可能是无痕模式）。建议在浏览器中打开。', 'warn');
    }

    // 微信内置浏览器没有「添加到主屏幕」，且 7 天不访问会被清缓存。
    // 不做这个提示，典型事故是：玩了三次攒了 150 分，一周后归零，孩子崩溃。
    var m = G.Store.meta();
    if (G.env.isWeChat && !m.wechatWarned) {
      G.Store.setMeta({ wechatWarned: true });
      setTimeout(function () {
        showModal('在微信里玩要注意', [
          '在微信里打开的游戏，进度可能会被系统清理掉。',
          '建议点右上角 ⋯ → 在浏览器中打开，再「添加到主屏幕」。',
          '或者直接用家长发给你的那个单文件版本，永久离线可玩。'
        ]);
      }, 600);
    }
  }

  function showModal(title, lines) {
    var overlay = G.el('div', { class: 'overlay' });
    var box = G.el('div', { class: 'panel panel-narrow' });
    box.appendChild(G.el('div', { class: 'panel-title', text: title }));
    lines.forEach(function (l) { box.appendChild(G.el('p', { class: 'modal-p', text: l })); });
    box.appendChild(G.el('button', {
      class: 'btn btn-primary', text: '知道了',
      onclick: function () {
        overlay.classList.add('closing');
        setTimeout(function () {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }, 260);
      }
    }));
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  }

  /* ---------- 首页 ---------- */

  function showHome() {
    G.clear(root);
    G.UI.dismissBanner();

    var s = G.UI.screen('screen-home');

    s.appendChild(G.el('div', { class: 'home-title', text: '知识闯关' }));
    s.appendChild(G.el('div', { class: 'home-sub', text: '语文 · 数学 · 英语' }));

    var stats = G.el('div', { class: 'home-stats' }, [
      G.el('div', { class: 'home-points', text: String(save.points.balance) }),
      G.el('div', { class: 'home-points-label', text: '积分' })
    ]);
    s.appendChild(stats);

    s.appendChild(G.el('button', {
      class: 'btn btn-primary btn-xl', text: '开始游戏',
      onclick: startRound
    }));

    var row = G.el('div', { class: 'home-row' });
    row.appendChild(G.el('button', {
      class: 'btn btn-secondary', text: '🎁 我的奖励',
      onclick: function () { G.Redeem.openScreen(save, showHome); }
    }));
    row.appendChild(G.el('button', {
      class: 'btn btn-ghost', text: '👨👩👧 家长',
      onclick: function () { G.Parent.openGate(function () { G.Parent.open(save); }); }
    }));
    s.appendChild(row);

    if (save.sessions.length) {
      var last = save.sessions[save.sessions.length - 1];
      s.appendChild(G.el('div', {
        class: 'home-last',
        text: '上次：' + last.correct + ' / ' + last.total + ' 题'
      }));
    }

    root.appendChild(s);

    if (G.DEBUG) s.appendChild(debugBar());
  }

  function debugBar() {
    var bar = G.el('div', { class: 'debug-bar' });
    bar.appendChild(G.el('button', {
      class: 'btn btn-xs', text: '自检',
      onclick: function () { location.hash = '#selftest'; location.reload(); }
    }));
    bar.appendChild(G.el('button', {
      class: 'btn btn-xs', text: '+100分',
      onclick: function () { save.points.balance += 100; save.points.lifetime += 100; G.Store.save(save); showHome(); }
    }));
    return bar;
  }

  /* ---------- 一局 ---------- */

  function startRound() {
    round = G.Runner.buildRound(save);
    idx = 0;
    results = new Array(round.questions.length).fill(null);
    items = [];
    spins = [];
    roundPoints = 0;
    respinCount = 0;

    G.log('本局题目：', round.questions.map(function (q) {
      return q.subject + ':' + q.type + (q.family ? '/' + q.family : '');
    }).join('  '));

    // 预加载本局音频，不阻塞渲染
    var ids = [];
    round.questions.forEach(function (q) { (q.audio || []).forEach(function (a) { ids.push(a); }); });
    G.Audio.preload(ids);

    showQuestion();
  }

  function showQuestion() {
    G.clear(root);

    if (idx >= round.questions.length) { showSummary(); return; }

    var q = round.questions[idx];
    qStartAt = Date.now();

    var s = G.UI.screen('screen-game');

    // ---- 顶栏 ----
    var top = G.el('div', { class: 'game-top' });
    top.appendChild(G.el('button', {
      class: 'btn btn-icon', text: '✕',
      onclick: function () {
        if (window.confirm('要退出这一局吗？这一局的进度不会保存。')) showHome();
      }
    }));
    top.appendChild(G.UI.progressDots(round.questions.length, idx, results));
    top.appendChild(G.el('span', { class: 'game-points', text: save.points.balance + '分' }));
    s.appendChild(top);

    // ---- 题面 ----
    var body = G.el('div', { class: 'game-body' });
    s.appendChild(body);

    root.appendChild(s);

    var renderer = G.rendererFor(q.type);
    renderer(body, q, {
      save: save,
      onAnswer: function (correct) { handleAnswer(q, correct); }
    });
  }

  function handleAnswer(q, correct) {
    var ms = Date.now() - qStartAt;

    results[idx] = correct;
    items.push({ qid: q.id, subject: q.subject, type: q.type, family: q.family || null, correct: correct, ms: ms });

    G.Runner.recordAnswer(save, q, correct, ms);
    G.Store.save(save);

    var advance = function () {
      idx++;
      showQuestion();
    };

    if (!correct) { advance(); return; }

    // 答对 → 转盘
    respinCount = 0;
    spinLoop(advance);
  }

  function spinLoop(then) {
    G.Wheel.open(save, { respinCount: respinCount }).then(function (res) {
      spins.push({ prize: res.prize.id, ts: Date.now() });
      roundPoints += res.awarded || 0;

      var dc = G.Store.todayCounter(save);
      dc.spins += 1;

      if (res.again) {
        respinCount = res.respins;
        G.log('再来一次，已重转', respinCount, '次');
        spinLoop(then);            // 重转，不推进题目
        return;
      }

      G.Store.save(save);
      updatePointsChip();
      setTimeout(then, 260);
    });
  }

  function updatePointsChip() {
    var chip = G.$('.game-points');
    if (chip) chip.textContent = save.points.balance + '分';
  }

  /* ---------- 结算 ---------- */

  function showSummary() {
    var session = G.Runner.finishSession(save, round, items, spins, roundPoints);
    G.clear(root);

    var s = G.UI.screen('screen-summary');

    var pct = Math.round(session.correct / session.total * 100);
    var praise = pct >= 90 ? '太棒了！' : pct >= 70 ? '做得很好！' : pct >= 50 ? '有进步！' : '继续加油！';

    s.appendChild(G.el('div', { class: 'summary-emoji', text: pct >= 70 ? '🌟' : '💪' }));
    s.appendChild(G.el('div', { class: 'summary-title', text: praise }));
    s.appendChild(G.el('div', { class: 'summary-score', text: session.correct + ' / ' + session.total }));

    var card = G.el('div', { class: 'summary-card' });
    card.appendChild(G.el('div', { class: 'stat-row' }, [
      G.el('span', { class: 'stat-label', text: '本局得分' }),
      G.el('span', { class: 'stat-value', text: '+' + roundPoints + ' 分' })
    ]));
    card.appendChild(G.el('div', { class: 'stat-row' }, [
      G.el('span', { class: 'stat-label', text: '当前积分' }),
      G.el('span', { class: 'stat-value', text: save.points.balance + ' 分' })
    ]));
    if (round.family) {
      card.appendChild(G.el('div', { class: 'stat-row' }, [
        G.el('span', { class: 'stat-label', text: '今天练的词族' }),
        G.el('span', { class: 'stat-value', text: '-' + round.family })
      ]));
    }
    s.appendChild(card);

    if (pct >= 70) G.UI.confetti(s);

    s.appendChild(G.el('button', {
      class: 'btn btn-primary btn-xl', text: '再来一局',
      onclick: startRound
    }));
    s.appendChild(G.el('button', {
      class: 'btn btn-ghost', text: '回到首页',
      onclick: showHome
    }));

    root.appendChild(s);
    G.Audio.play('ui.win');
  }

  /* ---------- 导出给入口 ---------- */

  G.App = { boot: boot, showHome: showHome };

})(window);
