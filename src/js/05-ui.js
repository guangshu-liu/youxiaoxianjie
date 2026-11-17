/* 05-ui.js — 共享 UI 组件：提示条、进度点、对错反馈 */
(function (window) {
  'use strict';

  var G = window.G;

  var toastEl = null;
  var toastTimer = null;

  function toast(msg, ms) {
    if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
    toastEl = G.el('div', { class: 'toast', text: msg });
    document.body.appendChild(toastEl);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
      toastEl = null;
    }, ms || 2400);
  }

  var bannerEl = null;

  function banner(msg, kind) {
    if (bannerEl) return;
    bannerEl = G.el('div', {
      class: 'banner banner-' + (kind || 'info'),
      onclick: function () { dismissBanner(); }
    }, [G.el('span', { text: msg }), G.el('span', { class: 'banner-x', text: '✕' })]);
    document.body.appendChild(bannerEl);
  }

  function dismissBanner() {
    if (bannerEl && bannerEl.parentNode) bannerEl.parentNode.removeChild(bannerEl);
    bannerEl = null;
  }

  /* ---------- 进度点 ---------- */

  function progressDots(total, current, results) {
    var wrap = G.el('div', { class: 'dots' });
    for (var i = 0; i < total; i++) {
      var cls = 'dot';
      if (results && results[i] === true) cls += ' dot-ok';
      else if (results && results[i] === false) cls += ' dot-bad';
      else if (i === current) cls += ' dot-now';
      wrap.appendChild(G.el('span', { class: cls }));
    }
    return wrap;
  }

  /* ---------- 对错反馈 ---------- */

  /**
   * 答对：绿色脉冲 + 音效。
   * 答错：抖动 + 显示正确答案，绝不惩罚性动画（6 岁孩子的挫败感阈值很低）。
   */
  function feedback(node, correct) {
    node.classList.add(correct ? 'fb-ok' : 'fb-bad');
    if (!correct) {
      // 抖动
      node.classList.add('shake');
      setTimeout(function () { node.classList.remove('shake'); }, 480);
    }
    // 这个音效一直写在注释里，但从来没有实现过 ——
    // 视觉反馈有（绿脉冲/抖动），听觉反馈没有，所以试玩反馈是
    // 「点了没声音」。视觉 + 听觉要成对出现：孩子低头看选项的时候，
    // 声音是唯一能确认「我点到了」的东西。
    if (G.Audio) G.Audio.play(correct ? 'ui.correct' : 'ui.wrong');
    setTimeout(function () {
      node.classList.remove('fb-ok', 'fb-bad');
    }, 700);
  }

  function confetti(container) {
    var n = 18;
    for (var i = 0; i < n; i++) {
      var p = G.el('span', { class: 'confetti' });
      p.style.left = (10 + Math.random() * 80) + '%';
      p.style.animationDelay = (Math.random() * 0.25) + 's';
      p.style.background = ['#FFD54F', '#4FC3F7', '#FF8A65', '#81C784', '#BA68C8'][i % 5];
      container.appendChild(p);
      (function (node) {
        setTimeout(function () {
          if (node.parentNode) node.parentNode.removeChild(node);
        }, 1400);
      })(p);
    }
  }

  /* ---------- 通用页面外壳 ---------- */

  function screen(extraClass) {
    return G.el('div', { class: 'screen ' + (extraClass || '') });
  }

  /**
   * 大喇叭按钮。题干带 audio 的题用它。
   * 可重复点 —— 6 岁孩子会反复听，不能只让听一次。
   */
  function speakerButton(audioId, label, opts) {
    opts = opts || {};
    var btn = G.el('button', {
      class: 'speaker' + (opts.small ? ' speaker-sm' : ''),
      onclick: function () {
        btn.classList.add('playing');
        G.Audio.play(audioId).then(function () {
          btn.classList.remove('playing');
        });
      }
    }, [
      G.el('span', { class: 'speaker-icon', text: '🔊' }),
      label ? G.el('span', { class: 'speaker-label', text: label }) : null
    ]);

    if (opts.autoplay) setTimeout(function () { btn.click(); }, 350);
    return btn;
  }

  /**
   * 「读题」按钮 —— 只念题干，不念选项。
   *
   * 和上面的音频喇叭长得一样（孩子只需认一个按钮），但走的是系统语音
   * 合成而不是 G.Audio 的固定音频文件，所以单独一个 read-stem 类做区分。
   * 两类喇叭在一道题里互斥：听音题有单词音频，其余题才有读题喇叭。
   */
  function readStemButton(text, opts) {
    opts = opts || {};
    var btn = G.el('button', {
      class: 'speaker read-stem',
      onclick: function () {
        btn.classList.add('playing');
        G.TTS.speak(text, {
          onEnd: function () { btn.classList.remove('playing'); }
        });
      }
    }, [
      G.el('span', { class: 'speaker-icon', text: '🔊' }),
      G.el('span', { class: 'speaker-label', text: opts.label || '读题' })
    ]);

    if (opts.autoplay) {
      btn.classList.add('playing');
      G.TTS.schedule(text, 350, {
        onEnd: function () { btn.classList.remove('playing'); }
      });
    }
    return btn;
  }

  G.UI = {
    toast: toast,
    banner: banner,
    dismissBanner: dismissBanner,
    progressDots: progressDots,
    feedback: feedback,
    confetti: confetti,
    screen: screen,
    speakerButton: speakerButton,
    readStemButton: readStemButton
  };

  // 供 10-store / 20-audio 里的降级路径调用
  G.toast = toast;
  G.banner = banner;

})(window);
