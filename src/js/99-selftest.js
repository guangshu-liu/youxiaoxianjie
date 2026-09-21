/* 99-selftest.js — 真机自检页（Phase 0 的核心交付物）
 *
 * Phase 0 的唯一目的是把所有「需实测验证」打掉。这些结论里任何一条为负面，
 * 都会改变架构。所以在真机上跑一遍，把结果复制回来看。
 *
 * 访问方式：index.html#selftest 或 index.html?debug=1 再点「自检」
 */
(function (window) {
  'use strict';

  var G = window.G;

  var results = [];
  var pass = 0, fail = 0, warn = 0;

  function record(name, status, detail) {
    results.push({ name: name, status: status, detail: detail });
    if (status === 'pass') pass++;
    else if (status === 'fail') fail++;
    else warn++;
  }

  /* ---------- 各项检测 ---------- */

  function checkEnvironment() {
    record('运行环境', 'info',
      (G.env.isIOS ? 'iOS' : G.env.isAndroid ? 'Android' : '桌面') +
      (G.env.isWeChat ? ' · 微信' : ' · 浏览器') +
      (G.env.isStandalone ? ' · 已添加到主屏幕' : ''));

    record('页面协议', G.env.isFile ? 'warn' : 'pass',
      location.protocol + (G.env.isFile ? '（file:// 下部分 API 受限，这正是单文件版要验证的）' : ''));

    record('屏幕', 'info', window.screen.width + '×' + window.screen.height +
      ' dpr=' + window.devicePixelRatio);

    record('UA', 'info', navigator.userAgent.slice(0, 120));
  }

  function checkAudioContext() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      record('AudioContext', 'fail', '不支持 —— 音频方案不可行，需要改用 <audio> 元素');
      return;
    }
    record('AudioContext', 'pass', '构造成功（实际播放需真人点击下方按钮测试）');
  }

  /**
   * 音频测试按钮。必须由真实手势触发，所以不能放进 run() 的自动流程里。
   * 结果写进 results 后重新渲染，让结论出现在报告里。
   */
  function audioTestCard() {
    var wrap = G.el('div', { class: 'st-manual st-audio-test' });
    wrap.appendChild(G.el('h2', { text: '音频测试（最重要的一项）' }));

    var btn = G.el('button', { class: 'btn btn-primary btn-xl', text: '▶ 点这里测试声音' });
    var log = G.el('div', { class: 'st-log', text: '在微信里也要单独测一次 —— 微信内置浏览器是全部待验证项里最不确定的一条。' });

    btn.addEventListener('click', function () {
      btn.disabled = true;
      var t0 = Date.now();
      log.textContent = '测试中…';

      G.Audio.unlock().then(function (ok) {
        record('全局解锁 AudioContext', ok ? 'pass' : 'fail',
          ok ? ('耗时 ' + (Date.now() - t0) + 'ms') : '解锁失败——音频方案需要调整');
        if (!ok) { log.textContent = '❌ 解锁失败'; render(); return; }

        var ids = Object.keys(G.AUDIO_MAP || {});

        // 还没有内置音频（Phase 0 的常态）→ 播一个合成正弦波，至少验证音频通路
        if (!ids.length) {
          var ctx = G.Audio._ctx();
          var osc = ctx.createOscillator();
          var g = ctx.createGain();
          g.gain.value = 0.15;
          osc.connect(g);
          g.connect(ctx.destination);
          osc.frequency.value = 660;
          osc.start();
          osc.stop(ctx.currentTime + 0.5);
          record('音频通路（合成音）', 'pass', '已播 0.5 秒 660Hz');
          log.textContent = '🔊 听到「嘀」了吗？听到就说明音频通路正常。';
          render();
          return;
        }

        // 有内置音频 → 端到端测一条真实的
        G.Audio.play(ids[0]).then(function (played) {
          record('端到端播放内置音频', played ? 'pass' : 'fail',
            played ? ('已播放 ' + ids[0]) : '解码或播放失败');

          // 合成音效走的是另一条路径（G.Sfx，不经解码），
          // 而它现在是孩子点每个按钮都能听到的声音 —— 单独测一条。
          var sfxOk = G.Sfx ? G.Sfx.play('ui.correct') : false;
          record('合成音效（按钮/对错反馈）', sfxOk ? 'pass' : 'fail',
            sfxOk ? '已播放 ui.correct（三连上行音）'
                  : '合成失败 —— 检查 AudioContext 是否已解锁');

          log.textContent = (played ? '✅ 播放成功：' + ids[0] : '❌ 播放失败') +
            '　' + (sfxOk ? '✅ 音效正常' : '❌ 音效异常');
          render();
        });
      }).catch(function (e) {
        record('音频测试', 'fail', String(e && e.message || e));
        log.textContent = '❌ ' + e;
        render();
      });
    });

    wrap.appendChild(btn);
    wrap.appendChild(log);
    return wrap;
  }

  function checkMediaRecorder() {
    if (!window.MediaRecorder) {
      record('MediaRecorder', 'fail', '不支持 —— 家长录音要走 PCM→WAV 兜底路径');
      return;
    }
    var candidates = ['audio/mp4', 'audio/mp4;codecs=mp4a.40.2', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm'];
    var supported = candidates.filter(function (m) {
      try { return window.MediaRecorder.isTypeSupported(m); } catch (e) { return false; }
    });

    if (!supported.length) {
      record('MediaRecorder 编码格式', 'fail', '没有支持的格式，录音要走 PCM→WAV 兜底');
    } else {
      var hasMp4 = supported.some(function (m) { return m.indexOf('audio/mp4') === 0 || m.indexOf('audio/aac') === 0; });
      record('MediaRecorder 编码格式', hasMp4 ? 'pass' : 'warn',
        '支持：' + supported.join(', ') +
        (hasMp4 ? '' : ' —— 只有 webm，iOS 上播不了，需要兜底'));
    }
  }

  function checkStorage() {
    return new Promise(function (res) {
      // localStorage
      try {
        var k = '__st_' + Date.now();
        window.localStorage.setItem(k, 'x');
        var v = window.localStorage.getItem(k);
        window.localStorage.removeItem(k);
        record('localStorage 读写', v === 'x' ? 'pass' : 'fail', v === 'x' ? '' : '写入后读不回来');
      } catch (e) {
        record('localStorage 读写', 'fail', '不可用：' + e.message + '（无痕模式或微信限制）');
      }

      // 持久性：写一个带时间戳的标记，下次打开若能读到说明还在
      try {
        var prev = window.localStorage.getItem('__st_persist');
        if (prev) {
          var age = Math.round((Date.now() - +prev) / 1000);
          record('localStorage 持久性', 'pass', '上次运行是 ' + age + ' 秒前，标记还在');
        } else {
          record('localStorage 持久性', 'warn', '首次运行。请关掉页面/微信后再打开本页，看这条会不会变绿');
        }
        window.localStorage.setItem('__st_persist', String(Date.now()));
      } catch (e) {}

      // 容量估算
      if (navigator.storage && navigator.storage.estimate) {
        navigator.storage.estimate().then(function (est) {
          record('存储配额', 'info',
            '已用 ' + fmtBytes(est.usage) + ' / 配额 ' + fmtBytes(est.quota));
          res();
        }).catch(function () { res(); });
      } else {
        record('存储配额', 'info', 'navigator.storage.estimate 不可用');
        res();
      }
    });
  }

  function checkIndexedDB() {
    return new Promise(function (res) {
      if (!window.indexedDB) {
        record('IndexedDB', 'fail', '不支持 —— 家长录音无处存放');
        return res();
      }
      try {
        var req = window.indexedDB.open('__st_test', 1);
        req.onupgradeneeded = function () {
          req.result.createObjectStore('t', { keyPath: 'id' });
        };
        req.onsuccess = function () {
          var db = req.result;
          var tx = db.transaction('t', 'readwrite');
          tx.objectStore('t').put({ id: 'k', blob: new Blob(['hello'], { type: 'text/plain' }) });
          tx.oncomplete = function () {
            var tx2 = db.transaction('t', 'readonly');
            var get = tx2.objectStore('t').get('k');
            get.onsuccess = function () {
              var ok = get.result && get.result.blob;
              record('IndexedDB 读写 Blob', ok ? 'pass' : 'fail',
                ok ? '可存可读（' + get.result.blob.size + ' 字节）' : '读回为空');
              db.close();
              try { window.indexedDB.deleteDatabase('__st_test'); } catch (e) {}
              res();
            };
            get.onerror = function () { record('IndexedDB 读写', 'fail', '读取失败'); res(); };
          };
          tx.onerror = function () { record('IndexedDB 读写', 'fail', '写入失败'); res(); };
        };
        req.onerror = function () {
          record('IndexedDB', 'fail', '打开失败：' + (req.error && req.error.message));
          res();
        };
      } catch (e) {
        record('IndexedDB', 'fail', e.message);
        res();
      }
    });
  }

  function checkAudioManifest() {
    var ids = Object.keys(G.AUDIO_MAP || {});
    if (!ids.length) {
      record('音频清单', 'warn', 'AUDIO_MAP 为空 —— Phase 0 只有占位音频，属正常');
      return;
    }
    record('音频清单', 'pass', ids.length + ' 条');

    // 抽 3 条解码，看会不会失败
    var sample = ids.slice(0, 3);
    var t0 = Date.now();
    var memBefore = performance.memory ? performance.memory.usedJSHeapSize : 0;

    G.Audio.preload(sample).then(function () {
      var dt = Date.now() - t0;
      var memAfter = performance.memory ? performance.memory.usedJSHeapSize : 0;
      var memNote = memBefore ? ('，堆增长 ' + fmtBytes(memAfter - memBefore)) : '';
      record('解码 ' + sample.length + ' 条音频', 'pass', dt + 'ms' + memNote);

      if (memBefore) {
        var perItem = (memAfter - memBefore) / sample.length;
        record('内存外推', 'info',
          '按此推算 145 条约需 ' + fmtBytes(perItem * 145) + '（含 LRU 可优化）');
      }
    });
  }

  function checkTouch() {
    record('指针事件', ('PointerEvent' in window) ? 'pass' : 'warn',
      ('PointerEvent' in window) ? '可用（用 pointerdown 解锁音频）' : '不支持，需要回退到 click');

    var hasSafeArea = window.CSS && CSS.supports && CSS.supports('padding', 'env(safe-area-inset-top)');
    record('安全区 env()', hasSafeArea ? 'pass' : 'warn',
      hasSafeArea ? '支持刘海屏安全区' : '不支持，刘海屏上可能被遮挡');
  }

  /* ---------- 渲染 ---------- */

  function fmtBytes(n) {
    if (!n && n !== 0) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  function render() {
    document.body.classList.add('selftest-mode');
    var wrap = G.el('div', { class: 'selftest' });

    wrap.appendChild(G.el('h1', { text: '真机自检' }));
    wrap.appendChild(G.el('p', { class: 'st-intro', text:
      'Phase 0 的目的是打掉技术不确定性。请在这台设备上跑完，点底部「复制结果」发回来。' }));

    var bar = G.el('div', { class: 'st-bar' });
    bar.appendChild(G.el('span', { class: 'st-pass', text: pass + ' 通过' }));
    bar.appendChild(G.el('span', { class: 'st-fail', text: fail + ' 失败' }));
    bar.appendChild(G.el('span', { class: 'st-warn', text: warn + ' 待确认' }));
    wrap.appendChild(bar);

    var list = G.el('div', { class: 'st-list', id: 'selftest-list' });
    results.forEach(function (r) {
      list.appendChild(G.el('div', { class: 'st-row st-' + r.status }, [
        G.el('span', { class: 'st-badge', text: badge(r.status) }),
        G.el('div', { class: 'st-body' }, [
          G.el('div', { class: 'st-name', text: r.name }),
          r.detail ? G.el('div', { class: 'st-detail', text: r.detail }) : null
        ])
      ]));
    });
    wrap.appendChild(list);

    // 音频测试必须由真实手势触发，不能放进自动流程
    wrap.appendChild(audioTestCard());

    // 重要的手动测试项
    wrap.appendChild(G.el('div', { class: 'st-manual' }, [
      G.el('h2', { text: '还需要手动确认的' }),
      G.el('ul', {}, [
        G.el('li', { text: '关掉本页/微信，30 秒后再打开 ——「localStorage 持久性」是否变绿？' }),
        G.el('li', { text: '把单文件 HTML 用微信发给自己，点开能不能玩、有没有声音？' }),
        G.el('li', { text: '切到别的 App 再切回来，声音还在吗？（僵尸 AudioContext 测试）' }),
        G.el('li', { text: '在微信里打开线上版链接，重复一次上面的音频测试。' })
      ])
    ]));

    var actions = G.el('div', { class: 'st-actions' });
    actions.appendChild(G.el('button', {
      class: 'btn btn-primary', text: '复制结果',
      onclick: function () {
        var text = reportText();
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () {
            G.UI.toast('已复制，粘贴发回即可');
          }).catch(function () {
            window.prompt('复制下面的内容：', text);
          });
        } else {
          window.prompt('复制下面的内容：', text);
        }
      }
    }));
    actions.appendChild(G.el('button', {
      class: 'btn btn-ghost', text: '返回游戏',
      onclick: function () { location.hash = ''; location.reload(); }
    }));
    wrap.appendChild(actions);

    G.clear(document.getElementById('app'));
    document.getElementById('app').appendChild(wrap);
  }

  function badge(s) {
    return { pass: '✅', fail: '❌', warn: '⚠️', info: 'ℹ️' }[s] || '·';
  }

  function reportText() {
    var lines = ['=== 幼小衔接游戏 自检报告 ===',
                 '时间：' + new Date().toLocaleString(),
                 '版本：' + G.VERSION,
                 (pass + ' 通过 / ' + fail + ' 失败 / ' + warn + ' 待确认'), ''];
    results.forEach(function (r) {
      lines.push(badge(r.status) + ' ' + r.name + (r.detail ? ' — ' + r.detail : ''));
    });
    return lines.join('\n');
  }

  /* ---------- 入口 ---------- */

  async function run() {
    checkEnvironment();
    checkAudioContext();
    checkMediaRecorder();
    checkTouch();
    await checkStorage();
    await checkIndexedDB();
    checkAudioManifest();
    render();
  }

  G.SelfTest = { run: run, reportText: reportText };

})(window);
