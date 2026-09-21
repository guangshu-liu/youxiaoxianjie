/* 20-audio.js — 音频层（全项目风险最高的文件）
 *
 * 三件事必须同时成立，任何一件失败都会改变架构：
 *   1. iOS 音频解锁          → 用 Web Audio 而非 <audio>（145 条音频不可能逐个预解锁）
 *   2. 微信内置浏览器        → 更严，需要 WeixinJSBridgeReady + 失败可见反馈
 *   3. 家长替换录音          → IndexedDB 存 Blob，优先级覆盖内置音频
 *
 * 覆盖优先级：家长禁用(静音) > 家长录音 > 内置音频 > null
 */
(function (window) {
  'use strict';

  var G = window.G;

  /* ---------- 状态 ---------- */

  var ctx = null;
  var buffers = {};              // { audioId: AudioBuffer }
  var pending = {};              // { audioId: Promise<AudioBuffer|null> }
  var overrides = {};            // { audioId: {blob, url, gain, ts} } — 家长录音
  var unlocked = false;
  var failStreak = 0;            // 连续播放失败次数
  var needsRebuild = false;      // 检测到僵尸 context，下次点击时重建

  var IDB_NAME = 'youxiaoxianjie';
  var IDB_STORE = 'overrides';

  /* ---------- AudioContext ---------- */

  function getCtx() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    return ctx;
  }

  /**
   * 全局解锁。必须在真实用户手势里调用（pointerdown / click，不能用 touchstart，
   * iOS 9 之后 touchstart 里启动音频已失效）。
   *
   * 一次 ctx.resume() 之后整个 context 永久解锁 —— 这是选 Web Audio 而不是
   * <audio> 元素的唯一原因。145 个 <audio> 元素需要 145 次预激活。
   */
  function unlock() {
    var c = getCtx();
    if (!c) return Promise.resolve(false);

    var p = (c.state === 'running') ? Promise.resolve() : c.resume();

    return p.then(function () {
      // 播一个 1 帧的静音 buffer。resume() 返回不等于真的出声了 ——
      // iOS 上曾出现 state 报 running 但实际静音的情况，所以要做一次真实播放探测。
      var s = c.createBufferSource();
      s.buffer = c.createBuffer(1, 1, c.sampleRate);
      s.connect(c.destination);
      s.start(0);
      unlocked = true;
      G.log('音频已解锁, state =', c.state);
      hideSoundPrompt();
      return true;
    }).catch(function (e) {
      G.log('音频解锁失败', e);
      return false;
    });
  }

  function isUnlocked() { return unlocked; }

  /* ---------- 僵尸 context 检测 ----------
   * 切后台/锁屏回来后，ctx.state 可能仍报 running 但实际已静音。
   */

  var hiddenAt = 0;

  function watchVisibility() {
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { hiddenAt = Date.now(); return; }

      if (hiddenAt && Date.now() - hiddenAt > 1000) {
        var c = getCtx();
        if (!c) return;
        c.resume().then(function () {
          // 探测是否真的还活着：播一个静音 buffer，看是否抛错
          try {
            var s = c.createBufferSource();
            s.buffer = c.createBuffer(1, 1, c.sampleRate);
            s.connect(c.destination);
            s.start(0);
          } catch (e) {
            G.log('检测到僵尸 AudioContext，标记重建');
            needsRebuild = true;
            unlocked = false;
          }
        }).catch(function () {
          needsRebuild = true;
          unlocked = false;
        });
      }
      hiddenAt = 0;
    });
  }

  function rebuildIfNeeded() {
    if (!needsRebuild) return;
    G.log('重建 AudioContext');
    try { if (ctx) ctx.close(); } catch (e) {}
    ctx = null;
    buffers = {};
    pending = {};
    needsRebuild = false;
  }

  /* ---------- 播放失败的用户可见反馈 ----------
   * 微信内置浏览器即使已经交互过，仍可能拒绝播放。连续失败 2 次就弹按钮，
   * 把解锁动作交回一次真实的点击。
   */

  var soundPromptEl = null;

  function showSoundPrompt() {
    if (soundPromptEl) return;
    soundPromptEl = G.el('button', {
      class: 'sound-prompt',
      onclick: function () {
        failStreak = 0;
        rebuildIfNeeded();
        unlock();
      }
    }, ['🔈 点这里开启声音']);
    document.body.appendChild(soundPromptEl);
  }

  function hideSoundPrompt() {
    if (soundPromptEl && soundPromptEl.parentNode) {
      soundPromptEl.parentNode.removeChild(soundPromptEl);
    }
    soundPromptEl = null;
  }

  /* ---------- 解析：覆盖优先级 ---------- */

  function resolve(audioId) {
    if (!audioId) return Promise.resolve(null);

    var s = G.Store.load();
    if (!s.settings.audioEnabled) return Promise.resolve(null);
    if (s.settings.mutedAudio.indexOf(audioId) >= 0) return Promise.resolve(null);

    // 1. 家长录音（最高优先级）
    if (overrides[audioId]) {
      return getOverrideBuffer(audioId).then(function (buf) {
        return buf ? { buffer: buf, gain: overrides[audioId].gain || 1.0, src: 'override' } : null;
      });
    }

    // 2. 内置音频
    var entry = G.AUDIO_MAP && G.AUDIO_MAP[audioId];
    if (entry) {
      return getBuffer(audioId, entry.src).then(function (buf) {
        return buf ? { buffer: buf, gain: 1.0, src: 'builtin' } : null;
      });
    }

    // 3. 无
    return Promise.resolve(null);
  }

  /* ---------- 内置音频解码 ---------- */

  function getBuffer(audioId, src) {
    if (buffers[audioId]) return Promise.resolve(buffers[audioId]);
    if (pending[audioId]) return pending[audioId];

    var c = getCtx();
    if (!c) return Promise.resolve(null);

    pending[audioId] = fetchBytes(src).then(function (bytes) {
      return new Promise(function (res, rej) {
        // Safari 只支持 callback 形式，不支持 Promise 形式
        c.decodeAudioData(bytes, res, rej);
      });
    }).then(function (buf) {
      buffers[audioId] = buf;
      delete pending[audioId];
      return buf;
    }).catch(function (e) {
      G.log('解码失败', audioId, e);
      delete pending[audioId];
      return null;
    });

    return pending[audioId];
  }

  function fetchBytes(src) {
    // 单文件版：src 是 data URI，不需要网络
    if (src.indexOf('data:') === 0) {
      var comma = src.indexOf(',');
      var b64 = src.slice(comma + 1);
      var bin = window.atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return Promise.resolve(bytes.buffer);
    }
    return fetch(src).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + src);
      return r.arrayBuffer();
    });
  }

  /* ---------- 播放 ---------- */

  function play(audioId, opts) {
    opts = opts || {};
    rebuildIfNeeded();

    // 合成音效优先。ui.tap / ui.correct 这些根本没有对应文件 ——
    // 它们是 21-sfx.js 用振荡器现场合成的（见那里的注释：为什么音效不走文件）。
    // 放前面是因为合成音效不需要解码、不会失败，能立刻出声。
    if (G.Sfx && G.Sfx.has(audioId)) {
      var ok = G.Sfx.play(audioId);
      return Promise.resolve(ok);
    }

    return resolve(audioId).then(function (hit) {
      if (!hit) return false;

      var c = getCtx();
      if (!c || c.state !== 'running') {
        // 还没解锁：尝试一次，失败则提示
        return unlock().then(function (ok) {
          if (!ok) { maybePrompt(); return false; }
          return doPlay(c, hit, opts);
        });
      }
      return doPlay(c, hit, opts);
    });
  }

  function doPlay(c, hit, opts) {
    return new Promise(function (res) {
      try {
        var src = c.createBufferSource();
        src.buffer = hit.buffer;

        var gain = c.createGain();
        gain.gain.value = (hit.gain || 1) * (opts.volume === undefined ? 1 : opts.volume);

        src.connect(gain);
        gain.connect(c.destination);
        src.onended = function () { failStreak = 0; res(true); };
        src.start(0);
      } catch (e) {
        G.log('播放异常', e);
        maybePrompt();
        res(false);
      }
    });
  }

  function maybePrompt() {
    failStreak++;
    if (failStreak >= 2) showSoundPrompt();
  }

  function has(audioId) {
    if (G.Sfx && G.Sfx.has(audioId)) return true;      // 合成音效，永远可用
    return !!(overrides[audioId] || (G.AUDIO_MAP && G.AUDIO_MAP[audioId]));
  }

  /* ---------- 预加载 ---------- */

  /**
   * 按需预加载。不阻塞 UI —— 先渲染题目骨架，音频到了再点亮喇叭图标。
   */
  function preload(ids) {
    var list = ids.filter(function (id) { return id && G.AUDIO_MAP && G.AUDIO_MAP[id]; });
    return Promise.all(list.map(function (id) {
      return getBuffer(id, G.AUDIO_MAP[id].src);
    }));
  }

  /* ---------- IndexedDB：家长录音 ---------- */

  var _db = null;

  function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (res, rej) {
      var req = window.indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = function () { _db = req.result; res(_db); };
      req.onerror = function () { rej(req.error); };
    });
  }

  function idbPut(rec) {
    return openDB().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(rec);
        tx.oncomplete = function () { res(rec.id); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }

  function idbGet(id) {
    return openDB().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(IDB_STORE, 'readonly');
        var req = tx.objectStore(IDB_STORE).get(id);
        req.onsuccess = function () { res(req.result || null); };
        req.onerror = function () { rej(req.error); };
      });
    });
  }

  function idbAll() {
    return openDB().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(IDB_STORE, 'readonly');
        var req = tx.objectStore(IDB_STORE).getAll();
        req.onsuccess = function () { res(req.result || []); };
        req.onerror = function () { rej(req.error); };
      });
    });
  }

  function idbDelete(id) {
    return openDB().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(id);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }

  /* ---------- 录音 ---------- */

  var recorder = null;
  var recChunks = [];
  var recStream = null;

  /**
   * iOS Safari 只支持 audio/mp4，不支持 audio/webm。这是整个替换功能的地基。
   * 探测结果写进 selftest（99-selftest.js）。
   */
  function pickMimeType() {
    if (!window.MediaRecorder || !window.MediaRecorder.isTypeSupported) return null;
    var candidates = [
      'audio/mp4',
      'audio/mp4;codecs=mp4a.40.2',
      'audio/aac',
      'audio/webm;codecs=opus',
      'audio/webm'
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (window.MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return null;
  }

  var usePcmFallback = false;

  function startRecording() {
    return navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      recStream = stream;
      recChunks = [];

      var mime = pickMimeType();
      if (!mime) {
        // 兜底：抓原始 PCM 自己编 WAV（约 30 行，无依赖）
        G.log('MediaRecorder 不可用，走 PCM→WAV 兜底');
        usePcmFallback = true;
        return startPcmRecording(stream);
      }

      usePcmFallback = false;
      recorder = new window.MediaRecorder(stream, { mimeType: mime });
      recorder.ondataavailable = function (e) {
        if (e.data && e.data.size > 0) recChunks.push(e.data);
      };
      recorder.start();
      return true;
    });
  }

  function stopRecording() {
    if (usePcmFallback) return stopPcmRecording();

    return new Promise(function (res) {
      if (!recorder) return res(null);
      recorder.onstop = function () {
        var blob = new Blob(recChunks, { type: recorder.mimeType || 'audio/mp4' });
        cleanupStream();
        res(blob);
      };
      recorder.stop();
    });
  }

  /* --- PCM → WAV 兜底 --- */

  var pcmChunks = [];
  var pcmNode = null;
  var pcmSource = null;

  function startPcmRecording(stream) {
    var c = getCtx();
    pcmSource = c.createMediaStreamSource(stream);
    // ScriptProcessor 已废弃但兼容性最好；AudioWorklet 在 iOS 上需要额外加载模块文件，
    // 而单文件版没有独立的 worklet 文件可加载。
    pcmNode = c.createScriptProcessor(4096, 1, 1);
    pcmChunks = [];
    pcmNode.onaudioprocess = function (e) {
      pcmChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    pcmSource.connect(pcmNode);
    pcmNode.connect(c.destination);   // 有些浏览器不连 destination 就不触发
    return true;
  }

  function stopPcmRecording() {
    return new Promise(function (res) {
      try { pcmNode.disconnect(); pcmSource.disconnect(); } catch (e) {}
      var flat = flattenPcm(pcmChunks);
      var blob = encodeWav(flat, getCtx().sampleRate);
      cleanupStream();
      res(blob);
    });
  }

  function flattenPcm(chunks) {
    var len = G.sum(chunks, function (c) { return c.length; });
    var out = new Float32Array(len);
    var off = 0;
    chunks.forEach(function (c) { out.set(c, off); off += c.length; });
    return out;
  }

  function encodeWav(samples, sampleRate) {
    var buf = new ArrayBuffer(44 + samples.length * 2);
    var view = new DataView(buf);

    function str(off, s) {
      for (var i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    }
    str(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);          // PCM
    view.setUint16(22, 1, true);          // 单声道
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    str(36, 'data');
    view.setUint32(40, samples.length * 2, true);

    var off = 44;
    for (var i = 0; i < samples.length; i++) {
      var s = G.clamp(samples[i], -1, 1);
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      off += 2;
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  function cleanupStream() {
    if (recStream) {
      recStream.getTracks().forEach(function (t) { t.stop(); });
      recStream = null;
    }
    recorder = null;
    pcmNode = null;
    pcmSource = null;
  }

  /* ---------- 覆盖管理 ---------- */

  function setOverride(id, blob, gain) {
    return idbPut({
      id: id,
      blob: blob,
      gain: gain === undefined ? 1.0 : gain,
      ts: Date.now(),
      source: 'parent-recorded'
    }).then(function () {
      overrides[id] = { blob: blob, gain: gain === undefined ? 1.0 : gain, ts: Date.now() };
      delete buffers['__override__' + id];
      return true;
    });
  }

  function removeOverride(id) {
    return idbDelete(id).then(function () {
      delete overrides[id];
      delete buffers['__override__' + id];
      return true;
    });
  }

  function getOverrideBuffer(id) {
    var key = '__override__' + id;
    if (buffers[key]) return Promise.resolve(buffers[key]);

    return idbGet(id).then(function (rec) {
      if (!rec || !rec.blob) return null;
      return rec.blob.arrayBuffer().then(function (bytes) {
        var c = getCtx();
        if (!c) return null;
        return new Promise(function (res, rej) {
          c.decodeAudioData(bytes, res, rej);
        }).then(function (buf) {
          buffers[key] = buf;
          return buf;
        }).catch(function (e) {
          G.log('家长录音解码失败', id, e);
          return null;
        });
      });
    });
  }

  // 启动时把所有家长录音的元信息读进内存，供 resolve 同步判断
  function loadOverrideIndex() {
    return idbAll().then(function (recs) {
      overrides = {};
      recs.forEach(function (r) {
        overrides[r.id] = { blob: r.blob, gain: r.gain, ts: r.ts };
      });
      G.log('已加载家长录音', Object.keys(overrides).length, '条');
      return overrides;
    }).catch(function (e) {
      G.log('读取家长录音索引失败', e);
      return {};
    });
  }

  /* ---------- 备份：Blob ↔ base64 ---------- */

  function blobToBase64(blob) {
    return new Promise(function (res) {
      var fr = new FileReader();
      fr.onload = function () {
        res(String(fr.result).split(',')[1]);
      };
      fr.readAsDataURL(blob);
    });
  }

  function base64ToBlob(b64, type) {
    var bin = window.atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: type || 'audio/mp4' });
  }

  function dumpOverrides() {
    var ids = Object.keys(overrides);
    return Promise.all(ids.map(function (id) {
      return blobToBase64(overrides[id].blob).then(function (b64) {
        return { id: id, data: b64, gain: overrides[id].gain, mime: overrides[id].blob.type };
      });
    })).catch(function (e) {
      G.log('导出录音失败', e);
      return [];
    });
  }

  function loadOverrides(list) {
    return Promise.all(list.map(function (item) {
      var blob = base64ToBlob(item.data, item.mime);
      return setOverride(item.id, blob, item.gain);
    })).then(function () { return list.length; });
  }

  /* ---------- 初始化 ---------- */

  function init() {
    watchVisibility();
    loadOverrideIndex();

    // 全局按钮反馈音。放在这里而不是各页面里 —— 见 21-sfx.js 的注释。
    if (G.Sfx && G.Sfx.installTap) G.Sfx.installTap();

    // 微信内置浏览器更严。WeixinJSBridgeReady 是微信最早可用的时机。
    if (G.env.isWeChat) {
      document.addEventListener('WeixinJSBridgeReady', function () {
        G.log('WeixinJSBridgeReady');
      }, false);
    }

    // 兜底：任何一次指针按下都尝试解锁（once 只保证主路径不重复，这里持续监听以防僵尸 context）
    document.addEventListener('pointerdown', function () {
      rebuildIfNeeded();
      if (!unlocked) unlock();
    }, { passive: true });

    // 三重保险：pointerdown 在少数环境下拿不到手势授权 ——
    // 微信 X5 内核、部分安卓 WebView、以及 iOS 上「从后台切回来」后的
    // 第一次点击，都可能出现 pointerdown 到了但 resume() 被拒的情况。
    // 加 touchend 和 click 是因为它们**同样算真实手势**，但触发时机和
    // 事件路径都不同；多一条路径，就少一次「家长说没声音」。
    // 已解锁时是空转（unlocked 判断在 unlock() 之前），不产生开销。
    ['touchend', 'click'].forEach(function (type) {
      document.addEventListener(type, function () {
        if (unlocked) return;
        rebuildIfNeeded();
        unlock();
      }, { passive: true });
    });
  }

  G.Audio = {
    init: init,
    unlock: unlock,
    isUnlocked: isUnlocked,
    resolve: resolve,
    play: play,
    preload: preload,
    has: has,

    startRecording: startRecording,
    stopRecording: stopRecording,
    pickMimeType: pickMimeType,
    setOverride: setOverride,
    removeOverride: removeOverride,
    loadOverrides: loadOverrides,
    dumpOverrides: dumpOverrides,
    listOverrides: function () { return Object.keys(overrides); },
    getOverrideMeta: function (id) { return overrides[id] || null; },

    // 调试用
    _buffers: function () { return buffers; },
    _ctx: function () { return ctx; },
    // 21-sfx.js 用这个拿 context —— 它必须复用同一个实例。
    // 各建一个的话，音效那个永远停在 suspended，症状又是「点了没声音」。
    _ensureCtx: getCtx
  };

})(window);
