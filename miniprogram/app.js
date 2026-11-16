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

    // 听音题是这个游戏的核心题型，iOS 静音开关默认会把 InnerAudioContext 静音。
    // 这个全局设置必须在创建任何 InnerAudioContext **之前**调用，且只管
    // InnerAudioContext（题干语音）；sfx.js 走的 WebAudioContext 不受它保护。
    try {
      wx.setInnerAudioOption({
        obeyMuteSwitch: false,
        fail: function (res) {
          console.warn('[app] setInnerAudioOption 失败，iOS 静音时可能没声', res && res.errMsg);
        }
      });
    } catch (e) {
      console.warn('[app] 当前基础库不支持 setInnerAudioOption', e);
    }
  },

  onHide: function () {
    if (this.globalData.save) G.Store.save(this.globalData.save);
  }
});
