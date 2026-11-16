/* app.js — 启动：装配逻辑层、加载存档
 *
 * 启动顺序照抄网页版 src/js/90-main.js 的 boot()：
 *   applyMix → Store.load → Bank.init → bootId++ → checkClock → save
 *
 * applyMix 必须在 Store.load 之前：一局的题数 G.ROUND_SIZE 由配比推出来，
 * 顺序反了的话，第一次进入的那一局会用兜底配比。
 */
var G = require('./generated/lib/game.js');
var bank = require('./generated/data/bank.js');
var audio = require('./lib/audio.js');

App({
  globalData: {
    G: G,
    save: null,
    // play 页结算后放这里，result 页只负责显示。
    // 结算不能放在 result 的 onLoad 里 —— 那个页面可能被重新进入。
    lastResult: null
  },

  onLaunch: function () {
    G.applyMix(bank.mix);

    var save = G.Store.load();
    G.Bank.init(bank);

    // 覆盖构建产物里的存根。必须在 Store.load 之后、任何备份操作之前。
    G.Audio = audio;

    save.integrity.bootId = (save.integrity.bootId || 0) + 1;
    G.Store.checkClock(save);
    G.Store.save(save);

    this.globalData.save = save;

    // 听音题是这个游戏的核心题型，iOS 的静音开关会把整个游戏变成哑的。
    // 网页版走 Web Audio 不受静音开关影响，这里对齐同样的行为。
    try {
      wx.setInnerAudioOption({ obeyMuteSwitch: false });
    } catch (e) { /* 低版本基础库没有这个 API，忽略 */ }
  },

  onHide: function () {
    if (this.globalData.save) G.Store.save(this.globalData.save);
  }
});
