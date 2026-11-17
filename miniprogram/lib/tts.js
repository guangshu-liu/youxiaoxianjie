/* tts.js — 题干朗读（微信同声传译插件 WechatSI）
 *
 * 只朗读题干，不朗读选项。规则（拼音题换说法、算式换中文读法）在
 * generated/lib/game.js 的 G.TTSText 里，和网页版是同一份文件。
 *
 * 为什么不预生成音频：600 道题去重后有 375 条不同题干，中文短句约
 * 3 MB，小程序主包上限 2 MB，现在包已经 1.1 MB。插件合成走网络、
 * 零包体积，代价是断网时读题不可用（英文单词音频是包内文件，不受影响）。
 *
 * 插件未授权 / 低版本基础库 / 无网络时**静默降级**：available() 返回
 * false，play 页不显示读题喇叭，原有听音题音频和答题流程完全不受影响。
 */
var plugin = null;
try {
  if (typeof requirePlugin === 'function') plugin = requirePlugin('WechatSI');
} catch (e) {
  plugin = null;
}

var current = null;
var timer = null;
var warned = false;
var seq = 0;                 // 丢弃「已经切题才返回的」合成结果

function available() {
  return !!(plugin && plugin.textToSpeech);
}

function release(ctx) {
  if (current === ctx) current = null;
  try { ctx.destroy(); } catch (e) { /* 已经销毁过 */ }
}

function stop() {
  if (timer) { clearTimeout(timer); timer = null; }
  seq++;
  if (current) {
    try { current.stop(); } catch (e) {}
    release(current);
  }
}

function speak(text) {
  if (!text || !available()) return false;
  stop();
  var mySeq = seq;

  try {
    plugin.textToSpeech({
      lang: 'zh_CN',
      tts: true,
      content: text,
      success: function (res) {
        if (mySeq !== seq) return;      // 慢网络：孩子已经翻到下一题了
        var ctx = wx.createInnerAudioContext();
        current = ctx;
        // app.js 已全局设过 obeyMuteSwitch:false；这里再设一次是给
        // 插件返回的临时文件兜底，iOS 拨静音时别让题目变哑巴。
        try { ctx.obeyMuteSwitch = false; } catch (e) {}
        ctx.src = res && res.filename;
        ctx.onEnded(function () { release(ctx); });
        ctx.onError(function (r) {
          console.warn('[tts] 播放失败', r && r.errMsg);
          release(ctx);
        });
        ctx.play();
      },
      fail: function (err) {
        console.warn('[tts] 合成失败', err && (err.errMsg || err.msg));
        // 每道题都弹 toast 会吵，只提示第一次；点喇叭仍可重试。
        if (!warned) {
          warned = true;
          try {
            wx.showToast({ title: '朗读暂不可用，点喇叭可重试', icon: 'none', duration: 2400 });
          } catch (e) {}
        }
      }
    });
    return true;
  } catch (e) {
    console.warn('[tts] 插件调用异常', e);
    return false;
  }
}

/** 进题后延迟一小会儿再念，让画面先出来（和听音题的 350ms 一致）。 */
function schedule(text, ms) {
  stop();
  timer = setTimeout(function () {
    timer = null;
    speak(text);
  }, ms || 350);
}

module.exports = {
  available: available,
  speak: speak,
  stop: stop,
  schedule: schedule
};
