#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
check_audio.py — 语音全链路体检（零依赖，只要 macOS 自带的 afinfo / afconvert）

覆盖两类音频：
  · 英语单词语音（audio/en，三处副本 + 两端映射）
  · 中文题干朗读语音（miniprogram/ttsAudio，小程序主包）

`npm run audio:check` 只回答「文件齐不齐」，回答不了「文件是不是能响」。
历史上出过两件光看文件查不出来的事：
  · 非 macOS 上生成的占位蜂鸣（都是 12204 字节，文件在、声音是假的）；
  · 网页版 / 小程序包里的音频副本和 audio/ 主副本不一致（一边更新一边没更新）。

所以这里分六层检查，任何一层挂了都以非 0 退出：
  1. 引用：三科题库引用的 id ↔ english_audio.json ↔ audio_manifest.json
  2. 文件：存在、m4a 头、体积、时长（单词 0.25–3.0 s）
  3. 内容：实际解码成 PCM，看峰值 / RMS / 有声帧占比，挡住静音和占位蜂鸣
  4. 副本：audio/ · docs/audio/ · miniprogram/generated/audio/ 逐字节一致
  5. 映射：docs/data.js 的 AUDIO_MAP 与 miniprogram/generated/data/audio.js
          都覆盖全部 id，且指向的文件真的存在
  6. 题干：主包 ttsAudio/ 里的中文朗读音频，清单 ↔ 22-tts-text.js 规则 ↔
          tts-map.js ↔ 文件 ↔ PCM，并检查主包预算够不够

用法：
    python3 tools/check_audio.py             # 完整体检
    python3 tools/check_audio.py --quick    # 跳过 PCM 解码（只看结构 / 文件）
    python3 tools/check_audio.py --json     # 机器可读的结果
"""

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'src', 'data')
SPEC = os.path.join(DATA, 'english_audio.json')
MANIFEST = os.path.join(ROOT, 'tools', 'audio_manifest.json')
MASTER = os.path.join(ROOT, 'audio')
COPIES = [
    ('网页版', os.path.join(ROOT, 'docs', 'audio')),
    ('小程序', os.path.join(ROOT, 'miniprogram', 'generated', 'audio')),
]
MAPS = [
    ('网页版 data.js', os.path.join(ROOT, 'docs', 'data.js'),
     os.path.join(ROOT, 'docs', 'audio')),
    ('小程序 audio.js',
     os.path.join(ROOT, 'miniprogram', 'generated', 'data', 'audio.js'),
     os.path.join(ROOT, 'miniprogram', 'generated', 'audio')),
]

# 一条正常的单词语音：say -v Samantha 读一个三四个字母的词，
# 时长 0.4–1.2 s，峰值接近 0 dBFS，RMS 在 -25 dB 上下。
# 阈值放宽到下面这些，只用来挡「完全没声音 / 是方波蜂鸣」，不用来挑音色。
MIN_BYTES = 3000
MIN_SEC = 0.25
MAX_SEC = 3.0
MIN_PEAK = 0.02          # 峰值至少 -34 dBFS
MIN_RMS = 0.002          # RMS 至少 -54 dBFS
MIN_VOICED = 0.12        # 至少 12% 的采样窗是有声的（挡住极短的滴声）

# 中文题干朗读音频：只在小程序主包里，没有副本；单句 1–6 s。
# 主包上限 2 MB，其余文件约 885 KB，音频预算 1.15 MB（现约 0.97 MB）。
TTS_SPEC = os.path.join(DATA, 'tts_audio.json')
TTS_DIR = os.path.join(ROOT, 'miniprogram', 'ttsAudio')
TTS_MAP = os.path.join(ROOT, 'miniprogram', 'generated', 'data', 'tts-map.js')
# 中文音色约 5 字/秒；最长题干 31 字（应用题）实测 5.8 s，所以按字数
# 给上限，而不是一刀切 3 s —— 那样会把最长的应用题误判成异常。
TTS_SEC_PER_CHAR = 0.28
TTS_MAX_SEC = 10.0                  # 绝对兜底，挡住卡死/拼接错的文件
TTS_MAX_BYTES = int(1.15 * 1024 * 1024)


def read(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()


def load(path):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def sha1(path):
    h = hashlib.sha1()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 16), b''):
            h.update(chunk)
    return h.hexdigest()


def relpath(path):
    return os.path.relpath(path, ROOT)


def refs_in_banks():
    """三科题库里所有引用到的音频 id。"""
    refs = set()
    for name in ('chinese.json', 'math.json', 'english.json'):
        path = os.path.join(DATA, name)
        if not os.path.exists(path):
            continue
        for q in load(path):
            stem = q.get('stem') or {}
            for aid in (stem.get('audio'), stem.get('promptAudio')):
                if aid:
                    refs.add(aid)
            for a in (q.get('audio') or []):
                if isinstance(a, str) and a:
                    refs.add(a)
                elif isinstance(a, dict) and a.get('id'):
                    refs.add(a['id'])
    return {a.replace('.mp3', '').replace('.wav', '') for a in refs}


def read_wav_pcm(path):
    """读 afconvert 产出的 16bit PCM WAV，返回 (采样率, 帧数, 原始字节)。

    **不能用标准库 wave。** 新版 macOS 的 afconvert 即使指定 `-d LEI16`，
    写出来的也是 WAVE_FORMAT_EXTENSIBLE（0xFFFE）而不是格式 1，而 Python
    3.9 的 wave 模块只认格式 1，直接抛 `unknown format: 65534`。表现为
    「语音体检 259 条全部解码失败」—— 音频本身是好的，是读的人不认识容器。
    这里手写解析，格式 1 和 0xFFFE 都接受。
    """
    data = open(path, 'rb').read()
    if data[:4] != b'RIFF' or data[8:12] != b'WAVE':
        raise ValueError('不是 RIFF/WAVE')

    fmt_tag = channels = bits = rate = None
    pcm = None
    i = 12
    while i + 8 <= len(data):
        cid = data[i:i + 4]
        size = struct.unpack('<I', data[i + 4:i + 8])[0]
        body = i + 8
        if cid == b'fmt ' and size >= 16:
            (fmt_tag, channels, rate, _byte_rate, _align, bits) = \
                struct.unpack('<HHIIHH', data[body:body + 16])
        elif cid == b'data':
            pcm = data[body:body + size]
            break
        i = body + size + (size & 1)

    if fmt_tag is None or pcm is None:
        raise ValueError('缺少 fmt / data 块')
    if fmt_tag not in (1, 0xFFFE):
        raise ValueError('不支持的 WAV 格式 %d' % fmt_tag)
    if bits != 16:
        raise ValueError('期望 16bit，实际 %d bit' % bits)
    if not channels:
        raise ValueError('声道数为 0')

    return rate, len(pcm) // 2 // channels, pcm


def pcm_stats(path, tmpdir):
    """afconvert 解成 16bit PCM WAV，返回 (时长, 峰值, RMS, 有声窗占比)。

    窗口取 20 ms，窗内 RMS 超过峰值 * 0.08 就算「有声」—— 比单纯看整段
    RMS 更能挡住「只有一个滴声」。
    """
    wav = os.path.join(tmpdir, os.path.basename(path) + '.wav')
    subprocess.run(['afconvert', '-f', 'WAVE', '-d', 'LEI16', path, wav],
                   check=True, capture_output=True)
    rate, n, raw = read_wav_pcm(wav)
    os.remove(wav)
    vals = struct.unpack('<%dh' % (len(raw) // 2), raw)
    if not vals:
        return (0.0, 0.0, 0.0, 0.0)
    peak = max(abs(v) for v in vals) / 32768.0
    sq = sum(v * v for v in vals) / len(vals)
    rms = math.sqrt(sq) / 32768.0
    win = max(1, int(rate * 0.02))
    voiced = 0
    total = 0
    for i in range(0, len(vals), win):
        chunk = vals[i:i + win]
        if not chunk:
            continue
        r = math.sqrt(sum(v * v for v in chunk) / len(chunk)) / 32768.0
        total += 1
        if peak > 0 and r > peak * 0.08:
            voiced += 1
    return (n / float(rate), peak, rms, voiced / float(total or 1))


def duration(path):
    out = subprocess.run(['afinfo', path], capture_output=True, text=True)
    if out.returncode != 0:
        return None
    m = re.search(r'estimated duration:\s+([\d.]+)', out.stdout)
    return float(m.group(1)) if m else None


def parse_map(path):
    """从 data.js / audio.js 里抠出 AUDIO_MAP 的 id → src。

    docs/data.js 前面还挂着一大段 window.G.DATA（题库），不能用「第一个
    {...}」去猜 —— 那样会解析到某道题的 stem 上，看起来像「70 条映射全丢
    了」。这里先定位 AUDIO_MAP / module.exports，再用 JSONDecoder 从它后面
    那个 { 开始读，读到完整对象为止。
    """
    text = read(path)
    start = -1
    for marker in ('AUDIO_MAP', 'module.exports'):
        p = text.find(marker)
        if p >= 0:
            start = text.find('{', p)
            if start >= 0:
                break
    if start < 0:
        start = text.find('{')
    if start < 0:
        return None
    try:
        obj, _end = json.JSONDecoder().raw_decode(text[start:])
        return obj if isinstance(obj, dict) else None
    except ValueError:
        return None


def check_tts(errs, stats, tmpdir, quick, have_tools):
    """中文题干朗读音频（小程序主包）：清单 ↔ 规则 ↔ 映射 ↔ 文件 ↔ 解码。"""
    if not os.path.exists(TTS_SPEC):
        errs.append('缺少 %s' % relpath(TTS_SPEC))
        return
    entries = (load(TTS_SPEC).get('entries') or [])
    if not entries:
        errs.append('题干音频清单是空的')
        return

    # 规则漂移：清单必须和 22-tts-text.js 现在的输出逐字一致。
    # 有人改了归一化规则却没重生成音频，这里会立刻挡住。
    r = subprocess.run(['node', os.path.join(ROOT, 'tools', 'tts_texts.js')],
                       capture_output=True, text=True)
    if r.returncode:
        errs.append('tools/tts_texts.js 跑不动：' + r.stderr.strip()[:120])
    elif json.loads(r.stdout) != sorted(e['text'] for e in entries):
        errs.append('题干音频清单与朗读规则不一致，跑 npm run tts:audio 重建')

    if not os.path.exists(TTS_MAP):
        errs.append('缺少 %s' % relpath(TTS_MAP))
    else:
        amap = parse_map(TTS_MAP)
        want = {e['text']: '/ttsAudio/' + e['file'] for e in entries}
        if amap is None:
            errs.append('tts-map.js 里的映射解析不出来')
        elif amap != want:
            errs.append('tts-map.js 与清单不一致，跑 npm run tts:audio 重建')

    wanted = set(e['file'] for e in entries)
    total = 0
    for e in entries:
        path = os.path.join(TTS_DIR, e['file'])
        if not os.path.exists(path):
            errs.append('题干音频缺文件 %s' % e['file'])
            continue
        size = os.path.getsize(path)
        total += size
        stats['tts_files'] += 1
        stats['tts_bytes'] += size
        if size < 1000:
            errs.append('%s 只有 %d 字节，可能是空音频' % (e['file'], size))
        with open(path, 'rb') as f:
            head = f.read(12)
        if head[4:8] != b'ftyp':
            errs.append('%s 不是 m4a（缺 ftyp 头）' % e['file'])

        if have_tools:
            sec = duration(path)
            if sec is None:
                errs.append('%s 无法被 afinfo 解析' % e['file'])
            else:
                stats['tts_min_sec'] = sec if stats['tts_min_sec'] is None else min(stats['tts_min_sec'], sec)
                stats['tts_max_sec'] = sec if stats['tts_max_sec'] is None else max(stats['tts_max_sec'], sec)
                limit = min(TTS_MAX_SEC, max(3.0, len(e['text']) * TTS_SEC_PER_CHAR))
                if sec > limit:
                    errs.append('%s 时长 %.2fs，超过按 %d 字估算的 %.2fs 上限'
                                % (e['file'], sec, len(e['text']), limit))
            if not quick:
                try:
                    _s, peak, rms, voiced = pcm_stats(path, tmpdir)
                except Exception as ex:
                    errs.append('%s 解码失败：%s' % (e['file'], ex))
                else:
                    stats['tts_decoded'] += 1
                    for key, val in (('tts_min_peak', peak), ('tts_min_rms', rms),
                                     ('tts_min_voiced', voiced)):
                        stats[key] = val if stats[key] is None else min(stats[key], val)
                    if peak < MIN_PEAK or rms < MIN_RMS:
                        errs.append('%s 几乎是静音（峰值 %.3f / RMS %.3f）' % (e['file'], peak, rms))
                    elif voiced < MIN_VOICED:
                        errs.append('%s 只有 %.0f%% 的时长有声' % (e['file'], voiced * 100))

    extra = [n for n in os.listdir(TTS_DIR)
             if n.endswith('.m4a') and n not in wanted]
    if extra:
        errs.append('题干音频目录有 %d 个多余文件：%s' % (len(extra), ', '.join(extra[:4])))
    if total > TTS_MAX_BYTES:
        errs.append('题干音频 %.2f MB，超出主包预算 %.2f MB'
                    % (total / 1024.0 / 1024.0, TTS_MAX_BYTES / 1024.0 / 1024.0))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--quick', action='store_true', help='跳过 PCM 解码')
    ap.add_argument('--json', action='store_true', help='输出 JSON')
    args = ap.parse_args()

    errs = []
    warns = []
    stats = {'files': 0, 'decoded': 0, 'bytes': 0,
             'min_sec': None, 'max_sec': None,
             'min_peak': None, 'min_rms': None, 'min_voiced': None,
             'tts_files': 0, 'tts_decoded': 0, 'tts_bytes': 0,
             'tts_min_sec': None, 'tts_max_sec': None,
             'tts_min_peak': None, 'tts_min_rms': None, 'tts_min_voiced': None}

    # ---- 1. 引用层 ----
    spec = load(SPEC)['entries'] if os.path.exists(SPEC) else []
    spec_ids = {e['id'] for e in spec}
    refs = refs_in_banks()
    if not spec:
        errs.append('缺少 %s' % relpath(SPEC))
    else:
        for aid in sorted(refs - spec_ids):
            errs.append('题库引用了 %s，但语音清单里没有' % aid)
        for aid in sorted(spec_ids - refs):
            errs.append('语音清单里的 %s 没有题目引用' % aid)
        if len(spec_ids) != len(spec):
            errs.append('语音清单有重复 id')

    manifest = load(MANIFEST)['entries'] if os.path.exists(MANIFEST) else {}
    if not manifest:
        errs.append('缺少 %s' % relpath(MANIFEST))
    else:
        for aid in sorted(spec_ids - set(manifest)):
            errs.append('audio_manifest.json 里缺少 %s' % aid)
        for aid in sorted(set(manifest) - spec_ids):
            errs.append('audio_manifest.json 里的 %s 已不在语音清单中' % aid)
        by_text = {e['id']: e['text'] for e in spec}
        for aid in sorted(spec_ids & set(manifest)):
            e = manifest[aid]
            want = hashlib.sha1(by_text[aid].encode('utf-8')).hexdigest()
            if e.get('text_sha1') != want:
                errs.append('%s：清单里的 text_sha1 和要读的文本对不上' % aid)

    have_tools = bool(shutil.which('afinfo') and shutil.which('afconvert'))
    if not have_tools:
        warns.append('找不到 afinfo / afconvert，跳过时长与 PCM 检查（只能在 macOS 上做）')

    tmpdir = tempfile.mkdtemp(prefix='check_audio_')
    try:
        # ---- 2–4. 文件 / 内容 / 副本 ----
        for aid in sorted(spec_ids):
            e = manifest.get(aid) or {}
            rel = e.get('path') or (aid.replace('.', '/') + '.m4a')
            master = os.path.join(MASTER, rel)
            if not os.path.exists(master):
                errs.append('缺文件 %s' % relpath(master))
                continue
            size = os.path.getsize(master)
            stats['files'] += 1
            stats['bytes'] += size
            if size < MIN_BYTES:
                errs.append('%s 只有 %d 字节，可能是占位文件' % (aid, size))
            with open(master, 'rb') as f:
                head = f.read(12)
            if head[4:8] != b'ftyp':
                errs.append('%s 不是 m4a（缺 ftyp 头）' % aid)
            if e.get('sha1') and e['sha1'] != sha1(master):
                errs.append('%s 的 sha1 与 audio_manifest.json 不符（文件被改过或没重新生成）' % aid)

            if have_tools:
                sec = duration(master)
                if sec is None:
                    errs.append('%s 无法被 afinfo 解析' % aid)
                else:
                    stats['min_sec'] = sec if stats['min_sec'] is None else min(stats['min_sec'], sec)
                    stats['max_sec'] = sec if stats['max_sec'] is None else max(stats['max_sec'], sec)
                    if not MIN_SEC <= sec <= MAX_SEC:
                        errs.append('%s 时长 %.2fs，不在 %.2f–%.2fs 之间'
                                    % (aid, sec, MIN_SEC, MAX_SEC))
                if not args.quick:
                    try:
                        _s, peak, rms, voiced = pcm_stats(master, tmpdir)
                    except Exception as ex:
                        errs.append('%s 解码失败：%s' % (aid, ex))
                    else:
                        stats['decoded'] += 1
                        stats['min_peak'] = peak if stats['min_peak'] is None else min(stats['min_peak'], peak)
                        stats['min_rms'] = rms if stats['min_rms'] is None else min(stats['min_rms'], rms)
                        stats['min_voiced'] = voiced if stats['min_voiced'] is None else min(stats['min_voiced'], voiced)
                        if peak < MIN_PEAK or rms < MIN_RMS:
                            errs.append('%s 几乎是静音（峰值 %.3f / RMS %.3f）'
                                        % (aid, peak, rms))
                        elif voiced < MIN_VOICED:
                            errs.append('%s 只有 %.0f%% 的时长有声，可能是一声滴'
                                        % (aid, voiced * 100))

            for label, base in COPIES:
                dest = os.path.join(base, rel)
                if not os.path.exists(dest):
                    errs.append('%s 副本缺文件 %s' % (label, relpath(dest)))
                elif sha1(dest) != sha1(master):
                    errs.append('%s 副本 %s 与主文件不一致（跑 npm run mp:build / npm run build）'
                                % (label, relpath(dest)))

        # ---- 5. 映射 ----
        for label, path, base in MAPS:
            if not os.path.exists(path):
                errs.append('%s 不存在' % label)
                continue
            amap = parse_map(path)
            if amap is None:
                errs.append('%s 里的音频映射解析不出来' % label)
                continue
            missing = sorted(spec_ids - set(amap))
            extra = sorted(set(amap) - spec_ids)
            if missing:
                errs.append('%s 少了 %d 条映射：%s'
                            % (label, len(missing), ', '.join(missing[:6])))
            if extra:
                warns.append('%s 有 %d 条多余映射：%s'
                             % (label, len(extra), ', '.join(extra[:6])))
            for aid, src in amap.items():
                if isinstance(src, dict):
                    src = src.get('src') or ''
                if src.startswith('data:'):
                    continue
                if src.startswith('/generated/audio/'):
                    rel = src[len('/generated/audio/'):]
                elif src.startswith('audio/'):
                    rel = src[len('audio/'):]
                else:
                    continue
                if not os.path.exists(os.path.join(base, rel)):
                    errs.append('%s 里 %s 指向的 %s 不存在' % (label, aid, rel))

        # ---- 6. 中文题干朗读音频（小程序主包） ----
        check_tts(errs, stats, tmpdir, args.quick, have_tools)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    if args.json:
        print(json.dumps({'ok': not errs, 'errors': errs, 'warnings': warns,
                          'stats': stats}, ensure_ascii=False, indent=2))
        return 0 if not errs else 1

    print('')
    print('语音体检  audio/ · docs/ · miniprogram/')
    print('=' * 52)
    print('  语音清单 %3d 条   题库引用 %3d 条' % (len(spec_ids), len(refs)))
    print('  主文件   %3d 个   %s' % (stats['files'],
                                     ('%.1f KB' % (stats['bytes'] / 1024.0))))
    if stats['min_sec'] is not None:
        print('  时长     %.2f – %.2f s' % (stats['min_sec'], stats['max_sec']))
    if stats['decoded']:
        print('  已解码   %3d 条   最低峰值 %.3f / 最低 RMS %.3f / 最低有声占比 %.0f%%'
              % (stats['decoded'], stats['min_peak'], stats['min_rms'],
                 stats['min_voiced'] * 100))
    elif not args.quick and have_tools:
        print('  已解码   0 条')
    print('')
    print('题干朗读音频（小程序主包 ttsAudio/）')
    print('-' * 52)
    print('  文件     %3d 条   %.2f MB' % (stats['tts_files'], stats['tts_bytes'] / 1024.0 / 1024.0))
    if stats['tts_min_sec'] is not None:
        print('  时长     %.2f – %.2f s' % (stats['tts_min_sec'], stats['tts_max_sec']))
    if stats['tts_decoded']:
        print('  已解码   %3d 条   最低峰值 %.3f / 最低 RMS %.3f / 最低有声占比 %.0f%%'
              % (stats['tts_decoded'], stats['tts_min_peak'], stats['tts_min_rms'],
                 stats['tts_min_voiced'] * 100))
    print('')
    for w in warns:
        print('  ⚠️  %s' % w)
    if errs:
        print('❌ 发现 %d 个问题：' % len(errs))
        for e in errs[:25]:
            print('   · %s' % e)
        if len(errs) > 25:
            print('   …… 还有 %d 条' % (len(errs) - 25))
        print('')
        return 1
    print('✅ 语音正常：单词音频的清单/文件/内容/三处副本/两端映射，以及题干朗读音频全部通过')
    print('')
    return 0


if __name__ == '__main__':
    sys.exit(main())
