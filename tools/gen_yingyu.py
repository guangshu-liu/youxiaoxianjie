#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_yingyu.py — 英语题库生成器（OPW1 复习 60 + OPW2 短元音 140）

孩子已经学完 OPW1（The Alphabet）、正在读 Oxford Phonics World 2
（Short Vowels）。旧版 200 道全部是字母题，已经落后于他的进度；这一版
把英语换成分层的两套内容：

    OPW1 复习   60 道   全部 d1，只留少量字母题保温，不占主要时间
    OPW2 新题  140 道   d1 40（U1–U4：a / e / i）
                        d2 100（U5–U8：i(2) / o / u + 混合复习）

    合计 200 道，d1 : d2 = 100 : 100（和数学的分档一致）。
    难度门控见 src/js/30-bank.js 的 levelOf()：本科目最近 20 次正确率
    ≥ 80% 才升到 d2，所以孩子不会因为语文/数学做得好就被塞进阶英语题。

**没有句子填空**。历史 OPW2 版本里有 27 道句子填空，音频念的是填好空的
整句，孩子一听就知道答案；而去掉音频又要求 6 岁孩子自己读整句 —— 两条
路都不成立。这一版全部题目都是「一个词就能做完」的题。

产出两个文件：
    src/data/english.json        英语题库（200 道，全部 choice）
    src/data/english_audio.json  题库引用到的语音清单（由题库反推）

词源只有两张表，都在本文件里具名声明：
    LETTER_WORDS   26 个字母 × 3 个词（OPW1 听音选字母用）
    FAMILIES       25 个词族、108 个 CVC 词（OPW2，逐字抄自 git 历史
                   fdbf573 的 curriculum，单元 U1–U8 顺序原样保留）

唯一答案全部是**构造保证**的，不靠出题人的语感：
    听音选词   —— 四个选项同词族，音频念的就是答案，只有一个同音
    辨短元音   —— 选项里只有一个元音字母是音频词中间的那个
    押韵配对   —— 干扰项取不同词族，选项里只有一个和题干同韵尾
    拼合 CVC   —— 同族四个词首字母两两不同，只有一个以题干的首字母开头
    跨词族归类 —— 三个词同韵尾、一个不同，异类只有一个
    找真词     —— 三个假词都不在 REAL_WORDS 里，真词只有一个
selfcheck 把上面每一条都翻成了机器能判定的断言。

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

# ================================================================ 词源 · OPW1

LETTERS = 'abcdefghijklmnopqrstuvwxyz'
UPPER = LETTERS.upper()

# 26 个字母，每个 3 个词，全是 OPW1 里会出现的首字母词。x 特殊 —— 英语里
# 几乎没有以 x 开头的词，OPW1 教的是词尾的 x（box / fox / six），所以 x
# 不进听音选字母。
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

# 读起来是同一个音的字母。c / k 在词首都是 /k/；q 读 /kw/，对 6 岁孩子
# 来说「queen 用 K 开头」是个很合理的错答，也归进同一键避开。
SOUND = {'C': 'k', 'K': 'k', 'Q': 'k'}


def sound(letter):
    return SOUND.get(letter, letter)


VOWELS = 'AEIOU'
CONSONANTS = ''.join(c for c in UPPER if c not in VOWELS)

# 字形相近的字母。大小写配对题里优先拿这些当干扰项。
CASE_CONFUSE = {
    'b': 'dpq', 'd': 'bpq', 'p': 'bdq', 'q': 'bdp',
    'm': 'nw', 'n': 'mh', 'u': 'nv', 'v': 'uw', 'w': 'vm',
    'i': 'jl', 'j': 'il', 'l': 'ij', 't': 'fl', 'f': 'tr',
    'c': 'eo', 'e': 'co', 'o': 'ce',
    's': 'zx', 'z': 'sx', 'x': 'zk',
    'a': 'eo', 'g': 'qy', 'h': 'nk', 'k': 'hx', 'r': 'nf', 'y': 'gv',
}

ORDER_OFFSETS = (2, 3, 4, 5, 6, 7, 8, -1, -2, -3, -4, -5, -6, -7, -8)

# ================================================================ 词源 · OPW2

# 25 个词族、108 个 CVC 词，格式：词族 -> (单元, 元音, [词])。
# 逐字抄自 git 历史 fdbf573 的 curriculum.json（OPW2 Short Vowels），
# 字典插入顺序就是课程序 U1 → U8。**没有抄 rime 音标**。
FAMILIES = {
    # ---- U1 · 短元音 a (1) ----
    'am': ('U1', 'a', ['ram', 'jam', 'yam', 'dam', 'ham']),
    'an': ('U1', 'a', ['fan', 'man', 'pan', 'can', 'van']),
    # ---- U2 · 短元音 a (2) ----
    'ad': ('U2', 'a', ['dad', 'pad', 'sad', 'bad', 'mad']),
    'ag': ('U2', 'a', ['bag', 'rag', 'tag', 'wag']),
    'ap': ('U2', 'a', ['cap', 'map', 'nap', 'tap', 'lap']),
    'at': ('U2', 'a', ['bat', 'rat', 'hat', 'mat', 'cat']),
    # ---- U3 · 短元音 e ----
    'et': ('U3', 'e', ['jet', 'net', 'wet', 'pet', 'vet']),
    'en': ('U3', 'e', ['hen', 'pen', 'ten', 'den', 'men']),
    'ed': ('U3', 'e', ['red', 'bed', 'fed', 'led', 'wed']),
    # ---- U4 · 短元音 i (1) ----
    'ip': ('U4', 'i', ['lip', 'tip', 'sip', 'rip', 'zip']),
    'ib': ('U4', 'i', ['rib', 'bib', 'fib']),
    'id': ('U4', 'i', ['hid', 'kid', 'did', 'lid', 'rid']),
    # ---- U5 · 短元音 i (2) ----
    'in': ('U5', 'i', ['pin', 'fin', 'bin', 'win', 'tin']),
    'ig': ('U5', 'i', ['fig', 'wig', 'big', 'dig', 'pig']),
    'it': ('U5', 'i', ['pit', 'hit', 'sit', 'fit', 'bit']),
    'ix': ('U5', 'i', ['six', 'fix', 'mix']),
    # ---- U6 · 短元音 o ----
    'ot': ('U6', 'o', ['pot', 'hot', 'cot', 'dot', 'lot']),
    'op': ('U6', 'o', ['top', 'mop', 'hop', 'pop', 'cop']),
    # ---- U7 · 短元音 u (1) ----
    'ug': ('U7', 'u', ['jug', 'mug', 'hug', 'rug', 'bug']),
    'ud': ('U7', 'u', ['bud', 'mud']),
    'up': ('U7', 'u', ['cup', 'pup']),
    # ---- U8 · 短元音 u (2) ----
    'ut': ('U8', 'u', ['nut', 'hut', 'cut']),
    'ub': ('U8', 'u', ['cub', 'tub', 'rub']),
    'um': ('U8', 'u', ['gum', 'hum', 'sum']),
    'un': ('U8', 'u', ['bun', 'sun', 'fun', 'run', 'gun']),
}

# 「找真词」的假词只允许换成这些首字母（课程教过的 onsets）。
ONSETS = ['b', 'c', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'm', 'n', 'p',
          'r', 's', 't', 'v', 'w', 'y', 'z']

# 这张表是从 /usr/share/dict/words 筛出来的：把 108 个词的每个首字母换成
# ONSETS 里任意一个，凡是词典里查得到的都收在这儿。词表里有些粗俗词，
# 但正因为它们是真词才必须留在表里 —— 留在这儿就意味着永远不会作为
# 「假词」出现在孩子面前。
REAL_EXTRA = (
    'bam', 'ban', 'bap', 'ben', 'bet', 'bid', 'bop', 'bot', 'bub', 'bum',
    'but', 'cad', 'cag', 'cam', 'cig', 'cit', 'cud', 'cum', 'dag', 'dan',
    'dap', 'dib', 'din', 'dip', 'dit', 'dop', 'dub', 'dud', 'dug', 'dum',
    'dun', 'dup', 'fad', 'fag', 'fam', 'fat', 'fen', 'fet', 'fid', 'fip',
    'fop', 'fot', 'fub', 'fud', 'fug', 'fum', 'fut', 'gad', 'gag', 'gam',
    'gan', 'gap', 'gat', 'ged', 'gen', 'get', 'gib', 'gid', 'gig', 'gin',
    'gip', 'git', 'got', 'gud', 'gup', 'gut', 'had', 'hag', 'han', 'hap',
    'het', 'hin', 'hip', 'hub', 'hud', 'hup', 'jag', 'jap', 'jed', 'jib',
    'jig', 'jot', 'jud', 'jut', 'kan', 'kat', 'ked', 'ken', 'ket', 'kin',
    'kip', 'kit', 'kop', 'lad', 'lag', 'lam', 'lan', 'lat', 'let', 'lin',
    'lit', 'lop', 'lug', 'lum', 'lut', 'mag', 'met', 'mib', 'mid', 'mig',
    'min', 'mot', 'mum', 'mun', 'nag', 'nam', 'nan', 'nat', 'nib', 'nid',
    'nig', 'nip', 'nit', 'nix', 'not', 'nub', 'nun', 'pam', 'pap', 'pat',
    'ped', 'pip', 'pix', 'pub', 'pud', 'pug', 'pun', 'put', 'rad', 'ran',
    'rap', 'ret', 'rig', 'rit', 'rix', 'rot', 'rud', 'rum', 'rut', 'sag',
    'sam', 'san', 'sap', 'sat', 'sen', 'set', 'sib', 'sig', 'sin', 'sop',
    'sot', 'sub', 'sud', 'sup', 'tad', 'tam', 'tan', 'tat', 'ted', 'tib',
    'tid', 'tig', 'tit', 'tot', 'tug', 'tum', 'tun', 'tup', 'tut', 'vag',
    'vat', 'vug', 'vum', 'wad', 'wan', 'wap', 'wat', 'wen', 'wid', 'wit',
    'wop', 'wot', 'wud', 'wun', 'wup', 'wut', 'yad', 'yan', 'yap', 'yat',
    'yed', 'yen', 'yet', 'yin', 'yip', 'yot', 'zad', 'zag', 'zat', 'zed',
    'zig',
)

WORDS = []
WORD_FAMILY = {}
WORD_VOWEL = {}
WORD_UNIT = {}
FAMILY_WORDS = {}
FAMILY_UNIT = {}
FAMILY_VOWEL = {}
for _fam in FAMILIES:
    _unit, _vowel, _ws = FAMILIES[_fam]
    FAMILY_WORDS[_fam] = list(_ws)
    FAMILY_UNIT[_fam] = _unit
    FAMILY_VOWEL[_fam] = _vowel
    for _w in _ws:
        if _w in WORD_FAMILY:
            raise ValueError('OPW2 词表里 %s 出现了两次' % _w)
        WORDS.append(_w)
        WORD_FAMILY[_w] = _fam
        WORD_VOWEL[_w] = _vowel
        WORD_UNIT[_w] = _unit

REAL_WORDS = set(WORDS) | set(REAL_EXTRA)
FAKES = {}
for _fam in FAMILIES:
    FAKES[_fam] = [o + _fam for o in ONSETS if o + _fam not in REAL_WORDS]

# 基础档 = U1–U4（a / e / i），进阶档 = U5–U8（i(2) / o / u）。
# 混合题（跨词族归类、辨短元音）允许跨这两组取词。
D1_FAMS = [f for f in FAMILIES if FAMILY_UNIT[f] in ('U1', 'U2', 'U3', 'U4')]
D2_FAMS = [f for f in FAMILIES if FAMILY_UNIT[f] in ('U5', 'U6', 'U7', 'U8')]
D1_WORDS = [w for w in WORDS if WORD_FAMILY[w] in D1_FAMS]
D2_WORDS = [w for w in WORDS if WORD_FAMILY[w] in D2_FAMS]

# ================================================================ 题干模板

# 五种题干写死在这里，selfcheck 拿它们反查 —— 「生成器里改了一个字而
# 题库没重生成」这种事不可能悄悄发生。
LISTEN_STEM = '听一听，这个词开头是哪个大写字母？'
CASE_UPPER_STEM = '大写 %s 的小写是哪个？'
CASE_LOWER_STEM = '小写 %s 的大写是哪个？'
ORDER_AFTER_STEM = '字母 %s 的下一个字母是哪个？'
ORDER_BEFORE_STEM = '字母 %s 的上一个字母是哪个？'
VOWEL_STEM = '下面哪个是元音字母？'

LISTEN_WORD_STEM = '听一听，选出你听到的词'
VOWEL_SOUND_STEM = '听一听，这个词的中间是哪个元音字母？'
RHYME_STEM = '下面哪个词和 %s 的结尾音一样？'
COMBINE_STEM = '%s + %s 拼起来是哪个词？'
ODD_FAMILY_STEM = '下面哪个词的结尾音和另外三个不一样？'
REALWORD_STEM = '下面哪个是真词？'

# 全库禁用字符：音标。孩子看到 /æm/ 只会发懵。
IPA_CHARS = set('æɪʊɒʌəɜɔʃʒθðŋɑɛɹʧʤˈˌːˑ')
VOICE = 'Samantha'


def rime(word):
    """词的结尾音。108 个词都是三字母 CVC，末两个字母就是韵尾。"""
    return word[-2:]


def answer_text(q):
    return [o['text'] for o in q['options'] if o['id'] == q['answer']][0]


def option_texts(q):
    return [o['text'] for o in q['options']]


# ================================================================ 干扰项

def listen_distractors(seed_key, answer):
    """听音选字母：三个和答案不同音、彼此也不同音的大写字母。"""
    pool = [c for c in UPPER if c != answer and sound(c) != sound(answer)]
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


def case_distractors(seed_key, letter, upper):
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


def prefer_unused(words, used, seed_key):
    """优先挑还没被别的听音题用作音频的词 —— 同样的预算覆盖更多 CVC 词，
    题库听起来不会翻来覆去就那几个词。不够了再用用过的补。"""
    fresh = seeded(seed_key + '|fresh').shuffle([w for w in words if w not in used])
    rest = seeded(seed_key + '|rest').shuffle([w for w in words if w in used])
    return fresh + rest


# ================================================================ OPW1 复习题

def build_review_listen(used):
    """听音选字母 26 道：interleave 按字母分组，前 25 道正好每个字母一道
    （x 跳过，25 个字母），第 26 道补一个字母的第二个词。"""
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
    return interleave(groups)[:26]


def build_review_case():
    """大小写配对 26 道：每个字母一道（interleave 第一轮），两种方向混着来。"""
    groups = []
    for l in LETTERS:
        qs = []
        for direction in seeded('case-order|' + l).shuffle(['upper', 'lower']):
            if direction == 'upper':
                qs.append(make_choice(
                    'english', 'en-case-%s-upper' % l, '大小写配对', 1,
                    CASE_UPPER_STEM % l.upper(), l,
                    case_distractors('case|' + l + '|upper', l, upper=False),
                    '%s 的小写是 %s。' % (l.upper(), l),
                ))
            else:
                qs.append(make_choice(
                    'english', 'en-case-%s-lower' % l, '大小写配对', 1,
                    CASE_LOWER_STEM % l, l.upper(),
                    case_distractors('case|' + l + '|lower', l, upper=True),
                    '%s 的大写是 %s。' % (l, l.upper()),
                ))
        groups.append(qs)
    return interleave(groups)[:26]


def build_review_order():
    """字母顺序 4 道：两个方向各两道，不能全挤在「下一个」上。"""
    all_q = []
    for i, l in enumerate(UPPER):
        for key in seeded('order-directions|' + l).shuffle(['after', 'before']):
            step = 1 if key == 'after' else -1
            j = i + step
            if not 0 <= j < len(UPPER):
                continue
            all_q.append(make_choice(
                'english', 'en-order-%s-%s' % (l.lower(), key), '字母顺序', 1,
                (ORDER_AFTER_STEM if step > 0 else ORDER_BEFORE_STEM) % l,
                UPPER[j], order_distractors(i, j),
                '%s 的%s字母是 %s。' % (l, '下一个' if step > 0 else '上一个',
                                        UPPER[j]),
            ))
    after = [q for q in all_q if '下一个' in q['stem']['text']][:2]
    before = [q for q in all_q if '上一个' in q['stem']['text']][:2]
    return interleave([after, before])


def build_review_vowel():
    groups = []
    for v in VOWELS:
        qs = []
        for k in range(6):
            ds = seeded('vowel|%s|%d' % (v, k)).shuffle(CONSONANTS)[:3]
            qs.append(make_choice(
                'english', 'en-vowel-%s-%d' % (v.lower(), k + 1), '元音字母', 1,
                VOWEL_STEM, v, ds,
                '%s 是元音字母，元音字母一共五个：A E I O U。' % v,
            ))
        groups.append(qs)
    return interleave(groups)[:4]


# ================================================================ OPW2 新题

def build_listen_word(fams, cap, level, used):
    """听音选词：四个选项同一个词族，音频念的就是答案。

    同族是硬要求 —— 播 cat 时给 cat / cap / can / cab，孩子不用听，
    看一眼首字母就能选对，这道题就白出了。
    """
    groups = []
    for fam in fams:
        words = FAMILY_WORDS[fam]
        if len(words) < 4:
            continue
        qs = []
        for w in seeded('lw-order|' + fam).shuffle(words):
            ds = seeded('lw|' + w).shuffle([x for x in words if x != w])[:3]
            qs.append(make_choice(
                'english', 'en-lw-%s-%s' % (fam, w), '听音选词', level,
                {'text': LISTEN_WORD_STEM, 'audio': 'en.' + w,
                 'layout': 'grid'},
                w, ds,
                '听到的是 %s，和 -%s 是同一个词族。' % (w, fam),
            ))
        groups.append(qs)
    return interleave(groups)[:cap]


def build_vowel_sound(fams, cap, level, used):
    """辨短元音：播一个 CVC 词，选它中间那个元音字母。

    干扰项是另外 4 个元音里随机取 3 个，所以选项里只有一个是对的 ——
    唯一答案不靠挑，靠构造。d1 的词来自 U1–U4，选项里照样会出现 o / u
    当干扰项；d2 全元音混合，o / u 词真的登场。
    """
    pool = []
    for fam in fams:
        for w in FAMILY_WORDS[fam]:
            if w not in pool:
                pool.append(w)
    pool = prefer_unused(pool, used, 'vs-pool|L%d' % level)

    # 按元音分组轮转，别让 8 道题全落在 a 上。
    groups = []
    for v in 'aeiou':
        ws = [w for w in pool if WORD_VOWEL[w] == v]
        if not ws:
            continue
        qs = []
        for w in ws:
            ds = seeded('vsd|' + w).shuffle(
                [c for c in 'aeiou' if c != v])[:3]
            qs.append(make_choice(
                'english', 'en-vs-' + w, '辨短元音', level,
                {'text': VOWEL_SOUND_STEM, 'audio': 'en.' + w,
                 'layout': 'grid'},
                v, ds,
                '%s 的中间是短元音 %s，读 -%s。' % (w, v, rime(w)),
            ))
        groups.append(qs)
    return interleave(groups)[:cap]


def build_rhyme(fams, cap, level):
    """押韵配对（基础档）：「哪个词和 cat 的结尾音一样？」

    干扰项一律取同元音、别的词族的词，所以选项里天然只有一个 -at，
    唯一答案是构造保证的。
    """
    # 必须是 list 不是 set：下面要把 allowed 交给 seeded().shuffle()，
    # 而 set 的迭代顺序每个 Python 进程都不同（字符串哈希随机化），
    # 会让题库跨进程不可复现 —— `--check` 会一直报「产物不一致」。
    allowed = [w for f in fams for w in FAMILY_WORDS[f]]
    groups = []
    for fam in fams:
        words = FAMILY_WORDS[fam]
        vowel = FAMILY_VOWEL[fam]
        others = [w for w in allowed
                  if WORD_FAMILY[w] != fam and WORD_VOWEL[w] == vowel]
        if len(others) < 3:
            continue
        qs = []
        for i, w in enumerate(words):
            answer = words[(i + 1) % len(words)]
            ds = seeded('rhyme|' + w).shuffle(others)[:3]
            qs.append(make_choice(
                'english', 'en-rhyme-%s-%s' % (fam, w), '押韵配对', level,
                RHYME_STEM % w, answer, ds,
                '%s 和 %s 的结尾都是 -%s。' % (w, answer, rime(w)),
            ))
        groups.append(qs)
    return interleave(groups)[:cap]


def build_combine(fams, cap, level):
    """拼合 CVC（基础档）：「c + at 拼起来是哪个词？」

    选项同词族、首字母两两不同，只有一个以题干的首字母开头 —— 孩子要做的
    就是把首字母和韵尾合起来。不带音频：音频一念就等于把答案念出来了。
    """
    groups = []
    for fam in fams:
        words = FAMILY_WORDS[fam]
        if len(words) < 4:
            continue
        qs = []
        for w in seeded('cb-order|' + fam).shuffle(words):
            onset = w[0]
            ds = seeded('cb|' + w).shuffle(
                [x for x in words if x != w and x[0] != onset])[:3]
            if len(ds) < 3:
                continue
            qs.append(make_choice(
                'english', 'en-cb-%s-%s' % (fam, w), '拼合 CVC', level,
                COMBINE_STEM % (onset, fam), w, ds,
                '%s + %s 拼成 %s，和 -%s 是同一个词族。'
                % (onset, fam, w, fam),
            ))
        groups.append(qs)
    return interleave(groups)[:cap]


def build_odd_family(cap, level):
    """跨词族归类（进阶档）：三个词同韵尾、一个词不同，挑出那个异类。

    这是 d2 的主力题型：混合 U1–U8 全部元音，且异类词**跨元音**取
    （问 -at 时异类不会是另一个 a 词），孩子必须真的看韵尾，不能靠元音蒙。
    """
    groups = []
    for fam in FAMILIES:
        words = FAMILY_WORDS[fam]
        if len(words) < 3:
            continue
        vowel = FAMILY_VOWEL[fam]
        odd_pool = [w for w in WORDS
                    if WORD_FAMILY[w] != fam and WORD_VOWEL[w] != vowel]
        if not odd_pool:
            continue
        qs = []
        for i, anchor in enumerate(words):
            same = seeded('odd-same|%s|%s' % (fam, anchor)).shuffle(
                [x for x in words if x != anchor])[:3]
            if len(same) < 3:
                continue
            odd = seeded('odd-one|%s|%s' % (fam, anchor)).shuffle(odd_pool)[0]
            qs.append(make_choice(
                'english', 'en-odd-%s-%d' % (fam, i), '跨词族归类', level,
                ODD_FAMILY_STEM, odd, same,
                '%s 是 -%s；其余三个都是 -%s。'
                % (odd, rime(odd), rime(anchor)),
            ))
        groups.append(qs)
    return interleave(groups)[:cap]


def build_realword(fams, cap, level):
    """找真词（进阶档，少量）：一个真词 + 三个同族假词。

    假词是换首字母造出来的，且必须不在 REAL_WORDS 里 —— 否则「gat / dat」
    里混进一个真词，这道题就有两个正确答案，肉眼看不出来。
    """
    groups = []
    for fam in fams:
        pool = FAKES[fam]
        if len(pool) < 3:
            continue
        qs = []
        for w in seeded('rw-order|' + fam).shuffle(FAMILY_WORDS[fam]):
            ds = seeded('rw|' + w).shuffle(pool)[:3]
            qs.append(make_choice(
                'english', 'en-rw-%s-%s' % (fam, w), '找真词', level,
                REALWORD_STEM, w, ds,
                '%s 是真词，另外三个不是。' % w,
            ))
        groups.append(qs)
    return interleave(groups)[:cap]


# ================================================================ 主流程

# (标签, 构造函数, 上限, 难度档)。上限之和正好 = LIMIT，难度 1 / 2 各 100。
# 改配比只动这里的数字，selfcheck 会验每一类正好出满、两档正好 100/100。
BUILDERS = [
    ('听音选字母', lambda u: build_review_listen(u), 26, 1),
    ('大小写配对', lambda u: build_review_case(), 26, 1),
    ('字母顺序', lambda u: build_review_order(), 4, 1),
    ('元音字母', lambda u: build_review_vowel(), 4, 1),
    ('听音选词', lambda u: build_listen_word(D1_FAMS, 16, 1, u), 16, 1),
    ('辨短元音', lambda u: build_vowel_sound(D1_FAMS, 8, 1, u), 8, 1),
    ('押韵配对', lambda u: build_rhyme(D1_FAMS, 8, 1), 8, 1),
    ('拼合 CVC', lambda u: build_combine(D1_FAMS, 8, 1), 8, 1),
    ('听音选词2', lambda u: build_listen_word(D2_FAMS, 28, 2, u), 28, 2),
    ('辨短元音2', lambda u: build_vowel_sound(D2_FAMS, 16, 2, u), 16, 2),
    ('跨词族归类', lambda u: build_odd_family(40, 2), 40, 2),
    ('找真词', lambda u: build_realword(D2_FAMS + D1_FAMS, 16, 2), 16, 2),
]

# 报告里把两个档的同名题型合起来显示，题库里的 tags 用不带 2 的名字。
DISPLAY_TAG = {
    '听音选词2': '听音选词',
    '辨短元音2': '辨短元音',
}

LIMIT = 200


def generate():
    used = set()
    all_q = []
    for label, fn, cap, level in BUILDERS:
        qs = fn(used)[:cap]
        # 报告用合并后的标签；题库里的 tags 也用合并后的名字，
        # 渲染器与统计只认题型名，不认「这是哪一档」。
        tag = DISPLAY_TAG.get(label, label)
        for q in qs:
            q['tags'] = [tag]
            # 只把**真的进了题库**的那些词记成「已用过」。出题函数按词族
            # 生成全部候选再切片，若在函数里就地记账，未入选的词也会被算
            # 成用过，后面的辨短元音就只会重复前面那几个词了。
            aid = (q['stem'] or {}).get('audio') or ''
            if aid.startswith('en.'):
                used.add(aid[len('en.'):])
        all_q += qs

    all_q = all_q[:LIMIT]
    for i, q in enumerate(all_q):
        q['id'] = 'en-%04d' % (i + 1)

    report = []
    for label, fn, cap, level in BUILDERS:
        tag = DISPLAY_TAG.get(label, label)
        if tag in [t for t, _ in report]:
            report = [(t, n + cap) if t == tag else (t, n)
                      for t, n in report]
        else:
            report.append((tag, cap))
    return all_q, report


# ================================================================ 语音清单

def build_audio(questions):
    """题库引用到的语音，由题库反推，不手写。

    两个方向都得对得上（selfcheck 里都断言了）：引用 → 清单、清单 → 引用。
    后者同样重要：多出来的条目会生成没人用的音频文件。
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


# ================================================================ 自检

def selfcheck(questions):
    """英语题库自己的语义校验（结构通用校验在 qbank.selfcheck_common）。

    自动生成的选择题最大的风险不是崩溃，是**一道题有两个正确答案**。
    下面每一条断言都是把「唯一答案」翻译成机器能判定的话。
    """
    errs = []

    # ---- 两张词源表自身的形状 ----
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
                    errs.append('x 的词 %r 不是以 x 结尾' % w)
            elif not w.startswith(l):
                errs.append('字母 %s 的词 %r 不是以 %s 开头' % (l, w, l))
            if w in owner and owner[w] != l:
                errs.append('词 %r 同时出现在 %s 和 %s 下面' % (w, owner[w], l))
            owner[w] = l

    for w in WORDS:
        if len(w) != 3 or not w.isalpha() or not w.islower():
            errs.append('OPW2 词表里 %r 不是三个小写字母' % w)
        elif rime(w) != WORD_FAMILY[w]:
            errs.append('%s 的末两字母 %s 和词族 %s 对不上'
                        % (w, rime(w), WORD_FAMILY[w]))
    if len(WORDS) != len(set(WORDS)):
        errs.append('OPW2 词表里有重复的词')
    if len(WORDS) != 108 or len(FAMILIES) != 25:
        errs.append('OPW2 词表规模变了：%d 族 / %d 词（应为 25 / 108）'
                    % (len(FAMILIES), len(WORDS)))

    # ---- 配比与分档 ----
    for label, _fn, cap, level in BUILDERS:
        got = len([q for q in questions
                   if q['id'] in _ids_of(questions, label)])
        if got != cap:
            errs.append('「%s」出了 %d 道，配比要求 %d 道' % (label, got, cap))
    lv = {1: 0, 2: 0}
    for q in questions:
        if q['difficulty'] not in lv:
            errs.append('%s：难度 %r 不是 1 或 2' % (q['id'], q['difficulty']))
        else:
            lv[q['difficulty']] += 1
    if lv != {1: 100, 2: 100}:
        errs.append('难度分档不对：d1 %d 道 / d2 %d 道（应 100 / 100）'
                    % (lv[1], lv[2]))

    # ---- 内容分层：d1 的 OPW2 题只能碰 U1–U4 的词 ----
    for q in questions:
        if q['difficulty'] != 1 or q['tags'][0] in (
                '听音选字母', '大小写配对', '字母顺序', '元音字母'):
            continue
        for t in option_texts(q) + _stem_words(q):
            if t in WORD_FAMILY and WORD_FAMILY[t] not in D1_FAMS:
                errs.append('%s：基础档出现了 U5–U8 的词 %s' % (q['id'], t))
    d2_with_late = len([q for q in questions
                        if q['difficulty'] == 2
                        and any(t in WORD_FAMILY and WORD_FAMILY[t] in D2_FAMS
                                for t in option_texts(q) + _stem_words(q))])
    if d2_with_late < 60:
        errs.append('进阶档里只有 %d 道题涉及 U5–U8 的词（应 ≥ 60）'
                    % d2_with_late)

    # ---- 不许有句子填空（历史版本的坑） ----
    if any(q['tags'][0] == '句子填空' for q in questions):
        errs.append('题库里还有句子填空（OPW2 阶段读不了整句）')

    # ---- 26 字母都要被复习到 ----
    covered = set()
    for q in questions:
        m = re.search(r'[A-Za-z]', q['stem'].get('text') or '')
        if m and q['tags'][0] in ('大小写配对', '字母顺序'):
            covered.add(m.group(0).lower())
    missing = [l for l in LETTERS if l not in covered]
    if missing:
        errs.append('这些字母连一道复习题都没有：%s' % ''.join(missing))

    order_dirs = set()
    for q in questions:
        m = re.search(r'的(上一个|下一个)字母是哪个？',
                      q['stem'].get('text') or '')
        if m:
            order_dirs.add(m.group(1))
    if order_dirs != {'上一个', '下一个'}:
        errs.append('字母顺序题只有一个方向：%s'
                    % ('/'.join(sorted(order_dirs)) or '一道都没有'))

    # ---- 逐题 ----
    for q in questions:
        tag = q['tags'][0]
        stem = q['stem']
        raw = stem.get('text') or ''
        texts = option_texts(q)
        got = answer_text(q)

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
                errs.append('%s：音频里的词 %r 不在字母词表里' % (q['id'], word))
                continue
            if owner[word] != got.lower():
                errs.append('%s：音频读 %s（开头 %s），答案却是 %s'
                            % (q['id'], word, owner[word].upper(), got))
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
                expect, want_case = l, '小写'
                wrong_case = [t for t in texts if t != t.lower()]
            else:
                m = re.match(r'^小写 ([a-z]) 的大写是哪个？$', raw)
                if not m:
                    errs.append('%s：大小写配对的题干写成了 %r' % (q['id'], raw))
                    continue
                l = m.group(1)
                expect, want_case = l.upper(), '大写'
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
            j = UPPER.index(l) + (1 if direction == '下一个' else -1)
            if not 0 <= j < len(UPPER):
                errs.append('%s：%s 没有%s字母' % (q['id'], l, direction))
                continue
            for t in texts:
                if not re.match(r'^[A-Z]$', t):
                    errs.append('%s：选项 %r 不是单个大写字母' % (q['id'], t))
            if got != UPPER[j]:
                errs.append('%s：%s 的%s字母是 %s，答案却是 %s'
                            % (q['id'], l, direction, UPPER[j], got))
            if l in texts:
                errs.append('%s：题干里的 %s 自己也出现在选项里'
                            % (q['id'], l))

        elif tag == '元音字母':
            if raw != VOWEL_STEM:
                errs.append('%s：元音字母的题干写成了 %r' % (q['id'], raw))
            hits = [t for t in texts if t in VOWELS]
            if len(hits) != 1:
                errs.append('%s：选项里的元音字母有 %d 个（%s）'
                            % (q['id'], len(hits), '/'.join(hits)))
            elif hits[0] != got:
                errs.append('%s：答案 %s 不是元音字母' % (q['id'], got))

        elif tag == '听音选词':
            if raw != LISTEN_WORD_STEM:
                errs.append('%s：听音选词的题干写成了 %r' % (q['id'], raw))
            fams = {WORD_FAMILY.get(t) for t in texts}
            if len(fams) != 1 or None in fams:
                errs.append('%s：听音选词的选项不全是同一个词族（%s）'
                            % (q['id'], '/'.join(texts)))
            if stem.get('audio') != 'en.' + got:
                errs.append('%s：听音选词的音频 %r 和答案 %r 对不上'
                            % (q['id'], stem.get('audio'), got))
            for t in texts:
                if t not in WORD_FAMILY:
                    errs.append('%s：选项 %r 不在 OPW2 词表里' % (q['id'], t))
            if texts.count(got) != 1:
                errs.append('%s：听音选词里答案出现了 %d 次'
                            % (q['id'], texts.count(got)))

        elif tag == '辨短元音':
            if raw != VOWEL_SOUND_STEM:
                errs.append('%s：辨短元音的题干写成了 %r' % (q['id'], raw))
            for t in texts:
                if t not in 'aeiou' or len(t) != 1:
                    errs.append('%s：选项 %r 不是单个小写元音字母'
                                % (q['id'], t))
            aid = stem.get('audio') or ''
            word = aid[len('en.'):] if aid.startswith('en.') else ''
            if word not in WORD_FAMILY:
                errs.append('%s：辨短元音的音频 %r 不在 OPW2 词表里'
                            % (q['id'], aid))
            elif got != WORD_VOWEL[word]:
                errs.append('%s：%s 的中间是 %s，答案却是 %s'
                            % (q['id'], word, WORD_VOWEL[word], got))
            hits = [t for t in texts if t == got]
            if len(hits) != 1:
                errs.append('%s：正确元音在选项里出现了 %d 次'
                            % (q['id'], len(hits)))

        elif tag == '押韵配对':
            m = re.match(r'^下面哪个词和 (\S+) 的结尾音一样？$', raw)
            if not m:
                errs.append('%s：押韵配对的题干写成了 %r' % (q['id'], raw))
                continue
            target = m.group(1)
            if target not in WORD_FAMILY:
                errs.append('%s：题干里的 %r 不在词表里' % (q['id'], target))
                continue
            hits = [t for t in texts if t in WORD_FAMILY
                    and rime(t) == rime(target)]
            if len(hits) != 1:
                errs.append('%s：和 %s 结尾音一样的选项有 %d 个（%s）'
                            % (q['id'], target, len(hits), '/'.join(hits)))
            elif hits[0] != got:
                errs.append('%s：答案 %s 的结尾音和 %s 不一样'
                            % (q['id'], got, target))
            if got == target:
                errs.append('%s：题干词 %s 自己出现在选项里' % (q['id'], target))
            for t in texts:
                if t != got and WORD_FAMILY.get(t) == WORD_FAMILY[target]:
                    errs.append('%s：干扰项 %s 和 %s 是同一个词族'
                                % (q['id'], t, target))

        elif tag == '拼合 CVC':
            m = re.match(r'^([a-z]) \+ ([a-z]{2}) 拼起来是哪个词？$', raw)
            if not m:
                errs.append('%s：拼合 CVC 的题干写成了 %r' % (q['id'], raw))
                continue
            onset, fam = m.group(1), m.group(2)
            if got != onset + fam:
                errs.append('%s：%s + %s 应是 %s，答案却是 %s'
                            % (q['id'], onset, fam, onset + fam, got))
            if stem.get('audio'):
                errs.append('%s：拼合 CVC 不能带音频（会念出答案）' % q['id'])
            if any(WORD_FAMILY.get(t) != fam for t in texts):
                errs.append('%s：拼合 CVC 的选项不全是 -%s 词族（%s）'
                            % (q['id'], fam, '/'.join(texts)))
            matched = [t for t in texts if t[0] == onset]
            if len(matched) != 1:
                errs.append('%s：以 %s 开头的选项有 %d 个（%s）'
                            % (q['id'], onset, len(matched), '/'.join(matched)))

        elif tag == '跨词族归类':
            if raw != ODD_FAMILY_STEM:
                errs.append('%s：跨词族归类的题干写成了 %r' % (q['id'], raw))
            if any(t not in WORD_FAMILY for t in texts):
                errs.append('%s：跨词族归类里有不在词表的选项（%s）'
                            % (q['id'], '/'.join(texts)))
                continue
            counts = {}
            for t in texts:
                counts[rime(t)] = counts.get(rime(t), 0) + 1
            odd_rimes = [r for r, n in counts.items() if n == 1]
            if len(counts) != 2 or len(odd_rimes) != 1 or \
                    sorted(counts.values()) != [1, 3]:
                errs.append('%s：选项不是「三个同族 + 一个异族」（%s）'
                            % (q['id'], '/'.join(texts)))
            elif rime(got) != odd_rimes[0]:
                errs.append('%s：答案 %s 不是那个异类' % (q['id'], got))
            others = [t for t in texts if t != got]
            if others and WORD_VOWEL[got] == WORD_VOWEL[others[0]]:
                errs.append('%s：异类 %s 和其余三个同元音，混合度不够'
                            % (q['id'], got))

        elif tag == '找真词':
            if raw != REALWORD_STEM:
                errs.append('%s：找真词的题干写成了 %r' % (q['id'], raw))
            real = [t for t in texts if t in REAL_WORDS]
            if len(real) != 1:
                errs.append('%s：选项里的真词有 %d 个（%s）'
                            % (q['id'], len(real), '/'.join(real)))
            elif real[0] != got:
                errs.append('%s：答案 %s 不是真词' % (q['id'], got))
            for t in texts:
                if t == got:
                    continue
                if len(t) != 3 or not t.isalpha() or not t.islower():
                    errs.append('%s：假词 %r 不是三个小写字母' % (q['id'], t))
                    continue
                if t in REAL_WORDS:
                    errs.append('%s：假词 %s 其实是真词' % (q['id'], t))
                if rime(t) != rime(got):
                    errs.append('%s：假词 %s 和真词 %s 不同族'
                                % (q['id'], t, got))
                if t[0] == got[0]:
                    errs.append('%s：假词 %s 和真词 %s 首字母一样，没换'
                                % (q['id'], t, got))

        else:
            errs.append('%s：未知题型 %r' % (q['id'], tag))

    # ---- 语音清单：两个方向都要对得上 ----
    manifest = build_audio(questions)
    have = [e['id'] for e in manifest['entries']]
    if len(have) != len(set(have)):
        errs.append('语音清单里有重复的 id')
    referenced = [(q['stem'] or {}).get('audio') for q in questions]
    referenced = [a for a in referenced if a]
    for aid in referenced:
        if aid not in have:
            errs.append('语音清单里缺少 %s（有题目在用它）' % aid)
    for aid in have:
        if aid not in referenced:
            errs.append('语音清单里的 %s 没有任何题目在引用' % aid)
    for e in manifest['entries']:
        if not re.match(r'^en\.[a-z]+$', e['id']):
            errs.append('语音 id %r 不是 en. + 小写英文单词' % e['id'])
        if e['voice'] != VOICE:
            errs.append('语音 %s 的音色不是 %s' % (e['id'], VOICE))
        if e['text'] != e['id'][len('en.'):]:
            errs.append('语音 %s 的文本对不上（%r）' % (e['id'], e['text']))

    return errs


def _stem_words(q):
    """题干里出现的 OPW2 单词（用于分档检查）。"""
    raw = (q['stem'] or {}).get('text') or ''
    return [w for w in re.findall(r'[a-z]+', raw) if w in WORD_FAMILY]


def _ids_of(questions, label):
    """按 BUILDERS 的顺序切回每一类题的 id 集合。

    generate() 是依次拼接的，所以按同样的顺序、按 cap 切回来就能定位每一类。
    这里只靠 id 的位置，不靠 tags —— tags 里两档同名（听音选词 / 辨短元音）
    故意合并了，用 tags 数会数错。
    """
    out = set()
    pos = 0
    for name, _fn, cap, _level in BUILDERS:
        chunk = questions[pos:pos + cap]
        pos += cap
        if name == label:
            out.update(q['id'] for q in chunk)
    return out


def audio_report(questions):
    entries = build_audio(questions)['entries']
    cvc = len([e for e in entries if e['text'] in WORD_FAMILY])
    return '  语音清单 %d 条（OPW2 短元音词 %d · OPW1 复习词 %d）' % (
        len(entries), cvc, len(entries) - cvc)


def main():
    qpath = os.path.join(DATA, 'english.json')
    apath = os.path.join(DATA, 'english_audio.json')

    code = run('英语（OPW1 复习 60 + OPW2 短元音 140）', 'english', qpath,
               generate, LIMIT, extra_checks=selfcheck,
               report_extra=audio_report)
    if code != 0:
        return code

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
