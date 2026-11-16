#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
set_appid.py — 把正式 AppID 写进小程序项目配置。

为什么值得单开一个脚本：
    AppID 是 wx + 16 位小写十六进制，手抄错一位，开发者工具只会给一句
    「AppID 不正确」，不会告诉你是第几位错了。这里在写盘前先按格式校验，
    再用 --check 随时复核当前配置到底还是不是测试号。

用法：
    python3 tools/set_appid.py wx1234567890abcdef   # 写入
    python3 tools/set_appid.py --check              # 只检查
"""

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, 'miniprogram', 'project.config.json')

# 小程序的 AppID 固定是 wx + 16 位小写十六进制。
PATTERN = re.compile(r'^wx[0-9a-f]{16}$')


def load():
    with open(CFG, 'r', encoding='utf-8') as f:
        return json.load(f)


def save(cfg):
    with open(CFG, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
        f.write('\n')


def check():
    appid = load().get('appid', '')
    if appid in ('', 'touristappid'):
        print('⚠️  当前是测试号（%r），只能在电脑模拟器里跑。' % appid)
        print('   真机预览 / 上传体验版都需要正式 AppID。')
        print('   注册地址：https://mp.weixin.qq.com/ → 立即注册 → 小程序')
        return 1
    if not PATTERN.match(appid):
        print('❌ %s 里的 AppID %r 格式不对（应为 wx + 16 位小写十六进制）'
              % (os.path.relpath(CFG, ROOT), appid))
        return 1
    print('✅ AppID：%s' % appid)
    return 0


def main():
    if len(sys.argv) != 2 or sys.argv[1] in ('-h', '--help'):
        print(__doc__.strip())
        return 2

    if sys.argv[1] == '--check':
        return check()

    appid = sys.argv[1].strip()
    if not PATTERN.match(appid):
        print('❌ %r 不像小程序 AppID。' % appid)
        print('   格式是 wx + 16 位小写十六进制，例如 wx1234567890abcdef。')
        print('   在公众平台「开发管理 → 开发设置」里复制，别手抄。')
        return 1

    cfg = load()
    old = cfg.get('appid')
    cfg['appid'] = appid
    save(cfg)

    print('✅ 已写入 AppID：%s' % appid)
    if old and old != appid:
        print('   （原来是 %s）' % old)
    print('')
    print('   下一步：')
    print('     1. npm run mp:build')
    print('     2. 微信开发者工具重新打开 miniprogram/')
    return 0


if __name__ == '__main__':
    sys.exit(main())
