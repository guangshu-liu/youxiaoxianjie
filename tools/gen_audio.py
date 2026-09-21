#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_audio.py — 语音生成（macOS 自带 say，不联网、不装任何东西）

产出：
    audio/en/<word>.m4a        英语单词
    audio/en/sentence/<n>.m4a  英语句子
    tools/audio_manifest.json  清单（id → 路径 + 文本哈希）

为什么用 say 而不是 edge-tts：
    这个项目有一条硬规矩 —— 「零依赖，半年后回来还能构建成功」。edge-tts
    要 pip 安装、要联网、依赖微软的接口；say 是每台 mac 都有的，afconvert
    也是。代价是音色不如云端 TTS 自然，但对「cat 读作什么」这种单词发音
    完全够用，而且**离线可复现**：同一句文本任何时候生成的都是同一条音频。

    非 macOS 上这个脚本会直接告诉你它跑不了，而不是产出一堆空文件 ——
    之前 audio/ 里那批 12204 字节的蜂鸣占位音就是这么来的。

为什么音频要做成文件而不是运行时用 SpeechSynthesis：
    iOS 的 SpeechSynthesis 在微信内置浏览器里时好时坏，而英语听音题
    一旦读不出声，那道题就完全没法做。预生成的文件走的是 Web Audio，
    和转盘音效同一条路径 —— 那条路径已经为 iOS 的自动播放限制做了处理。

用法：
    python3 tools/gen_audio.py            # 只生成缺失/变更的
    python3 tools/gen_audio.py --force    # 全部重新生成
    python3 tools/gen_audio.py --check    # 只报告缺什么，不生成
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
SRC = os.path.join(ROOT, 'src')
DATA = os.path.join(SRC, 'data')
AUDIO = os.path.join(ROOT, 'audio')
MANIFEST = os.path.join(ROOT, 'tools', 'audio_manifest.json')

# 输出格式。AAC/m4a：iOS 原生支持，同一段语音比 WAV 小一个数量级
# （一条单词 8 KB 左右，WAV 要 60 KB）。单文件版要把全部音频 base64 内联，
# 这个差别直接决定产物是 1 MB 还是 6 MB。
EXT = '.m4a'
AF_CONVERT = ['afconvert', '-f', 'm4af', '-d', 'aac', '-b', '32000']


def log(msg):
    print(msg, flush=True)


def sha1_text(s):
    return hashlib.sha1(s.encode('utf-8')).hexdigest()


def read(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()


def load_manifest():
    if not os.path.exists(MANIFEST):
        return {'version': 1, 'entries': {}}
    with open(MANIFEST, 'r', encoding='utf-8') as f:
        m = json.load(f)
    m.setdefault('entries', {})
    return m


def save_manifest(m):
    with open(MANIFEST, 'w', encoding='utf-8') as f:
        json.dump(m, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write('\n')


def audio_id_to_path(aid):
    """'en.sentence.01' → 'en/sentence/01.m4a'。

    id 就是路径把 / 换成 . —— 代码引用音频不需要第二张映射表，这条规矩
    从项目第一天起就在，别改。
    """
    return aid.replace('.', '/') + EXT


# ---------------------------------------------------------------- 待生成的清单

def collect():
    """从题库里收集所有被引用的音频，回填文本。

    音频清单（src/data/english_audio.json）由 gen_yingyu.py 产出，那里有
    文本；题库里的 stem.audio 只有 id。两边必须对得上 —— 对不上直接报错，
    不要静默跳过（跳过会变成「题在、声音没有」，在真机上才发现）。
    """
    spec_path = os.path.join(DATA, 'english_audio.json')
    if not os.path.exists(spec_path):
        return {}, []

    spec = json.loads(read(spec_path))
    by_id = {}
    for e in spec.get('entries', []):
        by_id[e['id']] = e

    wanted = {}
    errors = []
    for name in ('chinese.json', 'math.json', 'english.json'):
        path = os.path.join(DATA, name)
        if not os.path.exists(path):
            continue
        for q in json.loads(read(path)):
            stem = q.get('stem') or {}
            refs = [stem.get('audio'), stem.get('promptAudio')]
            refs += [a if isinstance(a, str) else a.get('id')
                     for a in (q.get('audio') or [])]
            for aid in refs:
                if not aid:
                    continue
                aid = aid.replace('.mp3', '').replace('.wav', '')
                if aid not in by_id:
                    errors.append('%s：引用了 %s，但它不在 english_audio.json 里'
                                  % (q.get('id'), aid))
                    continue
                wanted[aid] = by_id[aid]

    # 清单里有、却没人引用的条目同样是错 —— 会白生成一批没人用的文件
    for aid in sorted(set(by_id) - set(wanted)):
        errors.append('english_audio.json 里的 %s 没有被任何题目引用' % aid)

    return wanted, errors


# ---------------------------------------------------------------- 生成

def check_tools():
    missing = [t for t in ('say', 'afconvert') if not shutil.which(t)]
    if missing:
        return ('找不到 %s。这个脚本依赖 macOS 自带的 say + afconvert，'
                '其它系统上请改用任意 TTS 生成同名文件。' % '、'.join(missing))
    return None


def synth(text, voice, dest):
    """say 出声 → afconvert 转 AAC → 落到 dest。"""
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmpdir = tempfile.mkdtemp(prefix='gen_audio_')
    aiff = os.path.join(tmpdir, 't.aiff')
    try:
        subprocess.run(['say', '-v', voice, '-o', aiff, text],
                       check=True, capture_output=True)
        subprocess.run(AF_CONVERT + [aiff, dest], check=True, capture_output=True)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    return os.path.getsize(dest)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true', help='只报告缺什么，不生成')
    ap.add_argument('--force', action='store_true', help='全部重新生成')
    ap.add_argument('--quiet', action='store_true')
    args = ap.parse_args()

    wanted, errors = collect()
    if errors:
        log('❌ 音频清单和题库对不上：')
        for e in errors[:20]:
            log('   · %s' % e)
        if len(errors) > 20:
            log('   …… 还有 %d 条' % (len(errors) - 20))
        log('   先跑 npm run yingyu 重新生成题库和音频清单')
        return 1

    if not wanted:
        if not args.quiet:
            log('  没有需要语音的题目')
        return 0

    manifest = load_manifest()
    entries = manifest['entries']

    todo, ready = [], []
    for aid in sorted(wanted):
        e = wanted[aid]
        rel = audio_id_to_path(aid)
        abs_path = os.path.join(AUDIO, rel)
        text_sha = sha1_text(e['text'])

        if (os.path.exists(abs_path) and not args.force
                and entries.get(aid, {}).get('text_sha1') == text_sha):
            ready.append(aid)
            continue
        todo.append((aid, e, rel, abs_path, text_sha))

    if args.check:
        if todo:
            log('❌ 有 %d 条音频缺失或与文本不一致：' % len(todo))
            for aid, _e, _r, _a, _s in todo[:10]:
                log('   · %s' % aid)
            if len(todo) > 10:
                log('   …… 还有 %d 条' % (len(todo) - 10))
            log('   跑一次 npm run audio 生成')
            return 1
        if not args.quiet:
            log('✅ 语音齐了（%d 条）' % len(ready))
        return 0

    err = check_tools()
    if err and todo:
        log('❌ %s' % err)
        return 2

    made = 0
    total_bytes = 0
    for aid, e, rel, abs_path, text_sha in todo:
        try:
            size = synth(e['text'], e.get('voice') or 'Samantha', abs_path)
        except subprocess.CalledProcessError as ex:
            log('❌ %s 生成失败：%s' % (aid, (ex.stderr or b'').decode('utf-8', 'replace')))
            return 3
        total_bytes += size
        made += 1
        entries[aid] = {
            'path': rel,
            'text': e['text'],
            'voice': e.get('voice') or 'Samantha',
            'text_sha1': text_sha,
            'sha1': hashlib.sha1(open(abs_path, 'rb').read()).hexdigest(),
        }

    # 清掉不再被引用的条目和它们的文件
    dropped = []
    for aid in sorted(set(entries) - set(wanted)):
        rel = entries[aid]['path']
        p = os.path.join(AUDIO, rel)
        if os.path.exists(p):
            os.remove(p)
        del entries[aid]
        dropped.append(aid)

    manifest['version'] = 1
    save_manifest(manifest)

    # 清掉空目录（en/ 下没有句子时就别留一个空壳）
    for dirpath, dirnames, filenames in os.walk(AUDIO, topdown=False):
        if dirpath != AUDIO and not os.listdir(dirpath):
            os.rmdir(dirpath)

    if not args.quiet:
        log('')
        log('语音已生成')
        log('=' * 44)
        log('  新生成   %3d 条  %s' % (made, _fmt(total_bytes) if made else ''))
        log('  已是最新 %3d 条' % len(ready))
        if dropped:
            log('  已清理   %3d 条（不再被题库引用）' % len(dropped))
        log('  合计     %3d 条' % len(entries))
        log('')
        log('  → audio/ + tools/audio_manifest.json')
        log('')
    return 0


def _fmt(n):
    if n < 1024:
        return '%d B' % n
    if n < 1024 * 1024:
        return '%.1f KB' % (n / 1024)
    return '%.2f MB' % (n / 1024 / 1024)


if __name__ == '__main__':
    sys.exit(main())
