/* 22-tts-text.js — 「题干该念成什么」的纯规则
 *
 * 只朗读题干，不朗读选项：选项是单汉字 / 数字 / 字母 / 单词，本来就是
 * 孩子要辨认的对象，念出来会把识字题变成听力题（英语听音题更会直接泄答案）。
 *
 * 这个文件**不碰 DOM、不碰音频 API**，所以两端共用同一份：
 *   · 网页版：随 src/js/*.js 一起拼进 app.js
 *   · 小程序：由 build_miniprogram.py 拼进 generated/lib/game.js
 * 规则只写一次，避免出现「网页版把拼音念对了、小程序还在念何文红」。
 *
 * 为什么不直接把 stem.text 丢给 TTS —— 实测（macOS 中文音色 + 语音识别）：
 *   「大」的反义词是哪个字？  → 「大的反义词是哪个字？」   ✅
 *   「hóng」是哪个字？        → 「何文红是哪个字？」       ❌ 乱读且泄答案
 *   66 + 4 = ?                → 「66+4等于」              ⚠️ 没念出「几」
 * 下面两条规则就是为这两类题干写的。
 */
(function (window) {
  'use strict';

  var G = window.G;

  // 这三种题的题干自带英语音频（stem.audio）。再念一遍中文提示会和单词
  // 音频抢同一时刻的喇叭，孩子反而听不清要听的词。
  var LISTEN_TAGS = ['听音选字母', '听音选词', '辨短元音'];

  var PINYIN_TAG = '看拼音选字';
  var PINYIN_RE = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜüǹńň]/;

  // 算式 / 数列题的题干全是数字和符号：`66 + 4 = ?`、`14、17、20、（　）`。
  // 不识字不影响看这类题，念反而多此一举。更现实的原因是：归一化后这类
  // 短句有 121 条且各不相同，占中文题干音频的四成体积 —— 砍掉它们，小程序
  // 才装得进单个 2 MB 分包，不用拆两个包、不用等两次下载。
  // 判定用**原始题干**：normalizeText 会把 `+` 换成汉字「加」，那时再判就晚了。
  var HAN_RE = /[\u3400-\u9fff]/;

  // 英语题干里夹着 `ram` / `d + am` 这样的片段时，中文音色会把它念成
  // 含糊的「when」或逐字母拼读，正好和「学拼读」的目标打架。实测后给
  // 这两类题换成纯中文提示；单个字母（大写 A / 字母 d）中文音色读的是
  // 字母名，实测没问题，其余英语题干照常念。
  var EN_FIXED = {
    '押韵配对': '选出和例词押韵的词',
    '拼合 CVC': '把字母拼起来，选出正确的词'
  };

  /**
   * 把题干里的算式符号换成中文读法。
   * TTS 见到 `+ - = ?` 会跳过或读成「加号」，孩子听不出要算什么。
   * 阿拉伯数字保留 —— 中文音色会把 `66` 正确读成「六十六」。
   */
  function normalizeText(text) {
    var t = String(text || '').trim();
    if (!t) return '';

    // 找规律题：'14、17、20、（　）' 里的全角括号 + 全角空格
    t = t.replace(/（[\s\u3000]*）/g, '，括号里该填几');
    t = t.replace(/、，/g, '，');

    t = t.replace(/\+/g, ' 加 ')
         .replace(/-/g, ' 减 ')
         .replace(/=/g, ' 等于 ')
         .replace(/\?/g, ' 几 ');

    return t.replace(/\s+/g, ' ').trim();
  }

  /**
   * 决定这道题要不要朗读、念什么。
   * 返回 { text, skip, why }；skip 为 true 时调用方不要渲染读题喇叭。
   */
  function forQuestion(q) {
    if (!q || !q.stem || !q.stem.text) {
      return { text: '', skip: true, why: 'no-text' };
    }

    var tag = (q.tags || [])[0] || '';
    if (q.stem.audio || LISTEN_TAGS.indexOf(tag) >= 0) {
      return { text: '', skip: true, why: 'listen' };
    }

    var raw = String(q.stem.text);

    // 拼音题：把带声调的拉丁字母交给中文 TTS 会读成「何文红」，甚至把
    // 答案字念出来。改成一句不含拼音的固定提示 —— 孩子听懂「在问什么」，
    // 拼音本身仍在屏幕上，要拼的还是要拼的。
    if (tag === PINYIN_TAG || PINYIN_RE.test(raw)) {
      return { text: '看拼音，选出正确的字', skip: false, why: 'pinyin' };
    }

    if (EN_FIXED[tag]) {
      return { text: EN_FIXED[tag], skip: false, why: 'en-fixed' };
    }

    if (!HAN_RE.test(raw)) {
      return { text: '', skip: true, why: 'formula' };
    }

    var text = normalizeText(raw);
    if (!text) return { text: '', skip: true, why: 'empty' };
    return { text: text, skip: false, why: 'plain' };
  }

  G.TTSText = {
    forQuestion: forQuestion,
    normalizeText: normalizeText,
    LISTEN_TAGS: LISTEN_TAGS
  };

})(window);
