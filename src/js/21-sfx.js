/* 21-sfx.js — 音效层（全部用振荡器现场合成，一个音频文件都不需要）
 *
 * 为什么不用音频文件：
 *   以前 audio/ui/ 下放着两个 12 KB 的占位蜂鸣音，manifest 里标着
 *   _placeholder: true —— 那是「先占位，回头再录」，然后就没有回头了。
 *   结果是整个游戏只有转盘那一声「嘀」，孩子点任何地方都没反馈，
 *   试玩反馈就是「音频异常，点击无声音」。
 *
 *   而这种音效（短促的「嗒」「叮」「嗡」）用振荡器合成只需要几行，
 *   好处是实打实的：
 *     · 零字节，单文件版不用为它多扛一份 base64
 *     · 不会解码失败 —— 音频文件在 iOS 上因为采样率/编码不合规放不出声，
 *       是这个项目里最难查的一类 bug（放不出声但不报错）
 *     · 可以随时调音（音高、时长、波形都是参数）
 *
 *   真正需要「人声」的只有英语单词，那部分走 20-audio.js 的
 *   G.AUDIO_MAP + 预生成语音文件，和这里不冲突。
 *
 * 音效表（id 全部带 ui. 前缀 —— 和 G.AUDIO_MAP 的命名规则一致，
 * 也让 G.Audio.play() 能一眼看出哪些走合成、哪些走文件）：
 *   ui.tap      按钮反馈        ui.correct  答对
 *   ui.wrong    答错            ui.spin     转盘转动（会响 3.4 秒）
 *   ui.win      中奖            ui.lose     空奖（要温柔，不能让孩子难受）
 *   ui.star     攒够分/里程碑
 */
(function (window) {
  'use strict';

  var G = window.G;

  function ctxOf() {
    // 复用 20-audio.js 的 AudioContext —— 一个页面只能有一个，
    // 而且那个已经被 user gesture 解锁过了。这里自己 new 一个的话，
    // 会得到一个永远 suspended 的 context，症状又是「没声音」。
    if (G.Audio && G.Audio._ensureCtx) return G.Audio._ensureCtx();
    return null;
  }

  function enabled() {
    try {
      var s = G.Store && G.Store.load();
      if (s && s.settings && s.settings.audioEnabled === false) return false;
    } catch (e) { /* store 还没起来时按有声处理 */ }
    return true;
  }

  /* ---------- 发声原语 ---------- */

  /**
   * 一个音符。t0 是相对当前时间的偏移（秒），不是绝对时间 ——
   * 调用方只关心「这几个音依次隔多久」，不关心 ctx.currentTime 走到哪了。
   */
  function note(c, opt) {
    var t0 = c.currentTime + (opt.at || 0);
    var dur = opt.dur || 0.12;
    var osc = c.createOscillator();
    var gain = c.createGain();

    osc.type = opt.type || 'sine';
    osc.frequency.setValueAtTime(opt.freq, t0);
    if (opt.to) osc.frequency.exponentialRampToValueAtTime(opt.to, t0 + dur);

    // 包络：瞬间起音 + 指数衰减。
    // 直接 gain=1 然后 stop() 会「啪」一声（波形被硬切），所以尾巴一定要收。
    var vol = (opt.vol === undefined ? 0.25 : opt.vol);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** 扫频噪声，用来做「唰」「咔」这类没有明确音高的声音。 */
  function noise(c, opt) {
    var t0 = c.currentTime + (opt.at || 0);
    var dur = opt.dur || 0.08;
    var len = Math.max(1, Math.floor(c.sampleRate * dur));
    var buf = c.createBuffer(1, len, c.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) {
      // 后面衰减得更快，听起来像敲击而不是白噪
      d[i] = (Math.random() * 2 - 1) * (1 - i / len) * (1 - i / len);
    }
    var src = c.createBufferSource();
    src.buffer = buf;

    var filt = c.createBiquadFilter();
    filt.type = opt.filter || 'bandpass';
    filt.frequency.value = opt.freq || 1800;
    filt.Q.value = opt.q === undefined ? 1.2 : opt.q;

    var gain = c.createGain();
    gain.gain.value = opt.vol === undefined ? 0.3 : opt.vol;

    src.connect(filt);
    filt.connect(gain);
    gain.connect(c.destination);
    src.start(t0);
  }

  /* ---------- 音效定义 ---------- */

  var RECIPES = {
    // 按钮「嗒」。用方波，短到 60ms —— 长一点就会拖慢答题节奏，
    // 一局 10 道题要按几十次，每次多 100ms 就很烦。
    'ui.tap': function (c) {
      note(c, { freq: 880, dur: 0.05, type: 'square', vol: 0.10 });
    },

    // 答对：C5-E5-G5 上行。上行音阶是跨文化通用的「对了」。
    'ui.correct': function (c) {
      note(c, { freq: 523.25, dur: 0.11, type: 'triangle', at: 0,    vol: 0.22 });
      note(c, { freq: 659.25, dur: 0.11, type: 'triangle', at: 0.09, vol: 0.22 });
      note(c, { freq: 783.99, dur: 0.22, type: 'triangle', at: 0.18, vol: 0.26 });
    },

    // 答错：两个下行音，音量压低。
    // 故意不用「嗡嗡」的刺耳低频 —— 6 岁孩子答错本来就挫败，
    // 音效再凶一点，下一题他就不敢点了。
    'ui.wrong': function (c) {
      note(c, { freq: 392.00, dur: 0.13, type: 'sine', at: 0,   vol: 0.18 });
      note(c, { freq: 311.13, dur: 0.24, type: 'sine', at: 0.11, vol: 0.16 });
    },

    // 转盘：棘轮声。26 下，间隔从 45ms 渐增到 260ms ——
    // 和 50-wheel.js 里 3.4s 的 cubic-bezier 减速曲线大致对得上，
    // 孩子听到「咔、咔、咔…… 咔」慢下来，就知道快停了。
    'ui.spin': function (c) {
      var n = 26, t = 0;
      for (var i = 0; i < n; i++) {
        var k = i / (n - 1);
        noise(c, { at: t, dur: 0.035, freq: 2400 - k * 900, vol: 0.10 + k * 0.06, q: 3 });
        t += 0.045 + k * k * 0.215;
      }
    },

    // 中奖：C5-E5-G5-C6 小号式收尾。最后一个音拉长，给「中了！」留出时间。
    'ui.win': function (c) {
      note(c, { freq: 523.25, dur: 0.12, type: 'triangle', at: 0,    vol: 0.24 });
      note(c, { freq: 659.25, dur: 0.12, type: 'triangle', at: 0.10, vol: 0.24 });
      note(c, { freq: 783.99, dur: 0.12, type: 'triangle', at: 0.20, vol: 0.24 });
      note(c, { freq: 1046.5, dur: 0.42, type: 'triangle', at: 0.30, vol: 0.30 });
      note(c, { freq: 523.25, dur: 0.42, type: 'sine',     at: 0.30, vol: 0.14 });
    },

    // 空奖：两个下行长音，柔和。
    // 「下次好运」是明明白白的不中，但孩子已经答对了一道题 ——
    // 这里要收住，不能像是惩罚。
    'ui.lose': function (c) {
      note(c, { freq: 440.00, dur: 0.20, type: 'sine', at: 0,    vol: 0.16 });
      note(c, { freq: 349.23, dur: 0.40, type: 'sine', at: 0.17, vol: 0.14 });
    },

    'ui.star': function (c) {
      note(c, { freq: 1046.5, dur: 0.09, type: 'sine', at: 0,    vol: 0.20 });
      note(c, { freq: 1318.5, dur: 0.09, type: 'sine', at: 0.07, vol: 0.20 });
      note(c, { freq: 1568.0, dur: 0.28, type: 'sine', at: 0.14, vol: 0.24 });
    }
  };

  /* ---------- 对外 ---------- */

  function has(id) { return Object.prototype.hasOwnProperty.call(RECIPES, id); }

  function play(id) {
    if (!enabled()) return false;
    if (!has(id)) return false;

    var c = ctxOf();
    if (!c) return false;

    // 还没解锁时直接放弃，不排队。
    // 排队看着更「对」，但音效是即时反馈 —— 攒到解锁后一起放出来
    // 只会变成一串错位的怪声，不如不放。
    if (c.state !== 'running') {
      G.log('sfx 跳过（context 未解锁）', id);
      return false;
    }

    try {
      RECIPES[id](c);
      return true;
    } catch (e) {
      // 音效永远不能把游戏搞崩
      G.log('sfx 合成失败', id, e);
      return false;
    }
  }

  /* ---------- 全局按钮「嗒」声 ---------- */

  /**
   * 用事件委托给所有按钮加反馈音，而不是在每个 onclick 里各写一行。
   *
   * 为什么值得这么绕：这个游戏里绝大多数点击是「翻页/开始/继续」这类
   * 没有对错的动作，它们也必须有声音 —— 6 岁孩子判断「我点到了没有」
   * 靠的就是这一下响。逐个按钮去加，一定会漏；漏掉的那个正好就是
   * 「点了没反应」，也就是这次试玩反馈的问题。
   *
   * 用捕获阶段（第三个参数 true）：在业务 handler 跑之前出声，
   * 手感更跟手；也避免业务 handler 里 stopPropagation 把它吃掉。
   */
  function installTap() {
    document.addEventListener('click', function (e) {
      var el = e.target;
      if (!el || !el.closest) return;

      var btn = el.closest('button, .tap');
      if (!btn || btn.disabled || btn.classList.contains('locked')) return;
      if (btn.hasAttribute('data-sfx-off')) return;

      play('ui.tap');
    }, true);
  }

  G.Sfx = {
    play: play,
    has: has,
    installTap: installTap,
    list: function () { return Object.keys(RECIPES); }
  };

})(window);
