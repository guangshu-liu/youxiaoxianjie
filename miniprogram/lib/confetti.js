/* confetti.js — 彩纸数据
 *
 * 网页版是 18 个随机位置的 span，全部由 CSS keyframes 下落。
 * 小程序这边只把「位置 / 延迟 / 颜色」算成数据交给 WXML，
 * 动画仍然写在 app.wxss 里 —— 逻辑和样式分开，两边都好改。
 */
var COLORS = ['#FF8A65', '#4FC3F7', '#66BB6A', '#FFB74D', '#BA68C8'];

function pieces(n) {
  var count = n || 18;
  var out = [];
  for (var i = 0; i < count; i++) {
    out.push({
      id: i,
      left: 10 + Math.round(Math.random() * 80),
      delay: (Math.random() * 0.25).toFixed(2),
      color: COLORS[i % COLORS.length]
    });
  }
  return out;
}

module.exports = { pieces: pieces };
