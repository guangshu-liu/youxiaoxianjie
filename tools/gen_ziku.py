#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_ziku.py — 语文（识字）题库生成器

产出两个文件：
    src/data/zi_grade1.json     字表（字 / 拼音 / 笔画 / 部首 / 词语）
    src/data/chinese.json       识字题库（90 道，全部 choice 题型）

两条硬约束，都由机器保证，不靠眼睛：

  1. **只用一年级字。** GRADE_MAX = 1。字表里没有的字，根本进不了选项。
  2. **全库不出现拼音。** 出题一律绕开读音：考字形（笔画 / 部首 / 偏旁 /
     加一笔减一笔）和字义（反义词 / 归类）。selfcheck 里有一条断言直接
     扫题干、选项、解释里有没有拉丁字母和声调符号，出现就构建失败。

     「不以拼音的形式出现」不等于「生成器不能用拼音」—— split_tone 仍在
     用来判断两个字的声旁关系（形声字的声旁和整字同音，拿它当干扰项会让
     题目变成猜出题人想考哪个）。拼音只是内部判据，从不落到产物里。

产物必须可复现：同一个字表跑两次，得到逐字节相同的 JSON，`--check`
才有意义。公共的确定性随机和校验在 tools/qbank.py，三个科目共用。

数据从哪来：
    字表是**为幼小衔接阶段手工筛选的常用字**，取自统编版语文一年级
    识字表的高频部分，不是任何一个出版社识字表的逐字复制。

用法：
    python3 tools/gen_ziku.py            # 生成
    python3 tools/gen_ziku.py --check    # 只校验产物是否与生成结果一致
"""

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from qbank import (
    DATA, ROOT, Rng, dhash, interleave, make_choice, run, seeded, write_json,
)

# 出题只用一年级字。二年级的字留在 CHARS 里（家长面板的字表要看全貌），
# 但进不了任何一道题的题干或选项。
GRADE_MAX = 1

# 拼音检测：任何拉丁字母，以及带声调的元音（ā á ǎ à / ǖ ǘ ǚ ǜ / ü）。
# U+00C0–U+024F 覆盖拉丁字母补充区和扩展 A/B —— 声调符号全在里面。
LATIN_RE = re.compile(r'[A-Za-zÀ-ɏɐ-ʯ]')

# ---------------------------------------------------------------- 拼音工具

MARKED = {
    'a': ['ā', 'á', 'ǎ', 'à'],
    'e': ['ē', 'é', 'ě', 'è'],
    'i': ['ī', 'í', 'ǐ', 'ì'],
    'o': ['ō', 'ó', 'ǒ', 'ò'],
    'u': ['ū', 'ú', 'ǔ', 'ù'],
    'ü': ['ǖ', 'ǘ', 'ǚ', 'ǜ'],
}
ACCENTS = {}
for _b, _ms in MARKED.items():
    for _i, _m in enumerate(_ms):
        ACCENTS[_m] = (_b, _i + 1)

# 声母表，长的排前面 —— zh/ch/sh 要先于 z/c/s 匹配
INITIALS = ['zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l',
            'g', 'k', 'h', 'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w']


def split_tone(py):
    """'mā' → ('ma', 1)。轻声（无声调标记）返回 tone=0。"""
    base = []
    tone = 0
    for ch in py:
        if ch in ACCENTS:
            base.append(ACCENTS[ch][0])
            tone = ACCENTS[ch][1]
        else:
            base.append(ch)
    return ''.join(base), tone


def with_tone(base, tone):
    """('ma', 3) → 'mǎ'。声调标在 a > o > e > iu/ui 最后元音上，与汉语拼音方案一致。"""
    if tone <= 0:
        return base
    if 'a' in base:
        idx = base.index('a')
    elif 'o' in base:
        idx = base.index('o')
    elif 'e' in base:
        idx = base.index('e')
    elif 'iu' in base:
        idx = base.index('iu') + 1
    elif 'ui' in base:
        idx = base.index('ui') + 1
    else:
        idx = max((i for i, c in enumerate(base) if c in 'iuü'), default=-1)
    if idx < 0:
        return base
    c = base[idx]
    if c not in MARKED:
        return base
    return base[:idx] + MARKED[c][tone - 1] + base[idx + 1:]


def split_syllable(py):
    """'mā' → ('m', 'a')。用于判断两个读音像不像。"""
    base, _ = split_tone(py)
    for ini in INITIALS:
        if base.startswith(ini):
            return ini, base[len(ini):]
    return '', base


def dhash(text):
    """确定性字符串哈希。内置 hash() 每个进程换种子，会让产物不可复现。"""
    h = 2166136261
    for ch in text:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return h


# ---------------------------------------------------------------- 字表
# 字 -> (拼音, 笔画, 部首, 年级, [词语])
#   拼音 —— 常用读音。多音字会被 POLYPHONIC 挡在读音题之外。
#   笔画 —— 总笔画数（简体）
#   部首 —— 常用部首
#   年级 —— 1 / 2，表示「通常什么时候学」，用来给难度分级
#   词语 —— 常用词，用来出组词题

CHARS = {
    # ---- 数字 ----
    '一': ('yī',    1, '一', 1, ['一个', '一起']),
    '二': ('èr',    2, '二', 1, ['二月', '十二']),
    '三': ('sān',   3, '一', 1, ['三个', '三天']),
    '四': ('sì',    5, '囗', 1, ['四月', '四方']),
    '五': ('wǔ',    4, '二', 1, ['五个', '五月']),
    '六': ('liù',   4, '八', 1, ['六月', '六个']),
    '七': ('qī',    2, '一', 1, ['七月', '七天']),
    '八': ('bā',    2, '八', 1, ['八月', '八个']),
    '九': ('jiǔ',   2, '丿', 1, ['九月', '九个']),
    '十': ('shí',   2, '十', 1, ['十个', '十天']),
    '百': ('bǎi',   6, '白', 2, ['一百', '百年']),
    '千': ('qiān',  3, '十', 2, ['一千', '千万']),
    '万': ('wàn',   3, '一', 1, ['万一', '千万']),

    # ---- 天地自然 ----
    '日': ('rì',    4, '日', 1, ['日出', '生日']),
    '月': ('yuè',   4, '月', 1, ['月亮', '月光']),
    '水': ('shuǐ',  4, '水', 1, ['水果', '喝水']),
    '火': ('huǒ',   4, '火', 1, ['火车', '大火']),
    '山': ('shān',  3, '山', 1, ['大山', '上山']),
    '石': ('shí',   5, '石', 1, ['石头', '石子']),
    '田': ('tián',  5, '田', 1, ['田地', '水田']),
    '土': ('tǔ',    3, '土', 1, ['土地', '水土']),
    '木': ('mù',    4, '木', 1, ['木头', '树木']),
    '禾': ('hé',    5, '禾', 1, ['禾苗', '禾田']),
    '米': ('mǐ',    6, '米', 1, ['大米', '小米']),
    '竹': ('zhú',   6, '竹', 1, ['竹子', '竹叶']),
    '花': ('huā',   7, '艹', 1, ['花朵', '开花']),
    '草': ('cǎo',   9, '艹', 1, ['小草', '草地']),
    '云': ('yún',   4, '二', 1, ['白云', '云朵']),
    '雨': ('yǔ',    8, '雨', 1, ['下雨', '雨衣']),
    '风': ('fēng',  4, '风', 1, ['大风', '风筝']),
    '天': ('tiān',  4, '大', 1, ['天空', '白天']),
    '地': ('dì',    6, '土', 1, ['大地', '土地']),
    '星': ('xīng',  9, '日', 1, ['星星', '星光']),
    '河': ('hé',    8, '氵', 2, ['小河', '河水']),
    '海': ('hǎi',  10, '氵', 2, ['大海', '海边']),
    '江': ('jiāng', 6, '氵', 2, ['江水', '长江']),
    '清': ('qīng', 11, '氵', 1, ['清水', '清白']),
    '青': ('qīng',  8, '青', 1, ['青草', '青山']),

    # ---- 身体 ----
    '人': ('rén',   2, '人', 1, ['大人', '人口']),
    '入': ('rù',    2, '入', 1, ['入口', '出入']),
    '口': ('kǒu',   3, '口', 1, ['开口', '口水']),
    '手': ('shǒu',  4, '手', 1, ['手心', '小手']),
    '毛': ('máo',   4, '毛', 1, ['毛巾', '毛笔']),
    '足': ('zú',    7, '足', 2, ['足球', '手足']),
    '目': ('mù',    5, '目', 1, ['目光', '耳目']),
    '耳': ('ěr',    6, '耳', 1, ['耳朵', '木耳']),
    '头': ('tóu',   5, '大', 1, ['头发', '石头']),
    '心': ('xīn',   4, '心', 1, ['开心', '小心']),
    '牙': ('yá',    4, '牙', 1, ['牙齿', '刷牙']),

    # ---- 动物 ----
    '鸟': ('niǎo',  5, '鸟', 1, ['小鸟', '鸟叫']),
    '马': ('mǎ',    3, '马', 1, ['小马', '木马']),
    '牛': ('niú',   4, '牛', 1, ['小牛', '牛奶']),
    '午': ('wǔ',    4, '十', 1, ['中午', '午睡']),
    '羊': ('yáng',  6, '羊', 1, ['小羊', '山羊']),
    '虫': ('chóng', 6, '虫', 1, ['虫子', '小虫']),
    '鱼': ('yú',    8, '鱼', 1, ['小鱼', '金鱼']),
    '狗': ('gǒu',   8, '犭', 2, ['小狗', '狗叫']),
    '猫': ('māo',  11, '犭', 2, ['小猫', '花猫']),

    # ---- 人称与家庭 ----
    '爸': ('bà',    8, '父', 1, ['爸爸', '爸妈']),
    '妈': ('mā',    6, '女', 1, ['妈妈', '大妈']),
    '我': ('wǒ',    7, '戈', 1, ['我们']),
    '你': ('nǐ',    7, '亻', 1, ['你好', '你们']),
    '他': ('tā',    5, '亻', 1, ['他们']),
    '哥': ('gē',   10, '口', 2, ['哥哥', '大哥']),
    '姐': ('jiě',   8, '女', 2, ['姐姐', '大姐']),
    '弟': ('dì',    7, '弓', 2, ['弟弟', '小弟']),
    '妹': ('mèi',   8, '女', 1, ['妹妹', '小妹']),
    '男': ('nán',   7, '田', 1, ['男人', '男女']),
    '女': ('nǚ',    3, '女', 1, ['女人', '男女']),

    # ---- 大小方位 ----
    '大': ('dà',    3, '大', 1, ['大人', '大山']),
    '太': ('tài',   4, '大', 1, ['太阳', '太大']),
    '小': ('xiǎo',  3, '小', 1, ['小鸟', '小马']),
    '多': ('duō',   6, '夕', 1, ['多少', '很多']),
    '少': ('shǎo',  4, '小', 1, ['多少', '少数']),
    '上': ('shàng', 3, '一', 1, ['上山', '上下']),
    '下': ('xià',   3, '一', 1, ['下雨', '上下']),
    '左': ('zuǒ',   5, '工', 1, ['左右', '左手']),
    '右': ('yòu',   5, '口', 1, ['左右', '右手']),
    '中': ('zhōng', 4, '丨', 1, ['中间', '中国']),
    '里': ('lǐ',    7, '里', 1, ['里面', '家里']),
    '外': ('wài',   5, '夕', 2, ['外面', '校外']),
    '前': ('qián',  9, '丷', 2, ['前面', '前后']),
    '后': ('hòu',   6, '口', 2, ['后面', '前后']),
    '高': ('gāo',  10, '高', 2, ['高山', '高兴']),
    '矮': ('ǎi',   13, '矢', 2, ['矮小']),
    '长': ('cháng', 4, '长', 1, ['长江', '长短']),
    '短': ('duǎn', 12, '矢', 2, ['长短', '短小']),

    # ---- 颜色 ----
    '白': ('bái',   5, '白', 1, ['白云', '白天']),
    '黑': ('hēi',  12, '黑', 2, ['黑色', '黑夜']),
    '红': ('hóng',  6, '纟', 1, ['红花', '火红']),
    '黄': ('huáng', 11, '黄', 1, ['黄色', '黄牛']),
    '绿': ('lǜ',   11, '纟', 2, ['绿色', '绿叶']),

    # ---- 动作 ----
    '看': ('kàn',   9, '目', 1, ['看见', '看书']),
    '听': ('tīng',  7, '口', 1, ['听见', '听话']),
    '说': ('shuō',  9, '讠', 1, ['说话', '说明']),
    '请': ('qǐng', 10, '讠', 1, ['请坐', '请问']),
    '走': ('zǒu',   7, '走', 1, ['走路', '快走']),
    '跑': ('pǎo',  12, '足', 2, ['跑步', '快跑']),
    '跳': ('tiào', 13, '足', 2, ['跳高', '跳水']),
    '飞': ('fēi',   3, '飞', 1, ['飞机', '飞鸟']),
    '吃': ('chī',   6, '口', 1, ['吃饭', '好吃']),
    '喝': ('hē',   12, '口', 1, ['喝水', '喝茶']),
    '睡': ('shuì', 13, '目', 1, ['睡觉', '午睡']),
    '起': ('qǐ',   10, '走', 1, ['起来', '早起']),
    '来': ('lái',   7, '木', 1, ['回来', '出来']),
    '去': ('qù',    5, '厶', 1, ['回去', '出去']),
    '回': ('huí',   6, '囗', 1, ['回来', '回家']),
    '开': ('kāi',   4, '廾', 1, ['开心', '开门']),
    '关': ('guān',  6, '丷', 1, ['关门', '开关']),
    '写': ('xiě',   5, '冖', 2, ['写字', '书写']),
    '读': ('dú',   10, '讠', 2, ['读书', '朗读']),
    '画': ('huà',   8, '田', 1, ['画画', '图画']),
    '唱': ('chàng', 11, '口', 2, ['唱歌', '合唱']),
    '打': ('dǎ',    5, '扌', 1, ['打球', '打鼓']),
    '笑': ('xiào', 10, '竹', 1, ['笑话', '大笑']),
    '想': ('xiǎng', 13, '心', 1, ['想念', '思想']),
    '拿': ('ná',   10, '手', 1, ['拿来', '拿走']),

    # ---- 学习与生活 ----
    '书': ('shū',   4, '乙', 1, ['看书', '书本']),
    '本': ('běn',   5, '木', 1, ['书本', '本子']),
    '笔': ('bǐ',   10, '竹', 1, ['铅笔', '毛笔']),
    '纸': ('zhǐ',   7, '纟', 1, ['白纸', '纸片']),
    '字': ('zì',    6, '子', 1, ['写字', '生字']),
    '自': ('zì',    6, '自', 1, ['自己', '自大']),
    '文': ('wén',   4, '文', 1, ['语文', '文字']),
    '学': ('xué',   8, '子', 1, ['学习', '上学']),
    '校': ('xiào', 10, '木', 1, ['学校', '校门']),
    '门': ('mén',   3, '门', 1, ['开门', '大门']),
    '窗': ('chuāng', 12, '穴', 2, ['窗户', '窗外']),
    '桌': ('zhuō', 10, '木', 1, ['桌子', '书桌']),
    '车': ('chē',   4, '车', 1, ['火车', '汽车']),
    '刀': ('dāo',   2, '刀', 1, ['小刀', '刀子']),
    '尺': ('chǐ',   4, '尸', 1, ['尺子']),
    '巾': ('jīn',   3, '巾', 1, ['毛巾', '手巾']),
    '衣': ('yī',    6, '衣', 1, ['衣服', '雨衣']),
    '服': ('fú',    8, '月', 1, ['衣服', '服气']),
    '家': ('jiā',  10, '宀', 1, ['回家', '家里']),
    '国': ('guó',   8, '囗', 1, ['中国', '国王']),
    '生': ('shēng', 5, '生', 1, ['生日', '生字']),
    '声': ('shēng', 7, '士', 1, ['大声', '声音']),
    '工': ('gōng',  3, '工', 1, ['工人', '工作']),
    '力': ('lì',    2, '力', 1, ['力气', '用力']),
    '友': ('yǒu',   4, '又', 1, ['朋友', '友好']),
    '有': ('yǒu',   6, '月', 1, ['有人', '没有']),
    '朋': ('péng',  8, '月', 2, ['朋友']),
    '名': ('míng',  6, '口', 2, ['名字', '有名']),
    '树': ('shù',   9, '木', 1, ['大树', '树叶']),

    # ---- 时间与季节 ----
    '早': ('zǎo',   6, '日', 1, ['早上', '早起']),
    '晚': ('wǎn',  11, '日', 1, ['晚上', '晚安']),
    '春': ('chūn',  9, '日', 1, ['春天', '春风']),
    '夏': ('xià',  10, '夂', 1, ['夏天', '夏日']),
    '秋': ('qiū',   9, '禾', 1, ['秋天', '秋风']),
    '冬': ('dōng',  5, '夂', 1, ['冬天', '冬日']),
    '东': ('dōng',  5, '一', 1, ['东西', '东方']),
    '年': ('nián',  6, '干', 1, ['今年', '年月']),
    '时': ('shí',   7, '日', 1, ['时间', '小时']),
    '分': ('fēn',   4, '八', 1, ['分开', '十分']),
    '今': ('jīn',   4, '人', 1, ['今天', '今年']),
    '明': ('míng',  8, '日', 1, ['明天', '明白']),
    '冷': ('lěng',  7, '冫', 1, ['冷水', '寒冷']),
    '热': ('rè',   10, '灬', 1, ['热水', '热天']),
    '新': ('xīn',  13, '斤', 2, ['新年', '新书']),
    '旧': ('jiù',   5, '日', 2, ['旧书', '新旧']),
    '快': ('kuài',  7, '忄', 1, ['快走', '快乐']),
    '慢': ('màn',  14, '忄', 2, ['慢走', '快慢']),
    '好': ('hǎo',   6, '女', 1, ['好吃', '好看']),
    '晴': ('qíng', 12, '日', 1, ['晴天', '晴朗']),
}

# 多音字：读音不唯一。既不进答案位、也不进干扰项 ——
# 否则「长」出现在 cháng 的选项里，一道题会有两个正确答案。
POLYPHONIC = {
    '长', '少', '好', '中', '分', '大', '看', '地', '数', '乐',
    '觉', '得', '空', '发', '还', '种', '着', '只', '行', '为',
}

# 「加一笔 / 减一笔」的完整合法答案表。
#
# **必须穷举，一条都不能漏。** 这是全部题型里最容易出「两个正确答案」的
# 一类：「日」加一笔既是「目」也是「白」，还可能是「田」。如果只把「目」
# 记在这儿、拿「白」去当干扰项，那道题就有两个正确选项，而字面上看不出
# 任何异常。selfcheck 会拿这张表反过来验 —— 选项里有且只有一个在表内。
#
# 有歧义到无法穷举的字（「一」加一笔可以是二/十/七/丁…）直接不收，
# 收的都是答案集封闭在字表内的。
PLUS_ONE = {
    '人': ['大'],
    '大': ['天', '太'],
    '小': ['少'],
    '十': ['土'],
    '口': ['中', '日'],
    '木': ['本', '禾'],
    '日': ['目', '白', '田'],
    '目': ['自'],
    '米': ['来'],
}

# 减一笔 = 加一笔反过来。由 PLUS_ONE 推出，不手写第二张表 ——
# 两张表对不上，是最难查的一类不一致。
MINUS_ONE = {}
for _base, _outs in PLUS_ONE.items():
    for _o in _outs:
        MINUS_ONE.setdefault(_o, []).append(_base)

# 归类题用的类别。每个字只归一类，选项跨类别取 —— 答案唯一。
# (类别名, 题干, [字])
CATEGORY = [
    ('动物', '下面哪个字说的是动物？', ['鸟', '马', '牛', '羊', '虫', '鱼', '狗', '猫']),
    ('颜色', '下面哪个字说的是颜色？', ['白', '黑', '红', '黄', '绿']),
    ('数字', '下面哪个字说的是数字？',
     ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '百', '千', '万']),
    ('身体', '下面哪个字说的是身体的一部分？', ['口', '手', '毛', '足', '目', '耳', '头', '心', '牙']),
    ('家人', '下面哪个字说的是家里人？', ['爸', '妈', '哥', '姐', '弟', '妹', '男', '女']),
]

# 反义词对。两边都必须在字表里。
ANTONYMS = [
    ('大', '小'), ('多', '少'), ('上', '下'), ('左', '右'),
    ('长', '短'), ('早', '晚'), ('白', '黑'), ('来', '去'),
    ('开', '关'), ('天', '地'), ('冷', '热'), ('男', '女'),
    ('新', '旧'), ('高', '矮'), ('里', '外'), ('前', '后'),
    ('快', '慢'),
]

# 笔画题只用这些字：总笔画数是最容易记错的一类事实，候选范围收窄到
# 「闭着眼也不会错」的一批。顺序是刻意交错的 —— 按笔画排序会把 1-2 笔的
# 字全排在前面，出出来 20 道「一有几笔」。
STROKE_SAFE = [
    '一', '日', '七', '月', '十', '口', '人', '水', '八', '山', '三',
    '大', '九', '木', '土', '天', '五', '手', '六', '心', '门', '牙',
]

# 部首题只用这些字：部首无争议，且顺序交错开 ——
# 妈/姐/妹/好 挨在一起会连出四道「女字旁」。
RADICAL_SAFE = [
    '妈', '花', '河', '说', '跑', '吃', '明', '爸', '打', '读',
    '跳', '喝', '唱', '时', '晚', '猫', '狗', '笔', '笑', '想',
    '拿', '晴', '树', '桌', '草', '海', '姐', '妹', '好',
]

# 部首题的干扰项从这个池子里取。都是孩子看得见、认得出的常用偏旁；
# 不加限制的话会抽出「冖」「忄」这类孩子根本没概念的部件。
RADICAL_POOL = [
    '女', '木', '氵', '艹', '口', '日', '月', '目', '手', '足',
    '心', '亻', '讠', '扌', '犭', '竹', '土', '火', '水', '山',
    '石', '田', '人', '力', '刀', '门', '虫', '鸟', '马', '鱼',
    '宀', '纟', '父', '禾', '雨', '大', '小', '工', '车', '巾',
]

# 「同偏旁归类」问的偏旁。都是字形上一眼可辨的。
# 犭（猫/狗）和 足（跑/跳）去掉了 —— 那四个字全是一年级以外的，
# 而且这一档问不了「哪个字是犭旁」却用二年级字当答案。
RADICAL_ASK = ['木', '氵', '艹', '女', '口', '日', '扌', '讠']

# 「下面哪个字是 X 字旁？」的答案。**不能自动取**：按字表顺序取会给「木」
# 选中「本」——「本」的部首确实是木，但木在里面占的是整个字，孩子看到的
# 不是一个「字旁」。这里逐个挑的都是偏旁在左边、一眼可辨的字。
RADICAL_CLASS_ANSWER = {
    '木': '树', '氵': '清', '艹': '花', '女': '妈',
    '口': '吃', '日': '明', '扌': '打', '讠': '说',
}


# ---------------------------------------------------------------- 抽题工具

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


def in_scope(ch):
    """这个字能不能进题干或选项。

    只有一条：在字表里，且年级不超过 GRADE_MAX。二年级的字留在 CHARS 里
    供家长面板看全貌，但一道题都不出。
    """
    return ch in CHARS and CHARS[ch][3] <= GRADE_MAX


def scoped(chars):
    """把一串字过滤到出题范围内，保持原顺序。"""
    return [c for c in chars if in_scope(c)]


def sound_alike_initial(ch):
    """这个字的声母+韵母（不带声调），用来判断它是不是另一个字的声旁。

    只用在部首题里做干扰项过滤，拼音本身从不出现在产物里。
    """
    return split_syllable(CHARS[ch][0])


# ---------------------------------------------------------------- 各题型

def build_stroke_change():
    """加一笔 / 减一笔：考字形本身，是这一档最「认字」的一道题。"""
    # 加一笔和减一笔轮流出，切片的时候不会只剩一种
    plus, minus = [], []

    for base in sorted(PLUS_ONE):
        if not in_scope(base):
            continue
        valid = scoped(PLUS_ONE[base])
        if not valid:
            continue
        answer = valid[0]                       # 有多个合法答案时取第一个
        # **干扰项必须避开其余合法答案。** 这是这道题唯一会坏的地方：
        # 「日」加一笔既是目也是白，把白放进选项就有两个正确答案。
        pool = [c for c in scoped(''.join(sorted(CHARS)))
                if c not in valid and c != base
                and CHARS[c][1] == CHARS[base][1] + 1]
        ds = seeded('plus' + base).shuffle(pool)[:3]
        if len(ds) < 3:
            continue
        plus.append(make_choice(
            'chinese', 'zi-jia-%04d' % (len(plus) + 1), '加一笔', 2,
            '「%s」加一笔，变成下面哪个字？' % base, answer, ds,
            '「%s」加一笔是「%s」。' % (base, answer),
        ))

    for base in sorted(MINUS_ONE):
        if not in_scope(base):
            continue
        valid = scoped(MINUS_ONE[base])
        if not valid:
            continue
        answer = valid[0]
        pool = [c for c in scoped(''.join(sorted(CHARS)))
                if c not in valid and c != base
                and CHARS[c][1] == CHARS[base][1] - 1]
        ds = seeded('minus' + base).shuffle(pool)[:3]
        if len(ds) < 3:
            continue
        minus.append(make_choice(
            'chinese', 'zi-jian-%04d' % (len(minus) + 1), '减一笔', 2,
            '「%s」减一笔，变成下面哪个字？' % base, answer, ds,
            '「%s」减一笔是「%s」。' % (base, answer),
        ))

    return interleave([plus, minus])


def build_category():
    """归类：下面哪个字是动物？选项跨类别取，答案唯一。"""
    groups = [(name, stem, scoped(cs)) for name, stem, cs in CATEGORY]
    groups = [(n, st, cs) for n, st, cs in groups if len(cs) >= 4]

    # 每个类别内部打散，再按类别轮着抽。不打散的话切片 `[:cap]` 会
    # 把位置全留给排在前面的类别（数字 11 个字永远排在最前）。
    by_group = []
    for name, stem, members in groups:
        others = [c for _n, _s, cs in groups if _n != name for c in cs]
        qs = []
        for ch in seeded('cat' + name).shuffle(members):
            ds = seeded('cat' + ch).shuffle(others)[:3]
            if len(ds) < 3:
                continue
            qs.append(make_choice(
                'chinese', 'zi-guilei-%04d' % (len(qs) + 1), '归类', 1,
                stem, ch, ds,
                '「%s」是%s。' % (ch, name),
            ))
        by_group.append(qs)

    out = interleave(by_group)
    for i, q in enumerate(out):
        q['id'] = 'zi-guilei-%04d' % (i + 1)
    return out


def build_antonym():
    """反义词。干扰项从其他反义词字里取，比随机字更像回事。

    每对出两道（正着问一遍、反着问一遍）。10 对一年级反义词只够 10 道题，
    而这一档要出 18 道 —— 反着问不是凑数：「小」的反义词是哪个字，
    和「大」的反义词是哪个字，对孩子是两次独立的检索。
    """
    pairs = [(a, b) for a, b in ANTONYMS if in_scope(a) and in_scope(b)]
    pool = sorted({c for pair in pairs for c in pair})
    if len(pool) < 4:
        return []

    def one(a, b, n):
        ds = [x for x in seeded('ant' + a).shuffle(pool) if x != a and x != b][:3]
        if len(ds) < 3:
            return None
        return make_choice(
            'chinese', 'zi-fanyi-%04d' % n, '反义词', 1,
            '「%s」的反义词是哪个字？' % a, b, ds,
            '「%s」和「%s」意思相反。' % (a, b),
        )

    forward, backward = [], []
    for i, (a, b) in enumerate(pairs):
        q = one(a, b, i + 1)
        if q:
            forward.append(q)
        q = one(b, a, i + 1)
        if q:
            backward.append(q)
    return interleave([forward, backward])


def build_strokes():
    """数笔画。干扰项取答案 ±1 / ±2 —— 都是「数错会得到」的数。"""
    out = []
    for ch in STROKE_SAFE:
        if not in_scope(ch):
            continue
        _py, strokes, radical, _g, _w = CHARS[ch]
        ds = []
        for c in (strokes + 1, strokes - 1, strokes + 2, strokes - 2, strokes + 3):
            if c > 0 and c != strokes:
                t = '%d 笔' % c
                if t not in ds:
                    ds.append(t)
            if len(ds) >= 3:
                break
        if len(ds) < 3:
            continue
        out.append(make_choice(
            'chinese', 'zi-bihua-%04d' % (len(out) + 1), '笔画', 2,
            '「%s」一共有几笔？' % ch, '%d 笔' % strokes, ds,
            '「%s」是 %d 笔，部首是「%s」。' % (ch, strokes, radical),
        ))
    return out


def build_radical():
    """部首：「妈」的部首是什么？"""
    out = []
    for ch in RADICAL_SAFE:
        if not in_scope(ch):
            continue
        py, _s, radical, _g, words = CHARS[ch]
        base = split_tone(py)[0]

        # 干扰项不能和题干字同音节。
        # 「妈」的部首是「女」，但「马」是它的声旁 —— 选项里同时出现女和马，
        # 这道题就变成了猜出题人想考哪个，而不是考部首。形声字的声旁通常
        # 和整字同音节，这条规则正好把它们滤掉。
        # 池子里的「纟」「宀」这类不单独成字，字表里查不到读音 —— 它们不可能
        # 是哪个字的声旁，留着当干扰项没问题。
        ds = [r for r in seeded('rad' + ch).shuffle(RADICAL_POOL)
              if r != radical
              and not (r in CHARS and split_tone(CHARS[r][0])[0] == base)][:3]
        if len(ds) < 3:
            continue
        out.append(make_choice(
            'chinese', 'zi-bushou-%04d' % (len(out) + 1), '部首', 2,
            '「%s」的部首是什么？' % ch, radical, ds,
            '「%s」的部首是「%s」，可以组词「%s」。' % (ch, radical, words[0]),
        ))
    return out


def build_radical_class():
    """同偏旁归类：下面哪个字是木字旁？"""
    by_radical = {}
    for ch in sorted(CHARS):
        if in_scope(ch):
            by_radical.setdefault(CHARS[ch][2], []).append(ch)

    out = []
    for radical in RADICAL_ASK:
        # 答案不能是偏旁本身 —— 「哪个字是「女」字旁？」答案是「女」就没意思了
        members = [c for c in by_radical.get(radical, []) if c != radical]
        if not members:
            continue
        answer = RADICAL_CLASS_ANSWER.get(radical)
        if answer not in members:
            answer = members[0]

        # 干扰字：每个来自**不同**的偏旁，且字形里不含这个偏旁。
        # 全取排序最靠前的几个会得到 七/万/一 —— 三个都长得一样，
        # 孩子不用认偏旁也能靠排除法做对。
        ds = []
        used = {radical}
        for other_ch in sorted(CHARS, key=lambda c: dhash(answer + c)):
            if not in_scope(other_ch):
                continue
            r = CHARS[other_ch][2]
            if r in used or radical in other_ch:
                continue
            used.add(r)
            ds.append(other_ch)
            if len(ds) >= 3:
                break
        if len(ds) < 3:
            continue
        out.append(make_choice(
            'chinese', 'zi-pianpang-%04d' % (len(out) + 1), '偏旁', 2,
            '下面哪个字是「%s」字旁？' % radical, answer, ds,
            '「%s」是「%s」字旁。' % (answer, radical),
        ))
    return out


# ---------------------------------------------------------------- 主流程

# (标签, 构造函数, 上限)。上限之和**正好等于** LIMIT —— 这样每类的题量是
# 有意配的，而不是被切片随机截断的。改配比只动这里的数字。
#
# 语文一科占 90 道，是「语文:数学:英语 = 3:3:4」里的那份 3（见 build.py
# 的 SUBJECT_MIX）。
BUILDERS = [
    ('归类', build_category, 22),
    ('反义词', build_antonym, 18),
    ('笔画', build_strokes, 18),
    ('部首', build_radical, 14),
    ('加一笔减一笔', build_stroke_change, 10),
    ('偏旁', build_radical_class, 8),
]

LIMIT = 90


# ---------------------------------------------------------------- 自检

def stem_char(q):
    """取题干里「」之间的那个字。

    不能用 str.strip('「」…')：strip 会连**中间**的字一起吃掉，
    '「一」一共有几笔？'.strip('「」一共有几笔？') 会得到空串。
    """
    m = re.search(r'「(.*?)」', q['stem']['text'])
    return m.group(1) if m else None


def answer_text(q):
    """取这道题正确选项的文字。"""
    return [o['text'] for o in q['options'] if o['id'] == q['answer']][0]


def selfcheck(questions):
    """语文题库自己的语义校验（结构通用校验在 qbank.selfcheck_common）。

    这几条断言就是「一道题有没有唯一正确答案」的机器版本 ——
    内容题最大的风险不是崩溃，是答案错了但没人发现。自动生成的选择题
    尤其危险：错得很安静，四行 JSON 里看不出来。
    """
    errs = []

    # 反义词：答案必须真的是它的反义词
    pair = {a: b for a, b in ANTONYMS}
    pair.update({b: a for a, b in ANTONYMS})
    for q in questions:
        if q['tags'] != ['反义词']:
            continue
        ch = stem_char(q)
        got = answer_text(q)
        if pair.get(ch) != got:
            errs.append('%s：「%s」的反义词写成了「%s」' % (q['id'], ch, got))

    # 笔画：答案必须等于字表里的笔画数
    for q in questions:
        if q['tags'] != ['笔画']:
            continue
        ch = stem_char(q)
        got = answer_text(q)
        if got != '%d 笔' % CHARS[ch][1]:
            errs.append('%s：「%s」的笔画写成了 %s' % (q['id'], ch, got))

    # 部首：答案必须等于字表里的部首
    for q in questions:
        if q['tags'] != ['部首']:
            continue
        ch = stem_char(q)
        got = answer_text(q)
        if got != CHARS[ch][2]:
            errs.append('%s：「%s」的部首写成了「%s」' % (q['id'], ch, got))

    # 加一笔 / 减一笔：选项里有且只有一个字的笔画数对得上。
    # 这是全库最容易出「两个正确答案」的一类 —— 「日」加一笔既是「目」
    # 也是「白」，还可能是「田」。表的完备性由这条断言兜底。
    for q in questions:
        if q['tags'] not in (['加一笔'], ['减一笔']):
            continue
        base = stem_char(q)
        table = PLUS_ONE if q['tags'] == ['加一笔'] else MINUS_ONE
        delta = 1 if q['tags'] == ['加一笔'] else -1
        texts = [o['text'] for o in q['options']]
        hits = [t for t in texts if t in table.get(base, [])]
        if len(hits) != 1:
            errs.append('%s：「%s」%s的选项里正确答案有 %d 个（%s）'
                        % (q['id'], base, q['tags'][0], len(hits), '/'.join(hits)))
        # 顺手验一下笔画数：表写错了（比如「木」加一笔不该是「禾」）
        # 在这一条上会露出来
        for t in texts:
            if t in CHARS and t != answer_text(q) and CHARS[t][1] != CHARS[base][1] + delta:
                errs.append('%s：「%s」%s一笔不会是「%s」（笔画 %d→%d）'
                            % (q['id'], base, q['tags'][0], t,
                               CHARS[base][1], CHARS[t][1]))

    # 归类：答案在类别里，干扰项都不在
    cat_members = {stem: set(scoped(cs)) for _n, stem, cs in CATEGORY}
    for q in questions:
        if q['tags'] != ['归类']:
            continue
        members = cat_members.get(q['stem']['text'])
        if members is None:
            errs.append('%s：题干不在 CATEGORY 表里' % q['id'])
            continue
        got = answer_text(q)
        if got not in members:
            errs.append('%s：「%s」不属于「%s」' % (q['id'], got, q['stem']['text']))
        for o in q['options']:
            if o['text'] != got and o['text'] in members:
                errs.append('%s：干扰项「%s」也属于这一类，题目有两个答案'
                            % (q['id'], o['text']))

    # 偏旁：答案的部首必须真的是它，干扰项的部首必须都不是
    for q in questions:
        if q['tags'] != ['偏旁']:
            continue
        m = re.search(r'「(.*?)」字旁', q['stem']['text'])
        radical = m.group(1) if m else None
        got = answer_text(q)
        if not radical or CHARS.get(got, (None,) * 5)[2] != radical:
            errs.append('%s：「%s」的部首不是「%s」' % (q['id'], got, radical))
        for o in q['options']:
            if o['text'] != got and CHARS.get(o['text'], (None,) * 5)[2] == radical:
                errs.append('%s：干扰项「%s」也是「%s」旁，题目有两个答案'
                            % (q['id'], o['text'], radical))

    # 全库不许出现拼音。
    # 「不以拼音的形式出现」是这次改版的硬要求，而拼音最容易从 explain
    # 里漏出来（「「一」读 yī」这种）。这条断言直接扫题干、选项、解释，
    # 出现任何拉丁字母或声调符号就判定失败。
    for q in questions:
        blob = [q['stem'].get('text') or '', q.get('explain') or '']
        blob += [o['text'] for o in q['options']]
        hit = LATIN_RE.search(' '.join(blob))
        if hit:
            errs.append('%s：出现了拼音/拉丁字母「%s」' % (q['id'], hit.group(0)))

    # 出题范围：**孩子要认的那个字**必须是一年级的。
    #
    # 检查的是「选项」和题干里「」中的字，不是题干整句 —— 题干里的
    # 「下面哪个字是动物？」本身要用到 面/哪/个/是，这些字超纲不影响
    # 这道题考什么；要认的是那四个选项。
    for q in questions:
        # 题干里「」中的字也是要认的字 —— 但只有这几类的「」里装的是字。
        # 部首/偏旁的「」里是偏旁（氵 艹 扌…），本来就不在字表里。
        if q['tags'][0] in ('反义词', '笔画', '加一笔', '减一笔'):
            ch = stem_char(q)
            if ch and not in_scope(ch):
                errs.append('%s：题干考的字「%s」超纲' % (q['id'], ch))

        # 部首题的选项是偏旁，不是能单独成字的字，豁免
        targets = [] if q['tags'] == ['部首'] else [o['text'] for o in q['options']]
        for t in targets:
            for c in t:
                if '一' <= c <= '鿿' and not in_scope(c):
                    errs.append('%s：选项里的「%s」超纲' % (q['id'], c))

    return errs


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
        q['id'] = 'zi-%04d' % (i + 1)
    return all_q, report


def build_zibiao():
    """字表。既是构建校验的依据，也是给家长看的「这本书学哪些字」。

    只收一年级 —— 出题范围就到这里，多出来的字列在家长面板里只会让人
    以为孩子要学。
    """
    rows = []
    for ch in sorted(CHARS, key=lambda c: c):
        py, strokes, radical, grade, words = CHARS[ch]
        if grade > GRADE_MAX:
            continue
        rows.append({
            'char': ch, 'pinyin': py, 'strokes': strokes,
            'radical': radical, 'words': words,
            # grade 一起带上。过滤是这一步做的，但「字表里只有一年级」
            # 这条约束要能被**下游**独立验一次 —— 否则哪天过滤条件写错，
            # 产物里多出二年级字，没人看得出来（孩子照样能玩）。
            'grade': grade,
        })
    return {
        '_comment': '幼小衔接识字范围（小学一年级）。由 tools/gen_ziku.py '
                    '生成，不要手改。这里的 pinyin 只给家长看 —— 题库里'
                    '一道拼音题都没有，出题一律绕开读音。',
        'chars': rows,
    }


def main():
    qpath = os.path.join(DATA, 'chinese.json')
    zpath = os.path.join(DATA, 'zi_grade1.json')

    code = run('语文（识字）', 'chinese', qpath, generate, LIMIT,
               extra_checks=selfcheck,
               report_extra=lambda qs: '  字表 %d 个字（全部一年级）' % len(build_zibiao()['chars']))
    if code != 0:
        return code

    # 字表跟着题库一起走 --check 的一致性检查
    zibiao = build_zibiao()
    if '--check' in sys.argv:
        if not os.path.exists(zpath):
            print('❌ 缺少 %s' % os.path.relpath(zpath, ROOT))
            return 1
        with open(zpath, 'r', encoding='utf-8') as f:
            if json.load(f) != zibiao:
                print('❌ %s 与生成结果不一致' % os.path.relpath(zpath, ROOT))
                return 1
        return 0

    write_json(zpath, zibiao)
    print('  → %s' % os.path.relpath(zpath, ROOT))
    print('')
    return 0


if __name__ == '__main__':
    sys.exit(main())
