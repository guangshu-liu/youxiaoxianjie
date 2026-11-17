#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_miniprogram.py — 生成微信小程序需要的四类产物。

    miniprogram/generated/lib/game.js     纯逻辑（浏览器版五个纯逻辑文件拼成）
    miniprogram/generated/data/bank.js    题库 + 字表 + 配比
    miniprogram/generated/data/audio.js   音频 id → 包内绝对路径
    miniprogram/generated/audio/en/*.m4a  音频文件

**为什么不复制一份逻辑**：网页版的 00-core / 10-store / 22-tts-text /
30-bank / 40-runner 全都写成 `(function (window) { ... })(window)`，只依赖 `window.G`。给一个同名
垫片就能原样跑，于是两端的抽样、组局、错题加权、存档迁移永远是同一份实现 ——
网页版改了，小程序重新构建就跟着变。

垫片必须同时提供裸全局和 `window.*`：`00-core.js` 里两种写法都有
（`navigator.userAgent` 和 `window.navigator.standalone`）。少挂一个不是
「某个功能坏了」，是 App 启动直接抛 TypeError。

产物都带「不要手改」标记，并写进 .gitignore —— 它们是派生物，改的是 src/。

用法：
    python3 tools/build_miniprogram.py            # 生成
    python3 tools/build_miniprogram.py --check    # 只校验产物是否与源一致
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from build import ROOT, SRC, AUDIO, SUBJECT_MIX  # noqa: E402

MP = os.path.join(ROOT, 'miniprogram')
GEN = os.path.join(MP, 'generated')
DATA = os.path.join(SRC, 'data')

# 参与拼接的四个纯逻辑文件，顺序就是加载顺序：
#   00 定义 G 的常量和工具 → 10 用 G.LIMITS → 30/40 用 G.SUBJECTS / G.DEFAULT_MIX
# 界面层（05/41/50/60/70/90）不进来 —— 小程序用 WXML 重写。
# 音频（20/21）也不进来 —— 浏览器的 Web Audio + IndexedDB 录音在小程序里没有对应物。
LOGIC_FILES = [
    '00-core.js',
    '10-store.js',
    '22-tts-text.js',   # 「题干该念成什么」的纯规则，网页版共用同一份
    '30-bank.js',
    '40-runner.js'
]

PRELUDE = r"""/* ============================================================================
 * 由 tools/build_miniprogram.py 生成，不要手改。
 *
 * 下面五个文件是网页版的纯逻辑，原样搬过来。它们都写成
 *     (function (window) { ... })(window)
 * 只依赖 window.G，所以给一个同名垫片就能跑。
 *
 * 垫片必须**同时**提供裸全局和 window.*：
 *   navigator.userAgent          （裸，00-core.js:202）
 *   window.navigator.standalone  （带前缀，00-core.js:207）
 *   window.localStorage          （带前缀，00-core.js:213）
 * 少挂任何一个都不是「某个功能坏了」，是 App 启动时直接抛 TypeError。
 * ========================================================================== */

var window = {};

var navigator = {
  // 带 iPhone + MicroMessenger 的 UA：G.env.isIOS / isWeChat 都会是 true，
  // 和真机一致。写 'MicroMessenger' 一个词的话 isIOS 会是 false。
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
             'AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0',
  platform: 'iPhone',
  maxTouchPoints: 5,
  standalone: false
};

var location = { protocol: 'https:', search: '', href: '' };

function matchMedia() {
  return { matches: false, addListener: function () {}, addEventListener: function () {} };
}

// localStorage 的语义这里必须保住：取不到时返回 null，不是 ''。
// 10-store.js 的 safeParse 依赖这个区别。
var localStorage = {
  getItem: function (k) {
    var v = wx.getStorageSync(k);
    return (v === '' || v === null || v === undefined) ? null : String(v);
  },
  setItem: function (k, v) { wx.setStorageSync(k, String(v)); },
  removeItem: function (k) { wx.removeStorageSync(k); }
};

window.navigator = navigator;
window.location = location;
window.matchMedia = matchMedia;
window.localStorage = localStorage;

"""

EPILOGUE = r"""
/* ============================================================================
 * 垫片收尾
 * ========================================================================== */

(function (G) {
  'use strict';

  // 10-store.js 在存档损坏、写失败时会调用这两个 —— 它们原本在 05-ui.js，
  // 而 05 是 DOM 层，没有搬过来。不补的话是「存储满了」这种最需要告诉用户的
  // 场景反而静默失败。
  G.toast = function (msg) {
    try { wx.showToast({ title: String(msg), icon: 'none', duration: 2400 }); } catch (e) {}
  };
  G.banner = function (msg) { G.toast(msg); };

  // 真实的播放器在 lib/audio.js，由 app.js 启动时覆盖掉这个存根。
  // 必须先有存根：Store.exportAll() 同步调用 dumpOverrides()，
  // Store.importAll() 调用 loadOverrides()，而备份按钮可能在音频模块
  // 初始化之前就被点到。
  G.Audio = {
    dumpOverrides: function () { return Promise.resolve([]); },
    loadOverrides: function () { return Promise.resolve(0); }
  };

  module.exports = G;
})(window.G);
"""


# ---------------------------------------------------------------- 生成

def read(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()


def build_game_js():
    parts = [PRELUDE]
    for name in LOGIC_FILES:
        path = os.path.join(SRC, 'js', name)
        parts.append('/* ===== %s ===== */\n' % name)
        parts.append(read(path))
        parts.append('\n')
    parts.append(EPILOGUE)
    return ''.join(parts)


def load_json(name, root=None):
    path = os.path.join(root or DATA, name)
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def build_bank_js():
    """题库 + 字表 + 配比。

    mix 必须一起带上：它是「一局三科各出几道」的唯一真相源（来自
    build.py 的 SUBJECT_MIX）。漏了的话 G.applyMix(undefined) 会静默退回
    兜底值，页面照样能玩，只是配比从「配置的」变成了「碰巧一样的默认值」。

    zibiao 是家长面板里「认字范围」那张表，漏了那块会空。
    """
    data = {
        'chinese': load_json('chinese.json'),
        'math': load_json('math.json'),
        'english': load_json('english.json'),
        'zibiao': load_json('zi_grade1.json'),
        'mix': SUBJECT_MIX,
    }
    return ('/* 由 tools/build_miniprogram.py 生成，不要手改。 */\n'
            'module.exports = %s;\n'
            % json.dumps(data, ensure_ascii=False, separators=(',', ':')))


def build_audio_js():
    """音频 id → 包内绝对路径。

    路径从 tools/audio_manifest.json 读，不拿 id 硬拼 —— id 和文件路径的
    对应关系由 gen_audio.py 定义（`en.ant` → `en/ant.m4a`），这里再猜一次
    就会有两份规则。
    """
    manifest = load_json('audio_manifest.json', root=os.path.join(ROOT, 'tools'))
    mapping = {}
    for aid, entry in sorted(manifest.get('entries', {}).items()):
        mapping[aid] = '/generated/audio/' + entry['path']
    return ('/* 由 tools/build_miniprogram.py 生成，不要手改。 */\n'
            'module.exports = %s;\n'
            % json.dumps(mapping, ensure_ascii=False, separators=(',', ':')))


def expected_outputs():
    return {
        os.path.join(GEN, 'lib', 'game.js'): build_game_js(),
        os.path.join(GEN, 'data', 'bank.js'): build_bank_js(),
        os.path.join(GEN, 'data', 'audio.js'): build_audio_js(),
    }


def expected_audio():
    """包里应该存在的音频相对路径列表（相对 audio/）。"""
    manifest = load_json('audio_manifest.json', root=os.path.join(ROOT, 'tools'))
    return sorted(e['path'] for e in manifest.get('entries', {}).values())


# ---------------------------------------------------------------- 写盘

def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)


def copy_audio():
    paths = expected_audio()
    for rel in paths:
        src = os.path.join(AUDIO, rel)
        if not os.path.exists(src):
            raise SystemExit('❌ 缺少音频 %s，先跑 python3 tools/gen_audio.py'
                             % os.path.relpath(src, ROOT))
        dest = os.path.join(GEN, 'audio', rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(src, 'rb') as f:
            blob = f.read()
        with open(dest, 'wb') as f:
            f.write(blob)

    # 清掉不再被引用的音频（换了词表之后旧文件会留下）
    keep = set(os.path.normpath(p) for p in paths)
    audio_root = os.path.join(GEN, 'audio')
    if os.path.isdir(audio_root):
        for dirpath, _dirnames, filenames in os.walk(audio_root):
            for name in filenames:
                full = os.path.join(dirpath, name)
                if os.path.normpath(os.path.relpath(full, audio_root)) not in keep:
                    os.remove(full)
        for dirpath, _dirnames, _filenames in os.walk(audio_root, topdown=False):
            if dirpath != audio_root and not os.listdir(dirpath):
                os.rmdir(dirpath)
    return len(paths)


def build():
    outs = expected_outputs()
    for path, text in outs.items():
        write(path, text)
    n = copy_audio()

    print('')
    print('小程序产物已生成')
    print('=' * 44)
    for path in sorted(outs):
        print('  %-34s %6.1f KB'
              % (os.path.relpath(path, ROOT), os.path.getsize(path) / 1024))
    print('  %-34s %3d 个'
          % (os.path.relpath(os.path.join(GEN, 'audio'), ROOT), n))
    print('')
    print('  下一步：用微信开发者工具打开 %s/' % os.path.relpath(MP, ROOT))
    print('')
    return 0


def check():
    outs = expected_outputs()
    bad = []
    for path, text in sorted(outs.items()):
        rel = os.path.relpath(path, ROOT)
        if not os.path.exists(path):
            bad.append('缺少 %s' % rel)
        elif read(path) != text:
            bad.append('%s 与源不一致' % rel)

    for rel in expected_audio():
        if not os.path.exists(os.path.join(GEN, 'audio', rel)):
            bad.append('缺少音频 %s' % rel)

    if bad:
        print('❌ 小程序产物不是最新的：')
        for b in bad[:20]:
            print('   · %s' % b)
        print('   跑一次 python3 tools/build_miniprogram.py 重新生成')
        return 1

    print('✅ 小程序产物是最新的')
    return 0


def main():
    ap = argparse.ArgumentParser(description='生成微信小程序产物')
    ap.add_argument('--check', action='store_true', help='只校验产物是否与源一致')
    args = ap.parse_args()
    return check() if args.check else build()


if __name__ == '__main__':
    sys.exit(main())
