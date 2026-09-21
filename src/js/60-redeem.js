/* 60-redeem.js — 积分兑换 + 日/周上限
 *
 * 兑换走「家长确认」而不是自动生效。这不是防作弊，是防冲突 ——
 * 钱和屏幕时间的兑现本来就发生在物理世界。而且孩子看到 pending
 * 比看到「兑换成功」更符合真实体验（要等爸妈同意）。
 */
(function (window) {
  'use strict';

  var G = window.G;

  function rewardById(id) {
    return G.REWARDS.filter(function (r) { return r.id === id; })[0] || null;
  }

  function countThisWeek(save) {
    var start = G.weekStartStr();
    return save.redemptions.filter(function (r) {
      if (r.status === 'rejected') return false;
      return G.localDateStr(new Date(r.ts)) >= start;
    }).length;
  }

  function pendingList(save) {
    return save.redemptions.filter(function (r) { return r.status === 'pending'; });
  }

  /**
   * 能不能兑换。返回 {ok, why}。why 的文案是直接给孩子看的，要温和。
   *
   * reward 可以是对象也可以是 id —— request() 收 id，要是这里只收对象，
   * 调用方就得记住两套约定，传错了不会报错、只会静默放行（reward.cost 是
   * undefined，所有金额比较都为 false）。这种失败方式最难查，所以在入口归一化。
   */
  function canRedeem(save, reward) {
    var lim = save.limits;

    if (typeof reward === 'string') reward = rewardById(reward);
    if (!reward) return { ok: false, why: '没有这个奖励' };

    if (save.integrity.clockTampered) {
      return { ok: false, why: '需要爸爸妈妈确认一下才能兑换哦' };
    }
    if (save.points.balance < reward.cost) {
      return { ok: false, why: '还差 ' + (reward.cost - save.points.balance) + ' 分，继续加油！' };
    }

    var dc = G.Store.todayCounter(save);

    if (dc.redemptions >= lim.maxRedemptionsPerDay) {
      return { ok: false, why: '今天已经兑换过啦，明天再来' };
    }
    if (countThisWeek(save) >= lim.maxRedemptionsPerWeek) {
      return { ok: false, why: '这周兑换次数用完啦' };
    }
    // 转盘免费送的 tv10 和这里兑换的是同一份「动画片时间」，家长关心的是总时长。
    // 漏了这条，孩子一天抽中 4 次就能看 40 分钟。
    if (reward.id === 'tv10' && dc.tvMinutes + 10 > lim.maxTvMinutesPerDay) {
      return { ok: false, why: '今天动画片时间已经用完啦' };
    }

    return { ok: true };
  }

  /**
   * 发起兑换 → 生成 pending 记录。积分此时不扣，等家长批准才扣。
   */
  function request(save, rewardId) {
    var reward = rewardById(rewardId);
    if (!reward) return { ok: false, why: '没有这个奖励' };

    var check = canRedeem(save, reward);
    if (!check.ok) return check;

    var rec = {
      id: 'r_' + Date.now(),
      ts: Date.now(),
      cost: reward.cost,
      reward: reward.id,
      rewardLabel: reward.label,
      status: 'pending',
      requestedAt: Date.now(),
      decidedAt: null
    };
    save.redemptions.push(rec);
    G.Store.save(save);

    G.log('兑换申请已提交', rec.id);
    return { ok: true, record: rec };
  }

  /**
   * 家长批准。此时才真正扣分 —— 这样孩子单方面改余额也没用，
   * 因为家长面板里的 lifetime/balance 审计会立刻对不上账。
   */
  function approve(save, redemptionId) {
    var rec = save.redemptions.filter(function (r) { return r.id === redemptionId; })[0];
    if (!rec || rec.status !== 'pending') return { ok: false, why: '记录不存在或已处理' };

    if (save.points.balance < rec.cost) {
      return { ok: false, why: '积分不足（余额 ' + save.points.balance + '，需要 ' + rec.cost + '）' };
    }

    save.points.balance -= rec.cost;
    rec.status = 'approved';
    rec.decidedAt = Date.now();

    var dc = G.Store.todayCounter(save);
    dc.redemptions += 1;
    if (rec.reward === 'tv10') dc.tvMinutes += 10;

    G.Store.save(save);
    return { ok: true, record: rec };
  }

  function reject(save, redemptionId) {
    var rec = save.redemptions.filter(function (r) { return r.id === redemptionId; })[0];
    if (!rec || rec.status !== 'pending') return { ok: false, why: '记录不存在或已处理' };

    rec.status = 'rejected';
    rec.decidedAt = Date.now();
    G.Store.save(save);
    return { ok: true, record: rec };
  }

  /* ---------- 界面 ---------- */

  function openScreen(save, onClose) {
    var overlay = G.el('div', { class: 'overlay' });
    var box = G.el('div', { class: 'panel' });

    box.appendChild(G.el('div', { class: 'panel-title', text: '我的奖励' }));
    box.appendChild(G.el('div', {
      class: 'points-big',
      text: save.points.balance + ' 分'
    }));

    var list = G.el('div', { class: 'reward-list' });
    G.REWARDS.forEach(function (r) {
      var check = canRedeem(save, r);
      var btn = G.el('button', {
        class: 'reward-card' + (check.ok ? '' : ' disabled'),
        onclick: function () {
          if (!check.ok) { G.UI.toast(check.why); return; }
          var res = request(save, r.id);
          if (res.ok) {
            G.UI.toast('已告诉爸爸妈妈啦！');
            G.Audio.play('ui.win');
            refresh();
          } else {
            G.UI.toast(res.why);
          }
        }
      }, [
        G.el('span', { class: 'reward-emoji', text: r.emoji }),
        G.el('div', { class: 'reward-info' }, [
          G.el('div', { class: 'reward-label', text: r.label }),
          G.el('div', { class: 'reward-cost', text: r.cost + ' 分' })
        ]),
        G.el('span', { class: 'reward-state', text: check.ok ? '可兑换' : '' })
      ]);
      list.appendChild(btn);
    });
    box.appendChild(list);

    var pending = pendingList(save);
    if (pending.length) {
      var pbox = G.el('div', { class: 'pending-box' });
      pbox.appendChild(G.el('div', { class: 'pending-title', text: '等爸爸妈妈确认' }));
      pending.forEach(function (p) {
        pbox.appendChild(G.el('div', {
          class: 'pending-item',
          text: p.rewardLabel + '（' + p.cost + ' 分）'
        }));
      });
      box.appendChild(pbox);
    }

    var limits = G.el('div', { class: 'limits-hint', text:
      '今天还能兑换 ' + Math.max(0, save.limits.maxRedemptionsPerDay - G.Store.todayCounter(save).redemptions) + ' 次 · ' +
      '这周还能 ' + Math.max(0, save.limits.maxRedemptionsPerWeek - countThisWeek(save)) + ' 次' });
    box.appendChild(limits);

    box.appendChild(G.el('button', {
      class: 'btn btn-ghost', text: '关闭',
      onclick: function () {
        overlay.classList.add('closing');
        setTimeout(function () {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
          if (onClose) onClose();
        }, 260);
      }
    }));

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    function refresh() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      openScreen(save, onClose);
    }
  }

  G.Redeem = {
    rewardById: rewardById,
    canRedeem: canRedeem,
    countThisWeek: countThisWeek,
    pendingList: pendingList,
    request: request,
    approve: approve,
    reject: reject,
    openScreen: openScreen
  };

})(window);
