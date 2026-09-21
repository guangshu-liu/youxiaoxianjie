# 幼小衔接知识闯关

给一个 6 岁、处于幼小衔接阶段的孩子做的知识闯关游戏。语文 / 数学 / 英语三科，
英语走**牛津自然拼读 OPW2（Short Vowels）**的单元顺序。

设计上的三个硬约束，所有代码都围绕它们：

1. **能离线玩。** 在线版有 Service Worker 全量预缓存，第二次打开起不依赖网络。
2. **零构建依赖。** 只用 Python 3 和 Node 标准库，没有 webpack/vite/npm 包。
   半年后回来还能构建成功。
3. **内容完全可控。** 题库是 JSON，音频可替换，英语解锁由家长决定。

---

## ⚠️ 先读这条：微信打不开 html 文件

**微信内置浏览器禁用了 `file://` 协议，并且不把 `.html` 当可预览文件。**
发过去的 html 附件，点开只会得到「无法预览」/「暂不支持打开此类文件」/白屏 ——
iOS 上常常连提示都没有。收发双方都一样，没有开关可调。

一句话：**微信只认 http/https URL，不认文件路径。**

所以分发给孩子只有一条路：**部署成 HTTPS 链接，发链接**。这正是本项目要
做在线版的原因，也是为什么要 PWA —— 详见下面「分发」一节。

单文件版仍然有用（电脑上双击即玩、飞行模式、归档备份），但它**不是**微信分发路径。

## 快速开始

```bash
npm run setup      # 生成音频清单（第一次必跑）
npm run tts        # 生成正式音频（需要 edge-tts）
npm run verify     # 校验 + 测试 + 构建 + 产物测试，一条命令
npm run serve      # 本地预览 http://localhost:8080
npm run deploy     # 发布到 GitHub Pages，拿到可以发微信的链接
```

改完东西推手机之前，先跑 `npm run verify`。它做四件事：

| 命令 | 作用 |
|---|---|
| `npm run validate` | 题库 / 音频一致性校验（构建前必跑） |
| `npm test` | 无头冒烟测试，从 `src/` 加载，63 项断言，0.3 秒 |
| `npm run build` | 产出两种产物 |
| `npm run test:build` | 同样的断言，但**从构建产物里抽内联代码跑** |

最后一条不是多余的。拼接 15 个 JS 文件有真实风险：某个文件少个结尾分号、
下一个文件以 `(` 开头，就会变成一个调用表达式 —— 这类 bug 只在运行时炸，
build 日志完全正常。`test:build` 验的就是「实际发出去的字节」。

没有装 `edge-tts` 也能跑通全流程，用占位音代替：

```bash
npm run tts:placeholder    # 生成占位蜂鸣音，仅供链路验证
npm run build
```

---

## 目录

```
src/                  唯一真相源。只改这里。
  index.html          模板，含 <!--@inline:*--> / <!--@pwa--> / <!--@sw--> 占位符
  sw.js               Service Worker（构建时注入版本号和预缓存清单）
  manifest.webmanifest
  icons/              PWA 图标（由 tools/make_icons.py 生成，可删可重建）
  css/                base / game / wheel / parent
  js/                 按序号加载，见下表
  data/               curriculum / chinese / math / english.json

audio/                构建输入。TTS 产物 + 占位音
tools/
  build.py            双产物构建 + 题库校验
  deploy_pages.py     发布到 GitHub Pages
  make_icons.py       生成 PWA 图标（纯标准库写 PNG）
  tts_gen.py          音频清单管理 + 批量 TTS（增量）
  smoke_test.js       无头逻辑测试
  audio_manifest.json 音频清单（唯一真相源）
output/
  online/             分离资产版 + PWA → 部署用
  幼小衔接-v1.0.html   单文件版 → 电脑上双击即玩 / 归档
docs/                 ← 部署脚本同步出的产物，GitHub Pages 从这里发布
```

### JS 模块加载顺序

数字前缀决定顺序，`build.py` 按文件名字典序拼接。新增模块时选个合适的号段。

| 文件 | 职责 |
|---|---|
| `00-core.js` | 命名空间、常量、RNG、工具函数 |
| `05-ui.js` | toast / 横幅 / 反馈 / 撒花 / 通用控件 |
| `10-store.js` | 存档读写、备份、时钟检测、三方审计 |
| `20-audio.js` | ⚠️ 风险最高：Web Audio、解锁、家长录音覆盖 |
| `30-curriculum.js` | ⚠️ OPW2 课程表、解锁、最小对立干扰项、加权抽题 |
| `40-runner.js` | 一局编排（4/3/3 + 位置软约束） |
| `41`–`44-render-*.js` | 各题型渲染器 |
| `50-wheel.js` | 转盘（先定结果后动画） |
| `60-redeem.js` | 兑换 + 日/周上限 |
| `70-parent.js` | 家长模式 |
| `90-main.js` | 启动、路由、解锁手势 |
| `99-selftest.js` | 真机自检页（`#selftest`） |

---

## 怎么改题

题库全部是 JSON，加完跑 `npm run validate`。校验会挡住这些错：
`answer` 指向不存在的选项、选项 id 重复、英语题引用了未定义的词族、
sort 题的 item 落进了不存在的筐子、解锁范围内的词族题量不够。

### 语文 / 数学

```jsonc
{
  "id": "cn-pinyin-001",        // 全局唯一，重复会报错
  "subject": "chinese",          // chinese | math | english
  "type": "choice",
  "difficulty": 1,
  "tags": ["拼音"],
  "stem": { "text": "「妈」的拼音是？", "layout": "big-number" },
  "options": [{ "id": "a", "text": "mā" }, { "id": "b", "text": "má" }],
  "answer": "a",
  "explain": "第一声是平的高音。"
}
```

**数学优先用生成器**，一条模板顶几十道题：

```jsonc
{
  "id": "math-gen-add-10",
  "subject": "math",
  "type": "choice",
  "stem": { "layout": "big-number" },
  "generator": {
    "kind": "add",              // add | sub | compare | count
    "a": [1, 9], "b": [1, 9],
    "constraint": "a+b<=10",    // 运行时求值，保证不超纲
    "missing": "sum",           // sum | b
    "optionRule": "near-miss"   // 干扰项 = 正确答案 ±1/±2
  }
}
```

干扰项是「算错会得到的数」（±1、±2、±10），比随机数有区分度得多。

### 英语

英语题的工作量是语文数学的 5 倍，因为选项不能手写 —— 必须是**最小对立对**。

```jsonc
{
  "id": "en-opw2-u2-at-l001",
  "subject": "english",
  "type": "listen",             // listen | blend | sort | realword
  "unit": "U2",                 // 必须是 curriculum.json 里的单元
  "family": "at",               // 必须是已定义的词族
  "answerWord": "cat",
  "audio": ["word/cat.mp3"],
  "explain": "听到的是 cat。"
}
```

注意 `listen` 题**没有 `options` 字段** —— 这是故意的。选项每次由
`30-curriculum.js` 的 `makeDistractors()` 现生成，优先级是
换元音（`cat`→`cut`）> 同族换首音（`cat`→`hat`）> 同尾音，
且只从**真实存在的词**里选。固定选项会被孩子记住，而且手写很容易写出
`fan` vs `box` 这种"不用听就能排除"的废题。

`sort` / `realword` 同样不在 JSON 里写选项，原因见 `build.py` 顶部的
`NO_STATIC_OPTIONS` 注释。

**一局的 3 道英语题锁定同一词族**，按「听 → 拼 → 用」固定顺序：

| 槽位 | 题型 | 教学功能 |
|---|---|---|
| 英语 1 | `listen` | 听音辨认（输入） |
| 英语 2 | `blend` (vowel-gap) | 拼读合成（加工） |
| 英语 3 | `sort` / `realword` 交替 | 应用迁移（输出） |

这是自然拼读的标准教学顺序，**不要随机化**。

---

## 音频

`tools/audio_manifest.json` 是音频的唯一真相源。加新音频的正确姿势：

```bash
npm run setup     # 扫描题库，把新引用的音频自动加进清单
npm run tts       # 只生成新增/变更的，已有的不动
```

清单里每条记 `text_sha1`，改了文本才会重新生成；也记 `sha1`，检测文件被外部改动。

### 命名规范（硬规则）

```
audio/word/fan.mp3      →  id = "word.fan"
audio/phoneme/an.mp3    →  id = "phoneme.an"
audio/prompt/<题号>.mp3
audio/ui/correct.mp3
```

**全 ASCII 小写、无空格无中文。** COS 的 object key 对非 ASCII 的 URL 编码处理是坑，
文件名污染是后期最难修的技术债。`id` 就是路径把 `/` 换成 `.`、去掉扩展名 ——
代码引用音频不需要第二张映射表。

> 题库里两种写法都能用（`word/fan.mp3` 和 `word.fan`），`tts_gen.py` 会归一化。
> 但新写的题请统一用路径式。

### ⚠️ 音素音需要人工听辨

**edge-tts 不支持 IPA 输入。** 直接读 `a` 会得到字母名 /eɪ/、读 `f` 会得到 /ɛf/ ——
教学上是错的，不能接受。所以 `tts_gen.py` 用拼写诱导（短 a 写 `ah`、f 写 `fff`），
**全部标记 `needsReview`**。

```bash
npm run tts:review     # 列出待听辨清单，逐个听 audio/ 下对应文件
```

听不过关的**不用去改脚本** —— 在游戏家长面板里录一条替换就行。这个功能本来就要做。
爆破音（b/p/d/t/g/k）必然带出 schwa（/bə/ 而非 /b/），大概率全部需要重录。

`blend` 题已经做了降级：音素音缺失时自动退回播整词音
（`20-audio.js` 的 `playWithFallback`）。

---

## 家长模式

入口在开始页，需要回答 `7 × 8`。功能：

- **三方审计** —— `balance` / `lifetime` / `redemptions` 交叉对账，对不上就报警
- **今日数据** —— 转盘次数、动画片分钟数、兑换次数
- **待确认兑换** —— 孩子提交的兑换在这里批准
- **英语解锁** —— 「孩子课上到哪了？」只给建议，不自动解锁
- **音频替换** —— 给任意一条音频录音，带音量校准滑块
- **备份导出/导入** —— 存档 + 全部录音打包

### 为什么必须有备份

**WebKit 自 iOS 13.4 起，7 天未访问就清空所有脚本可写存储**（localStorage、
IndexedDB 一视同仁），**对没加到主屏幕的站点绝对生效**。

iOS 微信内置浏览器**没有「添加到主屏幕」功能**，所以微信里玩的进度随时可能归零。
家长面板顶部会显示「上次备份：N 天前」，超过 7 天变红。**这条提示本身就是防丢失的主要手段。**

---

## 分发

### 主路径：GitHub Pages 链接（微信里打开）

```bash
npm run deploy       # 校验 → 测试 → 构建 → 同步 docs/ → 提交 → 推送
npm run deploy:dry   # 只构建并同步到 docs/，不碰 git
```

首次只有一步，装 gh 并登录：

```bash
brew install gh
gh auth login        # GitHub.com → HTTPS → Login with a web browser
```

然后 `npm run deploy`。登录之后脚本会**自动**建仓库、从 GitHub 账号推断 git 身份
（用 `<id>+<login>@users.noreply.github.com` 当提交邮箱，不暴露真实邮箱）、
开启 Pages，最后打印可以发微信的链接。以后更新内容只需 `npm run deploy`。

> 不想装 gh 也行，脚本会在每一步告诉你缺什么：手配 `git config --global user.name/user.email`、
> 在 <https://github.com/new> 建一个 Public 仓库（**不要勾任何初始化选项**）、
> 手工开 Settings → Pages → Deploy from a branch → `main` / `/docs`。
> 用 SSH key 或 Personal Access Token 认证也可以。gh 只是把这些合成一条命令。

**为什么 GitHub Pages**：免费、自动 HTTPS、**不需要 ICP 备案**，当天就能用。
腾讯云 COS 在国内更快更稳，但大陆地域绑自定义域名必须完成 ICP 网站备案
（首次 1–3 周），且 2024-01-01 后创建的存储桶用默认域名不支持静态网站。
如果你已有备案域名，把 `docs/` 里的内容传上去即可，构建产物完全一样。

### 让孩子真正离线玩：添加到主屏幕

在 Safari 里打开链接 → 分享 → **添加到主屏幕**。这样做有两个好处：

1. **离线可玩。** Service Worker 已经预缓存了全部 65 个资源
   （含音频，约 875 KB），之后飞行模式也能玩。
2. **存档不会被清掉。** iOS 对 Safari 里的站点有「7 天未访问即清空存储」的规则，
   但**主屏幕 Web App 有独立的持久化存储，不受这条规则限制**。
   这比反复提醒家长备份有效得多。

> 微信内置浏览器**没有**「添加到主屏幕」，所以这一步必须在 Safari 里做。
> 微信里也能正常玩，只是受 7 天规则约束 —— 家长面板里的备份提示仍然重要。

### 备用：单文件版

```bash
npm run build:single    # → output/幼小衔接-v1.0.html
```

全内联，含 base64 音频，零外部依赖。**在电脑上双击即玩**，适合家长自己检查、
归档备份。不要在微信里发给别人 —— 见本文开头。

---

## 真机验收清单

无头测试能覆盖逻辑，**覆盖不了音频、微信和离线**。以下必须在真机上过一遍
（iPhone + iPad 各一次）：

- [ ] Safari 里打开 Pages 链接，点「开始游戏」后音频能播
- [ ] **微信内置浏览器**里打开同一链接，音频能播（最不确定的一条）
- [ ] 微信里关掉重开，进度还在
- [ ] Safari 里「添加到主屏幕」，从主屏幕图标启动能玩
- [ ] 主屏幕启动后开飞行模式，完整玩一局（音频 + 存档都要正常）
- [ ] 家长录音：`MediaRecorder` 能否录出可播放的 Blob
- [ ] 家长录音覆盖后优先级正确，音量滑块有效
- [ ] 家长面板导出备份 → 清空存储 → 导入，数据完整
- [ ] 故意把手机时间回拨，确认兑换被冻结且家长面板报警

自检页：在链接后面加 `#selftest`，会逐项检测环境、音频、存储、配额，
并生成一份可复制的报告。

---

## 两个待定参数

1. **`maxPointsPerDay: 60`** —— 每天最多 3 局有效积分，500 分（1 元）最少要 9 天。
   若希望是"月度大奖"感，60 正好；若希望孩子努力一周能拿到，调到 100。
   改 `src/js/00-core.js` 的 `G.LIMITS`。
2. **COS 存储桶的备案状态** —— 决定在线版能否按时交付（不影响单文件版）。

---

## 明确不做的事

这些都被考虑过并否决了，写在这里是为了防止将来重新想起来又做一遍：

- ❌ **服务端积分签名** —— 为保护 1 元兑换而后端化，而兑现者就是家长本人。
  且直接违背"单文件离线可玩"的核心需求。
- ❌ **存档 XOR 混淆** —— 对 6 岁孩子和加密一样无用（两个他都不会），
  只会让将来调试存档变难。
- ❌ **Canvas 反调试 / 代码混淆** —— 收益为零。
- ❌ **`<audio>` 元素做音频** —— iOS 上每个元素都要单独在 gesture 里解锁，
  145 条音频就是 145 次预解锁。Web Audio 一次 `ctx.resume()` 解决。
- ❌ **ES Module** —— `<script type="module">` 在 `file://` 下被 CORS 拦截，
  而单文件版正是要在 `file://` 下打开。
