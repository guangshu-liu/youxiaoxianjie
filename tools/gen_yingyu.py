#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_yingyu.py — 英语（牛津自然拼读 OPW1 · The Alphabet）题库生成器

产出两个文件：
    src/data/english.json        英语题库（120 道，全部 choice 题型）
    src/data/english_audio.json  题库引用到的语音清单（tools/gen_audio.py
                                 读它去调 macOS 的 say，这里只管清单对得上）

**这一版把范围降到 OPW1（字母本）。** 上一版是 OPW2 的词族和短元音，
要求孩子能读 CVC 词、能读整句 —— 对 5–7 岁刚开始认字母的孩子太难了。
OPW1 只教三件事：字母的名字、大写和小写的形状、字母在词首的发音。

所以题型整个换掉了，**四种旧题型一种都不留**：

    旧（OPW2）              为什么留不住
    听音选词（读 CVC 词）   孩子还不会读词，四个单词选项对他就是四张图
    词族归类（押韵）        要先会读词、再分析韵尾，OPW2 的内容
    句子填空（读整句）      OPW1 阶段读不了整句
    找真词（拼读判断）      要会拼读才谈得上「真词」「假词」

新题型全部只依赖字母，不需要读任何英语单词：

    听音选字母 70 · 大小写配对 52 · 字母顺序 48 · 元音字母 30 = 200

四者的共同点：**唯一答案都是构造保证的**，不靠出题人的语感。听音题是
「四个选项两两不同音」，配对题是「只有一个选项是那个字母的另一半」，
顺序题是「只有一个选项是相邻的那个字母」，元音题是「干扰项全是辅音」。
selfcheck 把这四条都翻成了机器能判定的断言。

词源只有一张表 LETTER_WORDS：26 个字母各配 3 个词，全是 OPW1 里会出现
的具体名词（apple / bear / cat …）。x 特殊 —— 英语里几乎没有以 x 开头的
词，OPW1 教的是**词尾**的 x（box / fox / six），所以 x 不进听音选字母。

产物必须可复现：跑两次得到逐字节相同的 JSON，`--check` 才有意义。
所有随机都走 tools/qbank.py 的 seeded()，不用内置 random，也不用 hash()。

用法：
    python3 tools/gen_yingyu.py            # 生成
    python3 tools/gen_yingyu.py --check    # 只校验产物是否与生成结果一致
"""

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Rng / dhash 在本文件里没有直接用上（要随机的地方一律走 seeded()，它俩在
# 里面），留着是因为这条 import 是三个科目的生成器共用的接口，别单方面改。
from qbank import (
    DATA, ROOT, Rng, dhash, interleave, make_choice, run, seeded, write_json,
)

# ---------------------------------------------------------------- 词源

LETTERS = 'abcdefghijklmnopqrstuvwxyz'
UPPER = LETTERS.upper()

# 26 个字母，每个 3 个词。选词的标准：具体、能指着说、首字母就是目标字母。
# 这套词表是全部题目的唯一词源 —— 听音题的音频读的就是这里面的词，
# selfcheck 反过来验「音频里的词确实在这个字母下面」。
#
# x 例外：英语里 x 极少出现在词首（xylophone 这种不算日常词），OPW1 教的是
# 词尾的 x。所以 x 的三个词是 box / fox / six，且 x 不参与「听音选字母」。
LETTER_WORDS = {
    'a': ('apple', 'ant', 'ax'),
    'b': ('bear', 'bed', 'ball'),
    'c': ('cat', 'cup', 'car'),
    'd': ('dog', 'duck', 'desk'),
    'e': ('egg', 'elephant', 'elbow'),
    'f': ('fish', 'fan', 'fork'),
    'g': ('goat', 'gate', 'girl'),
    'h': ('hat', 'horse', 'hand'),
    'i': ('igloo', 'ink', 'insect'),
    'j': ('jam', 'jet', 'juice'),
    'k': ('kite', 'key', 'king'),
    'l': ('lion', 'leaf', 'lemon'),
    'm': ('monkey', 'moon', 'milk'),
    'n': ('nest', 'nose', 'nut'),
    'o': ('octopus', 'ostrich', 'ox'),
    'p': ('pig', 'pen', 'panda'),
    'q': ('queen', 'quilt', 'question'),
    'r': ('rabbit', 'red', 'ring'),
    's': ('sun', 'snake', 'sock'),
    't': ('tiger', 'ten', 'tree'),
    'u': ('umbrella', 'up', 'under'),
    'v': ('van', 'vest', 'violin'),
    'w': ('water', 'window', 'watch'),
    'x': ('box', 'fox', 'six'),
    'y': ('yam', 'yellow', 'yes'),
    'z': ('zebra', 'zoo', 'zip'),
}

# 读起来是同一个音的字母。c 和 k 在词首都是 /k/ —— 听音题里让它们同时当
# 选项，这道题就有两个正确答案（「听到 cat，选 C 还是 K？」），而这种情况
# 肉眼审题是看不出来的。SOUND 把同音字母映射到同一个键，出题时避开、
# 自检时再验一遍。
#
# q 也归进 /k/：它读 /kw/，严格说不是同一个音，但对 6 岁孩子来说
# 「queen 用 K 开头」是一个非常合理的错答 —— 让 K 当 Q 的干扰项，等于
# 在考音标而不是考字母。宁可少一个干扰项，也不要一道冤枉题。
#
# 其他的「容易混」是字形问题（b/d/p/q），那是大小写配对故意要考的，
# 不是听音题的错误答案。
SOUND = {'C': 'k', 'K': 'k', 'Q': 'k'}


def sound(letter):
    return SOUND.get(letter, letter)


# 元音字母。孩子先知道「哪五个是元音」，到 OPW2 学短元音时才有落点 ——
# 元音字母本身是 OPW1 的知识，元音发什么音是 OPW2 的。
VOWELS = 'AEIOU'
CONSONANTS = ''.join(c for c in UPPER if c not in VOWELS)


# ---------------------------------------------------------------- 题库模板

# 五种题干。selfcheck 拿它们**反查**每道题的题干，于是「生成器里改了一个字
# 而题库没重生成」这种事不可能悄悄发生。
LISTEN_STEM = '听一听，这个词开头是哪个大写字母？'
CASE_UPPER_STEM = '大写 %s 的小写是哪个？'
CASE_LOWER_STEM = '小写 %s 的大写是哪个？'
# 用「下一个 / 上一个」而不是「后面 / 前面」：问「C 后面是哪个字母」时，
# D 在 C 后面，E、F 也在 C 后面 —— 干扰项恰好是 E/F，这句话就变成了
# 「四个选项都说得通」。这道题考的是**紧挨着**的那一个，题干必须说清楚。
ORDER_AFTER_STEM = '字母 %s 的下一个字母是哪个？'
ORDER_BEFORE_STEM = '字母 %s 的上一个字母是哪个？'
VOWEL_STEM = '下面哪个是元音字母？'

# 全库禁用字符：音标。上一版把 curriculum 的 rime 字段漏进过题库，孩子看到
# /æm/ 只会发懵。这条是硬断言，不是提醒。
IPA_CHARS = set('æɪʊɒʌəɜɔʃʒθðŋɑɛɹʧʤˈˌːˑ')

# 语音清单里的音色。固定值：另一个脚本读这张清单去调 macOS 的 say。
VOICE = 'Samantha'


def answer_text(q):
    """这道题正确选项的文字。"""
    return [o['text'] for o in q['options'] if o['id'] == q['answer']][0]


def option_texts(q):
    return [o['text'] for o in q['options']]


# ---------------------------------------------------------------- 干扰项

def listen_distractors(seed_key, answer):
    """听音选字母的干扰项：三个和答案**不同音**的大写字母。

    不同音是硬要求，见 SOUND 的注释。这里顺便保证三个干扰项彼此也不同音 ——
    否则四个选项里可能出现 C 和 K，孩子会觉得「两个对」。
    """
    pool = [c for c in UPPER
            if c != answer and sound(c) != sound(answer)]
    out = []
    used = {sound(answer)}
    for c in seeded(seed_key).shuffle(pool):
        k = sound(c)
        if k in used:
            continue
        used.add(k)
        out.append(c)
        if len(out) == 3:
            break
    return out


# 字形相近的字母。大小写配对题里优先拿这些当干扰项 —— b/d/p/q 长得像，
# 必须真的看清才选得对，这比拿 Q/X/M 当干扰项有意义得多。
# 键是小写，大写方向由调用方转成大写。
CASE_CONFUSE = {
    'b': 'dpq', 'd': 'bpq', 'p': 'bdq', 'q': 'bdp',
    'm': 'nw', 'n': 'mh', 'u': 'nv', 'v': 'uw', 'w': 'vm',
    'i': 'jl', 'j': 'il', 'l': 'ij', 't': 'fl', 'f': 'tr',
    'c': 'eo', 'e': 'co', 'o': 'ce',
    's': 'zx', 'z': 'sx', 'x': 'zk',
    'a': 'eo', 'g': 'qy', 'h': 'nk', 'k': 'hx', 'r': 'nf', 'y': 'gv',
}


def case_distractors(seed_key, letter, upper):
    """大小写配对的干扰项：先取形近字母，不够再按固定顺序补齐。

    补齐这一步是必须的 —— 形近表里多数只有 2 个，而每道题要 3 个干扰项。
    补进来的是随机字母，但它们和答案显然不同，不影响唯一答案。
    """
    out = []
    used = {letter}
    for c in CASE_CONFUSE.get(letter, ''):
        if c not in used:
            used.add(c)
            out.append(c)
        if len(out) == 3:
            break

    if len(out) < 3:
        rest = [c for c in LETTERS if c not in used]
        for c in seeded(seed_key).shuffle(rest):
            out.append(c)
            used.add(c)
            if len(out) == 3:
                break

    return [c.upper() if upper else c for c in out]


# 字母顺序题的干扰项取**邻近**的字母，而不是随机字母。
# 拿 Q/X/M 当干扰项，孩子只要看出「差得远」就能排除，没在考顺序；
# 拿 E/F/B 当干扰项，必须真的知道 C 后面是 D。
# 偏移先取后面再取前面，两头都够不着时（A 和 Z 附近）会自动跳过。
ORDER_OFFSETS = (2, 3, 4, 5, 6, 7, 8, -1, -2, -3, -4, -5, -6, -7, -8)


def order_distractors(pos, answer_pos):
    out = []
    used = {pos, answer_pos}
    for d in ORDER_OFFSETS:
        p = pos + d
        if 0 <= p < len(UPPER) and p not in used:
            used.add(p)
            out.append(UPPER[p])
        if len(out) == 3:
            break
    return out


# ---------------------------------------------------------------- 各题型

def build_listen():
    """听音选字母：播一个词，孩子选它开头的大写字母。

    干扰项是三个不同音的大写字母（见 listen_distractors）—— 所以「听到
    apple 选 A」是唯一正确答案，不是三个选项里挑一个顺眼的。

    x 整组跳过：x 在英语里几乎不出现在词首，OPW1 教的是词尾的 x。
    硬把它塞进来（读 box 选 X）会和「开头字母」这句题干自相矛盾。
    """
    groups = []
    for l in LETTERS:
        if l == 'x':
            continue
        qs = []
        for w in seeded('listen-order|' + l).shuffle(LETTER_WORDS[l]):
            answer = l.upper()
            qs.append(make_choice(
                'english', 'en-listen-' + w, '听音选字母', 1,
                {'text': LISTEN_STEM, 'audio': 'en.' + w, 'layout': 'grid'},
                answer, listen_distractors('listen|' + w, answer),
                '听到的是 %s，开头是 %s，大写 %s。' % (w, l, l.upper()),
            ))
        groups.append(qs)
    return interleave(groups)


def build_case():
    """大小写配对：大写 ↔ 小写，两个方向各出一半。

    只要孩子认识字母，两个方向都该会 —— 只会「大写变小写」不算学会，
    反过来在单词里看到小写 b 要能认出是 B。所以每个字母都出两道。
    """
    groups = []
    for l in LETTERS:
        qs = []
        for direction in seeded('case-order|' + l).shuffle(['upper', 'lower']):
            if direction == 'upper':
                qs.append(make_choice(
                    'english', 'en-case-%s-upper' % l, '大小写配对', 1,
                    CASE_UPPER_STEM % l.upper(),
                    l,
                    case_distractors('case|' + l + '|upper', l, upper=False),
                    '%s 的小写是 %s。' % (l.upper(), l),
                ))
            else:
                qs.append(make_choice(
                    'english', 'en-case-%s-lower' % l, '大小写配对', 1,
                    CASE_LOWER_STEM % l,
                    l.upper(),
                    case_distractors('case|' + l + '|lower', l, upper=True),
                    '%s 的大写是 %s。' % (l, l.upper()),
                ))
        groups.append(qs)
    return interleave(groups)


def build_order():
    """字母顺序：某个字母的前一个 / 后一个是谁。

    A 没有「前面」，Z 没有「后面」，这两道直接不出（`0 <= j < 26`）。
    出题时不写「A 前面是谁」再配四个错答案 —— 那种题没有正确答案。
    """
    groups = []
    for i, l in enumerate(UPPER):
        qs = []
        # 两个方向的顺序按字母打散。不这么做的话 interleave() 每个字母只取
        # 第一道，「上一个」会一道都出不出来 —— 26 组各取一道，取到的永远
        # 是组里排在前面那个方向。
        for key in seeded('order-directions|' + l).shuffle(['after', 'before']):
            step = 1 if key == 'after' else -1
            j = i + step
            if not 0 <= j < len(UPPER):
                continue
            qs.append(make_choice(
                'english', 'en-order-%s-%s' % (l.lower(), key), '字母顺序', 2,
                (ORDER_AFTER_STEM if step > 0 else ORDER_BEFORE_STEM) % l,
                UPPER[j], order_distractors(i, j),
                '%s 的%s字母是 %s。' % (l, '下一个' if step > 0 else '上一个',
                                        UPPER[j]),
            ))
        groups.append(qs)
    return interleave(groups)


def build_vowel():
    """元音字母：四个选项里挑出唯一的一个元音。

    干扰项全部取自 21 个辅音，所以「选项里有且只有一个元音」是构造
    保证的，不是挑出来的。每个元音配 4 组不同的干扰项 —— 题干只有一句，
    换的是选项，避免二十道题看起来一模一样。
    """
    groups = []
    for v in VOWELS:
        qs = []
        for k in range(6):
            ds = seeded('vowel|%s|%d' % (v, k)).shuffle(CONSONANTS)[:3]
            qs.append(make_choice(
                'english', 'en-vowel-%s-%d' % (v.lower(), k + 1), '元音字母', 2,
                VOWEL_STEM, v, ds,
                '%s 是元音字母，元音字母一共五个：A E I O U。' % v,
            ))
        groups.append(qs)
    return interleave(groups)


# ---------------------------------------------------------------- 主流程

# (标签, 构造函数, 上限)。上限之和**正好等于** LIMIT —— 这样每一类的题量
# 是有意配的，而不是被切片随机截断的（哪一类出不满，selfcheck 会报出来）。
# 改配比只动这里的数字。
#
# 英语一科占 120 道，是「语文:数学:英语 = 3:3:4」里的那份 4。
#
# 四类可出的题量：听音 25 字母 × 3 词 = 75；配对 26 × 2 = 52；
# 顺序 26 × 2 − 2（A 前 / Z 后）= 50；元音 5 × 4 = 20。
# 都大于各自的上限，上限才是真的配额。
BUILDERS = [
    # 可出题量：听音 25 字母 × 3 词 = 75；配对 26 × 2 = 52；
    # 顺序 26 × 2 − 2（A 前 / Z 后）= 50；元音 5 × 6 = 30。
    # 上限都卡在可出量以内，selfcheck 会验「每类正好出满」。
    ('听音选字母', build_listen, 70),
    ('大小写配对', build_case, 52),
    ('字母顺序', build_order, 48),
    ('元音字母', build_vowel, 30),
]

LIMIT = 200


def generate():
    all_q = []
    report = []
    for label, fn, cap in BUILDERS:
        qs = fn()[:cap]
        report.append((label, len(qs)))
        all_q += qs

    all_q = all_q[:LIMIT]
    # 全局重新编号，id 连续无洞
    for i, q in enumerate(all_q):
        q['id'] = 'en-%04d' % (i + 1)
    return all_q, report


# ---------------------------------------------------------------- 语音清单

def build_audio(questions):
    """题库引用到的语音。**由题库反推**，不手写 —— 手写必然对不上。

    两个方向都得对得上，selfcheck 里都断言了：
      · 每条 stem.audio 的 id 必须在清单里；
      · 清单里每一条都必须被至少一道题引用。
    第二条同样重要：多出来的条目会让构建流水线生成没人用的音频文件。
    """
    words = set()
    for q in questions:
        aid = (q.get('stem') or {}).get('audio') or ''
        if aid.startswith('en.'):
            words.add(aid[len('en.'):])

    return {
        'comment': '英语题库引用的语音。由 tools/gen_yingyu.py 生成，不要手改。',
        'entries': [{'id': 'en.' + w, 'text': w, 'voice': VOICE}
                    for w in sorted(words)],
    }


# ---------------------------------------------------------------- 自检

def selfcheck(questions):
    """英语题库自己的语义校验（结构通用校验在 qbank.selfcheck_common）。

    自动生成的选择题最大的风险不是崩溃，是**一道题有两个正确答案** ——
    四行 JSON 里看不出来，孩子做的时候才发现。下面每一条断言都是把
    「唯一答案」翻译成机器能判定的话。
    """
    errs = []

    # ---- 词表自身的形状 ----
    # 词表是全部题目的唯一词源，它错了下面所有断言都是在验一个错的东西。
    owner = {}
    for l in LETTERS:
        words = LETTER_WORDS.get(l)
        if not words:
            errs.append('字母 %s 没有配词' % l)
            continue
        for w in words:
            if not w.isascii() or not w.isalpha() or not w.islower():
                errs.append('字母 %s 的词 %r 不是纯小写英文字母' % (l, w))
                continue
            if l == 'x':
                if not w.endswith('x'):
                    errs.append('x 的词 %r 不是以 x 结尾（x 在词尾）' % w)
            elif not w.startswith(l):
                errs.append('字母 %s 的词 %r 不是以 %s 开头' % (l, w, l))
            if w in owner:
                errs.append('词 %r 同时出现在 %s 和 %s 下面'
                            % (w, owner[w], l))
            owner[w] = l
    extra = set(LETTER_WORDS) - set(LETTERS)
    if extra:
        errs.append('词表里有字母表之外的键：%s' % ''.join(sorted(extra)))

    # ---- 配比：每类题正好出满上限（上限之和 = LIMIT，所以不会被截断） ----
    for label, _fn, cap in BUILDERS:
        got = len([q for q in questions if q['tags'] == [label]])
        if got != cap:
            errs.append('「%s」出了 %d 道，配比要求 %d 道' % (label, got, cap))

    # ---- 26 个字母都得被考到 ----
    # 配对的题量只有 52 取 44，理论上可能整片漏掉某个字母。漏掉的字母
    # 孩子永远练不到，而从题量报告上看不出来。
    covered = set()
    for q in questions:
        m = re.search(r'[A-Za-z]', q['stem'].get('text') or '')
        if m and q['tags'][0] != '听音选字母':
            covered.add(m.group(0).lower())
    missing = [l for l in LETTERS if l not in covered]
    if missing:
        errs.append('这些字母一道配对/顺序题都没有：%s' % ''.join(missing))

    # 字母顺序题的「上一个 / 下一个」两个方向都得出现。
    # 26 组各取一道时，组内顺序如果固定，取到的永远是排在前面那个方向 ——
    # 这不是假想的风险，这一版第一次生成时 24 道题全是「下一个」。
    order_dirs = set()
    for q in questions:
        m = re.search(r'的(上一个|下一个)字母是哪个？',
                      q['stem'].get('text') or '')
        if m:
            order_dirs.add(m.group(1))
    if order_dirs != {'上一个', '下一个'}:
        errs.append('字母顺序题只有一个方向：%s'
                    % ('/'.join(sorted(order_dirs)) or '一道都没有'))

    for q in questions:
        tag = q['tags'][0]
        stem = q['stem']
        raw = stem.get('text') or ''
        texts = option_texts(q)
        got = answer_text(q)

        # ---- 全库不许有音标 ----
        for ch in ' '.join([raw, q.get('explain') or ''] + texts):
            if ch in IPA_CHARS:
                errs.append('%s：出现了音标符号 %s（全库不许有音标）'
                            % (q['id'], ch))

        if tag == '听音选字母':
            if raw != LISTEN_STEM:
                errs.append('%s：听音选字母的题干写成了 %r' % (q['id'], raw))

            for t in texts:
                if not re.match(r'^[A-Z]$', t):
                    errs.append('%s：选项 %r 不是单个大写字母' % (q['id'], t))

            aid = stem.get('audio') or ''
            if not aid.startswith('en.'):
                errs.append('%s：听音选字母没有音频' % q['id'])
                continue
            word = aid[len('en.'):]
            if word not in owner:
                errs.append('%s：音频里的词 %r 不在词表里' % (q['id'], word))
                continue
            # 音频读的词，开头必须就是答案那个字母。
            # 这条同时挡住了「答案和音频不是一道题」这种串题错误。
            if owner[word] != got.lower():
                errs.append('%s：音频读 %s（开头 %s），答案却是 %s'
                            % (q['id'], word, owner[word].upper(), got))

            # **唯一答案**：四个选项两两不同音，答案只有一个。
            # c 和 k 同时出现就是两个正确答案，见 SOUND 的注释。
            sounds = [sound(t) for t in texts]
            if len(set(sounds)) != len(sounds):
                errs.append('%s：选项里有同音字母（%s）'
                            % (q['id'], '/'.join(texts)))
            if texts.count(got) != 1:
                errs.append('%s：听音选字母里答案出现了 %d 次'
                            % (q['id'], texts.count(got)))

        elif tag == '大小写配对':
            m = re.match(r'^大写 ([A-Z]) 的小写是哪个？$', raw)
            if m:
                l = m.group(1).lower()
                expect = l
                want_case = '小写'
                wrong_case = [t for t in texts if t != t.lower()]
            else:
                m = re.match(r'^小写 ([a-z]) 的大写是哪个？$', raw)
                if not m:
                    errs.append('%s：大小写配对的题干写成了 %r'
                                % (q['id'], raw))
                    continue
                l = m.group(1)
                expect = l.upper()
                want_case = '大写'
                wrong_case = [t for t in texts if t != t.upper()]

            if wrong_case:
                errs.append('%s：问的是%s，选项里却混了另一种大小写（%s）'
                            % (q['id'], want_case, '/'.join(wrong_case)))
            if any(len(t) != 1 for t in texts):
                errs.append('%s：选项不是单个字母（%s）'
                            % (q['id'], '/'.join(texts)))
            if got != expect:
                errs.append('%s：%r 的答案应该是 %r，现在是 %r'
                            % (q['id'], raw, expect, got))

        elif tag == '字母顺序':
            m = re.match(r'^字母 ([A-Z]) 的(下一个|上一个)字母是哪个？$', raw)
            if not m:
                errs.append('%s：字母顺序的题干写成了 %r' % (q['id'], raw))
                continue
            l, direction = m.group(1), m.group(2)
            i = UPPER.index(l)
            j = i + 1 if direction == '下一个' else i - 1
            if not 0 <= j < len(UPPER):
                errs.append('%s：%s 没有%s字母' % (q['id'], l, direction))
                continue
            expect = UPPER[j]

            for t in texts:
                if not re.match(r'^[A-Z]$', t):
                    errs.append('%s：选项 %r 不是单个大写字母'
                                % (q['id'], t))
            if got != expect:
                errs.append('%s：%s 的%s字母是 %s，答案却是 %s'
                            % (q['id'], l, direction, expect, got))
            # 题干里的字母自己不能当选项 —— 「C 后面是哪个字母」的选项里
            # 出现 C，孩子会以为在问「哪个是 C」。
            if l in texts:
                errs.append('%s：题干里的 %s 自己也出现在选项里'
                            % (q['id'], l))

        elif tag == '元音字母':
            if raw != VOWEL_STEM:
                errs.append('%s：元音字母的题干写成了 %r' % (q['id'], raw))
            for t in texts:
                if not re.match(r'^[A-Z]$', t):
                    errs.append('%s：选项 %r 不是单个大写字母' % (q['id'], t))
            # **唯一答案**：选项里有且只有一个元音字母
            hits = [t for t in texts if t in VOWELS]
            if len(hits) != 1:
                errs.append('%s：选项里的元音字母有 %d 个（%s）'
                            % (q['id'], len(hits), '/'.join(hits)))
            elif hits[0] != got:
                errs.append('%s：答案 %s 不是元音字母' % (q['id'], got))

        else:
            errs.append('%s：未知题型 %r' % (q['id'], tag))

    # ---- 语音清单：两个方向都要对得上 ----
    manifest = build_audio(questions)
    have = [e['id'] for e in manifest['entries']]
    if len(have) != len(set(have)):
        errs.append('语音清单里有重复的 id')
    referenced = [(q['stem'] or {}).get('audio') for q in questions]
    referenced = [a for a in referenced if a]
    # 正向（引用 → 清单）由 build_audio 的写法保证，留着是为了挡住以后
    # 有人给它加过滤条件；反向（清单 → 引用）才是真会出事的那一头。
    for aid in referenced:
        if aid not in have:
            errs.append('语音清单里缺少 %s（有题目在用它）' % aid)
    for aid in have:
        if aid not in referenced:
            errs.append('语音清单里的 %s 没有任何题目在引用（会白造一个音频文件）' % aid)
    for e in manifest['entries']:
        if not re.match(r'^en\.[a-z]+$', e['id']):
            errs.append('语音 id %r 不是 en. + 小写英文单词' % e['id'])
        if e['voice'] != VOICE:
            errs.append('语音 %s 的音色不是 %s' % (e['id'], VOICE))
        if e['text'] != e['id'][len('en.'):]:
            errs.append('语音 %s 的文本对不上（%r）' % (e['id'], e['text']))

    return errs


def audio_report(questions):
    """报告里那行「语音清单 N 条」。"""
    n = len(build_audio(questions)['entries'])
    return '  语音清单 %d 条（全部是单词）' % n


def main():
    qpath = os.path.join(DATA, 'english.json')
    apath = os.path.join(DATA, 'english_audio.json')

    code = run('英语（自然拼读 OPW1 · 字母）', 'english', qpath, generate, LIMIT,
               extra_checks=selfcheck, report_extra=audio_report)
    if code != 0:
        return code

    # 语音清单跟着题库一起走 --check 的一致性检查（和 gen_ziku 的字表一样：
    # run() 只管 english.json，第二个产物得自己管）
    manifest = build_audio(generate()[0])
    if '--check' in sys.argv:
        if not os.path.exists(apath):
            print('❌ 缺少 %s' % os.path.relpath(apath, ROOT))
            return 1
        with open(apath, 'r', encoding='utf-8') as f:
            if json.load(f) != manifest:
                print('❌ %s 与生成结果不一致' % os.path.relpath(apath, ROOT))
                print('   跑一次 python3 tools/gen_yingyu.py 重新生成')
                return 1
        return 0

    write_json(apath, manifest)
    print('  → %s（%d 条语音）'
          % (os.path.relpath(apath, ROOT), len(manifest['entries'])))
    print('')
    return 0


if __name__ == '__main__':
    sys.exit(main())
