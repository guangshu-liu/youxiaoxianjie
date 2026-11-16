#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_shuxue.py — 数学题库生成器

产出 src/data/math.json（90 道，全部 choice 题型），是「语文 / 数学 / 英语」
三科里的数学那一份。

数学题没有语文那种「选项里混进了超纲的字」的问题，但有一类更隐蔽的错：
**一道题不止一个正确答案**。自动出题最容易栽在两类题上：

  · 找规律 —— 「3、6、9、（）」除了 12，还可能是别的读法；公差为 1 的
    「3、4、5、（）」更是既像等差又像数数。
  · 分类 —— 同一组四个数，按奇偶看异类是 A，按位数看异类是 B，题目就废了。

所以 selfcheck 不只看结构（那部分在 qbank.selfcheck_common 里），还要
**照着题干把答案重新算一遍**，再断言四个选项里恰好一个等于它。答案对不对
不靠生成时算得对，靠这遍复核 —— 生成和复核是两条独立的路。

其余硬约束，同样交给机器：
  · 数字不超过 100，不出现负数；减法结果不为负。
  · 干扰项是「算错会得到」的数（差 1 / 差 10 / 忘进位忘退位 / 看错符号），
    并且**自己也不越界** —— 「43 - 7」的干扰项里不能出现 -4。
  · 全中文，不出现英文字母；算式里的 + - 一律半角，全库统一。
  · 纯算式（计算 / 拆数 / 找规律）用 layout='big-number'，
    文字情境（应用题 / 比大小 / 分类）用 'grid'。

产物必须可复现：跑两次得到逐字节相同的 JSON，`--check` 才有意义。所以随机
全部走 qbank.seeded()（内部是 Rng(dhash(...))），一行内置 random 都没有。

用法：
    python3 tools/gen_shuxue.py            # 生成
    python3 tools/gen_shuxue.py --check    # 只校验产物是否与生成结果一致
"""

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from qbank import (
    DATA, ROOT, Rng, dhash, interleave, make_choice, run, seeded, write_json,
)

# 最大的数。100 以内加减法 —— 答案、干扰项、题干里出现的任何数都不许越过去。
MAX_NUM = 100

# 题干 / 选项 / 解释里不许出现拉丁字母。语文那一科拿同一条规则挡拼音，
# 数学这边挡的是顺手写出来的 x、①② 之外的杂字母。
LATIN_RE = re.compile(r'[A-Za-z]')

# ---------------------------------------------------------------- 抽题工具


def pick(rng, pool, n):
    """从池子里不重复地取 n 个，池子不够就返回空表。

    用 rng.shuffle 而不是 random.sample：内置随机的种子来自系统时间，
    同一个脚本跑两次会得到两份不同的题库，--check 立刻失去意义。
    """
    pool = list(pool)
    if len(pool) < n:
        return []
    return rng.shuffle(pool)[:n]


def near_miss(answer, cands, seed, lo=0, hi=MAX_NUM, avoid=()):
    """把「算错会得到的数」收拾成三个干扰项的文本。

    cands 由生成器按「孩子会怎么错」排出来（差 1、差 10、忘了进位…），
    这里只做三件事：丢掉越界的（负数、超过 100 的）、丢掉跟答案重样的、
    去重，再按种子打散。打散是必需的 —— 不打散的话每道题的干扰项都是
    同一组偏移量，孩子做上五道就能靠规律蒙。

    avoid 是题干里已经写出来的数。差几的偏移量很容易正好撞上它们
    （找规律里公差是 10 的时候，减 10 就回到了题面上那个数），
    撞上了这个选项等于白送，也显得像生成器没长眼睛。

    返回的列表可能不足 3 个，调用方自己决定跳过还是补。
    """
    pool = []
    for c in cands:
        if lo <= c <= hi and c != answer and c not in avoid and c not in pool:
            pool.append(c)
    return [str(c) for c in seeded(seed).shuffle(pool)[:3]]


# ---------------------------------------------------------------- 直接计算

def calc_pairs():
    """能出的算式全集。两条约束在这里就定死：

      · 加法必须**进位**（个位满十）—— 不进位的 23 + 4 数数就能做；
      · 减法必须**退位**（个位不够减）—— 不借位的 47 - 5 同理。

    这一档练的就是「满十进一」和「退一当十」这两个动作，所以算式是筛出来
    的，不是随机撞出来的。
    """
    adds, subs = [], []
    for a in range(11, MAX_NUM):
        for b in range(2, 10):
            if a % 10 + b >= 10 and a + b <= MAX_NUM:
                adds.append((a, b))
            if a % 10 < b:                      # a - b 必然 > 0，不会出负数
                subs.append((a, b))
    return adds, subs


def build_calc():
    """直接计算：100 以内进位加 / 退位减。"""
    adds, subs = calc_pairs()
    rng = Rng(dhash('calc-pick') & 0xFFFF)
    adds = rng.shuffle(adds)
    subs = rng.shuffle(subs)

    add_qs, sub_qs = [], []

    for a, b in adds:
        if len(add_qs) >= 50:
            break
        r = a + b
        # 干扰项：忘了进位（少 10）、多写一个十（多 10）、差 1、差 2、
        # 把加号看成减号（a - b）。全是孩子真会写出来的数 —— 刻意不放 ±20
        # 那种「差得很远」的偏移量，孩子看一眼就知道不对。
        ds = near_miss(r, [r - 10, r + 10, r - 1, r + 1, r - 2, r + 2, a - b],
                       'calc+%d+%d' % (a, b))
        if len(ds) < 3:
            continue
        add_qs.append(make_choice(
            'math', 'ma-jia-%04d' % (len(add_qs) + 1), '计算', 2,
            '%d + %d = ?' % (a, b), str(r), ds,
            '%d + %d = %d。个位 %d 加 %d 得 %d，满十要向十位进一。'
            % (a, b, r, a % 10, b, a % 10 + b),
            layout='big-number'))

    for a, b in subs:
        if len(sub_qs) >= 50:
            break
        r = a - b
        # 干扰项：忘了退位（多 10）、退多了（少 10）、差 1、差 2、
        # 把减号看成加号（a + b，超过 100 的会被 near_miss 丢掉）。
        ds = near_miss(r, [r + 10, r - 10, r - 1, r + 1, r - 2, r + 2, a + b],
                       'calc-%d-%d' % (a, b))
        if len(ds) < 3:
            continue
        sub_qs.append(make_choice(
            'math', 'ma-jian-%04d' % (len(sub_qs) + 1), '计算', 2,
            '%d - %d = ?' % (a, b), str(r), ds,
            '%d - %d = %d。个位 %d 减 %d 不够，从十位借一当十，%d 减 %d 得 %d。'
            % (a, b, r, a % 10, b, a % 10 + 10, b, a % 10 + 10 - b),
            layout='big-number'))

    # 加一道减一道，孩子不会连着做 13 道加法做麻了
    return interleave([add_qs, sub_qs])


# ---------------------------------------------------------------- 拆数凑十

def build_chaishu():
    """拆数凑十：两位数怎么拆成整十和几个一，以及凑十法。

    四种问法各 6 道：
        25 = 20 + ?            拆出个位
        25 = ? + 5             拆出整十（反着问才是真的懂，只问一个方向的话，
                               孩子会以为「拆数」就是把个位抹掉）
        7 + 8 = 7 + 3 + ?      凑十法
        56 里面有 5 个十和几个一？   数位
    """
    ns = [n for n in seeded('chaishu-pick').shuffle(range(11, 100))
          if n % 10 != 0]              # 个位是 0 的没有「几个一」可问

    # 三种问法各用一段**互不重叠**的数。共用一段的话，轮着抽出来的会是
    # 同一个数的三个问法 —— 「13 = 10 + ?」后面紧跟「13 = ? + 3」，
    # 中间还夹一道「13 里面有 1 个十和几个一？」，孩子一眼就看穿了。
    third = len(ns) // 3
    ones_pool, tens_pool, digit_pool = ns[:third], ns[third:2 * third], ns[2 * third:]

    ones, tens = [], []
    for n in ones_pool:
        if len(ones) >= 7:
            break
        tens_digit, ones_digit = n // 10, n % 10
        tens_val = tens_digit * 10
        # 干扰项里放了十位数字本身（2）和整个数（25）—— 分不清「几个十」
        # 和「几个一」的孩子，正好会写这两个。
        ds = near_miss(ones_digit, [ones_digit + 1, ones_digit - 1,
                                    ones_digit + 2, ones_digit - 2,
                                    tens_digit, n], 'chai-o%d' % n)
        if len(ds) < 3:
            continue
        ones.append(make_choice(
            'math', 'ma-chai-o-%04d' % (len(ones) + 1), '拆数', 2,
            '%d = %d + ?' % (n, tens_val), str(ones_digit), ds,
            '%d 里面有 %d 个十和 %d 个一，所以 %d = %d + %d。'
            % (n, tens_digit, ones_digit, n, tens_val, ones_digit),
            layout='big-number'))

    for n in tens_pool:
        if len(tens) >= 7:
            break
        tens_digit, ones_digit = n // 10, n % 10
        tens_val = tens_digit * 10
        # 同一条思路反过来：? + 5 = 25，缺的是整十那一份
        ds = near_miss(tens_val, [tens_val + 10, tens_val - 10,
                                  tens_val + 1, tens_val - 1,
                                  n, ones_digit], 'chai-t%d' % n)
        if len(ds) < 3:
            continue
        tens.append(make_choice(
            'math', 'ma-chai-t-%04d' % (len(tens) + 1), '拆数', 2,
            '%d = ? + %d' % (n, ones_digit), str(tens_val), ds,
            '%d 里面有 %d 个十和 %d 个一，所以 %d = %d + %d。'
            % (n, tens_digit, ones_digit, n, tens_val, ones_digit),
            layout='big-number'))

    # 凑十法：把第二个加数拆成「补满十的那块」和「剩下的那块」。
    # 只有 a + b > 10 才拆得出非零的剩下那块，所以先筛掉 a + b <= 10 的。
    couple = []
    pairs = [(a, b) for a in range(2, 10) for b in range(2, 10) if a + b > 10]
    for a, b in seeded('chaishu-couple').shuffle(pairs):
        if len(couple) >= 7:
            break
        fill = 10 - a                  # 8 拆成 3 和 5 里的那个 3
        r = b - fill                   # = a + b - 10，1..8
        ds = near_miss(r, [r + 1, r - 1, r + 2, r - 2, fill, b, a],
                       'cou%d+%d' % (a, b))
        if len(ds) < 3:
            continue
        couple.append(make_choice(
            'math', 'ma-chai-c-%04d' % (len(couple) + 1), '拆数', 2,
            '%d + %d = %d + %d + ?' % (a, b, a, fill), str(r), ds,
            '%d + %d = %d；%d + %d = 10，10 再加 %d 得 %d。'
            % (a, b, a + b, a, fill, r, a + b),
            layout='big-number'))

    # 数位：56 里面有 5 个十和几个一
    digit = []
    for n in digit_pool:
        if len(digit) >= 7:
            break
        tens_digit, ones_digit = n // 10, n % 10
        # 干扰项里的 5（十位数字）是专门留给「把几个十当成几个一」的
        ds = near_miss(ones_digit, [ones_digit + 1, ones_digit - 1,
                                    ones_digit + 2, tens_digit, n],
                       'dig%d' % n)
        if len(ds) < 3:
            continue
        digit.append(make_choice(
            'math', 'ma-chai-d-%04d' % (len(digit) + 1), '拆数', 2,
            '%d 里面有 %d 个十和几个一？' % (n, tens_digit), str(ones_digit), ds,
            '%d 里面有 %d 个十和 %d 个一。' % (n, tens_digit, ones_digit),
            layout='big-number'))

    return interleave([ones, tens, couple, digit])


# ---------------------------------------------------------------- 应用题

# 应用题模板。%d 按顺序填两个数，每句后面的符号是这道题该用的算法。
#
# 模板和算法写在同一张表里，是因为 selfcheck 要**拿这张表反过来验证**：
# 题干写着「还剩」，答案却算成了加法，是这一类题最容易犯又最难用眼睛发现的
# 错。表里没有的题干，自检直接判失败。
#
# 正好 14 个模板对 14 道题，一个模板出一道 —— 复用模板会让两道题干一样、
# 只有数字不同的题挨在一起（切片是按顺序取的），一眼就是凑数。
WORD_PROBLEMS = [
    ('小明有 %d 颗糖，吃了 %d 颗，还剩几颗？', '-'),
    ('树上停着 %d 只小鸟，又飞来 %d 只，一共有几只？', '+'),
    ('妈妈买了 %d 个苹果，吃掉 %d 个，还剩多少个？', '-'),
    ('停车场里停着 %d 辆车，开走 %d 辆，还剩几辆？', '-'),
    ('小红有 %d 张画片，小兰又给她 %d 张，现在一共有多少张？', '+'),
    ('篮子里有 %d 个鸡蛋，用了 %d 个，还剩多少个？', '-'),
    ('教室里有 %d 张桌子，又搬来 %d 张，一共有多少张？', '+'),
    ('书架上有 %d 本书，借走 %d 本，还剩多少本？', '-'),
    ('小华折了 %d 只纸鹤，小丽折了 %d 只，两人一共折了多少只？', '+'),
    ('池塘里有 %d 条小鱼，捞走 %d 条，还剩多少条？', '-'),
    ('果园里有 %d 棵果树，又种了 %d 棵，一共有多少棵？', '+'),
    ('盘子里有 %d 块饼干，吃掉 %d 块，还剩多少块？', '-'),
    ('花坛里有 %d 朵花，又开了 %d 朵，一共有多少朵？', '+'),
    ('小猴摘了 %d 个桃子，又摘了 %d 个，一共有多少个？', '+'),
]


def template_re(fmt):
    """把模板变成能抓出那两个数的正则。

    不能直接 re.escape(fmt) 了事：这里要留出两个数字的捕获位，所以先按
    '%d' 切开、逐段转义，再用捕获组拼回去。
    """
    return re.compile('^' + r'(\d+)'.join(re.escape(p) for p in fmt.split('%d')) + '$')


WORD_RES = [(template_re(fmt), op) for fmt, op in WORD_PROBLEMS]


def word_numbers(rng, op, used):
    """给应用题配两个数。

    约束跟「直接计算」保持一致（进位 / 退位、结果不越界）—— 同一档难度里
    不该突然冒出一道超纲的题。used 用来躲开重复的算式：两道题干不同、
    算式一样的应用题，孩子一眼就看出来是同一道。
    """
    for _ in range(200):
        a = rng.int(12, 91)
        b = rng.int(3, 9)
        if op == '+':
            ok = a % 10 + b >= 10 and a + b <= MAX_NUM     # 进位且不越界
        else:
            ok = a % 10 < b                                # 退位，结果必为正
        if ok and (a, b, op) not in used:
            return a, b
    return (25, 8) if op == '+' else (43, 7)               # 兜底，也是合法算式


def build_word():
    """应用题：一句话情境，孩子要自己判断该加还是该减。

    20 道 = 14 个模板各一道 + 再从模板里补 6 道（换一组数字）。
    模板不够用，但补题时用的数字和第一轮完全不同（`used` 挡着），
    所以不会出现「同一道题换个数字又来一遍」。
    """
    add_qs, sub_qs = [], []
    used = set()

    for rnd in range(2):
        for ti, (fmt, op) in enumerate(WORD_PROBLEMS):
            if len(add_qs) + len(sub_qs) >= 20:
                break
            a, b = word_numbers(seeded('word', rnd, ti), op, used)
            used.add((a, b, op))
            r = a + b if op == '+' else a - b
            # 干扰项：差 1、差 10，以及「该加的时候减了 / 该减的时候加了」。
            # 最后那个是最值钱的 —— 孩子列错算式时写的就是它。
            ds = near_miss(r, [r - 1, r + 1, r - 10, r + 10,
                               (a - b) if op == '+' else (a + b), r + 2],
                           'word%d-%d-%d' % (ti, a, b))
            if len(ds) < 3:
                continue
            n = len(add_qs) + len(sub_qs) + 1
            q = make_choice(
                'math', 'ma-word-%04d' % n, '应用题', 2,
                fmt % (a, b), str(r), ds,
                '用%s法：%d %s %d = %d。'
                % ('加' if op == '+' else '减', a, op, b, r))
            (add_qs if op == '+' else sub_qs).append(q)

    # 加一道减一道，不然连着七道都是同一种算式
    return interleave([add_qs, sub_qs])


# ---------------------------------------------------------------- 比大小

def build_compare():
    """比大小：三个问法，共同的不变式是「答案就是四个选项里唯一的最大
    （或最小）的那个数」。

    这一条同时把两类歧义挡在外面：
      · 四个数里有两个一样大的 → 「哪个最大」有两个答案；
      · 「37 和 41 哪个大？」的选项里混进 55 → 孩子不看题干、直接找最大的
        那个数也能选中 55，题目就变成了另一道题。所以这种问法的两个干扰项
        **必须比 37 和 41 都小**，答案才仍然是唯一的最大值。
    """
    rng = seeded('compare')
    just_max, just_min = [], []
    used = set()

    for _ in range(400):
        if len(just_max) >= 6 and len(just_min) >= 6:
            break
        nums = pick(rng, range(1, MAX_NUM + 1), 4)
        if not nums:
            break
        key = tuple(sorted(nums))
        if key in used:
            continue
        used.add(key)
        mx, mn = max(nums), min(nums)

        # 一轮只喂给一个问法。两个问法共用同一组四位数的话，轮着抽出来就是
        # 「哪个最大？[49,24,1,42]」紧跟「哪个最小？[49,24,1,42]」——
        # 同一组数连问两遍，第二遍孩子是背出来的，不是比出来的。
        if len(just_max) < 6 and len(just_max) <= len(just_min):
            ds = [str(x) for x in nums if x != mx]      # 四个数互不相同，答案唯一
            just_max.append(make_choice(
                'math', 'ma-big-%04d' % (len(just_max) + 1), '比大小', 1,
                '下面哪个数最大？', str(mx), ds,
                '把四个数比一比：%d 比 %s 都大，所以 %d 最大。'
                % (mx, '、'.join(str(x) for x in sorted(nums)[:-1]), mx)))
            continue

        if len(just_min) < 6:
            ds = [str(x) for x in nums if x != mn]
            just_min.append(make_choice(
                'math', 'ma-small-%04d' % (len(just_min) + 1), '比大小', 1,
                '下面哪个数最小？', str(mn), ds,
                '把四个数比一比：%d 比 %s 都小，所以 %d 最小。'
                % (mn, '、'.join(str(x) for x in sorted(nums)[1:]), mn)))

    # 「37 和 41 哪个大？」——两个干扰项都取得比小的那个还小，
    # 而且尽量贴近（差 1、差 2），这样选项看上去像一道正常的大小题。
    two = []
    rng2 = seeded('compare-two')
    for _ in range(200):
        if len(two) >= 6:
            break
        a = rng2.int(5, MAX_NUM)
        b = rng2.int(5, MAX_NUM)
        if a == b:
            continue
        lo, hi = min(a, b), max(a, b)
        pool = [x for x in (lo - 1, lo - 2, hi - 1, hi - 2, lo - 3, hi - 3)
                if 1 <= x < lo]
        extra = [str(x) for x in pick(rng2, sorted(set(pool)), 2)]
        if len(extra) < 2:
            continue
        # 四个选项 = 题里那两数 + 两个比它们都小的数。取贴近的差 1 / 差 2，
        # 看起来才像一道正常的大小题，而不是混进来两个不相干的数。
        ds = [str(lo)] + extra
        two.append(make_choice(
            'math', 'ma-cmp-%04d' % (len(two) + 1), '比大小', 1,
            '%d 和 %d 哪个大？' % (lo, hi), str(hi), ds,
            '%d 和 %d 比，%d 更大。' % (lo, hi, hi)))

    return interleave([just_max, just_min, two])


# ---------------------------------------------------------------- 找规律

def build_seq():
    """找规律。只出等差数列，并且公差 ≥ 2。

    公差为 1 的「3、4、5、（）」不能出：它和「接着数数」分不开，而这一档
    练的是找规律。公差 ≥ 2 的数列，前三个数就把公差钉死了（d = t2 - t1，
    再看 t3 - t2 是否相等），所以延续方式唯一。

    顺带一提，等差数列永远不会同时是等比数列（t1·t3 = t2² 要求 d = 0），
    所以「2、4、8」那种两个规律都说得通的坑，只要坚持按等差生成就踩不到。
    """
    groups = []
    # 三档：小步（+2..+5）、整十（+10）、大步（+12..+20）。
    # 分开成组是为了让三种步长都占上，不按步长分组的话切片会全是小步。
    plans = [
        (range(2, 6), range(1, 21)),
        (range(10, 11), range(10, 31)),
        (range(12, 21), range(12, 31)),
    ]
    for si, (steps, starts) in enumerate(plans):
        rng = seeded('seq', si)
        cands = [(s, d) for d in steps for s in starts
                 if s + 3 * d <= MAX_NUM]           # 第四项也要在 100 以内
        cands = rng.shuffle(cands)
        qs = []
        for start, d in cands:
            if len(qs) >= 7:
                break
            t1, t2, t3 = start, start + d, start + 2 * d
            r = t3 + d
            # 干扰项：差 1（忘了加公差）、差 2、差 10（数位错）、
            # 跳一格（少加一次公差）、跳两格。
            # 不放 r - d：那是题干里已经写出来的第三个数，当选项等于送分。
            # avoid 挡的是同一类事：公差是 10 的时候 r - 10 正好等于第三个数；
            # lo=1 是因为数列里全是正数，混一个 0 进来很扎眼。
            ds = near_miss(r, [r + 1, r - 1, r + 10, r - 10, r + d, r + 2 * d,
                               r + 2], 'seq%d' % start, lo=1,
                           avoid=(t1, t2, t3))
            if len(ds) < 3:
                continue
            # id 里必须带组号。三组都用 'ma-seq-0001' 的话，make_choice 拿
            # 同一个种子打乱选项，同一位置的题会得到一样的选项顺序 ——
            # 表现出来就是「这一档的答案全在 c」，孩子两题之后就只点 c 了。
            qs.append(make_choice(
                'math', 'ma-seq-%d-%04d' % (si, len(qs) + 1), '找规律', 2,
                '%d、%d、%d、（　）' % (t1, t2, t3), str(r), ds,
                '每次多 %d：%d、%d、%d，再往后是 %d。' % (d, t1, t2, t3, r),
                layout='big-number'))
        groups.append(qs)

    return interleave(groups)


# ---------------------------------------------------------------- 分类

# 分类题的出法：(其他三个的说法, 其他三个的判据, 异类的判据, 异类的说法)。
#
# 判据只有奇偶 / 位数 / 整十三条 —— 都是 6 岁孩子看得见的东西。
# 数值池卡在 1..99（不取 100），否则「位数」这条判据会被 100 这个三位数
# 弄出歧义。
CLASS_RULES = [
    ('都是双数', lambda n: n % 2 == 0, lambda n: n % 2 == 1, '是单数'),
    ('都是单数', lambda n: n % 2 == 1, lambda n: n % 2 == 0, '是双数'),
    ('都是一位数', lambda n: n < 10, lambda n: n >= 10, '是两位数'),
    ('都是整十数', lambda n: n % 10 == 0, lambda n: n % 10 != 0, '不是整十数'),
    ('都不是整十数', lambda n: n % 10 != 0, lambda n: n % 10 == 0, '是整十数'),
]

# 判断「异类」的三条判据。生成和自检都读这一张表。
RULES = [
    ('奇偶', lambda n: n % 2 == 0),
    ('位数', lambda n: n >= 10),
    ('整十', lambda n: n % 10 == 0),
]


def odd_one_out(texts):
    """四个数在每条判据下「异类」分别是谁。

    分类题的全部风险都在这里：同一组数，按奇偶看异类是 A，按位数看异类是 B，
    这道题就有两个答案。只收能切成 3+1 的判据 —— 切不开（2+2）说明这条判据
    下谁也不特殊，那就不是一条能用来做题的规则。
    """
    out = {}
    vals = [(t, int(t)) for t in texts]
    for name, pred in RULES:
        yes = [t for t, n in vals if pred(n)]
        no = [t for t, n in vals if not pred(n)]
        if len(yes) == 1:
            out[name] = yes[0]
        elif len(no) == 1:
            out[name] = no[0]
    return out


def class_ok(texts, answer):
    """这组选项能不能当一道分类题。

    两条：每条判据下的异类都得是同一个人（否则换个说法就有另一个答案），
    而且这个异类必须是四个数里**最大的那个**。

    后一条是经验性的取舍：「异类是最大的」能把「哪个数最大/超过 50」这类
    临时想出来的规则也导到同一个答案上。它挡不住孩子自创的任意规则
    （「唯一带 3 的」之类），那是 4 个元素分 3+1 这个问题本身的性质，
    只能靠判据选得干净来缓解。
    """
    kinds = odd_one_out(texts)
    if not kinds:
        return False
    if any(v != answer for v in kinds.values()):
        return False
    return answer == max(texts, key=int)


def build_classify():
    """分类：下面哪个数和其他三个不是一类？（奇偶 / 位数 / 是不是整十）"""
    groups = []
    for i, (same_desc, same_pred, diff_pred, diff_desc) in enumerate(CLASS_RULES):
        rng = seeded('class', i)
        same_pool = [n for n in range(1, 100) if same_pred(n)]
        diff_pool = [n for n in range(1, 100) if diff_pred(n)]
        qs = []
        for _ in range(600):
            if len(qs) >= 6:
                break
            same = pick(rng, same_pool, 3)
            if not same:
                break
            # 异类取比另外三个都大的数 —— 见 class_ok 的注释
            bigger = [n for n in diff_pool if n > max(same)]
            if not bigger:
                continue
            ans = bigger[rng.int(0, len(bigger) - 1)]
            texts = [str(x) for x in same] + [str(ans)]
            if not class_ok(texts, str(ans)):
                continue
            # 同 找规律：id 要带组号，否则五组共用一个种子，
            # 每道题的选项顺序一模一样，答案全落在同一个位置上。
            qs.append(make_choice(
                'math', 'ma-class-%d-%04d' % (i, len(qs) + 1), '分类', 1,
                '下面哪个数和其他三个不是一类？', str(ans),
                [t for t in texts if t != str(ans)],
                '其他三个%s，%d %s。' % (same_desc, ans, diff_desc)))
        groups.append(qs)

    return interleave(groups)


# ---------------------------------------------------------------- 主流程

# (标签, 构造函数, 上限)。上限之和**正好等于** LIMIT —— 这样每类的题量是
# 有意配的，而不是被切片随机截断的。改配比只动这里的数字。
#
# 数学占 90 道，是「语文:数学:英语 = 3:3:4」里的那份 3（见 build.py 的
# SUBJECT_MIX）。
BUILDERS = [
    ('直接计算', build_calc, 100),
    ('拆数凑十', build_chaishu, 28),
    ('应用题', build_word, 20),
    ('比大小', build_compare, 18),
    ('找规律', build_seq, 20),
    ('分类', build_classify, 14),
]

LIMIT = 200


# ---------------------------------------------------------------- 自检

# 题干形状。解析得**按生成时的模板逐字写死**，不图省事用宽松的正则：
# 宽松的正则会把「25 = 20 + ?」和「7 + 8 = 7 + 3 + ?」都吞下去，
# 复核出来的答案就成了另一道题的。
RE_CALC = re.compile(r'^(\d+) ([+-]) (\d+) = \?$')
RE_CHAI_ONES = re.compile(r'^(\d+) = (\d+) \+ \?$')          # 25 = 20 + ?
RE_CHAI_TENS = re.compile(r'^(\d+) = \? \+ (\d+)$')          # 25 = ? + 5
RE_CHAI_COUPLE = re.compile(r'^(\d+) \+ (\d+) = (\d+) \+ (\d+) \+ \?$')
RE_CHAI_DIGIT = re.compile(r'^(\d+) 里面有 (\d+) 个十和几个一？$')
RE_CMP_TWO = re.compile(r'^(\d+) 和 (\d+) 哪个大？$')


def option_texts(q):
    return [o['text'] for o in q['options']]


def answer_text(q):
    return [o['text'] for o in q['options'] if o['id'] == q['answer']][0]


def expected_answer(q):
    """照着题干重新算一遍答案。算不出来返回 None（自检会当成错误报出来）。

    这里刻意不复用生成时的任何中间量 —— 只读题干里的文字和四个选项。
    生成和复核走两条独立的路，才能抓到「生成时就算错了」这种错。
    """
    tag = q['tags'][0]
    t = q['stem']['text']
    texts = option_texts(q)

    if tag == '计算':
        m = RE_CALC.match(t)
        if not m:
            return None
        a, op, b = int(m.group(1)), m.group(2), int(m.group(3))
        return str(a + b if op == '+' else a - b)

    if tag == '拆数':
        m = RE_CHAI_ONES.match(t)
        if m:
            return str(int(m.group(1)) - int(m.group(2)))
        m = RE_CHAI_TENS.match(t)
        if m:
            return str(int(m.group(1)) - int(m.group(2)))
        m = RE_CHAI_COUPLE.match(t)
        if m:
            # 按题干字面算：a + b = c + d + ?  →  ? = a + b - c - d
            return str(int(m.group(1)) + int(m.group(2))
                       - int(m.group(3)) - int(m.group(4)))
        m = RE_CHAI_DIGIT.match(t)
        if m:
            n, tens = int(m.group(1)), int(m.group(2))
            if n // 10 != tens:
                return None                 # 题干自己就把十位写错了
            return str(n % 10)
        return None

    if tag == '应用题':
        for rx, op in WORD_RES:
            m = rx.match(t)
            if m:
                a, b = int(m.group(1)), int(m.group(2))
                return str(a + b if op == '+' else a - b)
        return None

    if tag == '比大小':
        if t == '下面哪个数最大？':
            return max(texts, key=int)
        if t == '下面哪个数最小？':
            return min(texts, key=int)
        m = RE_CMP_TWO.match(t)
        if m:
            return str(max(int(m.group(1)), int(m.group(2))))
        return None

    if tag == '找规律':
        nums = [int(x) for x in re.findall(r'\d+', t)]
        if len(nums) != 3:
            return None                     # 「（　）」里没有数字，正好三个
        t1, t2, t3 = nums
        if t2 - t1 != t3 - t2:
            return None
        return str(t3 + (t2 - t1))

    if tag == '分类':
        # 分类题的答案不在题干里，只能从四个选项反推 —— 反推出来的必须唯一
        kinds = odd_one_out(texts)
        vals = sorted(set(kinds.values()))
        return vals[0] if len(vals) == 1 else None

    return None


def selfcheck(questions):
    """数学题库自己的语义校验（结构通用校验在 qbank.selfcheck_common）。

    一条一条说清楚在防哪种错：

      1. 答案重算 —— 防「生成时就算错了」。每道题照着题干的字面重新算一遍，
         再断言四个选项里恰好一个等于它，而且它就是 answer 指的那个。
      2. 范围 —— 防超纲和负数：题干和选项里出现的每个数都在 0..100 之内，
         选项必须是纯数字（带负号的一眼就能看出来）。
      3. 进位 / 退位 —— 防「这道题其实不用进/退位」，也就是防生成器某天
         被人改了筛选条件，悄悄混进一堆数数就能做的题。
      4. 找规律 —— 防公差 1（和数数分不开）和第四项越界。
      5. 比大小 —— 防两个选项一样大（「哪个最大」就有两个答案）。
      6. 分类 —— 防「换一条判据答案就变了」。
      7. 全中文 —— 防题干 / 选项 / 解释里冒出拉丁字母。
    """
    errs = []

    for q in questions:
        qid = q['id']
        tag = q['tags'][0]
        t = q['stem']['text']
        texts = option_texts(q)
        ans = answer_text(q)

        # ---- 1. 答案重算：四个选项里恰好一个等于重算出来的答案 ----
        # 这里不 return，后面的范围 / 布局 / 分类检查照跑 —— 答案复核不出来
        # 的时候，正是最需要把剩下的断言全过一遍的时候。
        exp = expected_answer(q)
        if exp is None:
            errs.append('%s：题干「%s」解析不出来，答案无法复核' % (qid, t))
        else:
            hits = [x for x in texts if x == exp]
            if len(hits) != 1:
                errs.append('%s：重算出的答案 %s 在选项里出现了 %d 次'
                            % (qid, exp, len(hits)))
            if ans != exp:
                errs.append('%s：答案写的是 %s，重新算出来是 %s' % (qid, ans, exp))

        # ---- 2. 范围：没有超过 100 的数，选项里没有负数 ----
        for src in [t] + texts:
            for num in re.findall(r'\d+', src):
                if int(num) > MAX_NUM:
                    errs.append('%s：出现了超过 %d 的数 %s'
                                % (qid, MAX_NUM, num))
        for x in texts:
            # 选项必须是纯数字。负数会带 '-'，越界会大于 100，都在这一条上露头。
            if not re.match(r'^\d+$', x):
                errs.append('%s：选项「%s」不是非负整数' % (qid, x))

        # ---- 7. 全中文：题干 / 选项 / 解释里不许有拉丁字母 ----
        blob = ' '.join([t, q.get('explain') or ''] + texts)
        hit = LATIN_RE.search(blob)
        if hit:
            errs.append('%s：出现了拉丁字母「%s」' % (qid, hit.group(0)))

        # ---- layout：纯算式用大字号，文字情境用默认网格 ----
        want = 'big-number' if tag in ('计算', '拆数', '找规律') else 'grid'
        if q['stem'].get('layout') != want:
            errs.append('%s：layout 应为 %s，实际 %s'
                        % (qid, want, q['stem'].get('layout')))

        # ---- 3. 直接计算：必须进/退位，减法不出负数 ----
        if tag == '计算':
            m = RE_CALC.match(t)
            if m:
                a, op, b = int(m.group(1)), m.group(2), int(m.group(3))
                if op == '+':
                    if a % 10 + b >= 10:
                        pass
                    else:
                        errs.append('%s：%d + %d 不进位，数数就能做' % (qid, a, b))
                else:
                    if a % 10 >= b:
                        errs.append('%s：%d - %d 不退位' % (qid, a, b))
                    if a - b < 0:
                        errs.append('%s：%d - %d 结果是负数' % (qid, a, b))
                    if b > 9 or a > MAX_NUM:
                        errs.append('%s：%d - %d 的数超出了 100 以内' % (qid, a, b))

        # ---- 拆数：题干自己得是个成立的等式 ----
        if tag == '拆数':
            m = RE_CHAI_ONES.match(t)
            if m:
                n, tens_val = int(m.group(1)), int(m.group(2))
                if n % 10 != n - tens_val or not 0 < n - tens_val < 10:
                    errs.append('%s：%d = %d + ? 拆出来的不是它的个位' % (qid, n, tens_val))
            m = RE_CHAI_TENS.match(t)
            if m:
                n, ones_val = int(m.group(1)), int(m.group(2))
                if n % 10 != ones_val:
                    errs.append('%s：%d = ? + %d 里的 %d 不是它的个位'
                                % (qid, n, ones_val, ones_val))
            m = RE_CHAI_COUPLE.match(t)
            if m:
                a, b, c, d = (int(m.group(i)) for i in range(1, 5))
                if a != c:
                    errs.append('%s：凑十的等号两边第一个加数不一样（%d / %d）'
                                % (qid, a, c))
                if a + d != 10:
                    errs.append('%s：%d + %d 没有凑成 10，这道题不是凑十法'
                                % (qid, a, d))
                if b - d <= 0:
                    errs.append('%s：凑十之后剩下的部分不是正数' % qid)
                if a + b > 18:
                    errs.append('%s：凑十法的两个加数超出了十以内的范围' % qid)
            m = RE_CHAI_DIGIT.match(t)
            if m:
                n, tens = int(m.group(1)), int(m.group(2))
                if n // 10 != tens or n % 10 == 0:
                    errs.append('%s：%d 里面的十位写成了 %d' % (qid, n, tens))

        # ---- 应用题：模板必须在表里，结果不为负、不越界 ----
        if tag == '应用题':
            if not any(rx.match(t) for rx, _op in WORD_RES):
                errs.append('%s：题干「%s」不在应用题模板表里' % (qid, t))
            if exp is not None and int(exp) < 0:
                errs.append('%s：应用题算出了负数 %s' % (qid, exp))
            if exp is not None and int(exp) > MAX_NUM:
                errs.append('%s：应用题的结果 %s 超过了 %d' % (qid, exp, MAX_NUM))

        # ---- 5. 比大小：答案必须是唯一的那个最大（或最小）数 ----
        if tag == '比大小':
            if len(set(texts)) != 4:
                errs.append('%s：四个选项里有一样大的数，答案不唯一' % qid)
            if t == '下面哪个数最大？' and ans != max(texts, key=int):
                errs.append('%s：问的是最大的数，答案却是 %s' % (qid, ans))
            if t == '下面哪个数最小？' and ans != min(texts, key=int):
                errs.append('%s：问的是最小的数，答案却是 %s' % (qid, ans))
            m = RE_CMP_TWO.match(t)
            if m:
                # 两个干扰项里只要有一个比 A、B 都大，孩子不看题干、
                # 直接挑最大的数也能选对 —— 那道题就不是「比大小」了
                big = max(int(m.group(1)), int(m.group(2)))
                if ans != str(big):
                    errs.append('%s：%s 和 %s 里大的那个是 %d，答案却是 %s'
                                % (qid, m.group(1), m.group(2), big, ans))
                for x in texts:
                    if int(x) > big:
                        errs.append('%s：选项里的 %s 比 %d 和 %d 都大，会误导'
                                    % (qid, x, int(m.group(1)), int(m.group(2))))

        # ---- 4. 找规律：公差 ≥ 2、第四项不越界 ----
        if tag == '找规律':
            nums = [int(x) for x in re.findall(r'\d+', t)]
            if len(nums) != 3 or nums[1] - nums[0] != nums[2] - nums[1]:
                errs.append('%s：「%s」不是等差数列' % (qid, t))
            else:
                d = nums[1] - nums[0]
                if d < 2:
                    # 公差 1 的「3、4、5、（）」和「接着数数」分不开
                    errs.append('%s：公差是 %d，太小了' % (qid, d))
                if nums[2] + d > MAX_NUM:
                    errs.append('%s：下一个数 %d 超过了 %d'
                                % (qid, nums[2] + d, MAX_NUM))
                if ans != str(nums[2] + d):
                    errs.append('%s：答案是 %s，按等差算应该是 %d'
                                % (qid, ans, nums[2] + d))

        # ---- 6. 分类：换一条判据不能换出另一个答案 ----
        if tag == '分类':
            kinds = odd_one_out(texts)
            if not kinds:
                errs.append('%s：四个数在奇偶 / 位数 / 整十哪条判据下都切不出异类'
                            % qid)
            for rule, one in sorted(kinds.items()):
                if one != ans:
                    errs.append('%s：按「%s」看异类是 %s，答案却是 %s'
                                % (qid, rule, one, ans))
            # 异类必须同时是最大的数，理由见 class_ok
            if ans != max(texts, key=int):
                errs.append('%s：异类 %s 不是四个数里最大的，'
                            '孩子按「哪个最大」能选出别的数' % (qid, ans))

    return errs


# ---------------------------------------------------------------- 主流程


def generate():
    all_q, report = [], []
    for label, fn, cap in BUILDERS:
        qs = fn()[:cap]
        report.append((label, len(qs)))
        all_q += qs

    all_q = all_q[:LIMIT]
    # 全局重新编号，id 连续无洞
    for i, q in enumerate(all_q):
        q['id'] = 'ma-%04d' % (i + 1)
    return all_q, report


def main():
    return run('数学', 'math', os.path.join(DATA, 'math.json'),
               generate, LIMIT, extra_checks=selfcheck)


if __name__ == '__main__':
    sys.exit(main())
