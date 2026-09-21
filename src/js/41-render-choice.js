/* 41-render-choice.js — 选择题渲染器
 *
 * 整个题库现在只有一种题型：choice（题干 + 4 个选项）。曾经还有个 listen
 * 渲染分支（听音选词，走 OPW2 自然拼读），英语下线后一起删了 —— 留着就是
 * 一段永远跑不到、也没人测的代码。
 *
 * rendererFor 也放在这里。它原来在 44-render-realword.js，那个文件承载的
 * 是「看图选词 / 排序 / 拼词」三种英语题型；三种都没了，只剩下「按 type
 * 找渲染器」这一件小事，没必要为它单开一个文件。
 */
(function (window) {
  'use strict';

  var G = window.G;

  G.Renderers = G.Renderers || {};

  /**
   * 按题型取渲染器。目前只有 choice 一种，未知题型兜底也给它 ——
   * 宁可渲染出一道还能做的题，也不要空白屏。
   */
  G.rendererFor = function (type) {
    return G.Renderers[type] || G.Renderers.choice;
  };

  G.Renderers.choice = function (container, q, handlers) {
    var options = q.options || [];
    var layout = (q.stem && q.stem.layout) || (options.length <= 2 ? 'row' : 'grid');
    var answered = false;

    var root = G.el('div', { class: 'q q-choice' });

    // ---- 题干 ----
    var stem = G.el('div', { class: 'stem' });

    if (q.stem && q.stem.audio) {
      // 有语音的题干（「这个字读什么？」读一遍给孩子听）。
      // 现在的识字题库没有音频题干，这条留给以后加真人读音时用。
      if (q.stem.prompt) {
        stem.appendChild(G.el('div', { class: 'stem-hint', text: q.stem.prompt }));
      }
      stem.appendChild(G.UI.speakerButton(q.stem.audio, null, { autoplay: true }));

    } else if (q.stem && q.stem.text) {
      stem.appendChild(G.el('div', { class: 'stem-text', text: q.stem.text }));
    }

    root.appendChild(stem);

    // ---- 选项 ----
    var grid = G.el('div', { class: 'options options-' + layout });
    var buttons = {};

    options.forEach(function (opt) {
      // 单字选项（「日」「目」「白」这类形近字）单独放大 —— 一眼看不清的字
      // 会让孩子靠猜，而不是靠辨认
      var single = (opt.text || '').length === 1;

      var btn = G.el('button', {
        class: 'option' + (single ? ' option-single' : ''),
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

      if (!correct) {
        showExplain(q.explain);
      } else {
        G.UI.confetti(container);
      }

      // 答错的题留久一点，让孩子看清正确答案和解释
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
