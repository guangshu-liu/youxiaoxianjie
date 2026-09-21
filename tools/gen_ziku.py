#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_ziku.py — 识字题库生成器（唯一真相源）

产出两个文件：
    src/data/zi_grade12.json    字表（字 / 拼音 / 笔画 / 部首 / 年级 / 词语）
    src/data/chinese.json       识字题库（≤300 道，全部 choice 题型）

为什么用生成器而不是手写 JSON：
    手写 280 道题的选项，必然出现「answer 指向不存在的选项」「两个选项都
    说得通」「选项里混进了三年级的字」这三类错，而且靠眼睛查不出来。
    生成器把「字的范围」变成一条机器可校验的约束 —— 字表里没有的字，
    根本进不了选项。

    产物必须可复现：同一个字表跑两次，得到逐字节相同的 JSON，`--check`
    才有意义。所以这里不用 Python 内置的 hash()（它每个进程都换种子），
    自己写了个 dhash()。

数据从哪来：
    字表是**为幼小衔接阶段手工筛选的常用字**，取自统编版语文一、二年级
    识字表的高频部分，不是任何一个出版社识字表的逐字复制。年级标注表示
    「这个字通常什么时候学」，用途是让出题有难度梯度，不声称与教材逐字
    对齐。

用法：
    python3 tools/gen_ziku.py            # 生成
    python3 tools/gen_ziku.py --check    # 只校验产物是否与生成结果一致
"""

import argparse
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'src', 'data')

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

# 形近 / 同音辨析题，逐条人工核对过。
#
# 为什么不像别的题型那样自动生成：挖空题有个自动生成躲不掉的坑 ——
# 干扰项可能**也**能填进去。比如「（　）鸟」配 马/牛/羊，小马、小牛、
# 小羊全是词，四个选项都对。没有词典就没法自动判断，只能一条条挑
# 「剩下那半截字不跟干扰项组词」的搭配。
#
# (完整词语, 要填的字, [干扰字])
CURATED_SIMILAR = [
    ('日出', '日', ['目', '自', '白']),
    ('白云', '白', ['百', '日', '自']),
    ('自己', '自', ['日', '目', '白']),
    ('耳目', '目', ['日', '月', '自']),
    ('天空', '天', ['田', '木', '米']),
    ('太阳', '太', ['天', '大', '人']),
    ('大人', '大', ['太', '天', '人']),
    ('出入', '入', ['八', '人', '大']),
    ('木头', '木', ['本', '禾', '米']),
    ('本子', '本', ['木', '禾', '米']),
    ('禾苗', '禾', ['木', '本', '米']),
    ('大米', '米', ['木', '本', '禾']),
    ('牛奶', '牛', ['午', '手', '毛']),
    ('中午', '午', ['牛', '手', '毛']),
    ('手心', '手', ['毛', '牛', '午']),
    ('羊毛', '毛', ['手', '牛', '午']),
    ('石头', '石', ['右', '名', '田']),
    ('左右', '右', ['石', '名', '田']),
    ('有名', '名', ['石', '右', '田']),
    ('田地', '田', ['石', '右', '名']),
    ('月亮', '月', ['目', '耳', '自']),
    ('耳朵', '耳', ['目', '月', '自']),
    ('读书', '书', ['画', '字', '学']),
    ('画笔', '画', ['书', '字', '学']),
    ('生字', '字', ['书', '画', '学']),
    ('学习', '学', ['书', '画', '字']),
    ('回去', '去', ['云', '土', '工']),
    ('水土', '土', ['云', '去', '工']),
    ('工人', '工', ['云', '去', '土']),
    ('力气', '力', ['刀', '九', '女']),
    ('小刀', '刀', ['力', '九', '女']),
]

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
RADICAL_ASK = ['木', '氵', '艹', '女', '口', '犭', '日', '足', '扌', '讠']

# 「下面哪个字是 X 字旁？」的答案。**不能自动取**：按字表顺序取会给「木」
# 选中「本」——「本」的部首确实是木，但木在里面占的是整个字，孩子看到的
# 不是一个「字旁」。这里逐个挑的都是偏旁在左边、一眼可辨的字。
RADICAL_CLASS_ANSWER = {
    '木': '树', '氵': '江', '艹': '花', '女': '妈', '口': '吃',
    '犭': '猫', '日': '明', '足': '跑', '扌': '打', '讠': '说',
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


def usable(ch):
    """这个字能不能进读音题的答案位/干扰项。"""
    return ch in CHARS and ch not in POLYPHONIC


def sound_alike(ch, n=3):
    """按读音相似度挑干扰项。

    排名：同音节不同调 > 同韵母 > 同声母。
    **真同音字（音节和声调都相同）必须排除** —— 否则「shí 是哪个字？」
    的选项会变成 十/石/时，三个都对。这道题就没有答案了。
    """
    py = CHARS[ch][0]
    base, tone = split_tone(py)
    ini, fin = split_syllable(py)

    scored = []
    for other in CHARS:
        if other == ch or not usable(other):
            continue
        opy = CHARS[other][0]
        obase, otone = split_tone(opy)
        if obase == base and otone == tone:
            continue                      # 真同音字：不能当干扰项
        oini, ofin = split_syllable(opy)
        score = 0
        if obase == base:
            score += 100                  # 同音节不同调，最像
        elif ofin == fin:
            score += 40
        elif oini == ini and ini:
            score += 20
        if score:
            scored.append((score, other))

    scored.sort(key=lambda x: (-x[0], x[1]))
    return [c for _s, c in scored[:n]]


def look_alike(ch, n=3):
    """从形近字组里挑干扰项。"""
    for group in SIMILAR:
        if ch in group:
            others = [c for c in group if c != ch and c in CHARS]
            if len(others) >= n:
                return others[:n]
    return []


def make_choice(qid, tag, difficulty, stem, answer, distractors, explain):
    """拼一道选择题。选项打乱，答案位置不固定 —— 否则孩子会背「选 b」。"""
    opts = [answer] + list(distractors)
    opts = Rng(dhash(qid) & 0xFFFF).shuffle(opts)
    letters = 'abcd'
    options = [{'id': letters[i], 'text': t} for i, t in enumerate(opts)]
    ans_id = [o['id'] for o in options if o['text'] == answer][0]
    return {
        'id': qid,
        'subject': 'chinese',
        'type': 'choice',
        'difficulty': difficulty,
        'unit': None,
        'family': None,
        'tags': [tag],
        'stem': {'text': stem, 'layout': 'grid'},
        'options': options,
        'answer': ans_id,
        'explain': explain,
    }


def two_char_word(ch):
    """挑一个含这个字的双字词，用来挖空。"""
    for w in CHARS[ch][4]:
        if len(w) == 2 and ch in w:
            return w
    return None


# ---------------------------------------------------------------- 各题型

def build_py2zi():
    """看拼音选字：「mā」是哪个字？"""
    out = []
    for ch in sorted(CHARS):
        if not usable(ch):
            continue
        py, _s, _r, grade, words = CHARS[ch]
        ds = sound_alike(ch, 3)
        if len(ds) < 3:
            continue
        out.append(make_choice(
            'zi-py2zi-%04d' % (len(out) + 1), '看拼音选字',
            1 if grade == 1 else 2,
            '「%s」是哪个字？' % py, ch, ds,
            '「%s」读 %s，可以组词「%s」。' % (ch, py, words[0]),
        ))
    return out


def build_zi2py():
    """看字选拼音：「妈」读什么？"""
    out = []
    for ch in sorted(CHARS):
        if not usable(ch):
            continue
        py, _s, _r, grade, words = CHARS[ch]
        base, tone = split_tone(py)
        if tone == 0:
            continue

        n = len(out)
        if n % 2 == 0:
            # 考声调：mā → má / mǎ / mà
            cands = [with_tone(base, t) for t in (1, 2, 3, 4) if t != tone]
            ds = []
            for c in cands:
                if c != py and c not in ds:
                    ds.append(c)
        else:
            # 考声母韵母：从字表里挑读音相近的。
            # 必须排除读音和答案完全相同的字（夏 xià / 下 xià 都在字表里），
            # 否则选项里会出现两个正确答案 —— 而字面上它们长得完全一样，
            # 看起来只是「选项重复」，实际是题目坏了。
            ini, fin = split_syllable(py)
            ds = []
            for other in sorted(CHARS):
                if not usable(other) or other == ch:
                    continue
                opy = CHARS[other][0]
                ob, ot = split_tone(opy)
                if ot == 0 or ob == base:
                    continue
                oini, ofin = split_syllable(opy)
                if ((oini and oini == ini) or ofin == fin) and opy not in ds:
                    ds.append(opy)
                if len(ds) >= 3:
                    break

        if len(ds) < 3:
            continue
        out.append(make_choice(
            'zi-zi2py-%04d' % (n + 1), '看字选拼音',
            1 if grade == 1 else 2,
            '「%s」读什么？' % ch, py, ds[:3],
            '「%s」读 %s，可以组词「%s」。' % (ch, py, words[0]),
        ))
    return out


def build_similar():
    """形近 / 同音字辨析：给一个词，从几个长得像的字里挑对的。"""
    out = []
    for word, ch, ds in CURATED_SIMILAR:
        if ch not in CHARS:
            continue
        ds = [d for d in ds if d in CHARS and d != ch]
        if len(ds) < 3:
            continue
        idx = word.index(ch)
        blanked = word[:idx] + '（　）' + word[idx + 1:]
        out.append(make_choice(
            'zi-bianxi-%04d' % (len(out) + 1), '形近字辨析', 2,
            '「%s」里应该填哪个字？' % blanked, ch, ds[:3],
            '是「%s」，读 %s，不要和「%s」写混。'
            % (ch, CHARS[ch][0], '」「'.join(ds[:2])),
        ))
    return out


def build_category():
    """归类：下面哪个字是动物？选项跨类别取，答案唯一。"""
    groups = [(name, stem, [c for c in cs if c in CHARS]) for name, stem, cs in CATEGORY]
    groups = [(n, st, cs) for n, st, cs in groups if len(cs) >= 4]

    out = []
    for name, stem, members in groups:
        others = [c for _n, _s, cs in groups if _n != name for c in cs]
        for ch in members:
            ds = [c for c in Rng(dhash('cat' + ch) & 0xFFFF).shuffle(others)][:3]
            if len(ds) < 3:
                continue
            out.append(make_choice(
                'zi-guilei-%04d' % (len(out) + 1), '归类', 1,
                stem, ch, ds,
                '「%s」是%s。' % (ch, name),
            ))
    return out


def build_antonym():
    """反义词。干扰项从其他反义词字里取，比随机字更像回事。"""
    pool = sorted({c for pair in ANTONYMS for c in pair if c in CHARS})
    out = []
    for a, b in ANTONYMS:
        if a not in CHARS or b not in CHARS or len(pool) < 4:
            continue
        ds = [x for x in Rng(dhash('ant' + a) & 0xFFFF).shuffle(pool)
              if x != a and x != b][:3]
        if len(ds) < 3:
            continue
        out.append(make_choice(
            'zi-fanyi-%04d' % (len(out) + 1), '反义词', 1,
            '「%s」的反义词是哪个字？' % a, b, ds,
            '「%s」和「%s」意思相反。' % (a, b),
        ))
    return out


def build_strokes():
    """数笔画。干扰项取答案 ±1 / ±2 —— 都是「数错会得到」的数。"""
    out = []
    for ch in STROKE_SAFE:
        if ch not in CHARS:
            continue
        py, strokes, radical, _g, _w = CHARS[ch]
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
            'zi-bihua-%04d' % (len(out) + 1), '笔画', 2,
            '「%s」一共有几笔？' % ch, '%d 笔' % strokes, ds,
            '「%s」是 %d 笔，部首是「%s」。' % (ch, strokes, radical),
        ))
    return out


def build_radical():
    """部首：「妈」的部首是什么？"""
    out = []
    for ch in RADICAL_SAFE:
        if ch not in CHARS:
            continue
        py, strokes, radical, _g, words = CHARS[ch]
        base = split_tone(py)[0]

        # 干扰项不能和题干字同音节。
        # 「妈」的部首是「女」，但「马」是它的声旁 —— 选项里同时出现女和马，
        # 这道题就变成了猜出题人想考哪个，而不是考部首。形声字的声旁通常
        # 和整字同音节，这条规则正好把它们滤掉（和 sound_alike 里排除
        # 真同音字是同一个道理）。
        # 池子里的「纟」「宀」这类不单独成字，字表里查不到读音 —— 它们不可能
        # 是哪个字的声旁，留着当干扰项没问题。
        ds = [r for r in Rng(dhash('rad' + ch) & 0xFFFF).shuffle(RADICAL_POOL)
              if r != radical
              and not (r in CHARS and split_tone(CHARS[r][0])[0] == base)][:3]
        if len(ds) < 3:
            continue
        out.append(make_choice(
            'zi-bushou-%04d' % (len(out) + 1), '部首', 2,
            '「%s」的部首是什么？' % ch, radical, ds,
            '「%s」的部首是「%s」，可以组词「%s」。' % (ch, radical, words[0]),
        ))
    return out


def build_radical_class():
    """同偏旁归类：下面哪个字是木字旁？"""
    by_radical = {}
    for ch in sorted(CHARS):
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
            'zi-pianpang-%04d' % (len(out) + 1), '偏旁', 2,
            '下面哪个字是「%s」字旁？' % radical, answer, ds,
            '「%s」是「%s」字旁。' % (answer, radical),
        ))
    return out


# ---------------------------------------------------------------- 主流程

# (标签, 构造函数, 上限)。上限之和 > 300，靠 LIMIT 收口 ——
# 这样调整配比只需要动这里的数字，不用改生成逻辑。
BUILDERS = [
    ('看拼音选字', build_py2zi, 96),
    ('看字选拼音', build_zi2py, 62),
    ('形近字辨析', build_similar, 31),
    ('归类', build_category, 40),
    ('反义词', build_antonym, 17),
    ('笔画', build_strokes, 22),
    ('部首', build_radical, 18),
    ('偏旁', build_radical_class, 10),
]

LIMIT = 300


# ---------------------------------------------------------------- 自检

def stem_char(q):
    """取题干里「」之间的那个字。

    不能用 str.strip('「」…')：strip 会连**中间**的字一起吃掉，
    '「一」一共有几笔？'.strip('「」一共有几笔？') 会得到空串。
    """
    m = re.search(r'「(.*?)」', q['stem']['text'])
    return m.group(1) if m else None


def selfcheck(questions):
    """出题器自己的单元测试。

    这几条断言就是「一道题有没有唯一正确答案」的机器版本 ——
    内容题最大的风险不是崩溃，是答案错了但没人发现。
    """
    errs = []
    ids = set()
    by_id = {}

    for q in questions:
        qid = q['id']
        if qid in ids:
            errs.append('%s：id 重复' % qid)
        ids.add(qid)
        by_id[qid] = q

        opts = q.get('options', [])
        texts = [o['text'] for o in opts]
        if len(opts) != 4:
            errs.append('%s：选项不是 4 个（%d）' % (qid, len(opts)))
        if len(set(texts)) != len(texts):
            errs.append('%s：选项重复 %s' % (qid, texts))
        if q['answer'] not in [o['id'] for o in opts]:
            errs.append('%s：answer 不在选项里' % qid)
        if not q.get('explain'):
            errs.append('%s：缺少 explain' % qid)
        if not q.get('stem', {}).get('text'):
            errs.append('%s：缺少题干' % qid)

        # 选项里的单字必须在字表内 —— 这就是「字的范围」那条硬约束。
        # 部首题的选项是偏旁（氵 艹 扌…），本来就不是能单独成字的字，
        # 豁免这一类。
        if q['tags'][0] in ('部首', '偏旁'):
            continue
        for t in texts:
            for c in t:
                if '\u4e00' <= c <= '\u9fff' and c not in CHARS:
                    errs.append('%s：选项里的「%s」不在字表内' % (qid, c))

    # 看拼音选字：选项里必须**有且只有一个**字读这个音
    for q in questions:
        if q['tags'] != ['看拼音选字']:
            continue
        py = stem_char(q)
        want = split_tone(py)
        hits = [o['text'] for o in q['options']
                if split_tone(CHARS[o['text']][0]) == want]
        if len(hits) != 1:
            errs.append('%s：读 %s 的选项有 %d 个（%s）'
                        % (q['id'], py, len(hits), '/'.join(hits)))

    # 看字选拼音：选项里必须**有且只有一个**等于这个字的读音
    for q in questions:
        if q['tags'] != ['看字选拼音']:
            continue
        ch = stem_char(q)
        right = [o['text'] for o in q['options'] if o['text'] == CHARS[ch][0]]
        if len(right) != 1:
            errs.append('%s：「%s」的正确读音不在选项里' % (q['id'], ch))

    # 反义词：答案必须真的是它的反义词
    pair = {a: b for a, b in ANTONYMS}
    pair.update({b: a for a, b in ANTONYMS})
    for q in questions:
        if q['tags'] != ['反义词']:
            continue
        ch = stem_char(q)
        got = [o['text'] for o in q['options'] if o['id'] == q['answer']][0]
        if pair.get(ch) != got:
            errs.append('%s：「%s」的反义词写成了「%s」' % (q['id'], ch, got))

    # 挖空题：答案必须真的在那个词里
    for q in questions:
        if q['tags'] != ['形近字辨析']:
            continue
        blanked = stem_char(q)
        got = [o['text'] for o in q['options'] if o['id'] == q['answer']][0]
        if blanked.replace('（　）', got) not in [w for w, _c, _d in CURATED_SIMILAR]:
            errs.append('%s：填「%s」进「%s」不是一个词' % (q['id'], got, blanked))

    # 笔画：答案必须等于字表里的笔画数
    for q in questions:
        if q['tags'] != ['笔画']:
            continue
        ch = stem_char(q)
        got = [o['text'] for o in q['options'] if o['id'] == q['answer']][0]
        if got != '%d 笔' % CHARS[ch][1]:
            errs.append('%s：「%s」的笔画写成了 %s' % (q['id'], ch, got))

    # 全局规模
    if len(questions) > LIMIT:
        errs.append('题量 %d 超过上限 %d' % (len(questions), LIMIT))

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
    """字表。既是构建校验的依据，也是给家长看的「这本书学哪些字」。"""
    rows = []
    for ch in sorted(CHARS, key=lambda c: (CHARS[c][3], c)):
        py, strokes, radical, grade, words = CHARS[ch]
        rows.append({
            'char': ch, 'pinyin': py, 'strokes': strokes,
            'radical': radical, 'grade': grade, 'words': words,
        })
    return {
        '_comment': '幼小衔接识字范围。由 tools/gen_ziku.py 生成，不要手改。'
                    '年级表示「通常什么时候学」，用于难度分级，'
                    '不代表某个教材的逐字顺序。',
        'chars': rows,
    }


def write_json(path, obj):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write('\n')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true',
                    help='只校验产物是否与生成结果一致')
    args = ap.parse_args()

    questions, report = generate()
    zibiao = build_zibiao()

    errs = selfcheck(questions)
    if errs:
        print('❌ 出题自检未通过：')
        for e in errs[:25]:
            print('   · %s' % e)
        if len(errs) > 25:
            print('   …… 还有 %d 条' % (len(errs) - 25))
        return 1

    qpath = os.path.join(DATA, 'chinese.json')
    zpath = os.path.join(DATA, 'zi_grade12.json')

    if args.check:
        bad = []
        for path, want in [(qpath, questions), (zpath, zibiao)]:
            if not os.path.exists(path):
                bad.append('缺少 %s' % os.path.relpath(path, ROOT))
                continue
            with open(path, 'r', encoding='utf-8') as f:
                if json.load(f) != want:
                    bad.append('%s 与生成结果不一致' % os.path.relpath(path, ROOT))
        if bad:
            for b in bad:
                print('❌ %s' % b)
            print('   跑一次 python3 tools/gen_ziku.py 重新生成')
            return 1
        print('✅ 题库与字表都是最新的')
        return 0

    write_json(qpath, questions)
    write_json(zpath, zibiao)

    print('')
    print('识字题库已生成')
    print('=' * 44)
    for label, c in report:
        print('  %-12s %3d 道' % (label, c))
    print('  %-12s %3d 道   (上限 %d)' % ('合计', len(questions), LIMIT))
    print('')
    print('  字表 %d 个字（一年级 %d · 二年级 %d）'
          % (len(zibiao['chars']),
             sum(1 for r in zibiao['chars'] if r['grade'] == 1),
             sum(1 for r in zibiao['chars'] if r['grade'] == 2)))
    print('')
    print('  → src/data/chinese.json')
    print('  → src/data/zi_grade12.json')
    print('')
    return 0


if __name__ == '__main__':
    sys.exit(main())
