/* 50-wheel.js — 转盘抽奖
 *
 * 结果先定后动画：先按权重抽出奖品，再反推指针该停在哪。
 * 反过来让动画时长或角度决定结果，会在慢设备上产生偏差。
 *
 * 一次答对 = 一次转动，转完就结算。曾经有过「再来一次」的重转机制，
 * 已经去掉：重转把一次抽奖拖成几轮，孩子盯着盘转的时间比答题还长。
 * 空奖就是空奖（G.NO_PRIZE_TEXT），不兜底、不重来。
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

  // 扇区配色。**白字压在浅色上等于没字** —— 原来 p5 是 #FFD54F（亮黄）
  // 配白字，那个扇区基本是空的。这里每个色都压到能承住白色小字的深度，
  // 六个色相仍然分得开。
  function colorFor(id) {
    return {
      tv10: '#E4572E',
      p1: '#2E9E5B',
      p2: '#2A7FD4',
      p5: '#C9860A',
      p10: '#8E44AD',
      none: '#78909C'
    }[id] || '#78909C';
  }

  /* 标签中心到盘心的半径（px）。
   * 盘面 280px、白边 9px、box-sizing:border-box → 盘内半径 131px。
   * 标签宽 72px，所以它占 76±36 = 40px ~ 112px 这一段：
   *   外沿 112 < 131，不会压到白边；内沿 40 > 中心轴半径 23，不会被轴盖住。 */
  var LABEL_R = 76;

  /**
   * 盘面上的一个奖名。
   *
   * 为什么文字要转 90° 顺着半径排，而不是横着贴：
   *   六个奖项的权重是 5/30/20/15/10/20，摊到 360° 就是 18°/108°/72°/54°/36°/72°。
   *   最宽的和最窄的差了 6 倍。横排的话，18° 那个扇区在半径 100px 处只有
   *   31px 弧长，一行放不下两个字，必然和隔壁扇区叠在一起（这正是原来
   *   「转盘上看不清奖励」的原因之一）。
   *   转成径向之后，受角度限制的只剩行高（13px），而文字长度沿半径展开，
   *   有 72px 可用 —— 每个扇区都放得下。
   *
   * 上半圈从下往上读、下半圈翻过来从上往下读，都是正的，不会倒着。
   */
  function faceLabel(s) {
    var label = G.el('span', { class: 'wheel-label', text: s.prize.face || s.prize.label });

    // 变换链从左到右依次作用：
    //   translate(-50%,-50%) 先把标签自身中心对到盘心
    //   rotate(center)       绕盘心转到本扇区的角度
    //   translateY(-R)       沿这个方向推到半径 R
    //   rotate(±90deg)       把文字转成顺着半径读
    // 前两步一起等价于「把标签放到扇区中心」，后两步是让它在那个位置上可读。
    var text = (s.center > 180) ? 90 : -90;
    label.style.transform =
      'translate(-50%, -50%) rotate(' + s.center + 'deg)' +
      ' translateY(-' + LABEL_R + 'px) rotate(' + text + 'deg)';

    return label;
  }

  /**
   * 打开转盘。返回 Promise<{prize, awarded}> —— resolve 时奖励已入账。
   *
   * @param {object} save
   */
  function open(save) {
    return new Promise(function (resolve) {
      var segments = segmentAngles();

      var overlay = G.el('div', { class: 'overlay wheel-overlay' });
      var box = G.el('div', { class: 'wheel-box' });

      box.appendChild(G.el('div', { class: 'wheel-title', text: '答对啦！转转盘 🎉' }));

      var stage = G.el('div', { class: 'wheel-stage' });
      var wheel = G.el('div', { class: 'wheel' });
      wheel.style.background = wheelBackground(segments);

      // 奖名贴在盘面上
      segments.forEach(function (s) {
        wheel.appendChild(faceLabel(s));
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

        setTimeout(function () { finish(prize); }, 3600);
      });

      function finish(prize) {
        // 空奖有专门的音效。原来不管中没中都放 ui.win ——
        // 「下次好运」配一段中奖号角，孩子会先高兴一下再发现什么都没有，
        // 比直接给个温和的下行音更让人失望。
        G.Audio.play(prize.kind === 'none' ? 'ui.lose' : 'ui.win');

        var r = G.Runner.awardPoints(save, prize.points);
        var extra = '';

        if (prize.kind === 'none') {
          resultBar.textContent = G.NO_PRIZE_TEXT;
          resultBar.className = 'wheel-result wheel-result-none';
        } else if (prize.kind === 'tv') {
          G.Runner.awardTvMinutes(save, 10);
          resultBar.textContent = prize.label + '（记得让爸爸妈妈知道哦）';
          resultBar.className = 'wheel-result wheel-result-win';
        } else {
          if (r.capped) extra = '（今天的积分已经攒满啦，明天继续！）';
          resultBar.textContent = '+' + r.awarded + ' 分 ' + extra;
          resultBar.className = 'wheel-result wheel-result-win';
        }

        G.Store.save(save);

        setTimeout(function () {
          var ok = G.el('button', { class: 'btn btn-primary', text: '继续', onclick: close });
          box.appendChild(ok);
        }, 500);

        function close() {
          overlay.classList.add('closing');
          setTimeout(function () {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            resolve({ prize: prize, awarded: r.awarded });
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
