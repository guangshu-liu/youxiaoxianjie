#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_yingyu.py — 英语（牛津自然拼读 OPW2 · 短元音）题库生成器

产出两个文件：
    src/data/english.json        英语题库（120 道，全部 choice 题型）
    src/data/english_audio.json  题库引用到的语音清单（tools/gen_audio.py
                                 读它去调 macOS 的 say，这里只管清单对得上）

**词源只有一个**：25 个词族、108 个词，逐字抄自 OPW2（Short Vowels）的词族
体系。出题范围就是这 108 个词，外加一张在代码里具名声明的常见词小表
（SIGHT_WORDS，只用来搭句子骨架）。别的词一个都进不来 —— 这一条由
selfcheck 里「选项、答案、句子里的每个词都在词表里」的断言兜住。

四种题型，配比写死在 BUILDERS 里，上限之和**正好** 120：

    听音选词 40 · 词族归类 28 · 句子填空 27 · 找真词 25

为什么句子要自己写：OPW2 教材的句子有版权，一个字都不能抄。这 27 句是按
词表现写的，写完全库当文本读一遍 —— 语法错、意思拧的句子是这类题库最
丢人的 bug，而机器查不出来（机器只能查「选项是不是都在词表里」）。
所以 selfcheck 只兜得住形式，意思得靠人读；SENTENCES 表的注释里写清了
每类空位是靠什么锁死唯一答案的（词性 / 生命 / 数词），读的时候照着看。

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

# 25 个词族。词源是 git show d5df609:src/data/curriculum.json 的 families 段，
# 逐字抄下来，一字未改。格式：词族 -> (单元, 元音, [词])。
#
# **没有抄 rime 字段** —— 那一列是音标（/æm/ 这种），全库一个字都不许出现
# （见 selfcheck 里的 IPA_CHARS 断言）。词族的「结尾音」用词本身的末两个
# 字母表示，见 rime()。
#
# 字典的插入顺序就是课程序（U1 → U8），出题按这个顺序遍历；打散交给
# interleave()，不靠字典顺序。
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

# 假词只允许换成的首字母。抄自 curriculum.json 的 onsets —— 课程教过的
# 首字母才拿来造词，不自作主张加 q/x 这种孩子还没学的。
ONSETS = ['b', 'c', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'm', 'n', 'p',
          'r', 's', 't', 'v', 'w', 'y', 'z']

# 词表（108 个）和各种反查表，全部由 FAMILIES 推出来 —— 手写第二份词表
# 迟早会和 FAMILIES 对不上，那是这类脚本最难查的一类不一致。
WORDS = []
WORD_FAMILY = {}
WORD_VOWEL = {}
FAMILY_WORDS = {}
for _fam in FAMILIES:
    _unit, _vowel, _ws = FAMILIES[_fam]
    FAMILY_WORDS[_fam] = list(_ws)
    for _w in _ws:
        if _w in WORD_FAMILY:
            raise ValueError('词表里 %s 出现了两次' % _w)
        WORDS.append(_w)
        WORD_FAMILY[_w] = _fam
        WORD_VOWEL[_w] = _vowel

# ---------------------------------------------------------------- 造句白名单

# 造句只允许用这些功能词搭骨架。
#
# 为什么要这张表：句子填空的句子必须是「真句子」，而真句子绕不开 a / the /
# is / on 这些功能词；OPW2 教的是实义词，不含这些。表是**白名单**不是
# 「都用上了」—— 里面留了几个这次没用的（and / he / she / it / to / of），
# 改写句子时不用动断言。
#
# 没有 'I'：本文件所有句子一律小写，而小写的 'i' 在英语里就是拼写错误 ——
# 与其写「i can see a bug.」这种一眼错的句子，不如干脆不用第一人称。
# 也没有 'can'：can 本身就是 OPW2 的词（an 族），不需要白名单放行。
SIGHT_WORDS = {
    'a', 'the', 'is', 'on', 'in', 'and', 'has', 'my', 'see',
    'he', 'she', 'it', 'to', 'of',
}


# ---------------------------------------------------------------- 真词排除表

# 「这些确实是真词」。造「找真词」的假词 —— 把真词的首字母换掉 —— 时，
# 换出来的东西有可能碰巧也是真词（bag → nag/sag/wag/lag/jag/tag 全是），
# 那种假词混进选项，这道题就有两个正确答案，而肉眼看不出来。
#
# 这张表 = OPW2 的 108 个词（由 WORDS 推出）+ 下面这些**同样能由换首字母
# 造出来**的真词。是拿 /usr/share/dict/words（韦氏二版 235,976 条）筛出来的：
# 把 108 个词的每一个首字母换成 ONSETS 里的任意一个，凡是能在词典里查到
# 的都收在这儿。所以「一个三字母组合是不是真词」在这套题里是可判定的：
# 在这张表里就是真词，不在就是假词。
#
# 表里有些粗俗/冒犯词（cum / fag / wop / jap / nig / tit）—— 它们是真词，
# 所以**必须**留在这张表里：留在这儿就意味着它们永远不会被当成假词出现在
# 孩子面前。
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

REAL_WORDS = set(WORDS) | set(REAL_EXTRA)

# 每个词族能造的假词：换首字母，结果还得**不是**真词。
# 注意 an / at 两族各只凑得出 2 个（dat/jat 与 jan/zan，别的首字母换过去
# 都会撞上真词），凑不满一道题要的 3 个干扰项，所以这两族不出「找真词」。
FAKES = {}
for _fam in FAMILIES:
    FAKES[_fam] = [o + _fam for o in ONSETS if o + _fam not in REAL_WORDS]

# ---------------------------------------------------------------- 全库禁用字符

# 音标符号。全库（题干、选项、解释）一个都不许出现 —— 上一版把 curriculum
# 的 rime 字段漏进过题库，孩子看到 /æm/ 只会发懵。这条是硬断言，不是提醒。
IPA_CHARS = set('æɪʊɒʌəɜɔʃʒθðŋɑɛɹʧʤˈˌːˑ')

# 语音清单里的音色。固定值：另一个脚本读这张清单去调 macOS 的 say。
VOICE = 'Samantha'

# ---------------------------------------------------------------- 题库模板

# 四种题型的题干文字都写死在这儿。selfcheck 会拿它们**反查**每道题的题干，
# 于是「生成器里漏进了一段带拼音的中文」这种事不可能悄悄发生。
LISTEN_STEM = '听一听，选出你听到的词'
FAMILY_STEM = '下面哪个词和 %s 的结尾音一样？'
REALWORD_STEM = '下面哪个是真词？'

BLANK = '___'

# ---------------------------------------------------------------- 句子填空的题面

# 27 句全部按词表现写（OPW2 教材原文有版权，一个字都不能抄）。每条是
# (句子, 答案, [三个干扰项])。
#
# 写这 27 句的两条纪律：
#
# 1. **每句自己读过，且只有一处填得通。** 名词挖空是最容易出「两个答案」
#    的地方：「the ___ is on the mat.」配 bat/rat/cat 三个干扰项，三句都
#    成立。所以这里的空位挑的是**词性锁死**的位置 —— 形容词位（后面跟
#    名词，「the bed hat」不成话）、系动词后的形容词位（「the sun is pot」
#    不成话）、数词位（「ten men」只有 ten 是数词）、或者需要生命的位置
#    （「the pen can see」不成话）。这样唯一答案是**语法**保证的，不是
#    靠出题人的语感。
# 2. **干扰项与答案同词族或同元音**，而且不出现在这一句的别处
#    （「the cat has a red hat.」里 hat 就不能当 red 的干扰项）。
#
# 造句只用 is / has / see / can 四个动词，主语一律 a/the + 名词。
# 句子 4–7 个词，全小写，句末一个句号。
SENTENCES = [
    # ---- 形容词位：后面跟着名词，只有形容词填得进去 ----
    ('the ___ hat is on the mat.', 'red', ['bed', 'fed', 'led']),
    ('the ___ bug is in the mud.', 'big', ['fig', 'wig', 'dig']),
    ('the ___ cat is on the bed.', 'big', ['fig', 'wig', 'dig']),
    ('the ___ pot is on the mat.', 'hot', ['cot', 'dot', 'lot']),
    ('my ___ hat is in the bag.', 'wet', ['jet', 'net', 'pet']),
    ('the ___ jam is on the mat.', 'red', ['bed', 'fed', 'led']),
    ('the ___ pig is in the tub.', 'big', ['fig', 'wig', 'dig']),
    ('the hen can see a ___ bug.', 'big', ['fig', 'wig', 'dig']),
    ('the man can see a ___ hat.', 'red', ['bed', 'fed', 'wed']),
    ('the cat has a ___ hat.', 'red', ['bed', 'fed', 'wed']),

    # ---- 系动词后面的形容词位：pot / cot / dot 是名词，填不进去 ----
    ('the pen is ___.', 'red', ['bed', 'fed', 'wed']),
    ('the sun is ___.', 'hot', ['pot', 'cot', 'dot']),
    ('the mud is ___.', 'wet', ['jet', 'net', 'vet']),

    # ---- 需要生命的位置：笔、杯子、地毯不会「看见」 ----
    ('the ___ can see.', 'hen', ['pen', 'ten', 'den']),
    ('the ___ can see the sun.', 'kid', ['hid', 'did', 'lid']),
    ('the ___ can see the cat.', 'pup', ['cup', 'gum', 'tub']),
    ('the ___ can see the mud.', 'bug', ['jug', 'mug', 'rug']),
    ('the ___ can see my hat.', 'man', ['fan', 'van', 'pan']),
    ('the ___ can see my bed.', 'pig', ['fig', 'wig', 'dig']),

    # ---- has 的主语也得是有生命的（东西「有」不了一顶帽子） ----
    ('the ___ has a red hat.', 'pig', ['fig', 'wig', 'dig']),
    ('the ___ has a big hat.', 'man', ['fan', 'van', 'pan']),
    ('the ___ has a red cup.', 'kid', ['hid', 'did', 'lid']),
    ('the ___ has a big mug.', 'pup', ['jug', 'gum', 'tub']),
    ('the ___ has a red van.', 'man', ['fan', 'pan', 'can']),

    # ---- 数词位 / 容器：四个选项里只有 ten 是数词；
    #      hut 和 tub 塞不进一只杯子，hut 塞不进一只锅 ----
    ('the kid can see ___ men.', 'ten', ['pen', 'den', 'hen']),
    ('the ___ is in the cup.', 'pin', ['bin', 'win', 'tin']),
    ('the ___ is in the pot.', 'nut', ['hut', 'cut', 'tub']),
]


def rime(word):
    """词的「结尾音」。25 个词族全是两个字母的韵尾（am/an/at…），词又全是
    三个字母的 CVC 词，所以「末两个字母」就是韵尾本身。

    拿它而不是拿词族名做判断，是为了让断言独立于 FAMILIES 表 —— 表要是
    抄错了一个词，「和 X 结尾音一样」的答案唯一性会当场被这条戳破。
    """
    return word[-2:]


def answer_text(q):
    """这道题正确选项的文字。"""
    return [o['text'] for o in q['options'] if o['id'] == q['answer']][0]


def option_texts(q):
    return [o['text'] for o in q['options']]


# ---------------------------------------------------------------- 各题型

def build_listen():
    """听音选词：播一个词，四个选项都是**同一个词族**的词。

    干扰项必须同族（cat / hat / mat / bat），否则孩子不用听，看一眼首字母
    就能选对 —— 这道题就白出了。词族少于 4 个词的（ud / up / ib / ix / ut /
    ub / um）凑不满四个选项，整族跳过。
    """
    by_family = []
    for fam in FAMILIES:
        words = FAMILY_WORDS[fam]
        if len(words) < 4:
            continue
        qs = []
        for w in seeded('listen-order|' + fam).shuffle(words):
            ds = seeded('listen|' + w).shuffle([x for x in words if x != w])[:3]
            qs.append(make_choice(
                'english', 'en-listen-%s-%s' % (fam, w), '听音选词', 1,
                {'text': LISTEN_STEM, 'audio': 'en.' + w, 'layout': 'grid'},
                w, ds,
                '听到的是 %s。' % w,
            ))
        by_family.append(qs)
    # 按词族轮着抽再切片，不然 [:40] 会把位置全留给排在前面的 am/an/ad
    return interleave(by_family)


def build_family():
    """词族归类：「下面哪个词和 cat 的结尾音一样？」答案唯一。

    干扰项一律取**同一个元音、不同词族**的词（cat → cap / can / bag）。
    这么做有两层好处：一来孩子不能靠元音蒙（四个选项元音一样），必须听
    或者看到结尾的辅音；二来选项里天然只有一个是 -at，唯一答案是构造
    保证的，不是挑出来的。
    """
    by_family = []
    for fam in FAMILIES:
        words = FAMILY_WORDS[fam]
        vowel = WORD_VOWEL[words[0]]
        # 同元音、别的词族。这一步就是「不得碰巧也押韵」的机器版本：
        # 别的词族的韵尾和本族不同，所以不可能也押韵。
        others = [w for w in WORDS
                  if WORD_FAMILY[w] != fam and WORD_VOWEL[w] == vowel]
        qs = []
        for i, w in enumerate(words):
            # 答案取本族的**下一个**词：题干里的词自己不能当选项
            answer = words[(i + 1) % len(words)]
            ds = seeded('family|' + w).shuffle(others)[:3]
            if len(ds) < 3:
                continue
            qs.append(make_choice(
                'english', 'en-family-%s-%s' % (fam, w), '词族归类', 2,
                FAMILY_STEM % w, answer, ds,
                '%s 和 %s 的结尾都是 -%s。' % (w, answer, rime(w)),
            ))
        by_family.append(qs)
    return interleave(by_family)


def build_sentence():
    """句子填空：题面在 SENTENCES，这里只负责拼题。

    干扰项白名单校验（同词族/同元音、不在本句别处出现）在 selfcheck 里，
    不在这儿 —— 造句的人只需要专心把句子写对。
    """
    out = []
    for i, (sentence, answer, ds) in enumerate(SENTENCES):
        n = i + 1
        out.append(make_choice(
            'english', 'en-sentence-%04d' % n, '句子填空', 2,
            # 题干带上整句的音频：6 岁的孩子读不动整句，让他一边听一边看。
            # 音频读的是**填好空**的那一句（见 build_audio），所以它等于答案：
            # audioReveals 告诉渲染器在答题前不要放出喇叭按钮。
            {'text': sentence, 'audio': 'en.sentence.%02d' % n,
             'audioReveals': True, 'layout': 'grid'},
            answer, ds,
            '这一句是「%s」。' % sentence.replace(BLANK, answer),
        ))
    return out


def build_realword():
    """找真词：一个真词 + 三个同词族的假词（gat / dat / lat 这种）。

    假词是换首字母造出来的，而且**必须不是真词** —— 这条由 REAL_WORDS
    保证并在 selfcheck 里反过来验。凑不出 3 个假词的词族（an / at）整族
    跳过，宁可不考也不拿一个真词去当假词。
    """
    by_family = []
    for fam in FAMILIES:
        pool = FAKES[fam]
        if len(pool) < 3:
            continue
        qs = []
        for w in seeded('realword-order|' + fam).shuffle(FAMILY_WORDS[fam]):
            ds = seeded('realword|' + w).shuffle(pool)[:3]
            qs.append(make_choice(
                'english', 'en-real-%s-%s' % (fam, w), '找真词', 2,
                REALWORD_STEM, w, ds,
                '%s 是真词，另外三个不是。' % w,
            ))
        by_family.append(qs)
    return interleave(by_family)


# ---------------------------------------------------------------- 主流程

# (标签, 构造函数, 上限)。上限之和**正好等于** LIMIT —— 这样每一类的题量
# 是有意配的，而不是被切片随机截断的（哪一类出不满，selfcheck 会报出来）。
# 改配比只动这里的数字。
#
# 英语一科占 120 道，是「语文:数学:英语 = 3:3:4」里的那份 4。
BUILDERS = [
    ('听音选词', build_listen, 40),
    ('词族归类', build_family, 28),
    ('句子填空', build_sentence, 27),
    ('找真词', build_realword, 25),
]

LIMIT = 120


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
    第二条同样重要：多出来的条目会让构建流水线生成没人用的音频文件
    （每个词一条，几十条白造的语音）。
    """
    words = set()
    sentences = {}
    for q in questions:
        aid = (q.get('stem') or {}).get('audio') or ''
        if not aid:
            continue
        if aid.startswith('en.sentence.'):
            # 句子音频读的就是孩子屏幕上那一句，只是空填好了
            sentences[aid] = fill_blank(q['stem']['text'], answer_text(q))
        else:
            words.add(aid[len('en.'):])

    entries = [{'id': 'en.' + w, 'text': w, 'voice': VOICE}
               for w in sorted(words)]
    entries += [{'id': aid, 'text': sentences[aid], 'voice': VOICE}
                for aid in sorted(sentences)]
    return {
        'comment': '英语题库引用的语音。由 tools/gen_yingyu.py 生成，不要手改。',
        'entries': entries,
    }


def fill_blank(sentence, word):
    return sentence.replace(BLANK, word)


# ---------------------------------------------------------------- 自检

def selfcheck(questions):
    """英语题库自己的语义校验（结构通用校验在 qbank.selfcheck_common）。

    自动生成的选择题最大的风险不是崩溃，是**一道题有两个正确答案** ——
    四行 JSON 里看不出来，孩子做的时候才发现。下面每一条断言都是把
    「唯一答案」翻译成机器能判定的话。
    """
    errs = []

    # ---- 词表自身的形状。rime() 靠「词长 3、词族名长 2」成立，先验它。 ----
    for w in WORDS:
        if len(w) != 3 or not w.isalpha() or not w.islower():
            errs.append('词表里 %r 不是三个小写字母' % w)
        elif rime(w) != WORD_FAMILY[w]:
            errs.append('%s 的末两个字母 %s 和词族 %s 对不上'
                        % (w, rime(w), WORD_FAMILY[w]))
    if len(WORDS) != len(set(WORDS)):
        errs.append('词表里有重复的词')

    # ---- 配比：每类题正好出满上限（上限之和 = LIMIT，所以不会被截断） ----
    for label, _fn, cap in BUILDERS:
        got = len([q for q in questions if q['tags'] == [label]])
        if got != cap:
            errs.append('「%s」出了 %d 道，配比要求 %d 道' % (label, got, cap))

    # ---- 通用：选项里不许有音标 ----
    for q in questions:
        blob = [q['stem'].get('text') or '', q.get('explain') or '']
        blob += option_texts(q)
        for ch in ' '.join(blob):
            if ch in IPA_CHARS:
                errs.append('%s：出现了音标符号 %s（全库不许有音标）'
                            % (q['id'], ch))

    for q in questions:
        tag = q['tags'][0]
        stem = q['stem']
        texts = option_texts(q)
        got = answer_text(q)

        # ---- 所有单词必须来自 OPW2 词表 ----
        # 空格也要去掉：音标那种「/æm/」混不进来，但「a cat」这种带空格的
        # 选项同样是坏的。
        #
        # 「找真词」豁免这条：它的三个干扰项**本来就该不是词**，那正是这道题
        # 要考的东西。「它是不是词」由下面 REAL_WORDS 那几条单独判。
        for t in texts:
            if t.strip() != t or ' ' in t:
                errs.append('%s：选项 %r 前后有空格或夹了空格' % (q['id'], t))
            elif t not in WORD_FAMILY and tag != '找真词':
                errs.append('%s：选项 %r 不在 OPW2 词表里' % (q['id'], t))

        if tag == '听音选词':
            # 四个选项必须同一个词族 —— 不然孩子靠首字母就能选对，不用听
            fams = {WORD_FAMILY.get(t) for t in texts}
            if len(fams) != 1 or None in fams:
                errs.append('%s：听音选词的选项不全是同一个词族（%s）'
                            % (q['id'], '/'.join(texts)))
            if stem.get('text') != LISTEN_STEM:
                errs.append('%s：听音选词的题干写成了 %r' % (q['id'], stem.get('text')))
            # 音频播的就是答案那个词，且只播一个词
            if stem.get('audio') != 'en.' + got:
                errs.append('%s：听音选词的音频 %r 和答案 %r 对不上'
                            % (q['id'], stem.get('audio'), got))
            # 有且只有一个正确答案：音频里的词在选项里只出现一次
            if texts.count(got) != 1:
                errs.append('%s：听音选词里答案出现了 %d 次' % (q['id'], texts.count(got)))

        elif tag == '词族归类':
            m = re.match(r'^下面哪个词和 (\S+) 的结尾音一样？$', stem.get('text') or '')
            if not m:
                errs.append('%s：词族归类的题干写成了 %r' % (q['id'], stem.get('text')))
                continue
            target = m.group(1)
            if target not in WORD_FAMILY:
                errs.append('%s：题干里的 %r 不在词表里' % (q['id'], target))
                continue
            # **唯一答案**：选项里有且只有一个词的末两个字母和题干词相同。
            # 这就是「不得碰巧也押韵」的机器版本 —— 问 -at 时选项里出现
            # 两个 -at 词，这道题就废了。
            hits = [t for t in texts if rime(t) == rime(target)]
            if len(hits) != 1:
                errs.append('%s：和 %s 结尾音一样的选项有 %d 个（%s）'
                            % (q['id'], target, len(hits), '/'.join(hits)))
            elif hits[0] != got:
                errs.append('%s：答案 %s 的结尾音和 %s 不一样' % (q['id'], got, target))
            if got == target:
                errs.append('%s：题干词 %s 自己出现在选项里' % (q['id'], target))
            # 干扰项必须来自别的词族 —— 否则「碰巧押韵」会以同族的形式漏进来
            for t in texts:
                if t != got and WORD_FAMILY.get(t) == WORD_FAMILY.get(target):
                    errs.append('%s：干扰项 %s 和 %s 是同一个词族'
                                % (q['id'], t, target))

        elif tag == '找真词':
            if stem.get('text') != REALWORD_STEM:
                errs.append('%s：找真词的题干写成了 %r' % (q['id'], stem.get('text')))
            # **唯一答案**：选项里有且只有一个真词
            real = [t for t in texts if t in REAL_WORDS]
            if len(real) != 1:
                errs.append('%s：选项里的真词有 %d 个（%s）'
                            % (q['id'], len(real), '/'.join(real)))
            elif real[0] != got:
                errs.append('%s：答案 %s 不是真词' % (q['id'], got))
            for t in texts:
                if t == got:
                    continue
                # 假词必须真的造出来：换首字母、同韵尾、且不在真词表里
                if len(t) != 3 or not t.isalpha() or not t.islower():
                    errs.append('%s：假词 %r 不是三个小写字母' % (q['id'], t))
                    continue
                if t in REAL_WORDS:
                    errs.append('%s：假词 %s 其实是真词' % (q['id'], t))
                if rime(t) != rime(got):
                    errs.append('%s：假词 %s 和真词 %s 不同族' % (q['id'], t, got))
                if t[0] == got[0]:
                    errs.append('%s：假词 %s 和真词 %s 首字母一样，没换'
                                % (q['id'], t, got))
                # 这个假词的首字母换回本族的某个真词，就是它的来历
                if not [w for w in FAMILY_WORDS[WORD_FAMILY[got]] if rime(w) == rime(t)]:
                    errs.append('%s：假词 %s 换不出任何真词' % (q['id'], t))

        elif tag == '句子填空':
            raw = stem.get('text') or ''
            if raw.count(BLANK) != 1:
                errs.append('%s：句子里的空位有 %d 个（%r）'
                            % (q['id'], raw.count(BLANK), raw))
                continue
            if raw != raw.lower():
                errs.append('%s：句子不是全小写（%r）' % (q['id'], raw))
            if not raw.endswith('.'):
                errs.append('%s：句子末尾不是句号（%r）' % (q['id'], raw))
            tokens = raw.split(' ')
            if not 4 <= len(tokens) <= 7:
                errs.append('%s：句子 %d 个词，不在 4–7 之间（%r）'
                            % (q['id'], len(tokens), raw))
            # 除空位外，每个词都得是 OPW2 的词或白名单里的功能词
            for t in tokens:
                # 先去掉句末的句号再认空位 —— 「the pen is ___.」的最后一个
                # 词节是「___.」，不是「___」
                if t.endswith('.'):
                    t = t[:-1]
                if t == BLANK:
                    continue
                if t not in WORD_FAMILY and t not in SIGHT_WORDS:
                    errs.append('%s：句子里的 %r 既不在 OPW2 词表里，'
                                '也不在常见词白名单里' % (q['id'], t))
            if got not in WORD_FAMILY:
                errs.append('%s：填进去的 %s 不在 OPW2 词表里' % (q['id'], got))
            filled = fill_blank(raw, got)
            # 句子的其余部分（空位换成空格，免得答案自己撞上自己）
            rest = [t.rstrip('.') for t in fill_blank(raw, ' ').split()]
            if got in rest:
                errs.append('%s：答案 %s 在句子的别处也出现了' % (q['id'], got))
            # 干扰项：同词族或同元音，而且不能出现在这一句的别处 ——
            # 「the cat has a red hat.」里 hat 就不能当 red 的干扰项
            for t in texts:
                if t == got:
                    continue
                same = (WORD_FAMILY.get(t) == WORD_FAMILY.get(got)
                        or WORD_VOWEL.get(t) == WORD_VOWEL.get(got))
                if not same:
                    errs.append('%s：干扰项 %s 和答案 %s 既不同族也不同元音'
                                % (q['id'], t, got))
                if t in rest:
                    errs.append('%s：干扰项 %s 本来就出现在这句里' % (q['id'], t))
            # 音频：id 有序号，文本就是填好空的那一句
            m = re.match(r'^en\.sentence\.(\d\d)$', stem.get('audio') or '')
            if not m:
                errs.append('%s：句子填空的音频 id 写成了 %r'
                            % (q['id'], stem.get('audio')))
            elif stem.get('text') != SENTENCES[int(m.group(1)) - 1][0]:
                errs.append('%s：题干和 SENTENCES 表里的第 %s 句对不上'
                            % (q['id'], m.group(1)))
            # 句子音频念的是填好空的那句，等于答案，必须带上 audioReveals
            if not stem.get('audioReveals'):
                errs.append('%s：句子填空的音频会念出答案，必须标 audioReveals'
                            % q['id'])
            if filled != filled.lower():
                errs.append('%s：填好空的句子不是全小写' % q['id'])

    # 句子本身：27 条各不相同（两条一样的句子，孩子会以为是同一题）
    seen = {}
    for i, (s, _a, _d) in enumerate(SENTENCES):
        if s in seen:
            errs.append('SENTENCES 第 %d 句和第 %d 句一模一样' % (i + 1, seen[s]))
        seen[s] = i + 1
        if '___' not in s:
            errs.append('SENTENCES 第 %d 句没有空位' % (i + 1))

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
        if not re.match(r'^en\.[a-z0-9.]+$', e['id']):
            errs.append('语音 id %r 不是全 ASCII 小写无空格' % e['id'])
        if e['voice'] != VOICE:
            errs.append('语音 %s 的音色不是 %s' % (e['id'], VOICE))
        if not e['text']:
            errs.append('语音 %s 没有文本' % e['id'])
        if e['id'].startswith('en.sentence.'):
            if not e['text'].endswith('.'):
                errs.append('句子语音 %s 的文本不是一整句' % e['id'])
        elif e['text'] != e['id'][len('en.'):]:
            errs.append('词语音 %s 的文本对不上（%r）' % (e['id'], e['text']))

    return errs


def audio_report(questions):
    """报告里那行「语音清单 N 条（词 x · 句 y）」。"""
    entries = build_audio(questions)['entries']
    sent = len([e for e in entries if e['id'].startswith('en.sentence.')])
    return '  语音清单 %d 条（词 %d · 句 %d）' % (len(entries), len(entries) - sent, sent)


def main():
    qpath = os.path.join(DATA, 'english.json')
    apath = os.path.join(DATA, 'english_audio.json')

    code = run('英语（自然拼读 OPW2）', 'english', qpath, generate, LIMIT,
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
