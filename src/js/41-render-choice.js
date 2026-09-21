/* 41-render-choice.js — 选择题渲染器（choice 与 listen 共用）
 *
 * choice 和 listen 从渲染代码看是同一个东西：题干 + N 个选项。
 * 差别只是题干是文字还是音频。写两套渲染器是重复劳动，会带来两份 bug。
 * 它们真正不同的地方在内容模型（listen 的干扰项是最小对立对），那个在
 * 30-curriculum.js 里处理。
 */
(function (window) {
  'use strict';

  var G = window.G;

  G.Renderers = G.Renderers || {};

  G.Renderers.choice = function (container, q, handlers) {
    var options = q.options || [];
    var layout = (q.stem && q.stem.layout) || (options.length <= 2 ? 'row' : 'grid');
    var answered = false;

    var root = G.el('div', { class: 'q q-choice' });

    // ---- 题干 ----
    var stem = G.el('div', { class: 'stem' });

    if (q.type === 'listen') {
      // 听音辨认：不显示文字，纯听。答完才露出拼写。
      stem.appendChild(G.el('div', { class: 'stem-hint', text: '听一听，是哪个词？' }));
      stem.appendChild(G.UI.speakerButton(q.audio && q.audio[0], null, { autoplay: true }));

    } else if (q.type === 'prompt' || (q.stem && q.stem.audio)) {
      // 有语音的题干（语文拼音等）
      stem.appendChild(G.el('div', { class: 'stem-hint', text: q.stem.prompt || '' }));
      stem.appendChild(G.UI.speakerButton(q.stem.audio, null, { autoplay: true }));

    } else if (q.stem && q.stem.text) {
      var cls = 'stem-text';
      if (layout === 'big-number') cls += ' stem-number';
      else if (layout === 'count') cls += ' stem-count';
      stem.appendChild(G.el('div', { class: cls, text: q.stem.text }));
      if (q.stem.audio) {
        stem.appendChild(G.UI.speakerButton(q.stem.audio, null, { small: true }));
      }
    }

    root.appendChild(stem);

    // ---- 选项 ----
    var grid = G.el('div', { class: 'options options-' + layout });
    var buttons = {};

    options.forEach(function (opt) {
      var btn = G.el('button', {
        class: 'option',
        'data-id': opt.id,
        onclick: function () { choose(opt); }
      }, [G.el('span', { class: 'option-text', text: opt.text })]);

      buttons[opt.id] = btn;
      grid.appendChild(btn);
    });

    root.appendChild(grid);

    // ---- 解释条（答错时出现）----
    var explainBar = G.el('div', { class: 'explain hidden' });
    root.appendChild(explainBar);

    container.appendChild(root);

    function choose(opt) {
      if (answered) return;
      answered = true;

      var correct = opt.id === q.answer;
      G.UI.feedback(buttons[opt.id], correct);

      // 锁定所有选项，正确项高亮
      Object.keys(buttons).forEach(function (id) {
        buttons[id].classList.add('locked');
        if (id === q.answer) buttons[id].classList.add('is-answer');
      });

      // listen 题答完才显示拼写 —— 否则孩子靠字形猜
      if (q.type === 'listen') {
        stem.querySelectorAll('.stem-hint').forEach(function (n) {
          n.textContent = q.answerWord ? '答案是：' + q.answerWord : '';
        });
      }

      // 播放该选项自己的音（listen 题的选项本身就是词）
      var chosenWord = (q.options.filter(function (o) { return o.id === opt.id; })[0] || {}).text;
      if (q.type === 'listen' && chosenWord && G.Audio.has('word.' + chosenWord)) {
        setTimeout(function () { G.Audio.play('word.' + chosenWord); }, 260);
      }

      if (!correct) {
        showExplain(q.explain);
        if (q.explainAudio) {
          setTimeout(function () { G.Audio.play(q.explainAudio); }, 700);
        }
      } else {
        G.UI.confetti(container);
      }

      setTimeout(function () { handlers.onAnswer(correct); }, correct ? 620 : 1500);
    }

    function showExplain(text) {
      if (!text) return;
      explainBar.textContent = text;
      explainBar.classList.remove('hidden');
    }

    return { destroy: function () { /* 容器由调用方清空 */ } };
  };

})(window);
