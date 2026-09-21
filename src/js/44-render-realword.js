/* 44-render-realword.js — 真假词判断
 *
 * 假词默认不配音，只显示字母。两个原因：
 *   1. TTS 读 sep / fap 这类非词时发音不可预测（可能按拼写规则读，也可能触发
 *      语言模型纠错），孩子听到错音会破坏整个练习的意义。
 *   2. 不用音频反而更接近自然拼读的真实目标 —— 见词能读。孩子看到 sep，
 *      心里默拼 /s/ /e/ /p/，发现拼不出认识的词，就选「假词」。
 *
 * probeAudio 字段保留：若实测某几个假词的 TTS 读法标准，可以填上。
 */
(function (window) {
  'use strict';

  var G = window.G;

  G.Renderers = G.Renderers || {};

  G.Renderers.realword = function (container, q, handlers) {
    var answered = false;
    var probe = q.probe || {};

    var root = G.el('div', { class: 'q q-realword' });
    root.appendChild(G.el('div', { class: 'stem-hint', text: q.stem.prompt || '这个词是真的吗？' }));

    // ---- 词卡 ----
    var card = G.el('div', { class: 'word-card' }, [
      G.el('span', { class: 'word-card-text', text: probe.text })
    ]);

    // 真词可以给个喇叭（孩子可以点来确认），假词不给
    if (probe.isReal && G.Audio.has('word.' + probe.text)) {
      card.appendChild(G.el('button', {
        class: 'word-card-speaker',
        onclick: function (e) {
          e.stopPropagation();
          G.Audio.play('word.' + probe.text);
        }
      }, ['🔊']));
    }
    root.appendChild(card);

    // ---- 两个大按钮 ----
    var row = G.el('div', { class: 'realword-actions' });
    var btnReal = G.el('button', {
      class: 'rw-btn rw-real',
      onclick: function () { answer(true, btnReal); }
    }, ['✅ 真词']);
    var btnFake = G.el('button', {
      class: 'rw-btn rw-fake',
      onclick: function () { answer(false, btnFake); }
    }, ['❌ 假词']);
    row.appendChild(btnReal);
    row.appendChild(btnFake);
    root.appendChild(row);

    container.appendChild(root);

    function answer(saidReal, btn) {
      if (answered) return;
      answered = true;

      var correct = (saidReal === !!probe.isReal);
      G.UI.feedback(btn, correct);

      btnReal.classList.add('locked');
      btnFake.classList.add('locked');
      (probe.isReal ? btnReal : btnFake).classList.add('is-answer');

      var reveal = q.reveal || {};
      if (correct) {
        G.UI.confetti(container);
        // 揭晓真正的那个词
        if (reveal.audio && G.Audio.has(reveal.audio.replace(/\.mp3$/, '').replace(/\//g, '.'))) {
          setTimeout(function () {
            G.Audio.play(reveal.audio.replace(/\.mp3$/, '').replace(/\//g, '.'));
          }, 320);
        }
        if (reveal.text) showExplain(reveal.text);
      } else {
        showExplain(reveal.text || q.explain);
      }

      setTimeout(function () { handlers.onAnswer(correct); }, correct ? 800 : 1800);
    }

    function showExplain(text) {
      if (!text) return;
      var bar = G.el('div', { class: 'explain', text: text });
      root.appendChild(bar);
    }

    return { destroy: function () {} };
  };

  /**
   * 题型 → 渲染器。渲染器按视觉形态分（3 个），内容按题型分（5 个）。
   */
  G.rendererFor = function (type) {
    if (type === 'choice' || type === 'listen') return G.Renderers.choice;
    if (type === 'blend') return G.Renderers.blend;
    if (type === 'sort') return G.Renderers.sort;
    if (type === 'realword') return G.Renderers.realword;
    return G.Renderers.choice;
  };

})(window);
