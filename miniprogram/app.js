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
var progress = require('./lib/progress.js');

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

    // 1.2.21：sessions 只留 30 条。老存档升级时先把窗口值固化成累计计数器
    // 起点，否则第一局若是复习局，地图还会倒退一次。必须在下面 save()
    // 之前做，让它一起落盘；新存档三科都是 0，无副作用。
    progress.ensureRounds(save);

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

    // 题干朗读音频在主包 ttsAudio/ 里，随小程序一起下载，无需预热。
    // 和英文单词音频走同一条 InnerAudioContext 路径，断网也能播。

    // 1.2.25：正式版的新代码包是微信异步下发的，界面里又不显示版本号。
    // 没有这段时用户可能一直跑着旧包，把「开发版和正式版长得不一样」
    // 当成 bug。新包下载完只弹一次：点「立即重启」才 applyUpdate，
    // 点「稍后再说」不打断正在答的题（下次冷启动微信自己也会换包）。
    // 下载失败要给一条能自己操作的出路，否则用户只能干等。
    // 低版本基础库和部分开发者工具环境没有这个 API，整段做能力检测 + try，
    // 且放在启动主链路最后 —— 就算它抛错，存档和音频设置也已经完成。
    try {
      if (typeof wx.getUpdateManager === 'function') {
        var updateManager = wx.getUpdateManager();
        if (updateManager) {
          updateManager.onCheckForUpdate(function (res) {
            console.info('[app] 版本检查：' + (res && res.hasUpdate ? '发现新版本' : '已是最新'));
          });
          updateManager.onUpdateReady(function () {
            wx.showModal({
              title: '发现新版本',
              content: '新版本已经下载好啦，重启后就能用上。',
              confirmText: '立即重启',
              cancelText: '稍后再说',
              success: function (r) {
                if (r && r.confirm) updateManager.applyUpdate();
              }
            });
          });
          updateManager.onUpdateFailed(function () {
            wx.showModal({
              title: '更新没成功',
              content: '请删掉这个小程序，重新搜索进入一次，就能用上最新版。',
              showCancel: false,
              confirmText: '知道了'
            });
          });
        }
      }
    } catch (e) {
      console.warn('[app] 版本更新检查不可用', e);
    }
  },

  onHide: function () {
    if (this.globalData.save) G.Store.save(this.globalData.save);
  }
});
