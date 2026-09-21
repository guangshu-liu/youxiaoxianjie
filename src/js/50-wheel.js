/* 50-wheel.js — 转盘抽奖
 *
 * 结果先定后动画：先按权重抽出奖品，再反推指针该停在哪。
 * 反过来（让动画时长或角度决定结果）会在慢设备上产生偏差，也会让
 * 「再来一次」的重转逻辑变得不可控。
 */
(function (window) {
  'use strict';

  var G = window.G;

  /* ---------- 抽奖 ---------- */

  function rollPrize(rng) {
    rng = rng || Math.random;
    var total = G.sum(G.PRIZES, function (p) { return p.weight; });
    var r = rng() * total;
    for (var i = 0; i < G.PRIZES.length; i++) {
      r -= G.PRIZES[i].weight;
      if (r <= 0) return G.PRIZES[i];
    }
    return G.PRIZES[G.PRIZES.length - 1];
  }

  // 每个奖项在转盘上占的弧度（累加），用于反推指针角度
  function segmentAngles() {
    var total = G.sum(G.PRIZES, function (p) { return p.weight; });
    var acc = 0;
    return G.PRIZES.map(function (p) {
      var sweep = (p.weight / total) * 360;
      var seg = { prize: p, start: acc, sweep: sweep, center: acc + sweep / 2 };
      acc += sweep;
      return seg;
    });
  }

  /* ---------- 渲染 ---------- */

  function wheelBackground(segments) {
    var stops = segments.map(function (s) {
      var color = colorFor(s.prize.id);
      return color + ' ' + s.start + 'deg ' + (s.start + s.sweep) + 'deg';
    });
    return 'conic-gradient(from -90deg, ' + stops.join(', ') + ')';
  }

  function colorFor(id) {
    return {
      tv10: '#FF8A65',
      p1: '#81C784',
      p2: '#4FC3F7',
      p5: '#FFD54F',
      p10: '#BA68C8',
      again: '#B0BEC5'
    }[id] || '#B0BEC5';
  }

  /**
   * 打开转盘。返回 Promise<{prize, respins}> —— resolve 时奖励已入账。
   *
   * @param {object} save
   * @param {object} roundState  {respinCount}
   */
  function open(save, roundState) {
    return new Promise(function (resolve) {
      var segments = segmentAngles();
      var respins = (roundState && roundState.respinCount) || 0;
      var maxRespins = save.limits.maxRespinsPerQuestion || 3;

      var overlay = G.el('div', { class: 'overlay wheel-overlay' });
      var box = G.el('div', { class: 'wheel-box' });

      box.appendChild(G.el('div', { class: 'wheel-title', text: '答对啦！转转盘 🎉' }));

      var stage = G.el('div', { class: 'wheel-stage' });
      var wheel = G.el('div', { class: 'wheel' });
      wheel.style.background = wheelBackground(segments);

      // 奖名贴在盘面上
      segments.forEach(function (s) {
        var label = G.el('span', { class: 'wheel-label', text: s.prize.label });
        label.style.transform = 'rotate(' + s.center + 'deg) translateY(-38%)';
        wheel.appendChild(label);
      });

      var pointer = G.el('div', { class: 'wheel-pointer' });
      stage.appendChild(wheel);
      stage.appendChild(pointer);
      box.appendChild(stage);

      var resultBar = G.el('div', { class: 'wheel-result' });
      box.appendChild(resultBar);

      var spinBtn = G.el('button', { class: 'btn btn-primary btn-spin', text: '转！' });
      box.appendChild(spinBtn);

      overlay.appendChild(box);
      document.body.appendChild(overlay);

      var done = false;
      var totalRot = 0;          // 累计旋转角。必须累加而不是每次从 0 起算，
                                 // 否则第二次转动的 transition 会反向绕回来。

      spinBtn.addEventListener('click', function () {
        if (done) return;
        done = true;
        spinBtn.disabled = true;
        spinBtn.classList.add('hidden');

        var prize = rollPrize();

        // 反推落点。conic-gradient 从 -90deg 起算，即 12 点方向，
        // 所以扇区中心在 center 度处；要让它对上 12 点的指针，需顺时针转 (360 - center)。
        var want = (360 - centerDegOf(prize, segments)) % 360;
        var jitter = Math.random() * 10 - 5;                    // 散开落点，别每次都停正中
        var cur = ((totalRot % 360) + 360) % 360;
        var delta = ((want - cur) + 360) % 360 + 360 * 5;        // 至少转 5 圈
        totalRot += delta;

        wheel.style.transition = 'transform 3.4s cubic-bezier(.17,.67,.24,1)';
        wheel.style.transform = 'rotate(' + (totalRot + jitter) + 'deg)';

        G.Audio.play('ui.spin');

        setTimeout(function () { settle(prize, respins); }, 3600);
      });

      function settle(prize, respinCount) {
        if (prize.kind === 'again') {
          if (respinCount >= maxRespins) {
            // 重转次数用完 —— 给最低档奖励，不能让孩子空手而归
            finish(G.PRIZES[1], respinCount);
            return;
          }
          G.Audio.play('ui.win');
          resultBar.textContent = '再来一次！';
          resultBar.className = 'wheel-result wheel-result-again';
          setTimeout(function () {
            overlay.classList.add('closing');
            setTimeout(function () {
              if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
              resolve({ prize: prize, respins: respinCount + 1, again: true });
            }, 320);
          }, 900);
          return;
        }
        finish(prize, respinCount);
      }

      function finish(prize, respinCount) {
        G.Audio.play('ui.win');

        var r = G.Runner.awardPoints(save, prize.points);
        var extra = '';

        if (prize.kind === 'tv') {
          G.Runner.awardTvMinutes(save, 10);
          extra = '（记得让爸爸妈妈知道哦）';
        } else if (r.capped) {
          extra = '（今天的积分已经攒满啦，明天继续！）';
        }

        resultBar.textContent = prize.points > 0
          ? ('+' + r.awarded + ' 分 ' + extra)
          : (prize.label + ' ' + extra);
        resultBar.className = 'wheel-result wheel-result-win';

        G.Store.save(save);

        setTimeout(function () {
          var ok = G.el('button', { class: 'btn btn-primary', text: '继续', onclick: close });
          box.appendChild(ok);
        }, 500);

        function close() {
          overlay.classList.add('closing');
          setTimeout(function () {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            resolve({ prize: prize, respins: respinCount, awarded: r.awarded });
          }, 320);
        }
      }
    });
  }

  // 取扇区中心角（供反推落点用）
  function centerDegOf(prize, segments) {
    var seg = segments.filter(function (s) { return s.prize.id === prize.id; })[0];
    return seg ? seg.center : 0;
  }

  /* ---------- 自检用：分布验证 ---------- */

  function simulate(n) {
    var counts = {};
    G.PRIZES.forEach(function (p) { counts[p.id] = 0; });
    for (var i = 0; i < n; i++) counts[rollPrize().id]++;
    return G.PRIZES.map(function (p) {
      var actual = counts[p.id] / n * 100;
      return {
        id: p.id,
        declared: p.weight,
        actual: +actual.toFixed(2),
        delta: +(actual - p.weight).toFixed(2)
      };
    });
  }

  G.Wheel = {
    rollPrize: rollPrize,
    open: open,
    simulate: simulate,
    _segments: segmentAngles,
    _centerDegOf: centerDegOf
  };

})(window);
