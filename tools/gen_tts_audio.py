#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""题干朗读音频生成器（小程序主包用）。

网页版的题干朗读走浏览器 speechSynthesis，零文件；小程序没有内置 TTS，
而微信同声传译插件只对企业主体开放（本项目是个人主体），所以这里在构建时
把中文题干预生成成 m4a，放进小程序**主包**的 `ttsAudio/` 目录。

  npm run tts:audio         生成缺失的音频 + 清单 + 映射
  npm run tts:audio:check   只检查，不写文件（verify 用）

规则不在本文件里：`tools/tts_texts.js` 加载网页版/小程序共用的
`src/js/22-tts-text.js`，把 600 道题过一遍规则后导出唯一朗读文本。
文本变了（题型、归一化规则改动）时，这里会自动多生成/清理音频，
不会出现「题目在念、音频还是旧的那句」。

为什么放主包而不是分包：微信规定「主包不能直接引用分包资源」，把播放器
放在主包、音频放在 pkgTts 分包时，真机上 `InnerAudioContext` 拿不到分包
路径，表现为「读题喇叭在，但一点声音都没有」。主包 2 MB 上限原本装不下
171 条音频，靠下面这条解决 ——

体积关键：macOS `afconvert` 会把音频数据对齐到 4096 字节页边界，中间塞一个
约 3 KB 的 `free` 填充 box。171 个文件合计白白占 515 KB。这里生成后剥掉
`free` 并修正 `moov/stco` 里的 chunk 偏移表，解码出的 PCM 逐字节不变
（音质、时长、音量完全不动），音频从 1.46 MB 降到 0.97 MB，主包合计
约 1.81 MB，稳稳落在 2 MB 以内。

音频参数：macOS `say -v Tingting -r 205` → `afconvert` AAC-LC 22.05 kHz /
16 kbps，iOS / Android 的 InnerAudioContext 都原生支持。
"""

import argparse
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDIO_DIR = os.path.join(ROOT, 'miniprogram', 'ttsAudio')
SPEC_PATH = os.path.join(ROOT, 'src', 'data', 'tts_audio.json')
MAP_PATH = os.path.join(ROOT, 'miniprogram', 'generated', 'data', 'tts-map.js')
TEXTS_JS = os.path.join(ROOT, 'tools', 'tts_texts.js')

VOICE = 'Tingting'
RATE = 205
AF_CONVERT = ['afconvert', '-f', 'm4af', '-d', 'aac@22050', '-b', '16000']
AUDIO_URL_ROOT = '/ttsAudio/'

# 主包上限 2 MB。除题干音频外的主包约 885 KB，留 100 KB 余量给以后改动。
TTS_MAX_BYTES = int(1.15 * 1024 * 1024)

OK = '\033[32m✔\033[0m'
BAD = '\033[31m✖\033[0m'

# ---- MP4 容器：剥掉 afconvert 的页对齐填充 -------------------------------

CONTAINER_BOXES = {'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf'}


def log(msg):
    print(msg, flush=True)


def fail(msg):
    print(BAD + ' ' + msg, file=sys.stderr, flush=True)
    sys.exit(1)


def _boxes(buf, start, end):
    """列出 [start, end) 里的顶层 box：(type, 起点, 大小, 头长)。"""
    p = start
    out = []
    while p + 8 <= end:
        size = struct.unpack('>I', buf[p:p + 4])[0]
        typ = buf[p + 4:p + 8].decode('latin1')
        hdr = 8
        if size == 1:
            size = struct.unpack('>Q', buf[p + 8:p + 16])[0]
            hdr = 16
        elif size == 0:
            size = end - p
        if size < hdr or p + size > end:
            break
        out.append((typ, p, size, hdr))
        p += size
    return out


def has_filler(path):
    data = open(path, 'rb').read()
    return any(b[0] == 'free' for b in _boxes(data, 0, len(data)))


def strip_filler(path):
    """剥掉唯一的顶层 free box，修正 stco/co64 的绝对偏移；返回省下的字节数。

    free box 之后是 mdat，删掉它等于把 mdat 整块前移；MP4 的 chunk offset
    是**文件绝对偏移**，不跟着改的话播放器会读到错误位置（有声音也是杂音）。
    """
    data = bytearray(open(path, 'rb').read())
    frees = [b for b in _boxes(data, 0, len(data)) if b[0] == 'free']
    if len(frees) != 1:
        return 0
    _, start, size, _ = frees[0]
    cut_end = start + size

    def walk(a, e):
        for typ, p, n, hdr in _boxes(data, a, e):
            body = p + hdr
            if typ in ('stco', 'co64'):
                count = struct.unpack('>I', data[body + 4:body + 8])[0]
                fmt = '>I' if typ == 'stco' else '>Q'
                width = 4 if typ == 'stco' else 8
                for i in range(count):
                    off = body + 8 + i * width
                    value = struct.unpack(fmt, data[off:off + width])[0]
                    if value > cut_end:
                        struct.pack_into(fmt, data, off, value - size)
            elif typ in CONTAINER_BOXES:
                walk(body, p + n)

    walk(0, len(data))
    with open(path, 'wb') as f:
        f.write(data[:start] + data[cut_end:])
    return size


# ---- 文本 / 清单 / 映射 ----------------------------------------------------

def computed_texts():
    """跑 Node 拿唯一朗读文本；规则只存在于 JS 那一侧。"""
    r = subprocess.run(['node', TEXTS_JS], capture_output=True, text=True)
    if r.returncode:
        fail('tools/tts_texts.js 执行失败：' + r.stderr.strip()[:300])
    texts = json.loads(r.stdout)
    if not texts or not all(isinstance(t, str) and t.strip() for t in texts):
        fail('朗读文本清单为空或含非法项')
    if texts != sorted(set(texts)):
        fail('朗读文本清单没有排序/去重')
    return texts


def filename(text):
    return hashlib.sha1(text.encode('utf-8')).hexdigest()[:10] + '.m4a'


def entries_for(texts):
    return [{'text': t, 'file': filename(t)} for t in texts]


def spec_obj(entries):
    return {
        'comment': '由 tools/gen_tts_audio.py 生成，勿手改。文本来自 22-tts-text.js 的规则去重结果。',
        'voice': VOICE,
        'rate': RATE,
        'format': 'AAC-LC 22050Hz / 16kbps / m4a（已剥离 free 填充块）',
        'location': 'miniprogram/ttsAudio（主包）',
        'entries': entries
    }


def map_source(entries):
    mapping = {e['text']: AUDIO_URL_ROOT + e['file'] for e in entries}
    body = json.dumps(mapping, ensure_ascii=False, indent=2, sort_keys=True)
    return ('/* tts-map.js — 由 tools/gen_tts_audio.py / build_miniprogram.py 生成，勿手改。\n'
            ' * 朗读文本 → 主包内音频路径；小程序 lib/tts.js 查这张表。\n'
            ' */\nmodule.exports = ' + body + ';\n')


def generate_one(text, dest, tmpdir):
    aiff = os.path.join(tmpdir, 'tts.aiff')
    r = subprocess.run(['say', '-v', VOICE, '-r', str(RATE), '-o', aiff, text],
                       capture_output=True, text=True)
    if r.returncode:
        return 'say 失败：' + (r.stderr or '').strip()[:160]
    r = subprocess.run(AF_CONVERT + [aiff, dest], capture_output=True, text=True)
    if r.returncode:
        return 'afconvert 失败：' + (r.stderr or '').strip()[:160]
    if not os.path.exists(dest) or os.path.getsize(dest) < 500:
        return '输出文件异常'
    strip_filler(dest)
    return None


def generate(entries):
    os.makedirs(AUDIO_DIR, exist_ok=True)
    wanted = set(e['file'] for e in entries)

    made, reused, trimmed, errors = 0, 0, 0, []
    with tempfile.TemporaryDirectory(prefix='tts_') as tmp:
        for e in entries:
            dest = os.path.join(AUDIO_DIR, e['file'])
            if os.path.exists(dest) and os.path.getsize(dest) > 500:
                reused += 1
                # 旧版本（分包时代）留下的文件带 free 填充，就地瘦身，
                # 不必重新合成，音色与 PCM 完全不变。
                if has_filler(dest) and strip_filler(dest):
                    trimmed += 1
                continue
            err = generate_one(e['text'], dest, tmp)
            if err:
                errors.append(e['text'] + ' → ' + err)
            else:
                made += 1
    if errors:
        for e in errors[:5]:
            print(BAD + ' ' + e, file=sys.stderr)
        fail('共 %d 条生成失败' % len(errors))

    removed = 0
    for name in os.listdir(AUDIO_DIR):
        if name.endswith('.m4a') and name not in wanted:
            os.remove(os.path.join(AUDIO_DIR, name))
            removed += 1

    with open(SPEC_PATH, 'w', encoding='utf-8') as f:
        json.dump(spec_obj(entries), f, ensure_ascii=False, indent=2)
        f.write('\n')
    with open(MAP_PATH, 'w', encoding='utf-8') as f:
        f.write(map_source(entries))

    total = sum(os.path.getsize(os.path.join(AUDIO_DIR, n)) for n in wanted)
    log('%s 题干音频：新生成 %d，复用 %d（瘦身 %d），清理 %d，共 %d 条 / %.2f MB'
        % (OK, made, reused, trimmed, removed, len(entries), total / 1024.0 / 1024.0))
    log('   位置 %s（主包内）' % os.path.relpath(AUDIO_DIR, ROOT))
    log('   清单 %s' % os.path.relpath(SPEC_PATH, ROOT))
    log('   映射 %s' % os.path.relpath(MAP_PATH, ROOT))
    if total > TTS_MAX_BYTES:
        fail('题干音频 %.2f MB 超出主包预算 %.2f MB，需要重新压缩'
             % (total / 1024.0 / 1024.0, TTS_MAX_BYTES / 1024.0 / 1024.0))


def check():
    texts = computed_texts()
    entries = entries_for(texts)

    if not os.path.isfile(SPEC_PATH):
        fail('缺少清单 ' + SPEC_PATH)
    spec = json.load(open(SPEC_PATH, encoding='utf-8'))
    if spec.get('entries') != entries:
        fail('清单与 22-tts-text.js 的规则不一致，跑 npm run tts:audio 重建')
    if spec.get('voice') != VOICE or spec.get('rate') != RATE:
        fail('清单里的音色/语速与生成器不一致，需要重生成')

    if not os.path.isfile(MAP_PATH):
        fail('缺少映射 ' + MAP_PATH)
    with open(MAP_PATH, encoding='utf-8') as f:
        if f.read() != map_source(entries):
            fail('tts-map.js 与清单不一致，跑 npm run tts:audio 重建')

    missing, broken, filler, total = [], [], [], 0
    for e in entries:
        p = os.path.join(AUDIO_DIR, e['file'])
        if not os.path.isfile(p):
            missing.append(e['text'])
            continue
        total += os.path.getsize(p)
        if has_filler(p):
            filler.append(e['file'])
        r = subprocess.run(['afinfo', p], capture_output=True, text=True)
        if r.returncode or 'm4af' not in r.stdout or 'aac ' not in r.stdout:
            broken.append(e['text'])
    extra = [n for n in os.listdir(AUDIO_DIR)
             if n.endswith('.m4a') and n not in set(x['file'] for x in entries)]

    if missing or broken or extra or filler:
        if missing:
            print(BAD + ' 缺音频 %d 条，例如 %s' % (len(missing), missing[:3]), file=sys.stderr)
        if broken:
            print(BAD + ' 无法解码 %d 条，例如 %s' % (len(broken), broken[:3]), file=sys.stderr)
        if extra:
            print(BAD + ' 多余音频 %d 条，例如 %s' % (len(extra), extra[:3]), file=sys.stderr)
        if filler:
            print(BAD + ' 仍带 free 填充 %d 条，跑 npm run tts:audio 瘦身' % len(filler),
                  file=sys.stderr)
        fail('题干音频体检不通过')
    if total > TTS_MAX_BYTES:
        fail('题干音频 %.2f MB，超出主包预算' % (total / 1024.0 / 1024.0))

    log('%s 题干音频 %d 条 / %.2f MB（主包内、无填充），清单、映射、文件三者一致'
        % (OK, len(entries), total / 1024.0 / 1024.0))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--check', action='store_true', help='只检查，不写文件')
    ap.add_argument('--force', action='store_true', help='已有音频也重新生成')
    args = ap.parse_args()

    for tool in ('node', 'say', 'afconvert'):
        if not shutil.which(tool):
            fail('找不到 ' + tool + '（本脚本依赖 macOS 自带的 say / afconvert）')

    if args.force:
        shutil.rmtree(AUDIO_DIR, ignore_errors=True)
    if args.check:
        check()
    else:
        generate(entries_for(computed_texts()))


if __name__ == '__main__':
    main()
