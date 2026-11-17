/* tts.js — 题干朗读（分包内预生成音频）
 *
 * 只朗读题干，不朗读选项。规则（拼音题换说法、算式题不念、英语混排换
 * 纯中文提示）在 generated/lib/game.js 的 G.TTSText 里，和网页版是同一份
 * 文件；音频由 tools/gen_tts_audio.py 按那份规则生成，映射在 tts-map.js。
 *
 * 为什么不用微信同声传译插件：那个插件只对企业主体小程序开放，本项目是
 * 个人主体，后台添加插件也过不了 80082 校验；而且只要 app.json 声明了
 * 插件，未授权时连模拟器都启动不了。所以改成构建时预生成 171 条中文
 * 短句（约 1.46 MB），放进 pkgTts 分包，零后台配置、断网可用。
 *
 * 分包首次使用要下载，启动时由 app.js 调 prepare() 后台预载；还没下完
 * 就进题的话请求会排队，下完再播（并用 seq 丢掉已经翻页的那一句）。
 * 下载失败会安静隐藏读题喇叭，原有英文单词音频和答题流程完全不受影响。
 */
var MAP = require('../generated/data/tts-map.js');

var ready = false;          // 分包已加载
var loading = false;        // 正在下载
var waiters = [];           // 下载期间排队的 [text, seq]
var current = null;
var timer = null;
var seq = 0;                // 丢弃「已经切题才返回的」播放请求
var warned = false;

function has(text) {
  return !!(text && MAP[text]);
}

/** play 页用它决定要不要画读题喇叭；下载彻底失败后返回 false。 */
function available() {
  return (ready || loading) && Object.keys(MAP).length > 0;
}

function release(ctx) {
  if (current === ctx) current = null;
  try { ctx.destroy(); } catch (e) { /* 已经销毁过 */ }
}

function stop() {
  if (timer) { clearTimeout(timer); timer = null; }
  seq++;
  waiters.length = 0;       // 切题时，排队中的旧题干一律作废
  if (current) {
    try { current.stop(); } catch (e) {}
    release(current);
  }
}

function playNow(text, mySeq) {
  if (mySeq !== seq || !has(text)) return false;
  try {
    var ctx = wx.createInnerAudioContext();
    current = ctx;
    // app.js 已全局设过 obeyMuteSwitch:false；这里再设一次兜底，
    // iOS 拨静音时别让题目变哑巴。
    try { ctx.obeyMuteSwitch = false; } catch (e) {}
    ctx.src = MAP[text];
    ctx.onEnded(function () { release(ctx); });
    ctx.onError(function (r) {
      console.warn('[tts] 播放失败', MAP[text], r && r.errMsg);
      release(ctx);
    });
    ctx.play();
    return true;
  } catch (e) {
    console.warn('[tts] 创建播放器异常', e);
    return false;
  }
}

function finish(okFlag, err) {
  loading = false;
  ready = !!okFlag;
  var list = waiters.slice();
  waiters.length = 0;
  if (ready) {
    for (var i = 0; i < list.length; i++) playNow(list[i][0], list[i][1]);
  } else {
    console.warn('[tts] 分包加载失败', err && (err.errMsg || err.msg));
    if (!warned) {
      warned = true;
      try {
        wx.showToast({ title: '读题音频未就绪，稍后重试', icon: 'none', duration: 2400 });
      } catch (e) {}
    }
  }
}

/** 启动时调一次，后台预下载分包。家长开关关掉也照下，随时能打开。 */
function prepare() {
  if (ready || loading) return;
  if (typeof wx === 'undefined' || typeof wx.loadSubpackage !== 'function') {
    // 低版本基础库没有预下载接口，包内路径仍可直接播，当作就绪。
    ready = true;
    return;
  }
  loading = true;
  try {
    wx.loadSubpackage({
      name: 'tts',
      success: function () { finish(true); },
      fail: function (err) { finish(false, err); }
    });
  } catch (e) {
    finish(false, e);
  }
}

function speak(text) {
  if (!has(text)) return false;
  stop();
  var mySeq = seq;

  if (ready) return playNow(text, mySeq);
  if (loading) { waiters.push([text, mySeq]); return true; }

  // 之前下载失败过：再试一次，这次成功就接着播。
  prepare();
  if (loading) { waiters.push([text, mySeq]); return true; }
  return false;
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
