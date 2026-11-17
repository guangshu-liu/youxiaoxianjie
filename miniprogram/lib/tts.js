/* tts.js — 题干朗读（主包内预生成音频）
 *
 * 只朗读题干，不朗读选项。规则（拼音题换说法、算式题不念、英语混排换
 * 纯中文提示）在 generated/lib/game.js 的 G.TTSText 里，和网页版是同一份
 * 文件；音频由 tools/gen_tts_audio.py 按那份规则生成，映射在 tts-map.js。
 *
 * 为什么不用微信同声传译插件：那个插件只对企业主体小程序开放，本项目是
 * 个人主体，后台添加插件也过不了 80082 校验；而且只要 app.json 声明了
 * 插件，未授权时连模拟器都启动不了。
 *
 * 为什么不用分包：「主包不能直接引用分包资源」。1.2.6 把音频放在 pkgTts
 * 分包、播放器留在主包，真机上 InnerAudioContext 拿不到分包路径，表现为
 * 「读题喇叭在、一点声音都没有」。现在 171 条音频剥掉 afconvert 的 free
 * 填充块后只有 0.97 MB，直接放主包 ttsAudio/，与英文单词音频走同一条
 * 已验证可播的路径；不联网、不预下载、不需要任何后台配置。
 *
 * 也刻意不再用 wx.loadSubpackage：一旦 success/fail 没回调，loading 会永远
 * 为 true，所有朗读请求排队但一句都不播 —— 这正是上一版「无声」的第二个
 * 隐患。现在没有异步前置条件，进题即播。
 */
var MAP = require('../generated/data/tts-map.js');

var current = null;
var timer = null;
var seq = 0;                // 丢弃「已经切题才返回的」播放请求
var warned = false;

function has(text) {
  return !!(text && MAP[text]);
}

/** play 页用它决定要不要画读题喇叭。主包内文件一定在，不再有就绪状态。 */
function available() {
  return Object.keys(MAP).length > 0;
}

/** 保留这个接口给 app.js / 测试调用；现在无需预热，什么都不用做。 */
function prepare() {}

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

function warnOnce(msg) {
  console.warn('[tts] ' + msg);
  if (warned) return;
  warned = true;
  try {
    wx.showToast({ title: '读题音频加载失败', icon: 'none', duration: 2400 });
  } catch (e) {}
}

function playNow(text, mySeq) {
  if (mySeq !== seq || !has(text)) return false;
  var src = MAP[text];
  try {
    var ctx = wx.createInnerAudioContext();
    current = ctx;
    // app.js 已全局设过 obeyMuteSwitch:false；这里再设一次兜底，
    // iOS 拨静音时别让题目变哑巴。
    try { ctx.obeyMuteSwitch = false; } catch (e) {}
    ctx.src = src;
    ctx.onPlay(function () { console.log('[tts] 播放开始', src); });
    ctx.onEnded(function () { release(ctx); });
    ctx.onError(function (r) {
      console.warn('[tts] 播放失败', src, r && (r.errMsg || r.errCode));
      warnOnce('读题音频加载失败，请检查 /ttsAudio/ 路径');
      release(ctx);
    });
    ctx.play();
    return true;
  } catch (e) {
    console.warn('[tts] 创建播放器异常', e);
    warnOnce('无法创建播放器');
    return false;
  }
}

function speak(text) {
  if (!has(text)) return false;
  stop();
  return playNow(text, seq);
}

/** 进题后延迟一小会儿再念，让画面先出来（和听音题的 350ms 一致）。 */
function schedule(text, ms) {
  stop();
  var mySeq = seq;
  timer = setTimeout(function () {
    timer = null;
    if (mySeq !== seq) return;
    speak(text);
  }, ms || 350);
}

module.exports = {
  available: available,
  has: has,
  prepare: prepare,
  speak: speak,
  stop: stop,
  schedule: schedule
};
