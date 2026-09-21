#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
deploy_pages.py — 把在线版发布到 GitHub Pages。

为什么是 GitHub Pages：微信内置浏览器禁用了 file://，只认 http/https，
所以「发文件给对方」这条路根本不通（这是微信的硬限制，不是代码问题）。
Pages 免费、自动配 HTTPS、不需要 ICP 备案，是唯一当天就能跑通的方案。

仓库结构用「源码 + docs/」单仓库：
    <repo>/
      src/ tools/ ...      源码（公开无妨，题库本来就来自公开来源）
      docs/                ← 构建产物，GitHub Pages 从这里发布

孩子和存档数据全在设备本地（localStorage / IndexedDB），从不上传，
所以仓库公开不涉及任何隐私。

用法：
    python3 tools/deploy_pages.py                 # 构建 + 提交 + 推送
    python3 tools/deploy_pages.py --dry-run       # 只构建并同步到 docs/，不碰 git
    python3 tools/deploy_pages.py --repo <url>    # 指定远端
"""

import argparse
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ONLINE = os.path.join(ROOT, 'output', 'online')
DOCS = os.path.join(ROOT, 'docs')

BG = '\033[1m'
DIM = '\033[2m'
RED = '\033[31m'
GREEN = '\033[32m'
YELLOW = '\033[33m'
RESET = '\033[0m'


def log(m=''):
    print(m, flush=True)


def run(cmd, cwd=ROOT, check=True, capture=True):
    r = subprocess.run(cmd, cwd=cwd, shell=isinstance(cmd, str),
                       capture_output=capture, text=True)
    if check and r.returncode != 0:
        raise RuntimeError('%s 失败：\n%s\n%s'
                           % (cmd if isinstance(cmd, str) else ' '.join(cmd),
                              (r.stdout or '').strip(), (r.stderr or '').strip()))
    return r


def git(args, **kw):
    return run(['git'] + args, **kw)


def have(cmd):
    return shutil.which(cmd) is not None


# ---------------------------------------------------------------- 前置检查

def preflight():
    """先跑校验和测试。发布一个坏版本比不发布更糟 ——
    孩子那边不会报错，只会玩到一个坏掉的东西。"""
    log(BG + '前置检查' + RESET)

    if not have('git'):
        log(RED + '  ✘ 没找到 git。装一个：xcode-select --install' + RESET)
        return False
    log(GREEN + '  ✔ git' + RESET)

    log(DIM + '  跑题库校验…' + RESET)
    r = run([sys.executable, 'tools/build.py', 'all', '--check-only'], check=False)
    if r.returncode != 0:
        log(RED + '  ✘ 校验未通过，已中止：' + RESET)
        log(r.stdout)
        return False
    log(GREEN + '  ✔ 题库校验通过' + RESET)

    if have('node'):
        log(DIM + '  跑冒烟测试…' + RESET)
        r = run(['node', 'tools/smoke_test.js'], check=False)
        if r.returncode != 0:
            log(RED + '  ✘ 测试未通过，已中止：' + RESET)
            log(r.stdout[-3000:])
            return False
        log(GREEN + '  ✔ 冒烟测试通过' + RESET)
    else:
        log(YELLOW + '  ⚠ 没找到 node，跳过冒烟测试' + RESET)
    return True


# ---------------------------------------------------------------- gh 助手

def gh(args, **kw):
    return run(['gh'] + args, **kw)


def gh_authed():
    """gh 装了且已登录？返回用户名，否则 None。"""
    if not have('gh'):
        return None
    r = run(['gh', 'auth', 'status'], check=False)
    if r.returncode != 0:
        return None
    r = run(['gh', 'api', 'user', '--jq', '.login'], check=False)
    if r.returncode != 0:
        return None
    return r.stdout.strip() or None


def gh_user_id():
    r = run(['gh', 'api', 'user', '--jq', '.id'], check=False)
    return r.stdout.strip() if r.returncode == 0 else None


# ---------------------------------------------------------------- git 准备

def git_identity():
    name = git(['config', 'user.name'], check=False).stdout.strip()
    email = git(['config', 'user.email'], check=False).stdout.strip()
    return name, email


def in_repo():
    r = git(['rev-parse', '--is-inside-work-tree'], check=False)
    return r.returncode == 0 and r.stdout.strip() == 'true'


def ensure_identity(login):
    """没配 git 身份就从 gh 推断，不打扰用户。
    GitHub 的 noreply 邮箱是 <id>+<login>@users.noreply.github.com ——
    用它当提交邮箱，既不用暴露真实邮箱，GitHub 也能正确归属到账号上。"""
    name, email = git_identity()
    if name and email:
        log(DIM + '  git 身份已有：%s <%s>' % (name, email) + RESET)
        return True

    uid = gh_user_id()
    if not uid:
        log(YELLOW + '  配不出 git 身份，请手动跑：' + RESET)
        log('      git config --global user.name  "你的名字"')
        log('      git config --global user.email "你的邮箱"')
        return False

    if not name:
        git(['config', '--global', 'user.name', login])
    if not email:
        git(['config', '--global', 'user.email',
             '%s+%s@users.noreply.github.com' % (uid, login)])
    log(GREEN + '  ✔ 已自动配置 git 身份：%s <%s+%s@users.noreply.github.com>'
        % (login, uid, login) + RESET)
    log(DIM + '    想换成真名/真邮箱：git config --global user.name "..."' + RESET)
    return True


def ensure_repo(login, repo_name):
    """建仓库并配好远端。已存在就直接用。"""
    if not in_repo():
        log(DIM + '  初始化本地仓库…' + RESET)
        git(['init', '-b', 'main'])

    remote = git(['remote', 'get-url', 'origin'], check=False).stdout.strip()
    if remote:
        log(GREEN + '  ✔ 远端已配置 ' + remote + RESET)
        return remote

    full = '%s/%s' % (login, repo_name)
    log(DIM + ('  创建 GitHub 仓库 %s…' % full) + RESET)
    r = run(['gh', 'repo', 'create', full, '--public',
             '--source=.', '--remote=origin',
             '--description', '给幼小衔接阶段孩子的识字闯关游戏'],
            check=False)

    if r.returncode != 0:
        err = ((r.stderr or '') + (r.stdout or '')).strip()
        if 'already exists' in err.lower() or 'Name already exists' in err:
            log(YELLOW + '  仓库已存在，直接接上远端' + RESET)
            git(['remote', 'add', 'origin',
                 'https://github.com/%s.git' % full])
        else:
            log(RED + '  ✘ 建仓库失败：' + RESET)
            log('    ' + err[:600])
            return None
    else:
        log(GREEN + '  ✔ 仓库已创建：https://github.com/%s' % full + RESET)

    return git(['remote', 'get-url', 'origin'], check=False).stdout.strip()


def enable_pages(login, repo_name):
    """开启 Pages（main 分支 /docs 目录）。已开则跳过，不让脚本因为
    「已经开过了」而失败 —— 重复跑部署是常态。"""
    path = 'repos/%s/%s/pages' % (login, repo_name)

    r = run(['gh', 'api', path, '--jq', '.html_url'], check=False)
    if r.returncode == 0 and r.stdout.strip():
        log(GREEN + '  ✔ Pages 已开启：' + r.stdout.strip() + RESET)
        return r.stdout.strip()

    r = run(['gh', 'api', '-X', 'POST', path,
             '-f', 'source[branch]=main',
             '-f', 'source[path]=/docs'], check=False)
    if r.returncode == 0:
        log(GREEN + '  ✔ Pages 已开启（main / docs）' + RESET)
        return 'https://%s.github.io/%s/' % (login, repo_name)

    err = ((r.stderr or '') + (r.stdout or '')).strip()
    log(YELLOW + '  ⚠ 自动开启 Pages 失败，手动开一下：' + RESET)
    log('    https://github.com/%s/%s/settings/pages' % (login, repo_name))
    log(DIM + '    Source 选 Deploy from a branch → main → /docs → Save' + RESET)
    if err:
        log(DIM + '    ' + err[:300] + RESET)
    return None



# ---------------------------------------------------------------- 同步产物

def sync_docs():
    if not os.path.isdir(ONLINE):
        log(RED + '  ✘ 找不到 output/online/，先跑 npm run build:online' + RESET)
        return False

    if os.path.isdir(DOCS):
        shutil.rmtree(DOCS)
    shutil.copytree(ONLINE, DOCS)

    # Pages 默认会对下划线开头的文件报错，Jekyll 也会试图处理这些静态文件。
    # .nojekyll 让 Pages 原样发布，不经过 Jekyll —— 少了它有些文件会 404。
    with open(os.path.join(DOCS, '.nojekyll'), 'w'):
        pass

    total = 0
    for dirpath, _, files in os.walk(DOCS):
        for f in files:
            total += os.path.getsize(os.path.join(dirpath, f))
    log(GREEN + '  ✔ 产物已同步到 docs/  （%.0f KB）' % (total / 1024) + RESET)
    return True


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description='发布在线版到 GitHub Pages')
    ap.add_argument('--dry-run', action='store_true', help='只构建同步，不碰 git')
    ap.add_argument('--repo', help='远端仓库 URL')
    ap.add_argument('--repo-name', default='youxiaoxianjie',
                    help='GitHub 仓库名（默认 youxiaoxianjie）')
    ap.add_argument('--message', '-m', help='提交信息')
    ap.add_argument('--skip-checks', action='store_true', help='跳过校验和测试')
    args = ap.parse_args()

    log('')
    log(BG + '发布到 GitHub Pages' + RESET)
    log('=' * 46)

    if not args.skip_checks and not preflight():
        return 1

    log('')
    log(BG + '构建' + RESET)
    r = run([sys.executable, 'tools/build.py', 'online'], check=False)
    if r.returncode != 0:
        log(r.stdout)
        log(r.stderr)
        return 1
    for line in r.stdout.strip().splitlines():
        if 'output/online' in line or '预缓存' in line or '总计' in line:
            log('  ' + line.strip())

    log('')
    log(BG + '同步到 docs/' + RESET)
    if not sync_docs():
        return 1

    if args.dry_run:
        log('')
        log(YELLOW + '--dry-run：已停在本地。docs/ 里就是将要发布的内容。' + RESET)
        log(DIM + '  本地预览：python3 -m http.server 8080 --directory docs' + RESET)
        return 0

    log('')
    log(BG + '提交' + RESET)

    login = gh_authed()

    if args.repo:
        if not in_repo():
            git(['init', '-b', 'main'])
        git(['remote', 'remove', 'origin'], check=False)
        git(['remote', 'add', 'origin', args.repo])
        remote = args.repo
        log(GREEN + '  ✔ 远端 ' + remote + RESET)
    elif login:
        log(GREEN + '  ✔ gh 已登录：' + login + RESET)
        if not ensure_identity(login):
            return 2
        remote = ensure_repo(login, args.repo_name)
    else:
        # 没有 gh 或没登录。gh 装了却没登录是此刻最可能的情况，
        # 所以这条分支的首要任务就是把「跑 gh auth login」说清楚。
        if not in_repo():
            log(DIM + '  初始化仓库…' + RESET)
            git(['init', '-b', 'main'])

        if have('gh'):
            log('')
            log(YELLOW + 'gh 装了，但还没登录。跑这一条就行：' + RESET)
            log('')
            log(BG + '      gh auth login' + RESET)
            log('')
            log(DIM + '  选 GitHub.com → HTTPS → Login with a web browser，'
                      '浏览器里点一下授权。' + RESET)
            log(DIM + '  登录后重跑 npm run deploy，'
                      '建仓库 / 配身份 / 配凭据 / 开 Pages 我全自动做完。' + RESET)
            log('')
            log(DIM + '  产物已在 docs/ 里，重跑不会白费。' + RESET)
            return 2

        name, email = git_identity()
        if not name or not email:
            log('')
            log(YELLOW + 'git 还没配置身份（提交记录需要）。先跑这两条：' + RESET)
            log('    git config --global user.name  "你的名字"')
            log('    git config --global user.email "你的邮箱@example.com"')
            log(DIM + '  邮箱不必是 GitHub 账号邮箱。' + RESET)
            return 2

        remote = git(['remote', 'get-url', 'origin'],
                     check=False).stdout.strip()
        if not remote:
            log('')
            log(YELLOW + '还没配置远端仓库。' + RESET)
            log('')
            log('  先去 https://github.com/new 建一个 Public 仓库')
            log('  （不要勾任何初始化选项），然后：')
            log(BG + '      git remote add origin https://github.com/<用户名>/<仓库名>.git' + RESET)
            log('')
            log(DIM + '  老实说，装 gh 能把这堆全省掉：brew install gh' + RESET)
            return 2
        log(GREEN + '  ✔ 远端 ' + remote + RESET)

    if not remote:
        log('')
        log(YELLOW + '配好远端后重跑本脚本即可。产物已经在 docs/ 里了，不会白跑。' + RESET)
        return 2

    # 忽略规则。产物目录要提交（Pages 从它发布），但中间文件不要。
    gi = os.path.join(ROOT, '.gitignore')
    if not os.path.exists(gi):
        with open(gi, 'w', encoding='utf-8') as f:
            f.write('.DS_Store\n__pycache__/\n*.pyc\noutput/\n')
        log(GREEN + '  ✔ 写入 .gitignore' + RESET)

    git(['add', '-A'])
    r = git(['diff', '--cached', '--quiet'], check=False)
    if r.returncode == 0:
        log(DIM + '  没有变化，跳过提交。' + RESET)
    else:
        msg = args.message or '发布在线版'
        git(['commit', '-m', msg])
        log(GREEN + '  ✔ 已提交' + RESET)

    log('')
    log(BG + '推送' + RESET)
    r = git(['push', '-u', 'origin', 'HEAD'], check=False)
    if r.returncode != 0:
        err = (r.stderr or '') + (r.stdout or '')
        log(RED + '  ✘ 推送失败：' + RESET)
        log(err.strip()[:1500])
        log('')
        if 'could not read Username' in err or 'Authentication failed' in err or 'Permission denied' in err:
            log('  看起来是认证没配好。两种办法，选一个：' + RESET)
            log('')
            log(BG + '  A. 装 gh CLI（省事，推荐）' + RESET)
            log('      brew install gh && gh auth login')
            log('      然后重跑本脚本。gh 会顺便帮你建仓库、配好凭据。')
            log('')
            log(BG + '  B. 用 SSH key' + RESET)
            log('      ssh-keygen -t ed25519 -C "你的邮箱"')
            log('      pbcopy < ~/.ssh/id_ed25519.pub   # 粘到 GitHub → Settings → SSH keys')
            log('      git remote set-url origin git@github.com:<用户名>/<仓库名>.git')
            log('')
            log(BG + '  C. 用 Personal Access Token（HTTPS）' + RESET)
            log('      在 GitHub → Settings → Developer settings → Tokens 建一个有 repo 权限的 token，')
            log('      然后 git remote set-url origin https://<用户名>:<token>@github.com/<用户名>/<仓库名>.git')
        return 1
    log(GREEN + '  ✔ 已推送' + RESET)

    # 推导 Pages 地址
    m = re.search(r'github\.com[:/]([^/]+)/([^/\s]+?)(?:\.git)?$', remote.strip())
    log('')
    log('=' * 46)

    if not m:
        log(YELLOW + '远端不是 GitHub，无法自动开 Pages。' + RESET)
        log(DIM + '  remote = ' + remote + RESET)
        return 0

    user, repo = m.group(1), m.group(2)
    url = 'https://%s.github.io/%s/' % (user, repo)

    if login:
        log(BG + '开启 Pages' + RESET)
        enable_pages(user, repo)
        log('')

    log(BG + '好了' + RESET)
    log('')
    if not login:
        log('  ⚠ Pages 还没开。开一下（只需做一次）：')
        log('     https://github.com/%s/%s/settings/pages' % (user, repo))
        log('     Source → Deploy from a branch → ' + BG + 'main' + RESET
            + ' + ' + BG + '/docs' + RESET + ' → Save')
        log('')
    log('  等 1～2 分钟，然后访问：')
    log('')
    log(BG + GREEN + '     ' + url + RESET)
    log('')
    log('  把这个链接发到微信，点开就能玩。')
    log(DIM + '  建议先在 Safari 里打开 → 分享 → 添加到主屏幕：')
    log('  这样能离线玩，而且存档不会被 iOS 的 7 天规则清掉。' + RESET)
    log('')

    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except RuntimeError as e:
        log('')
        log(RED + str(e) + RESET)
        sys.exit(1)
