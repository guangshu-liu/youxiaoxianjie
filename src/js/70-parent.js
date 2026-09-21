/* 70-parent.js — 家长模式
 *
 * 门禁用 7×8（超出幼小衔接范围）。失败 3 次冷却 30 秒 —— 防孩子狂点蒙对。
 * 冷却写进 localStorage，刷新页面绕不过去。
 */
(function (window) {
  'use strict';

  var G = window.G;

  var COOLDOWN_KEY = 'yxjx.parent.cooldown';
  var FAIL_KEY = 'yxjx.parent.fails';
  var MAX_FAILS = 3;
  var COOLDOWN_MS = 30 * 1000;

  /* ---------- 门禁 ---------- */

  function gateState() {
    var until = 0, fails = 0;
    try {
      until = +(window.localStorage.getItem(COOLDOWN_KEY) || 0);
      fails = +(window.localStorage.getItem(FAIL_KEY) || 0);
    } catch (e) {}
    return { until: until, fails: fails, blocked: Date.now() < until };
  }

  function recordFail() {
    var s = gateState();
    var fails = s.fails + 1;
    try {
      window.localStorage.setItem(FAIL_KEY, String(fails));
      if (fails >= MAX_FAILS) {
        window.localStorage.setItem(COOLDOWN_KEY, String(Date.now() + COOLDOWN_MS));
        window.localStorage.setItem(FAIL_KEY, '0');
      }
    } catch (e) {}
    return fails >= MAX_FAILS;
  }

  function clearFails() {
    try {
      window.localStorage.removeItem(FAIL_KEY);
      window.localStorage.removeItem(COOLDOWN_KEY);
    } catch (e) {}
  }

  function openGate(onPass) {
    var s = gateState();
    if (s.blocked) {
      G.UI.toast('请等 ' + Math.ceil((s.until - Date.now()) / 1000) + ' 秒后再试');
      return;
    }

    var overlay = G.el('div', { class: 'overlay' });
    var box = G.el('div', { class: 'panel panel-narrow' });

    box.appendChild(G.el('div', { class: 'panel-title', text: '家长验证' }));
    box.appendChild(G.el('div', { class: 'gate-q', text: G.PARENT_GATE.question }));

    var input = G.el('input', {
      class: 'gate-input', type: 'number', inputmode: 'numeric',
      placeholder: '答案'
    });
    box.appendChild(input);

    var err = G.el('div', { class: 'gate-err hidden' });
    box.appendChild(err);

    var submit = G.el('button', {
      class: 'btn btn-primary', text: '进入',
      onclick: function () {
        if (+input.value === G.PARENT_GATE.answer) {
          clearFails();
          close();
          onPass();
        } else {
          var blocked = recordFail();
          err.textContent = blocked ? '错误次数过多，请 30 秒后再试' : '答案不对';
          err.classList.remove('hidden');
          input.value = '';
        }
      }
    });
    box.appendChild(submit);

    box.appendChild(G.el('button', {
      class: 'btn btn-ghost', text: '取消',
      onclick: close
    }));

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    setTimeout(function () { input.focus(); }, 200);

    function close() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
  }

  /* ---------- 主面板 ---------- */

  function open(save) {
    var overlay = G.el('div', { class: 'overlay overlay-scroll' });
    var box = G.el('div', { class: 'panel panel-wide' });

    function rerender() {
      G.clear(box);
      build(box, save, rerender, overlay);
    }
    rerender();

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    return function close() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };
  }

  function build(box, save, rerender, overlay) {
    box.appendChild(G.el('div', { class: 'panel-title', text: '家长面板' }));
    G.UI.dismissBanner();

    /* --- 警示区 --- */
    if (save.integrity.clockTampered) {
      box.appendChild(G.el('div', { class: 'warn-card' }, [
        G.el('div', { text: '⚠️ 检测到设备时间被回拨，兑换已冻结。' }),
        G.el('div', { class: 'warn-sub', text: '如果是改时区或跨日旅行导致的误报，点下面解除。' }),
        G.el('button', {
          class: 'btn btn-sm', text: '解除冻结',
          onclick: function () {
            save.integrity.clockTampered = false;
            save.integrity.maxSeenTs = Date.now();
            G.Store.save(save);
            rerender();
          }
        })
      ]));
    }

    if (!G.storageAvailable()) {
      box.appendChild(G.el('div', { class: 'warn-card' }, [
        G.el('div', { text: '⚠️ 当前环境无法保存进度（无痕模式或微信限制）' })
      ]));
    }

    /* --- 积分审计 --- */
    var a = G.Store.audit(save);
    var auditCard = G.el('div', { class: 'audit-card' });
    auditCard.appendChild(row('当前余额', a.balance + ' 分'));
    auditCard.appendChild(row('累计获得', a.lifetime + ' 分'));
    auditCard.appendChild(row('已兑换', a.spent + ' 分'));
    auditCard.appendChild(row('账目应等于', a.expected + ' 分'));
    if (!a.ok) {
      auditCard.appendChild(G.el('div', {
        class: 'audit-bad',
        text: '⚠️ 账目对不上，积分可能被修改过'
      }));
    }
    box.appendChild(section('积分账目', auditCard));

    /* --- 今日数据 --- */
    var dc = G.Store.todayCounter(save);
    var today = G.el('div', { class: 'stat-card' });
    today.appendChild(row('转盘次数', dc.spins + ' 次'));
    today.appendChild(row('今日得分', dc.pointsEarned + ' / ' + save.limits.maxPointsPerDay));
    today.appendChild(row('动画片时长', dc.tvMinutes + ' / ' + save.limits.maxTvMinutesPerDay + ' 分钟'));
    today.appendChild(row('今日兑换', dc.redemptions + ' / ' + save.limits.maxRedemptionsPerDay));
    box.appendChild(section('今天', today));

    /* --- 待确认兑换 --- */
    var pending = G.Redeem.pendingList(save);
    var pendBox = G.el('div', { class: 'stat-card' });
    if (!pending.length) {
      pendBox.appendChild(G.el('div', { class: 'muted', text: '暂无待确认的兑换' }));
    } else {
      pending.forEach(function (p) {
        var item = G.el('div', { class: 'approve-row' }, [
          G.el('div', { class: 'approve-label', text: p.rewardLabel + ' · ' + p.cost + ' 分' }),
          G.el('div', { class: 'approve-actions' }, [
            G.el('button', {
              class: 'btn btn-sm btn-primary', text: '已兑现',
              onclick: function () {
                var r = G.Redeem.approve(save, p.id);
                if (!r.ok) G.UI.toast(r.why);
                rerender();
              }
            }),
            G.el('button', {
              class: 'btn btn-sm btn-ghost', text: '拒绝',
              onclick: function () {
                G.Redeem.reject(save, p.id);
                rerender();
              }
            })
          ])
        ]);
        pendBox.appendChild(item);
      });
    }
    box.appendChild(section('待确认兑换', pendBox));

    /* --- 英语进度解锁 --- */
    var unlockBox = G.el('div', { class: 'stat-card' });
    unlockBox.appendChild(G.el('div', {
      class: 'muted',
      text: '孩子在课外班学到哪了？游戏只在这个范围内出题。'
    }));
    var cur = G.Curriculum.curriculum();
    cur.unlockOptions.forEach(function (opt) {
      var checked = save.settings.englishUnlockedThrough === opt.through;
      var optEl = G.el('button', {
        class: 'unlock-opt' + (checked ? ' unlock-on' : ''),
        onclick: function () {
          save.settings.englishUnlockedThrough = opt.through;
          G.Store.save(save);
          rerender();
        }
      }, [
        G.el('span', { class: 'unlock-radio', text: checked ? '●' : '○' }),
        G.el('div', {}, [
          G.el('div', { class: 'unlock-label', text: opt.label }),
          G.el('div', { class: 'unlock-detail', text: opt.detail })
        ])
      ]);
      unlockBox.appendChild(optEl);
    });

    // 只给建议，不自动执行 —— 决定权在家长
    var suggestion = englishSuggestion(save);
    if (suggestion) unlockBox.appendChild(G.el('div', { class: 'suggest', text: suggestion }));

    box.appendChild(section('英语进度', unlockBox));

    /* --- 学习数据 --- */
    box.appendChild(section('学习数据', buildStats(save)));

    /* --- 音频替换 --- */
    box.appendChild(section('音频', buildAudioPanel(save, rerender)));

    /* --- 备份 --- */
    box.appendChild(section('备份', buildBackupPanel(save, rerender)));

    /* --- 危险区 --- */
    var danger = G.el('div', { class: 'stat-card' });
    danger.appendChild(G.el('button', {
      class: 'btn btn-sm btn-danger', text: '清空所有数据（不可恢复）',
      onclick: function () {
        if (window.confirm('确定要清空所有进度和积分吗？这个操作不可恢复。\n建议先做一次备份。')) {
          G.Store.reset();
          G.UI.toast('已清空');
          rerender();
        }
      }
    }));
    box.appendChild(section('危险操作', danger));

    box.appendChild(G.el('button', {
      class: 'btn btn-ghost', text: '关闭',
      onclick: function () {
        overlay.classList.add('closing');
        setTimeout(function () {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }, 260);
      }
    }));
  }

  /* ---------- 各区块 ---------- */

  function englishSuggestion(save) {
    var fs = save.progress.english.familyStats;
    var fams = G.Curriculum.unlockedFamilies(save);
    var seen = 0, correct = 0;
    fams.forEach(function (f) {
      if (fs[f]) { seen += fs[f].seen; correct += fs[f].correct; }
    });
    if (seen < 20) return null;
    var acc = correct / seen;
    if (acc < 0.9) return null;

    var units = G.Curriculum.unlockedUnitIds(save);
    var idx = units.length;
    if (idx >= G.Curriculum.curriculum().unlockOptions.length) return null;

    return '建议：当前范围正确率 ' + Math.round(acc * 100) +
           '%，要不要跟老师确认后解锁下一单元？';
  }

  function buildStats(save) {
    var wrap = G.el('div', { class: 'stat-card' });

    // 英语按词族
    var fs = save.progress.english.familyStats;
    var fams = Object.keys(fs);
    if (fams.length) {
      wrap.appendChild(G.el('div', { class: 'stat-title', text: '英语 · 按词族' }));
      fams.sort(function (a, b) { return (fs[a].correct / fs[a].seen) - (fs[b].correct / fs[b].seen); })
        .forEach(function (f) {
          wrap.appendChild(bar(f + ' (-' + f + ')', fs[f].correct, fs[f].seen));
        });
    }

    // 语文数学按标签
    ['chinese', 'math'].forEach(function (sub) {
      var bucket = save.progress[sub].byTag;
      var tags = Object.keys(bucket);
      if (!tags.length) return;
      wrap.appendChild(G.el('div', { class: 'stat-title', text: G.SUBJECT_LABEL[sub] + ' · 按知识点' }));
      tags.sort(function (a, b) { return (bucket[a].correct / bucket[a].seen) - (bucket[b].correct / bucket[b].seen); })
        .forEach(function (t) { wrap.appendChild(bar(t, bucket[t].correct, bucket[t].seen)); });
    });

    // 错题本
    var wrong = save.wrongBook.filter(function (w) { return !w.cleared; })
      .sort(function (a, b) { return b.wrongCount - a.wrongCount; });
    if (wrong.length) {
      wrap.appendChild(G.el('div', { class: 'stat-title', text: '待巩固的题（' + wrong.length + '）' }));
      wrong.slice(0, 15).forEach(function (w) {
        var q = findQuestion(w.qid);
        wrap.appendChild(G.el('div', { class: 'wrong-row' }, [
          G.el('span', { text: (q ? (q.stem.text || q.answerWord || w.qid) : w.qid) }),
          G.el('span', { class: 'wrong-count', text: '错 ' + w.wrongCount + ' 次' })
        ]));
      });
    }

    // 最近局
    if (save.sessions.length) {
      wrap.appendChild(G.el('div', { class: 'stat-title', text: '最近 ' + Math.min(10, save.sessions.length) + ' 局' }));
      save.sessions.slice(-10).reverse().forEach(function (s) {
        wrap.appendChild(bar(
          G.localDateStr(new Date(s.ts)).slice(5) + ' · ' + (s.family ? '-' + s.family : ''),
          s.correct, s.total
        ));
      });
    }

    return wrap;
  }

  var _qIndex = null;
  function findQuestion(qid) {
    if (!_qIndex) {
      _qIndex = {};
      ['chinese', 'math', 'english'].forEach(function (s) {
        (window.G.DATA && window.G.DATA[s] || []).forEach(function (q) { _qIndex[q.id] = q; });
      });
    }
    return _qIndex[qid];
  }

  function buildAudioPanel(save, rerender) {
    var wrap = G.el('div', { class: 'stat-card' });
    var ids = Object.keys(G.AUDIO_MAP || {}).sort();

    wrap.appendChild(G.el('div', {
      class: 'muted',
      text: '共 ' + ids.length + ' 条音频。觉得哪条读得不准，可以自己录一条盖掉。录完拖动滑块调到和原音一样响。'
    }));

    var filter = G.el('input', { class: 'gate-input', placeholder: '搜索，如 fan 或 word.f' });
    wrap.appendChild(filter);

    var list = G.el('div', { class: 'audio-list' });
    wrap.appendChild(list);

    function renderList(kw) {
      G.clear(list);
      var shown = ids.filter(function (id) { return !kw || id.indexOf(kw) >= 0; }).slice(0, 60);
      if (!shown.length) {
        list.appendChild(G.el('div', { class: 'muted', text: '没有匹配的音频' }));
        return;
      }
      shown.forEach(function (id) {
        list.appendChild(audioRow(id, save, rerender));
      });
      if (ids.filter(function (id) { return !kw || id.indexOf(kw) >= 0; }).length > 60) {
        list.appendChild(G.el('div', { class: 'muted', text: '（结果太多，请用搜索缩小范围）' }));
      }
    }

    filter.addEventListener('input', function () { renderList(filter.value.trim()); });
    renderList('');

    wrap.appendChild(G.el('button', {
      class: 'btn btn-sm', text: '列出所有家长录音',
      onclick: function () {
        var ov = G.Audio.listOverrides();
        G.UI.toast(ov.length ? ('已录 ' + ov.length + ' 条：' + ov.slice(0, 5).join(', ')) : '还没有录过');
      }
    }));

    return wrap;
  }

  function audioRow(id, save, rerender) {
    var meta = G.Audio.getOverrideMeta(id);
    var muted = save.settings.mutedAudio.indexOf(id) >= 0;

    var rowEl = G.el('div', { class: 'audio-row' });

    rowEl.appendChild(G.el('div', { class: 'audio-id', text: id }));

    var actions = G.el('div', { class: 'audio-actions' });

    actions.appendChild(G.el('button', {
      class: 'btn btn-xs', text: '听内置',
      onclick: function () { G.Audio.play(id); }
    }));

    actions.appendChild(recButton(id, meta, rerender));

    if (meta) {
      actions.appendChild(G.el('button', {
        class: 'btn btn-xs', text: '听我的',
        onclick: function () { G.Audio.play(id); }
      }));

      // 音量对齐：录音和 TTS 音量必然不一致，忽大忽小会让孩子听不清
      var slider = G.el('input', {
        class: 'gain-slider', type: 'range', min: '0.2', max: '3', step: '0.1',
        value: String(meta.gain || 1)
      });
      slider.addEventListener('input', function () {
        G.Audio.setOverride(id, meta.blob, parseFloat(slider.value));
      });
      actions.appendChild(slider);

      actions.appendChild(G.el('button', {
        class: 'btn btn-xs btn-danger', text: '删',
        onclick: function () {
          G.Audio.removeOverride(id).then(rerender);
        }
      }));
    }

    actions.appendChild(G.el('button', {
      class: 'btn btn-xs' + (muted ? ' btn-danger' : ''),
      text: muted ? '已静音' : '静音',
      onclick: function () {
        var i = save.settings.mutedAudio.indexOf(id);
        if (i >= 0) save.settings.mutedAudio.splice(i, 1);
        else save.settings.mutedAudio.push(id);
        G.Store.save(save);
        rerender();
      }
    }));

    rowEl.appendChild(actions);
    return rowEl;
  }

  function recButton(id, meta, rerender) {
    var btn = G.el('button', {
      class: 'btn btn-xs ' + (meta ? '' : 'btn-primary'),
      text: meta ? '重录' : '录一条',
      onclick: function () {
        var original = btn.textContent;
        btn.textContent = '录音中…';
        btn.disabled = true;

        G.Audio.startRecording().then(function () {
          G.UI.toast('开始录音，读完点「停止」');
          btn.textContent = '停止';
          btn.disabled = false;
          btn.onclick = function () {
            btn.disabled = true;
            G.Audio.stopRecording().then(function (blob) {
              if (!blob) { G.UI.toast('录音失败'); return; }
              G.Audio.setOverride(id, blob, 1.0).then(function () {
                G.UI.toast('已替换');
                rerender();
              });
            });
          };
        }).catch(function (e) {
          G.log('录音失败', e);
          G.UI.toast('无法录音，请检查麦克风权限');
          btn.textContent = original;
          btn.disabled = false;
        });
      }
    });
    return btn;
  }

  function buildBackupPanel(save, rerender) {
    var wrap = G.el('div', { class: 'stat-card' });

    var m = G.Store.meta();
    var days = m.lastBackupAt ? G.daysBetween(m.lastBackupAt, Date.now()) : null;
    var hint = days === null
      ? '还没有备份过。iOS 上超过 7 天不玩，进度可能被系统清掉。'
      : ('上次备份：' + (days === 0 ? '今天' : days + ' 天前'));

    wrap.appendChild(G.el('div', {
      class: 'backup-hint' + (days === null || days >= 7 ? ' backup-warn' : ''),
      text: hint
    }));

    wrap.appendChild(G.el('button', {
      class: 'btn btn-sm btn-primary', text: '导出备份',
      onclick: function () {
        G.Store.exportAll().then(function (payload) {
          var text = JSON.stringify(payload);
          var size = Math.round(text.length / 1024);
          var name = 'yxjx-backup-' + G.localDateStr() + '.json';

          // 两条路都给：iOS/微信里 <a download> 大概率不工作，剪贴板是兜底
          try {
            var blob = new Blob([text], { type: 'application/json' });
            var url = URL.createObjectURL(blob);
            var a = G.el('a', { href: url, download: name });
            document.body.appendChild(a);
            a.click();
            setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
          } catch (e) {
            G.log('下载失败', e);
          }

          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () {
              G.Store.setMeta({ lastBackupAt: Date.now() });
              G.UI.toast('已复制到剪贴板（' + size + ' KB），粘贴到微信文件传输助手保存');
              rerender();
            }).catch(function () {
              G.UI.toast('已尝试下载备份文件（' + size + ' KB）');
              rerender();
            });
          } else {
            G.UI.toast('已尝试下载备份文件（' + size + ' KB）');
            rerender();
          }
        });
      }
    }));

    var importArea = G.el('textarea', {
      class: 'gate-input import-area', placeholder: '把备份内容粘贴到这里'
    });
    wrap.appendChild(importArea);

    wrap.appendChild(G.el('button', {
      class: 'btn btn-sm', text: '从上面内容恢复',
      onclick: function () {
        var text = importArea.value.trim();
        if (!text) { G.UI.toast('请先粘贴备份内容'); return; }
        try {
          var payload = JSON.parse(text);
          G.Store.importAll(payload).then(function (r) {
            G.UI.toast('已恢复：' + r.save.points.balance + ' 分，' + r.overrides + ' 条录音');
            rerender();
          }).catch(function (e) {
            G.UI.toast('恢复失败：' + e.message);
          });
        } catch (e) {
          G.UI.toast('内容不是有效的备份（' + e.message + '）');
        }
      }
    }));

    return wrap;
  }

  /* ---------- 小工具 ---------- */

  function section(title, content) {
    return G.el('div', { class: 'p-section' }, [
      G.el('div', { class: 'p-section-title', text: title }),
      content
    ]);
  }

  function row(label, value) {
    return G.el('div', { class: 'stat-row' }, [
      G.el('span', { class: 'stat-label', text: label }),
      G.el('span', { class: 'stat-value', text: value })
    ]);
  }

  function bar(label, correct, total) {
    var pct = total ? Math.round(correct / total * 100) : 0;
    return G.el('div', { class: 'bar-row' }, [
      G.el('span', { class: 'bar-label', text: label }),
      G.el('span', { class: 'bar-track' }, [
        G.el('span', { class: 'bar-fill', style: 'width:' + pct + '%' })
      ]),
      G.el('span', { class: 'bar-pct', text: pct + '%' })
    ]);
  }

  G.Parent = {
    openGate: openGate,
    open: open,
    gateState: gateState
  };

})(window);
