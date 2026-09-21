/* 42-render-blend.js — 拼读合成题（OPW2 的核心题型）
 *
 * 两个子模式：
 *   vowel-gap    — 「f _ n」听音填元音。OPW2 整本书就是教 5 个短元音，
 *                  这个模式直接把考点变成题目本身，性价比最高。建议占 blend 的 60%。
 *   tap-to-blend — 点 onset/rime 两张卡听音素，再选整词。
 *
 * 音素音缺失或质量差时走降级路径（playWithFallback → 整词音 + 依次高亮）。
 * 这条降级路径必须在 Phase 0 就存在，否则 Phase 1 发现音素音不行时要返工整个题型。
 */
(function (window) {
  'use strict';

  var G = window.G;

  G.Renderers = G.Renderers || {};

  G.Renderers.blend = function (container, q, handlers) {
    var mode = q.mode || 'vowel-gap';
    var answered = false;

    var root = G.el('div', { class: 'q q-blend q-blend-' + mode });
    root.appendChild(G.el('div', { class: 'stem-hint', text: q.stem.prompt || '听一听，拼一拼' }));

    if (mode === 'tap-to-blend') {
      renderTapToBlend();
    } else {
      renderVowelGap();
    }

    container.appendChild(root);

    /* ---------- 子模式 A：听音拼装 ---------- */

    function renderTapToBlend() {
      var onset = q.stem.onset;
      var rime = q.stem.rime;
      var word = q.answerWord;
      var playedOnset = false, playedRime = false;

      var cards = G.el('div', { class: 'blend-cards' });

      var onsetCard = G.el('button', {
        class: 'blend-card',
        onclick: function () {
          playedOnset = true;
          onsetCard.classList.add('tapped');
          // 降级：音素音缺失就播整词音，卡片依次高亮
          G.Audio.playWithFallback(onset.audio, q.audio && q.audio[0]);
          checkBoth();
        }
      }, [G.el('span', { class: 'blend-card-text', text: onset.text })]);

      var plus = G.el('span', { class: 'blend-plus', text: '+' });

      var rimeCard = G.el('button', {
        class: 'blend-card',
        onclick: function () {
          playedRime = true;
          rimeCard.classList.add('tapped');
          G.Audio.playWithFallback(rime.audio, q.audio && q.audio[0]);
          checkBoth();
        }
      }, [G.el('span', { class: 'blend-card-text', text: rime.text })]);

      cards.appendChild(onsetCard);
      cards.appendChild(plus);
      cards.appendChild(rimeCard);
      root.appendChild(cards);

      function checkBoth() {
        if (playedOnset && playedRime) {
          root.querySelector('.blend-cards').classList.add('ready');
        }
      }

      root.appendChild(G.el('div', { class: 'stem-hint stem-hint-sm', text: '两个音合起来是哪个词？' }));
      root.appendChild(buildOptions(q.options || []));
    }

    /* ---------- 子模式 B：元音填空 ---------- */

    function renderVowelGap() {
      var display = G.el('div', { class: 'vowel-gap' });
      // "f _ n" 里的空位渲染成一个闪烁的槽，视觉上提示「这里缺一个字母」
      q.stem.display.split('').forEach(function (ch) {
        if (ch === '_') display.appendChild(G.el('span', { class: 'vg-blank', text: '?' }));
        else if (ch === ' ') display.appendChild(G.el('span', { class: 'vg-space' }));
        else display.appendChild(G.el('span', { class: 'vg-char', text: ch }));
      });

      root.appendChild(display);
      root.appendChild(G.UI.speakerButton(q.stem.audio, null, { autoplay: true }));

      // 选项是大号字母，比文字选项更好点
      var grid = G.el('div', { class: 'options options-row options-letters' });
      (q.options || []).forEach(function (opt) {
        var btn = G.el('button', {
          class: 'option option-letter',
          onclick: function () { choose(opt, btn); }
        }, [G.el('span', { class: 'option-text', text: opt.text })]);
        grid.appendChild(btn);
      });
      root.appendChild(grid);
    }

    function buildOptions(options) {
      var grid = G.el('div', { class: 'options options-grid options-words' });
      options.forEach(function (opt) {
        var btn = G.el('button', {
          class: 'option option-word',
          onclick: function () {
            if (answered) return;
            // 先让孩子听到这个词，再判定
            if (G.Audio.has('word.' + opt.text)) G.Audio.play('word.' + opt.text);
            choose(opt, btn);
          }
        }, [G.el('span', { class: 'option-text', text: opt.text })]);
        grid.appendChild(btn);
      });
      return grid;
    }

    function choose(opt, btn) {
      if (answered) return;
      answered = true;

      var correct = opt.id === q.answer;
      G.UI.feedback(btn, correct);

      G.$$('.option', root).forEach(function (b) {
        b.classList.add('locked');
        if (b.getAttribute('data-id') === q.answer) b.classList.add('is-answer');
      });

      if (correct) {
        G.UI.confetti(container);
        // 答对了再把整词读一遍，强化「拼出来的是什么」
        if (q.answerWord && G.Audio.has('word.' + q.answerWord)) {
          setTimeout(function () { G.Audio.play('word.' + q.answerWord); }, 320);
        }
      } else {
        showExplain(q.explain);
      }

      setTimeout(function () { handlers.onAnswer(correct); }, correct ? 750 : 1600);
    }

    function showExplain(text) {
      if (!text) return;
      var bar = G.el('div', { class: 'explain', text: text });
      root.appendChild(bar);
    }

    return { destroy: function () {} };
  };

})(window);
