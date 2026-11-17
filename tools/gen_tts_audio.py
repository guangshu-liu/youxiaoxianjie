#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""题干朗读音频生成器（小程序分包用）。

网页版的题干朗读走浏览器 speechSynthesis，零文件；小程序没有内置 TTS，
而微信同声传译插件只对企业主体开放（本项目是个人主体），所以这里在构建时
把中文题干预生成成 m4a，放进 `pkgTts` 分包。

  npm run tts:audio         生成缺失的音频 + 清单 + 映射
  npm run tts:audio:check   只检查，不写文件（verify 用）

规则不在本文件里：`tools/tts_texts.js` 加载网页版/小程序共用的
`src/js/22-tts-text.js`，把 600 道题过一遍规则后导出唯一朗读文本。
文本变了（题型、归一化规则改动）时，这里会自动多生成/清理音频，
不会出现「题目在念、音频还是旧的那句」。

音频参数：macOS `say -v Tingting -r 205` → `afconvert` AAC-LC 22.05 kHz / 16 kbps。
选中等偏低码率是为了让 171 条短句能塞进单个 2 MB 分包；22 kHz 单声道
中文朗读清晰度足够，且 iOS / Android 的 InnerAudioContext 都原生支持。
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDIO_DIR = os.path.join(ROOT, 'miniprogram', 'pkgTts', 'audio')
SPEC_PATH = os.path.join(ROOT, 'src', 'data', 'tts_audio.json')
MAP_PATH = os.path.join(ROOT, 'miniprogram', 'generated', 'data', 'tts-map.js')
TEXTS_JS = os.path.join(ROOT, 'tools', 'tts_texts.js')

VOICE = 'Tingting'
RATE = 205
AF_CONVERT = ['afconvert', '-f', 'm4af', '-d', 'aac@22050', '-b', '16000']
SUBPACKAGE_ROOT = '/pkgTts/audio/'

OK = '\033[32m✔\033[0m'
BAD = '\033[31m✖\033[0m'


def log(msg):
    print(msg, flush=True)


def fail(msg):
    print(BAD + ' ' + msg, file=sys.stderr, flush=True)
    sys.exit(1)


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
        'format': 'AAC-LC 22050Hz / 16kbps / m4a',
        'entries': entries
    }


def map_source(entries):
    mapping = {e['text']: SUBPACKAGE_ROOT + e['file'] for e in entries}
    body = json.dumps(mapping, ensure_ascii=False, indent=2, sort_keys=True)
    return ('/* tts-map.js — 由 tools/gen_tts_audio.py / build_miniprogram.py 生成，勿手改。\n'
            ' * 朗读文本 → 分包内音频路径；小程序 lib/tts.js 查这张表。\n'
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
    return None


def generate(entries):
    os.makedirs(AUDIO_DIR, exist_ok=True)
    wanted = set(e['file'] for e in entries)

    made, reused, errors = 0, 0, []
    with tempfile.TemporaryDirectory(prefix='tts_') as tmp:
        for e in entries:
            dest = os.path.join(AUDIO_DIR, e['file'])
            if os.path.exists(dest) and os.path.getsize(dest) > 500:
                reused += 1
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
    log('%s 题干音频：新生成 %d，复用 %d，清理 %d，共 %d 条 / %.2f MB'
        % (OK, made, reused, removed, len(entries), total / 1024.0 / 1024.0))
    log('   清单 %s' % os.path.relpath(SPEC_PATH, ROOT))
    log('   映射 %s' % os.path.relpath(MAP_PATH, ROOT))
    if total > 1.9 * 1024 * 1024:
        fail('分包音频超过 1.9 MB，逼近小程序 2 MB 分包上限，需要重新压缩或拆分')


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

    missing, broken, total = [], [], 0
    for e in entries:
        p = os.path.join(AUDIO_DIR, e['file'])
        if not os.path.isfile(p):
            missing.append(e['text'])
            continue
        total += os.path.getsize(p)
        r = subprocess.run(['afinfo', p], capture_output=True, text=True)
        if r.returncode or 'm4af' not in r.stdout or 'aac ' not in r.stdout:
            broken.append(e['text'])
    extra = [n for n in os.listdir(AUDIO_DIR)
             if n.endswith('.m4a') and n not in set(x['file'] for x in entries)]

    if missing or broken or extra:
        if missing:
            print(BAD + ' 缺音频 %d 条，例如 %s' % (len(missing), missing[:3]), file=sys.stderr)
        if broken:
            print(BAD + ' 无法解码 %d 条，例如 %s' % (len(broken), broken[:3]), file=sys.stderr)
        if extra:
            print(BAD + ' 多余音频 %d 条，例如 %s' % (len(extra), extra[:3]), file=sys.stderr)
        fail('题干音频体检不通过')
    if total > 1.9 * 1024 * 1024:
        fail('分包音频 %.2f MB，逼近 2 MB 上限' % (total / 1024.0 / 1024.0))

    log('%s 题干音频 %d 条 / %.2f MB，清单、映射、文件三者一致'
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
