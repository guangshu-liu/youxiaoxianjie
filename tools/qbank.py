#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
qbank.py — 三个题库生成器共用的底座

语文 / 数学 / 英语各有一个生成器（gen_ziku.py / gen_shuxue.py /
gen_yingyu.py），它们产出的题目必须是**同一个 schema** —— 运行时的
渲染器只认这一套字段，任何一家走样都会在真机上白屏。

所以拼题、序列化、通用校验这三件事只写一遍，放在这里。

为什么是生成器而不是手写 JSON：
    手写几百道题的选项，必然出现「answer 指向不存在的选项」「两个选项
    都说得通」「选项里混进了超纲的字」这三类错，而且靠眼睛查不出来。
    生成器把「范围」变成一条机器可校验的约束。

产物必须可复现：同一份输入跑两次得到逐字节相同的 JSON，`--check` 才有
意义。所以这里不用 Python 内置的 hash()（每个进程换种子），自己写了
dhash()。
"""

import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'src', 'data')


# ---------------------------------------------------------------- 确定性随机

def dhash(text):
    """确定性字符串哈希（FNV-1a）。内置 hash() 每个进程换种子，会让产物不可复现。"""
    h = 2166136261
    for ch in text:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return h


class Rng(object):
    """线性同余。固定种子 → 每次生成同一份题库，git diff 才可读。"""

    def __init__(self, seed=20260921):
        self.s = (seed & 0x7FFFFFFF) or 1

    def next(self):
        self.s = (1103515245 * self.s + 12345) & 0x7FFFFFFF
        return self.s / 0x80000000

    def int(self, lo, hi):
        return lo + int(self.next() * (hi - lo + 1))

    def shuffle(self, arr):
        a = list(arr)
        for i in range(len(a) - 1, 0, -1):
            j = self.int(0, i)
            a[i], a[j] = a[j], a[i]
        return a


def seeded(*parts):
    """从若干个字符串拼出一个固定种子的 Rng —— 同一个 qid 永远同一份选项顺序。"""
    return Rng(dhash('|'.join(str(p) for p in parts)) & 0xFFFF)


def interleave(groups):
    """把若干组元素轮着抽，拼成一个列表。

    为什么需要它：生成器是按题型分块的，切片 `[:cap]` 取的是**前面**那些。
    如果某一类内部是按类别成块排列的（归类题的动物、颜色、数字…），
    切片就会把所有位置都留给排在前面的类别，配比失控。
    """
    groups = [list(g) for g in groups]
    out = []
    while any(groups):
        for g in groups:
            if g:
                out.append(g.pop(0))
    return out


# ---------------------------------------------------------------- 拼题

def make_choice(subject, qid, tag, difficulty, stem, answer, distractors,
                explain, layout='grid'):
    """拼一道选择题。选项打乱，答案位置不固定 —— 否则孩子会背「选 b」。

    stem 可以是字符串（纯文字题干），也可以是 dict（需要额外字段时，
    比如英语听音题的 stem.audio）。返回的题目对所有科目都是同一套字段。
    """
    opts = [answer] + list(distractors)
    opts = seeded(qid).shuffle(opts)

    # 选项文字可能重复（数学题的选项都是数字），去重后按原顺序补位没有意义，
    # 这里直接断言唯一 —— 重复选项一定是出题逻辑写错了。
    if len(set(opts)) != len(opts):
        raise ValueError('%s：选项里有重复内容 %s' % (qid, opts))

    letters = 'abcd'
    options = [{'id': letters[i], 'text': t} for i, t in enumerate(opts)]
    ans_id = [o['id'] for o in options if o['text'] == answer][0]

    if isinstance(stem, dict):
        stem_obj = dict(stem)
        stem_obj.setdefault('layout', layout)
    else:
        stem_obj = {'text': stem, 'layout': layout}

    return {
        'id': qid,
        'subject': subject,
        'type': 'choice',
        'difficulty': difficulty,
        'unit': None,
        'family': None,
        'tags': [tag],
        'stem': stem_obj,
        'options': options,
        'answer': ans_id,
        'explain': explain,
    }


# ---------------------------------------------------------------- 通用校验

def selfcheck_common(questions, limit):
    """所有科目共用的结构校验。返回错误字符串列表（空 = 通过）。

    这几条断言就是「一道题有没有唯一正确答案」的机器版本 ——
    内容题最大的风险不是崩溃，是答案错了但没人发现。
    """
    errs = []
    ids = set()

    for q in questions:
        qid = q.get('id', '?')
        if qid in ids:
            errs.append('%s：id 重复' % qid)
        ids.add(qid)

        if q.get('type') != 'choice':
            errs.append('%s：type 不是 choice（%s）' % (qid, q.get('type')))
        if not q.get('subject'):
            errs.append('%s：缺少 subject' % qid)
        if not q.get('tags'):
            errs.append('%s：缺少 tags' % qid)
        if not q.get('explain'):
            errs.append('%s：缺少 explain' % qid)

        stem = q.get('stem') or {}
        if not stem.get('text') and not stem.get('audio'):
            errs.append('%s：题干既没有文字也没有音频' % qid)
        # 只有音频没有文字的题干，渲染出来就是一个孤零零的喇叭按钮，
        # 孩子不知道要他干什么。渲染器现在两者都画，这里保证两者都在。
        if stem.get('audio') and not stem.get('text'):
            errs.append('%s：有音频就必须有文字题干' % qid)
        if not stem.get('layout'):
            errs.append('%s：题干缺少 layout' % qid)

        opts = q.get('options', [])
        texts = [o['text'] for o in opts]
        if len(opts) != 4:
            errs.append('%s：选项不是 4 个（%d）' % (qid, len(opts)))
        if len(set(texts)) != len(texts):
            errs.append('%s：选项重复 %s' % (qid, texts))
        if q.get('answer') not in [o['id'] for o in opts]:
            errs.append('%s：answer 不在选项里' % qid)

        for o in opts:
            if not str(o.get('text', '')).strip():
                errs.append('%s：选项 %s 是空的' % (qid, o.get('id')))

    if len(questions) > limit:
        errs.append('题量 %d 超过上限 %d' % (len(questions), limit))

    return errs


# ---------------------------------------------------------------- 序列化 / CLI

def write_json(path, obj):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write('\n')


def run(description, subject, path, generate, limit, extra_checks=None,
        report_extra=None):
    """生成器的 main()。

    每个生成器的 main() 只有三件事要自己做：算出题目、写出题目、打印报告；
    校验失败要挡住写入、`--check` 要挡住「产物和生成结果不一致」——
    这两条每个生成器都得有，写一遍就够。
    """
    ap = argparse.ArgumentParser(description=description)
    ap.add_argument('--check', action='store_true',
                    help='只校验产物是否与生成结果一致')
    ap.add_argument('--quiet', action='store_true', help='只输出错误')
    args = ap.parse_args()

    questions, report = generate()

    errs = selfcheck_common(questions, limit)
    if extra_checks:
        errs += extra_checks(questions)

    if errs:
        print('❌ %s 出题自检未通过：' % subject)
        for e in errs[:25]:
            print('   · %s' % e)
        if len(errs) > 25:
            print('   …… 还有 %d 条' % (len(errs) - 25))
        return 1

    if args.check:
        if not os.path.exists(path):
            print('❌ 缺少 %s' % os.path.relpath(path, ROOT))
            print('   跑一次 python3 tools/%s 重新生成' % os.path.basename(sys.argv[0]))
            return 1
        with open(path, 'r', encoding='utf-8') as f:
            if json.load(f) != questions:
                print('❌ %s 与生成结果不一致' % os.path.relpath(path, ROOT))
                print('   跑一次 python3 tools/%s 重新生成' % os.path.basename(sys.argv[0]))
                return 1
        if not args.quiet:
            print('✅ %s 题库是最新的（%d 道）' % (subject, len(questions)))
        return 0

    write_json(path, questions)

    if not args.quiet:
        print('')
        print('%s 题库已生成' % subject)
        print('=' * 44)
        for label, c in report:
            print('  %-14s %3d 道' % (label, c))
        print('  %-14s %3d 道   (上限 %d)' % ('合计', len(questions), limit))
        if report_extra:
            print('')
            print(report_extra(questions))
        print('')
        print('  → %s' % os.path.relpath(path, ROOT))
        print('')
    return 0
