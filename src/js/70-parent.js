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

    /* --- 语文认字范围 --- */
    box.appendChild(section('语文认字范围', buildZibiaoPanel(save)));

    /* --- 学习数据 --- */
    box.appendChild(section('学习数据', buildStats(save)));

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

  /**
   * 识字范围面板。
   *
   * 只读，没有任何开关 —— 原来这里是「英语学到第几单元」的解锁选择，现在
   * 题库固定在小学一、二年级范围内，没有可调的东西。留下的是家长真正想看
   * 的那个问题：**哪几个字还没会**。
   */
  function buildZibiaoPanel(save) {
    var wrap = G.el('div', { class: 'stat-card' });
    var zb = G.Bank.zibiao();
    if (!zb) {
      wrap.appendChild(G.el('div', { class: 'muted', text: '字表未加载' }));
      return wrap;
    }

    wrap.appendChild(G.el('div', {
      class: 'muted',
      text: '题库共 ' + G.Bank.all().length + ' 道题（语文 ' + G.Bank.of('chinese').length +
            ' · 数学 ' + G.Bank.of('math').length + ' · 英语 ' + G.Bank.of('english').length + '）。' +
            '语文的每一个字都出自下面这张一年级字表（' + zb.chars.length + ' 字），' +
            '题干和四个选项都不会超纲。'
    }));

    // 还没掌握的字。只从「答案是一个汉字」的题里统计 —— 数笔画题的答案是
    // 数字、看字选拼音的答案是拼音，那些题对不上字，不参与。
    var shaky = {};
    save.wrongBook.forEach(function (w) {
      if (w.cleared) return;
      var q = findQuestion(w.qid);
      var ch = q && answerChar(q);
      if (!ch) return;
      shaky[ch] = (shaky[ch] || 0) + w.wrongCount;
    });

    var chars = Object.keys(shaky).sort(function (a, b) { return shaky[b] - shaky[a]; });
    if (chars.length) {
      wrap.appendChild(G.el('div', { class: 'stat-title', text: '还没巩固的字（错得最多的在前）' }));
      wrap.appendChild(G.el('div', { class: 'zi-grid' }, chars.slice(0, 24).map(function (ch) {
        return G.el('span', { class: 'zi-chip zi-chip-weak', text: ch });
      })));
      if (chars.length > 24) {
        wrap.appendChild(G.el('div', { class: 'muted', text: '还有 ' + (chars.length - 24) + ' 个，先练这些。' }));
      }
    } else if (save.wrongBook.length) {
      wrap.appendChild(G.el('div', { class: 'muted', text: '错题本里没有尚未巩固的字，继续保持。' }));
    }

    var learned = zb.chars.filter(function (c) { return !shaky[c.char]; });
    wrap.appendChild(G.el('div', {
      class: 'stat-title',
      text: '字表（' + zb.chars.length + ' 字，' + learned.length + ' 个当前没在错题本里）'
    }));
    wrap.appendChild(G.el('div', { class: 'zi-grid' }, zb.chars.map(function (c) {
      return G.el('span', {
        class: 'zi-chip' + (shaky[c.char] ? ' zi-chip-weak' : ''),
        title: c.pinyin,
        text: c.char
      });
    })));

    return wrap;
  }

  /** 取一道题的答案对应的字；答案不是单个汉字就返回 null。 */
  function answerChar(q) {
    var opts = q.options || [];
    for (var i = 0; i < opts.length; i++) {
      if (opts[i].id !== q.answer) continue;
      var t = (opts[i].text || '').trim();
      return /^[一-龥]$/.test(t) ? t : null;
    }
    return null;
  }

  function buildStats(save) {
    var wrap = G.el('div', { class: 'stat-card' });

    // 按题型统计，三科分开列（语文：归类 / 笔画…；数学：拆数 / 比大小…；
    // 英语：听音选字母 / 大小写配对…）。合在一起列的话，家长看不出到底是
    // 哪一科弱 —— 而这正是他翻到这个页面想知道的。
    G.SUBJECTS.forEach(function (s) {
      var bucket = (save.progress[s] && save.progress[s].byTag) || {};
      var tags = Object.keys(bucket);
      if (!tags.length) return;
      wrap.appendChild(G.el('div', {
        class: 'stat-title',
        text: (G.SUBJECT_LABEL[s] || s) + ' · 按题型'
      }));
      // 正确率低的排前面：家长要的是「先补哪个」
      tags.sort(function (a, b) {
        return (bucket[a].correct / bucket[a].seen) - (bucket[b].correct / bucket[b].seen);
      }).forEach(function (t) {
        wrap.appendChild(bar(t, bucket[t].correct, bucket[t].seen));
      });
    });

    // 错题本
    var wrong = save.wrongBook.filter(function (w) { return !w.cleared; })
      .sort(function (a, b) { return b.wrongCount - a.wrongCount; });
    if (wrong.length) {
      wrap.appendChild(G.el('div', { class: 'stat-title', text: '待巩固的题（' + wrong.length + '）' }));
      wrong.slice(0, 15).forEach(function (w) {
        var q = findQuestion(w.qid);
        var stemText = (q && q.stem && q.stem.text) || '';
        wrap.appendChild(G.el('div', { class: 'wrong-row' }, [
          G.el('span', { text: stemText || w.qid }),
          G.el('span', { class: 'wrong-count', text: '错 ' + w.wrongCount + ' 次' })
        ]));
      });
    }

    // 最近局
    if (save.sessions.length) {
      wrap.appendChild(G.el('div', { class: 'stat-title', text: '最近 ' + Math.min(10, save.sessions.length) + ' 局' }));
      save.sessions.slice(-10).reverse().forEach(function (s) {
        wrap.appendChild(bar(
          G.localDateStr(new Date(s.ts)).slice(5) + ' · ' + s.correct + '/' + s.total,
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
      // 用 G.Bank.all() 而不是 window.G.DATA.chinese —— 三科都要能查到。
      // 只查语文的话，错题本里每道数学题都会显示成一串 qid。
      G.Bank.all().forEach(function (q) { _qIndex[q.id] = q; });
    }
    return _qIndex[qid];
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
