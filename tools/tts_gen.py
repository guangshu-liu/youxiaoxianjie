#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tts_gen.py — 音频生成与清单管理。

设计要点
--------
1. **清单是唯一真相源。** tools/audio_manifest.json 声明「要哪些音频、读什么文本、
   用什么音色」。改文本改这里，不改脚本。
2. **增量。** 每条记 text_sha1；文本没变就跳过。重跑一次不会覆盖已有的，
   更不会碰家长录音（家长录音存 IndexedDB，跟这里完全两个世界）。
3. **音素音全部 needsReview。** edge-tts 不支持 IPA 输入，拼写诱导出来的
   音素音必然有偏差（/b/ 会读成 /bə/）。这些标记出来让人耳过一遍，
   过不了的走游戏内的家长录音替换。

用法
----
    python3 tools/tts_gen.py --sync          # 扫描题库，补齐清单里缺的条目
    python3 tools/tts_gen.py                 # 生成所有缺失/变更的音频
    python3 tools/tts_gen.py --only word.    # 只生成 word.* 前缀
    python3 tools/tts_gen.py --dry-run       # 只报告要做什么
    python3 tools/tts_gen.py --verify        # 校验文件存在 + sha1 匹配
    python3 tools/tts_gen.py --review        # 列出所有待人工听辨的音素音
    python3 tools/tts_gen.py --placeholder   # 不联网，生成占位音（Phase 0 用）

依赖：edge-tts（`pip3 install edge-tts`）。只有真正生成时才需要，
      --sync / --verify / --review / --placeholder 都是纯标准库。
"""

import argparse
import hashlib
import json
import os
import re
import struct
import sys
import wave

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(ROOT, 'tools', 'audio_manifest.json')
AUDIO = os.path.join(ROOT, 'audio')
DATA = os.path.join(ROOT, 'src', 'data')

# ---------------------------------------------------------------- 音色

VOICE_WORD = 'en-US-AnaNeural'      # 儿童音色，6 岁代入感强
VOICE_PHONEME = 'en-US-AnaNeural'
VOICE_CN = 'zh-CN-XiaoyiNeural'
VOICE_UI = 'zh-CN-XiaoyiNeural'

RATE_WORD = '-20%'
RATE_PHONEME = '-30%'               # 音素要更慢，孩子才分得清
RATE_CN = '-10%'

# 音素拼写诱导表。
# edge-tts 读 "a" 会得到字母名 /eɪ/，读 "f" 会得到 /ɛf/ —— 教学上是错的。
# 下表是「怎么拼写能让 TTS 尽量发出那个音」，全部 needsReview。
PHONEME_SAY = {
    # 短元音（OPW2 的全部考点）
    'a': 'ah',      # /æ/  —— 近似，Ana 的 ah 偏 /ɑ/，需听辨
    'e': 'eh',      # /ɛ/
    'i': 'ih',      # /ɪ/
    'o': 'awe',     # /ɒ/  —— 最勉强的一个，很可能要家长重录
    'u': 'uh',      # /ʌ/
    # 连续音（摩擦/鼻/流），TTS 表现通常不错
    'f': 'fff', 'v': 'vvv', 's': 'sss', 'z': 'zzz',
    'm': 'mmm', 'n': 'nnn', 'l': 'lll', 'r': 'rrr',
    'h': 'hhh', 'w': 'wuh', 'y': 'yuh',
    # 爆破音 —— 必然带出 schwa（/bə/ 而非 /b/），教学上不干净，全部待审
    'b': 'buh', 'p': 'puh', 'd': 'duh', 't': 'tuh',
    'g': 'guh', 'k': 'kuh', 'c': 'kuh', 'j': 'juh',
    'q': 'kwuh', 'x': 'ks',
    # 词族韵脚
    'an': 'an', 'am': 'am', 'at': 'at', 'ap': 'ap', 'ad': 'ad', 'ag': 'ag',
    'en': 'en', 'et': 'et', 'ed': 'ed', 'eg': 'eg',
    'in': 'in', 'it': 'it', 'ig': 'ig', 'ip': 'ip', 'id': 'id',
    'ot': 'ot', 'op': 'op', 'og': 'og', 'ob': 'ob',
    'un': 'un', 'ut': 'ut', 'ug': 'ug', 'ub': 'ub', 'up': 'up',
}

# 固定 UI 音效（题库里不引用，但游戏要用）
BASE_UI = {
    'ui.tap':      {'text': '点击', 'voice': VOICE_UI, 'rate': RATE_CN},
    'ui.correct':  {'text': '答对啦！', 'voice': VOICE_UI, 'rate': RATE_CN},
    'ui.wrong':    {'text': '再想一想', 'voice': VOICE_UI, 'rate': RATE_CN},
    'ui.spin':     {'text': '转一转！', 'voice': VOICE_UI, 'rate': RATE_CN},
    'ui.win':      {'text': '哇，中奖啦！', 'voice': VOICE_UI, 'rate': RATE_CN},
}

# 数学题干拼接片段。生成题无法预生成整句，改为运行时用 start(when) 排期拼接。
BASE_MATH = {}
for _n in range(0, 21):
    BASE_MATH['ui.num.%d' % _n] = {'text': str(_n), 'voice': VOICE_CN, 'rate': RATE_CN}
for _k, _t in [('add', '加'), ('sub', '减'), ('eq', '等于'),
               ('howmany', '一共有几个'), ('whichbig', '哪个大')]:
    BASE_MATH['ui.op.%s' % _k] = {'text': _t, 'voice': VOICE_CN, 'rate': RATE_CN}

# 题库里音频引用有两种写法混用：路径式 "word/fan.mp3" 和 id 式 "phoneme.a.mp3"。
# 两种都收，统一归一化成 id（"word.fan" / "phoneme.a"）—— 与其去纠正已经写了
# 一百多处的数据，不如让工具容错。清单里的 id 才是唯一真相源。
AUDIO_REF_RE = re.compile(r'^(word|phoneme|prompt|ui)[/.]([\w\-./]+)\.(mp3|wav|m4a)$')


def audio_ref_to_id(s):
    """'word/fan.mp3' 和 'word.fan.mp3' 都 → 'word.fan'。不是音频引用则返回 None。"""
    m = AUDIO_REF_RE.match(s.strip())
    if not m:
        return None
    kind, rest = m.group(1), m.group(2)
    return kind + '.' + rest.replace('/', '.')


def log(m):
    print(m, flush=True)


def sha1_text(s):
    return hashlib.sha1(s.encode('utf-8')).hexdigest()


def sha1_file(path):
    h = hashlib.sha1()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(65536), b''):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------- 清单

def load_manifest():
    if not os.path.exists(MANIFEST):
        return {'version': 1, 'entries': {}}
    with open(MANIFEST, 'r', encoding='utf-8') as f:
        return json.load(f)


def save_manifest(m):
    with open(MANIFEST, 'w', encoding='utf-8') as f:
        json.dump(m, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write('\n')


def entry_for(audio_id, text=None, voice=None, rate=None, needs_review=False, note=None):
    """audio id → 清单条目。id 到路径的映射就是 '/' ↔ '.'。"""
    path = audio_id.replace('.', '/', 1) + '.mp3'
    if text is None:
        kind, _, name = audio_id.partition('.')
        if kind == 'word':
            text, voice, rate = name, VOICE_WORD, RATE_WORD
        elif kind == 'phoneme':
            text = PHONEME_SAY.get(name, name)
            voice, rate, needs_review = VOICE_PHONEME, RATE_PHONEME, True
        else:
            text, voice, rate = name, VOICE_CN, RATE_CN

    e = {
        'path': path,
        'text': text,
        'voice': voice or VOICE_WORD,
        'rate': rate or RATE_WORD,
        'text_sha1': sha1_text(text),
    }
    if needs_review:
        e['needsReview'] = True
    if note:
        e['note'] = note
    return e


# ---------------------------------------------------------------- sync

def walk_json_strings(obj, out):
    if isinstance(obj, str):
        out.append(obj)
    elif isinstance(obj, dict):
        for v in obj.values():
            walk_json_strings(v, out)
    elif isinstance(obj, list):
        for v in obj:
            walk_json_strings(v, out)


def referenced_audio_ids():
    """扫描 src/data/*.json 里所有长得像音频引用的字符串。

    故意不按 schema 取值 —— 题库的音频字段散在 q.audio / stem.audio /
    items[].audio / reveal.audio / stem.onset.audio 等七八个位置，
    逐个写死会在加题型时漏掉。形状匹配反而更稳。
    """
    ids = {}
    for fn in sorted(os.listdir(DATA)):
        if not fn.endswith('.json'):
            continue
        with open(os.path.join(DATA, fn), 'r', encoding='utf-8') as f:
            data = json.load(f)
        strings = []
        walk_json_strings(data, strings)
        for s in strings:
            aid = audio_ref_to_id(s)
            if aid:
                ids.setdefault(aid, fn)
    return ids


def cmd_sync(m):
    refs = referenced_audio_ids()
    added = []
    for aid, src in sorted(refs.items()):
        if aid in m['entries']:
            continue
        m['entries'][aid] = entry_for(aid)
        m['entries'][aid]['_from'] = src
        added.append(aid)

    for aid, e in sorted(BASE_UI.items()):
        if aid not in m['entries']:
            m['entries'][aid] = entry_for(aid, **e)
            added.append(aid)

    for aid, e in sorted(BASE_MATH.items()):
        if aid not in m['entries']:
            m['entries'][aid] = entry_for(aid, **e)
            added.append(aid)

    save_manifest(m)
    log('题库引用音频 %d 条，清单现有 %d 条' % (len(refs), len(m['entries'])))
    if added:
        log('新增 %d 条：' % len(added))
        for a in added[:40]:
            log('  + %s  ← "%s"' % (a, m['entries'][a]['text']))
        if len(added) > 40:
            log('  … 另有 %d 条' % (len(added) - 40))
    else:
        log('清单已是最新，无新增。')

    missing = [a for a in refs if a not in m['entries']]
    if missing:
        log('⚠️  仍有 %d 条题库引用不在清单里' % len(missing))
    return 0


# ---------------------------------------------------------------- 状态

def status(m):
    """返回 (缺失, 文本变更, 已就绪, 文件被外部改动)。"""
    missing, changed, ready, tampered = [], [], [], []
    for aid, e in sorted(m['entries'].items()):
        path = os.path.join(AUDIO, e['path'])
        if not os.path.exists(path):
            missing.append(aid)
            continue
        if e.get('text_sha1') and e['text_sha1'] != sha1_text(e['text']):
            changed.append(aid)
            continue
        if e.get('sha1') and e['sha1'] != sha1_file(path):
            tampered.append(aid)
            continue
        ready.append(aid)
    return missing, changed, ready, tampered


def cmd_verify(m):
    missing, changed, ready, tampered = status(m)
    total = len(m['entries'])
    log('清单 %d 条：就绪 %d · 缺失 %d · 文本已改 %d · 文件被改动 %d'
        % (total, len(ready), len(missing), len(changed), len(tampered)))
    for label, items in [('缺失', missing), ('文本已改（需重新生成）', changed),
                         ('文件被外部改动（sha1 不符）', tampered)]:
        if items:
            log('')
            log('%s：' % label)
            for a in items[:30]:
                log('  · %s  "%s"' % (a, m['entries'][a]['text']))
            if len(items) > 30:
                log('  … 另有 %d 条' % (len(items) - 30))
    return 0 if not (missing or changed) else 1


def cmd_review(m):
    """列出所有待人工听辨的条目 —— Phase 1 的主要交付物就是这个列表的结论。"""
    rows = [(a, e) for a, e in sorted(m['entries'].items()) if e.get('needsReview')]
    log('待人工听辨：%d 条' % len(rows))
    log('')
    log('逐个听 audio/ 下的对应文件，判断「读到的是不是那个音」。')
    log('过不了的不用改这里 —— 在游戏家长面板里录一条替换即可。')
    log('')
    log('%-18s %-8s %s' % ('ID', '读作', '备注'))
    log('-' * 60)
    for a, e in rows:
        path = os.path.join(AUDIO, e['path'])
        mark = '✔' if os.path.exists(path) else '✗'
        log('%s %-16s %-8s %s' % (mark, a, e['text'], e.get('note', '')))
    return 0


# ---------------------------------------------------------------- 生成

def cmd_placeholder(m, only, force):
    """Phase 0 用：不联网生成占位音。

    故意做成「每条一个不同音高」而不是静音 —— 静音只能验证「没崩」，
    不同音高能验证「播的是不是这一条」，这对排查音频路由错误有用得多。
    """
    import math
    made = 0
    sr = 16000
    for aid, e in sorted(m['entries'].items()):
        if only and not aid.startswith(only):
            continue
        path = os.path.join(AUDIO, e['path'])
        if os.path.exists(path) and not force:
            continue
        os.makedirs(os.path.dirname(path), exist_ok=True)

        # 用 id 的哈希定音高，保证同一条每次生成一致、不同条可区分
        h = int(hashlib.sha1(aid.encode()).hexdigest()[:4], 16)
        freq = 320 + (h % 24) * 55            # 320–1640 Hz
        dur = 0.38
        n = int(sr * dur)
        frames = bytearray()
        for i in range(n):
            t = i / sr
            # 两端各 25ms 淡入淡出，避免爆音
            env = min(1.0, i / (sr * 0.025), (n - i) / (sr * 0.025))
            v = int(14000 * env * math.sin(2 * math.pi * freq * t))
            frames += struct.pack('<h', v)

        wav_path = os.path.splitext(path)[0] + '.wav'
        with wave.open(wav_path, 'wb') as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes(bytes(frames))

        e['path'] = os.path.relpath(wav_path, AUDIO).replace(os.sep, '/')
        e['sha1'] = sha1_file(wav_path)
        e['_placeholder'] = True
        made += 1

    save_manifest(m)
    log('生成占位音 %d 条 → audio/ (WAV)' % made)
    log('⚠️  这些是音高不同的蜂鸣，不是人声。仅用于在真机上验证音频链路。')
    log('    正式音频请跑（不带 --placeholder）python3 tools/tts_gen.py')
    return 0


def cmd_generate(m, only, force, dry):
    try:
        import edge_tts
    except ImportError:
        log('❌ 缺少 edge-tts。安装：pip3 install edge-tts')
        log('   或者先用 --placeholder 生成占位音把 Phase 0 跑通。')
        return 2

    import asyncio

    missing, changed, ready, tampered = status(m)
    todo = missing + changed + (tampered if force else [])
    if only:
        todo = [a for a in todo if a.startswith(only)]
    if force:
        todo = [a for a, _ in sorted(m['entries'].items())
                if not only or a.startswith(only)]

    log('待生成 %d 条（就绪 %d 条跳过）' % (len(todo), len(ready)))
    if dry:
        for a in todo[:40]:
            log('  → %s  "%s"  [%s %s]' % (a, m['entries'][a]['text'],
                                           m['entries'][a]['voice'], m['entries'][a]['rate']))
        if len(todo) > 40:
            log('  … 另有 %d 条' % (len(todo) - 40))
        return 0
    if not todo:
        log('没有需要生成的。')
        return 0

    async def run():
        ok, fail = 0, []
        for i, aid in enumerate(todo, 1):
            e = m['entries'][aid]
            path = os.path.join(AUDIO, e['path'])
            os.makedirs(os.path.dirname(path), exist_ok=True)
            try:
                c = edge_tts.Communicate(e['text'], e['voice'], rate=e['rate'])
                await c.save(path)
                e['text_sha1'] = sha1_text(e['text'])
                e['sha1'] = sha1_file(path)
                e.pop('_placeholder', None)
                ok += 1
                log('  [%d/%d] ✔ %s  "%s"' % (i, len(todo), aid, e['text']))
            except Exception as ex:
                fail.append((aid, str(ex)))
                log('  [%d/%d] ✗ %s  %s' % (i, len(todo), aid, ex))
        return ok, fail

    ok, fail = asyncio.run(run())
    save_manifest(m)
    log('')
    log('完成：成功 %d，失败 %d' % (ok, len(fail)))
    if fail:
        log('失败的条目：')
        for a, err in fail[:20]:
            log('  · %s  %s' % (a, err))
        return 1
    if any(m['entries'][a].get('needsReview') for a in todo):
        log('')
        log('⚠️  本次生成了音素音。跑 python3 tools/tts_gen.py --review 拿到待听辨清单。')
    return 0


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description='音频清单管理与 TTS 生成')
    ap.add_argument('--sync', action='store_true', help='扫描题库补齐清单')
    ap.add_argument('--verify', action='store_true', help='校验文件存在与 sha1')
    ap.add_argument('--review', action='store_true', help='列出待人工听辨的条目')
    ap.add_argument('--placeholder', action='store_true', help='生成占位蜂鸣音（不联网）')
    ap.add_argument('--only', default=None, help='只处理此前缀，如 word.')
    ap.add_argument('--force', action='store_true', help='重新生成（覆盖已有）')
    ap.add_argument('--dry-run', action='store_true', help='只报告，不写文件')
    args = ap.parse_args()

    m = load_manifest()

    if args.sync:
        return cmd_sync(m)
    if args.verify:
        return cmd_verify(m)
    if args.review:
        return cmd_review(m)
    if args.placeholder:
        return cmd_placeholder(m, args.only, args.force)

    if not m['entries']:
        log('清单是空的。先跑：python3 tools/tts_gen.py --sync')
        return 2
    return cmd_generate(m, args.only, args.force, args.dry_run)


if __name__ == '__main__':
    sys.exit(main())
