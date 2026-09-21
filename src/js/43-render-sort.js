/* 43-render-sort.js — 词族归类题
 *
 * 交互用「点选 → 点筐」而不是拖拽。6 岁孩子在手机上拖拽命中率很低，
 * 拖到一半掉了会很挫败。点选式容错高得多。
 *
 * passRatio：sort 占一题的槽位但含 4 次判断，全对才算对太苛刻 ——
 * 会打击积极性，也扭曲难度统计。
 */
(function (window) {
  'use strict';

  var G = window.G;

  G.Renderers = G.Renderers || {};

  G.Renderers.sort = function (container, q, handlers) {
    var answered = false;
    var selected = null;
    var placed = {};                       // { itemId: bucketId }
    var buckets = q.buckets || [];
    var items = q.items || [];
    var passRatio = q.passRatio === undefined ? 0.75 : q.passRatio;

    var root = G.el('div', { class: 'q q-sort' });
    root.appendChild(G.el('div', { class: 'stem-hint', text: q.stem.prompt || '把单词放进正确的筐子' }));

    // ---- 待归类的词 ----
    var tray = G.el('div', { class: 'sort-tray' });
    var itemEls = {};

    items.forEach(function (item) {
      var el = G.el('button', {
        class: 'sort-item',
        onclick: function () { selectItem(item.id, el); }
      }, [G.el('span', { text: item.text })]);
      itemEls[item.id] = el;
      tray.appendChild(el);
    });
    root.appendChild(tray);

    // ---- 筐子 ----
    var bucketRow = G.el('div', { class: 'sort-buckets' });
    var bucketEls = {};

    buckets.forEach(function (b) {
      var drop = G.el('div', { class: 'sort-drop' });
      var el = G.el('button', {
        class: 'sort-bucket',
        style: b.color ? ('--bucket-color:' + b.color) : null,
        onclick: function () { placeInto(b.id); }
      }, [
        G.el('span', { class: 'bucket-label', text: b.label }),
        drop
      ]);
      bucketEls[b.id] = { el: el, drop: drop };
      bucketRow.appendChild(el);
    });
    root.appendChild(bucketRow);

    root.appendChild(G.el('div', { class: 'stem-hint stem-hint-sm', text: '点一个词，再点一个筐子' }));
    container.appendChild(root);

    function selectItem(id, el) {
      if (answered) return;
      if (placed[id]) return;                  // 已放好的不能再选

      Object.keys(itemEls).forEach(function (k) { itemEls[k].classList.remove('selected'); });
      selected = id;
      el.classList.add('selected');

      var item = items.filter(function (i) { return i.id === id; })[0];
      if (item && item.audio && G.Audio.has(item.audio.replace(/\.mp3$/, '').replace(/\//g, '.'))) {
        G.Audio.play(item.audio.replace(/\.mp3$/, '').replace(/\//g, '.'));
      }
    }

    function placeInto(bucketId) {
      if (answered || !selected) return;

      var id = selected;
      placed[id] = bucketId;

      var el = itemEls[id];
      el.classList.remove('selected');
      el.classList.add('placed');
      bucketEls[bucketId].drop.appendChild(el);

      selected = null;
      if (Object.keys(placed).length === items.length) setTimeout(check, 320);
    }

    function check() {
      if (answered) return;
      answered = true;

      var right = 0;
      items.forEach(function (item) {
        var ok = placed[item.id] === item.bucket;
        if (ok) right++;
        var el = itemEls[item.id];
        el.classList.add(ok ? 'item-ok' : 'item-bad');
      });

      var ratio = right / items.length;
      var passed = ratio >= passRatio;

      // 错的词把正确归处标出来
      if (!passed) {
        items.forEach(function (item) {
          if (placed[item.id] !== item.bucket) {
            bucketEls[item.bucket].el.classList.add('bucket-hint');
          }
        });
        showExplain(q.explain || ('对了 ' + right + ' 个，再仔细看看尾音。'));
      } else {
        G.UI.confetti(container);
      }

      G.log('sort 结果', right + '/' + items.length, '通过 =', passed);
      setTimeout(function () { handlers.onAnswer(passed); }, passed ? 800 : 1900);
    }

    function showExplain(text) {
      if (!text) return;
      root.appendChild(G.el('div', { class: 'explain', text: text }));
    }

    return { destroy: function () {} };
  };

})(window);
