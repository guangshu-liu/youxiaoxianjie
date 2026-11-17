/* 41-render-choice.js — 选择题渲染器
 *
 * 三科 300 道题全部是 choice（题干 + 4 个选项），所以只有一个渲染分支。
 * 差异全在数据里：stem.layout 决定选项排布，stem.audio 决定要不要喇叭。
 *
 * rendererFor 也放在这里。它原来在 44-render-realword.js —— 那个文件承载的
 * 是「看图选词 / 排序 / 拼词」三种看图题型，都删了，只剩下「按 type 找
 * 渲染器」这一件小事，没必要为它单开一个文件。
 */
(function (window) {
  'use strict';

  var G = window.G;

  G.Renderers = G.Renderers || {};

  /**
   * 「单独一个字符」的选项。汉字（日 / 目 / 白）和英语的单个字母
   * （B / b）都要单独放大 —— 一眼看不清的字形，孩子只能靠猜。
   *
   * 数学题不在这条里：它的选项也是短的（7 / 70），把「7」放大到 50px
   * 会让同一排高低不平，看起来像排版坏了。
   */
  var SINGLE_RE = /^(?:[一-鿿]|[A-Za-z])$/;

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

    // 布局类别挂在根上，题干和选项都能按它取样式
    // （math 的 big-number 要连题干一起放大，只给选项加类做不到）。
    var root = G.el('div', { class: 'q q-choice q-layout-' + layout });

    // ---- 题干 ----
    var stem = G.el('div', { class: 'stem' });

    var hasAudio = !!(q.stem && q.stem.audio);

    // 题干朗读只给「没有自带音频」的题。听音题已经有英文单词音频，
    // 再念一句中文提示会和它抢喇叭；拼音题、算式题由 TTSText 换过说法。
    // 选项一律不朗读 —— 它们就是孩子要辨认的对象。
    var readInfo = (G.TTSText && G.TTSText.forQuestion)
      ? G.TTSText.forQuestion(q) : { text: '', skip: true };
    var canRead = !readInfo.skip && !!readInfo.text
      && !!(G.TTS && G.TTS.available() && G.TTS.enabled());

    if (q.stem && q.stem.prompt) {
      stem.appendChild(G.el('div', { class: 'stem-hint', text: q.stem.prompt }));
    }

    // 题干文字和喇叭按钮**不是二选一**：英语的听音题两者都有
    // （「听一听，这个词开头是哪个大写字母？」+ 音频）。
    // 早先这里写成了 if/else if，结果是英语题的文字题干全都不显示。
    if (q.stem && q.stem.text) {
      stem.appendChild(G.el('div', { class: 'stem-text', text: q.stem.text }));
    }

    if (hasAudio) {
      stem.appendChild(G.UI.speakerButton(q.stem.audio, null, { autoplay: true }));
    } else if (canRead) {
      stem.appendChild(G.UI.readStemButton(readInfo.text, { autoplay: true }));
    }

    root.appendChild(stem);

    // ---- 选项 ----
    var grid = G.el('div', { class: 'options options-' + layout });
    var buttons = {};

    options.forEach(function (opt) {
      // 单字选项（「日」「目」「白」这类形近字）单独放大 —— 一眼看不清的字
      // 会让孩子靠猜，而不是靠辨认。
      //
      // 必须限定「是一个汉字或一个字母」，不能只看长度：数学题的选项也是
      // 短的，「7」和「70」混在一道题里，只把「7」放大到 50px 会让这一排
      // 高低不平，看起来像是排版坏了。
      var single = SINGLE_RE.test(opt.text || '');

      var btn = G.el('button', {
        class: 'option' + (single ? ' option-single' : ''),
        'data-id': opt.id,
        // 关掉全局的「嗒」声：选项有自己的对/错音效（见 05-ui.js 的
        // feedback），两个叠在一起会糊成一团。
        'data-sfx-off': '1',
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
