#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build.py — 产出两种产物，零第三方依赖。

  online  → output/online/                分离资产，部署到对象存储
  single  → output/幼小衔接-v1.0.html      单文件全内联，微信传阅/离线

为什么不用 webpack/vite：单文件化本质就是字符串替换 + base64 编码，
一个脚本就够。零依赖意味着半年后回来仍能构建成功。

用法：
    python3 tools/build.py [online|single|all]
"""

import base64
import json
import os
import re
import shutil
import sys
import hashlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_icons

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'src')
OUT = os.path.join(ROOT, 'output')
AUDIO = os.path.join(ROOT, 'audio')

# 产物文件名
SINGLE_NAME = '幼小衔接-v1.0.html'

# CSS 拼接顺序（顺序有意义：变量必须先于使用）
CSS_ORDER = ['base.css', 'game.css', 'wheel.css', 'parent.css']

# 音频扩展名。Phase 0 的占位音是 WAV，正式内容用 MP3。
AUDIO_EXT = ['.mp3', '.wav', '.m4a', '.ogg']

MIME = {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
}

# 在线版的 PWA 头。全部用相对路径 —— 这样部署在 GitHub Pages 的子路径
# （https://user.github.io/repo/）下也能正常工作，不需要知道自己的前缀。
PWA_LINKS = '''<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icons/icon-180.png">
<link rel="icon" type="image/png" sizes="32x32" href="icons/favicon-32.png">'''

# Service Worker 注册。只在 https（或本机调试）下注册 ——
# file:// 和 http:// 下 SW 不可用，注册会抛异常刷控制台。
SW_REGISTER = '''<script>
(function () {
  if (!('serviceWorker' in navigator)) return;
  var h = location.hostname;
  var okProto = location.protocol === 'https:' || h === 'localhost' || h === '127.0.0.1';
  if (!okProto) return;
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function (e) {
      console.warn('[sw] 注册失败（不影响在线使用，只影响离线）', e);
    });
  });
})();
</script>'''


def log(msg):
    print(msg, flush=True)


def read(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()


def write(path, content, binary=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    mode = 'wb' if binary else 'w'
    with open(path, mode, **({} if binary else {'encoding': 'utf-8'})) as f:
        f.write(content)


def fmt_size(n):
    if n < 1024:
        return '%d B' % n
    if n < 1024 * 1024:
        return '%.1f KB' % (n / 1024)
    return '%.2f MB' % (n / 1024 / 1024)


# ---------------------------------------------------------------- 数据

def load_json(name, empty=None):
    path = os.path.join(SRC, 'data', name)
    if not os.path.exists(path):
        log('  ⚠️  缺少 %s，按空处理' % name)
        return {} if empty is None else empty
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def load_zibiao():
    """字表白名单。题库里的每一个汉字都必须出自它 —— 这就是「字的范围」那条约束。"""
    return load_json('zi_grade12.json', empty={'chars': []})


def build_data_js():
    """生成 window.G.DATA = {chinese: [...], zibiao: {...}}。

    整个游戏只有识字一科，数据也就只有两份：题库和它背后的字表。
    """
    data = {
        'chinese': load_json('chinese.json', empty=[]),
        'zibiao': load_zibiao(),
    }
    # ensure_ascii=False 让中文在产物里保持可读，便于调试
    js = ('window.G = window.G || {};\n'
          'window.G.DATA = %s;\n'
          % json.dumps(data, ensure_ascii=False, separators=(',', ':')))

    log('  题库：识字 %d 道 · 字表 %d 字'
        % (len(data['chinese']), len(data['zibiao'].get('chars', []))))
    return js


# ---------------------------------------------------------------- 音频

def scan_audio():
    """扫描 audio/ 生成清单。

    audio id = 相对路径去掉扩展名、'/' 换成 '.' —— 例如
        audio/word/fan.mp3  →  'word.fan'
    这样代码引用音频不需要第二张映射表。
    """
    entries = []
    if not os.path.isdir(AUDIO):
        return entries

    for dirpath, _, filenames in os.walk(AUDIO):
        for fn in sorted(filenames):
            ext = os.path.splitext(fn)[1].lower()
            if ext not in AUDIO_EXT:
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, AUDIO).replace(os.sep, '/')
            audio_id = os.path.splitext(rel)[0].replace('/', '.')
            entries.append({
                'id': audio_id,
                'rel': rel,
                'abs': full,
                'ext': ext,
                'bytes': os.path.getsize(full),
            })
    return entries


def build_audio_js_online(entries):
    amap = {}
    for e in entries:
        amap[e['id']] = {'src': 'audio/' + e['rel']}
    return ('window.G = window.G || {};\n'
            'window.G.AUDIO_MAP = %s;\n'
            % json.dumps(amap, ensure_ascii=False, separators=(',', ':'))), 0


def build_audio_js_single(entries):
    """单文件版：音频以 data URI 内联。这是「1.3 MB 单文件」判断的落地点。"""
    amap = {}
    total = 0
    for e in entries:
        with open(e['abs'], 'rb') as f:
            raw = f.read()
        total += len(raw)
        b64 = base64.b64encode(raw).decode('ascii')
        amap[e['id']] = {'src': 'data:%s;base64,%s' % (MIME.get(e['ext'], 'audio/mpeg'), b64)}
    return ('window.G = window.G || {};\n'
            'window.G.AUDIO_MAP = %s;\n'
            % json.dumps(amap, ensure_ascii=False, separators=(',', ':'))), total


# ---------------------------------------------------------------- 源码

def read_js():
    jsdir = os.path.join(SRC, 'js')
    names = sorted(n for n in os.listdir(jsdir) if n.endswith('.js'))
    parts = []
    for n in names:
        parts.append('/* ===== %s ===== */\n%s' % (n, read(os.path.join(jsdir, n))))
    return names, '\n'.join(parts)


def read_css():
    cssdir = os.path.join(SRC, 'css')
    present = [n for n in CSS_ORDER if os.path.exists(os.path.join(cssdir, n))]
    # 兜底：CSS_ORDER 里没列出但目录里存在的，追加在后面
    extra = sorted(n for n in os.listdir(cssdir)
                   if n.endswith('.css') and n not in present)
    order = present + extra
    parts = []
    for n in order:
        parts.append('/* ===== %s ===== */\n%s' % (n, read(os.path.join(cssdir, n))))
    return order, '\n'.join(parts)


def template():
    return read(os.path.join(SRC, 'index.html'))


# ---------------------------------------------------------------- 校验

# 题量上限。需求是「控制在 300 以内」，这里是它的机器版本。
QUESTION_LIMIT = 300

# 选项里会出现偏旁（氵 艹 扌…）而不是汉字的题型。这些字符本来就不单独成字，
# 不在字表里是正常的。
RADICAL_TAGS = {'部首', '偏旁'}


def is_han(c):
    """cjk 统一汉字区。标点、拼音字母、数字都不算。"""
    return chr(0x4E00) <= c <= chr(0x9FFF)


def validate(entries):
    """构建前的自检。

    题库是生成出来的（tools/gen_ziku.py），所以这里不重复生成器的那些断言
    （唯一正确答案之类，见 gen_ziku.py 的 selfcheck），只查生成器管不到、
    或者一旦出错就会静默生效的东西：
      · 题量是否超限
      · 每个选项里的汉字是否真在字表白名单内 —— 「字的范围」这条需求
    """
    errors = []
    warnings = []

    audio_ids = set(e['id'] for e in entries)
    chars = set(c['char'] for c in load_zibiao().get('chars', []))
    if not chars:
        errors.append('字表 zi_grade12.json 是空的，无法校验出题范围')

    questions = load_json('chinese.json', empty=[])

    if len(questions) > QUESTION_LIMIT:
        errors.append('题库 %d 道，超过上限 %d' % (len(questions), QUESTION_LIMIT))

    all_ids = set()
    for q in questions:
        qid = q.get('id', '<无 id>')
        qtype = q.get('type')

        if qid in all_ids:
            errors.append('%s：id 重复' % qid)
        all_ids.add(qid)

        if q.get('subject') != 'chinese':
            errors.append('%s：subject 应为 chinese，实际 %s' % (qid, q.get('subject')))

        opts = q.get('options', [])
        ids = [o.get('id') for o in opts]
        if len(ids) != len(set(ids)):
            errors.append('%s：选项 id 重复' % qid)

        ans = q.get('answer')
        if ans not in ids:
            errors.append('%s：answer "%s" 不在选项里' % (qid, ans))

        if not opts:
            errors.append('%s：没有选项' % qid)

        if not q.get('explain'):
            errors.append('%s：缺少 explain（答错时孩子看不到讲解）' % qid)

        # ---- 字的范围 ----
        # 只看「答案是一个汉字」的题还不够 —— 干扰项跑出范围同样有害：
        # 孩子会在选项里见到三年级的字，甚至把那个字当成正确答案记下来。
        tags = q.get('tags') or []
        if not (set(tags) & RADICAL_TAGS):
            for o in opts:
                for c in (o.get('text') or ''):
                    if is_han(c) and c not in chars:
                        errors.append('%s：选项「%s」不在字表内' % (qid, o.get('text')))

        # 音频引用必须存在
        for a in (q.get('audio') or []):
            aid = a if isinstance(a, str) else a.get('id')
            if not aid:
                continue
            key = aid.replace('.mp3', '').replace('.wav', '').replace('/', '.')
            if key not in audio_ids:
                warnings.append('%s：引用的音频 %s 不存在' % (qid, aid))

    # 题型分布。某一种题型只剩一两道时，一局 10 题必然反复出它，很单调。
    by_tag = {}
    for q in questions:
        tag = (q.get('tags') or [q.get('type') or '?'])[0]
        by_tag[tag] = by_tag.get(tag, 0) + 1
    thin = [t for t, n in by_tag.items() if n < 8]
    if thin:
        warnings.append('这些题型不足 8 道，一局里会重复出现：%s'
                        % ' '.join('%s(%d)' % (t, by_tag[t]) for t in thin))

    return errors, warnings


# ---------------------------------------------------------------- 产物

def build_online(data_js, audio_js, css_names, css_text, js_names, js_text, entries):
    outdir = os.path.join(OUT, 'online')
    if os.path.isdir(outdir):
        shutil.rmtree(outdir)
    os.makedirs(outdir, exist_ok=True)

    write(os.path.join(outdir, 'app.css'), css_text)
    write(os.path.join(outdir, 'data.js'), data_js + audio_js)
    write(os.path.join(outdir, 'app.js'), js_text)

    # 音频资源
    for e in entries:
        dest = os.path.join(outdir, 'audio', e['rel'])
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copy2(e['abs'], dest)

    # 图标（缺失时自动生成）+ manifest
    icons_src = os.path.join(SRC, 'icons')
    make_icons.ensure_icons(icons_src, quiet=True)
    os.makedirs(os.path.join(outdir, 'icons'), exist_ok=True)
    for fn in sorted(os.listdir(icons_src)):
        if fn.endswith('.png'):
            shutil.copy2(os.path.join(icons_src, fn),
                         os.path.join(outdir, 'icons', fn))
    shutil.copy2(os.path.join(SRC, 'manifest.webmanifest'),
                 os.path.join(outdir, 'manifest.webmanifest'))

    # ---- 预缓存清单 ----
    # 版本号取全部产物的内容哈希：内容一变缓存名就变，SW 激活时自动清掉旧缓存。
    # 不这么做的话，孩子会被永久钉在第一次打开的版本上。
    precache = ['index.html', 'app.css', 'data.js', 'app.js', 'manifest.webmanifest']
    precache += ['icons/' + fn for fn in sorted(os.listdir(os.path.join(outdir, 'icons')))]
    precache += ['audio/' + e['rel'] for e in entries]

    h = hashlib.sha1()
    for rel in sorted(precache):
        p = os.path.join(outdir, rel)
        if os.path.exists(p):
            with open(p, 'rb') as f:
                h.update(f.read())
    version = 'yxjx-' + h.hexdigest()[:10]

    sw = read(os.path.join(SRC, 'sw.js'))
    sw = sw.replace('__SW_VERSION__', version)
    sw = sw.replace('__SW_PRECACHE__', json.dumps(precache, ensure_ascii=False))
    write(os.path.join(outdir, 'sw.js'), sw)

    # ---- index.html ----
    html = template()
    html = html.replace('<!--@pwa-->', PWA_LINKS)
    html = html.replace('<!--@inline:css-->',
                        '<link rel="stylesheet" href="app.css">')
    html = html.replace('<!--@inline:data-->',
                        '<script src="data.js"></script>')
    html = html.replace('<!--@inline:audio-->', '')
    html = html.replace('<!--@inline:js-->',
                        '<script src="app.js"></script>')
    html = html.replace('<!--@sw-->', SW_REGISTER)
    write(os.path.join(outdir, 'index.html'), html)

    # 预缓存清单里的每一项都必须在磁盘上存在。
    # 这一条必须硬失败：SW 装不上是完全静默的 —— 在线玩一切正常，
    # 只有孩子到了没网的地方才会发现，而那时候已经来不及修了。
    missing = [rel for rel in precache
               if not os.path.exists(os.path.join(outdir, rel))]
    if missing:
        raise SystemExit('预缓存清单里有 %d 个文件不存在，SW 会装不上：\n  %s'
                         % (len(missing), '\n  '.join(missing)))

    total = 0
    for dirpath, _, files in os.walk(outdir):
        for f in files:
            total += os.path.getsize(os.path.join(dirpath, f))

    log('  output/online/  →  index.html + app.js + app.css + data.js')
    log('                      + sw.js + manifest + icons/ + audio/')
    log('    CSS: %s' % ', '.join(css_names))
    log('    JS:  %s (%d 个文件)' % (', '.join(js_names), len(js_names)))
    log('    预缓存 %d 个资源，缓存版本 %s' % (len(precache), version))
    log('    总计 %s' % fmt_size(total))
    return outdir


def build_single(data_js, audio_js, audio_raw_bytes, css_text, js_text, entries):
    html = template()

    # 单文件版把图标内联成 data URI，保持「一个文件、零外部依赖」
    icon = os.path.join(SRC, 'icons', 'icon-180.png')
    if os.path.exists(icon):
        with open(icon, 'rb') as f:
            b64 = base64.b64encode(f.read()).decode('ascii')
        pwa = ('<link rel="apple-touch-icon" href="data:image/png;base64,%s">' % b64)
    else:
        pwa = ''

    html = html.replace('<!--@pwa-->', pwa)
    html = html.replace('<!--@inline:css-->', '<style>\n%s\n</style>' % css_text)
    html = html.replace('<!--@inline:data-->',
                        '<script>\n%s\n</script>' % data_js)
    html = html.replace('<!--@inline:audio-->',
                        '<script>\n%s\n</script>' % audio_js)
    html = html.replace('<!--@inline:js-->',
                        '<script>\n%s\n</script>' % js_text)
    # 单文件版不注册 SW：file:// 下 SW 不可用，且它本来就是离线的
    html = html.replace('<!--@sw-->', '')

    outpath = os.path.join(OUT, SINGLE_NAME)
    write(outpath, html)

    size = os.path.getsize(outpath)
    raw = sum(e['bytes'] for e in entries)

    log('  output/%s' % SINGLE_NAME)
    log('    源码 %.1f KB + 音频 %s（base64 后 ≈ %s）'
        % ((len(css_text) + len(js_text) + len(data_js)) / 1024,
           fmt_size(raw), fmt_size(raw * 4 / 3)))
    log('    单文件总计 %s' % fmt_size(size))
    return outpath


# ---------------------------------------------------------------- main

def main():
    argv = [a for a in sys.argv[1:] if not a.startswith('--')]
    flags = set(a for a in sys.argv[1:] if a.startswith('--'))
    mode = argv[0] if argv else 'all'

    if mode not in ('online', 'single', 'all'):
        log('用法：python3 tools/build.py [online|single|all] [--check-only]')
        return 1
    check_only = '--check-only' in flags or '--check' in flags or '-c' in sys.argv[1:]

    log('')
    log('构建 识字闯关 (%s)' % mode)
    log('=' * 46)

    entries = scan_audio()
    log('音频：%d 条，共 %s' % (len(entries), fmt_size(sum(e['bytes'] for e in entries))))
    if not entries:
        log('  ⚠️  audio/ 为空。游戏能跑，但没有声音 —— 转盘的转动音和答对音会缺失。')

    log('')
    log('校验')
    errors, warnings = validate(entries)
    for w in warnings:
        log('  ⚠️  %s' % w)
    if errors:
        for e in errors:
            log('  ❌ %s' % e)
        log('')
        log('校验未通过，构建中止。')
        return 1
    log('  ✅ 通过（%d 条警告）' % len(warnings))

    if check_only:
        log('')
        log('--check-only：校验通过，未生成产物。')
        return 0

    log('')
    log('生成')
    data_js = build_data_js()
    css_names, css_text = read_css()
    js_names, js_text = read_js()

    if mode in ('online', 'all'):
        audio_js, _ = build_audio_js_online(entries)
        build_online(data_js, audio_js, css_names, css_text, js_names, js_text, entries)

    if mode in ('single', 'all'):
        audio_js, raw = build_audio_js_single(entries)
        build_single(data_js, audio_js, raw, css_text, js_text, entries)

    log('')
    log('完成。本地预览：')
    log('  python3 -m http.server 8080 --directory output/online')
    log('  然后打开 http://localhost:8080')
    log('  自检页：http://localhost:8080#selftest')
    log('')
    return 0


if __name__ == '__main__':
    sys.exit(main())
