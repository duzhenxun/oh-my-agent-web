# 推广：仓库设置填写清单

这份文件只放**能直接复制粘贴**的东西。策略与渠道排期见讨论记录，不在这里重复。

> 每次发版 / 改定位时回来看一眼：About 和 topics 是仓库**唯一**的被动搜索入口，
> 一次填好之后长期带量，填错或空着等于把流量让给别人的 fork 与镜像。

---

## 1. GitHub Topics（10 个位子，建议填满）

仓库首页右栏齿轮 → Topics。一行一个，粘贴时 GitHub 会按空格/回车切分。

**推荐组合（直接复制这行）：**

```
pi-agent coding-agent agent-ui claude-code codex opencode llm local-first self-hosted web-ui
```

取舍理由：

| topic | 为什么留 |
|---|---|
| `pi-agent` | 差异化最大的一条：pi 引擎深度适配，搜这个的人少但对得上 |
| `coding-agent` / `agent-ui` / `web-ui` | 品类词，Explore 与话题页的主入口 |
| `claude-code` / `codex` / `opencode` | **蹭成熟生态的搜索词**——大家搜的是这些 CLI 的 Web UI，而本仓库确实支持它们 |
| `llm` | 大池子，只做兜底 |
| `local-first` / `self-hosted` | 打「不上云、不建数据库」的人群，也是 awesome-selfhosted 的门槛 |
| `web-ui` | 英文侧常见搜法 |

**不要加的**：`oh-my-zsh` `oh-my-posh` `zsh`（同名前缀但完全无关，反而拉低相关度）、
`vscode`（不是编辑器插件）、`chatbot`（定位不符，来的人会失望）。

---

## 2. About 栏

**Description（一句话，中文——仓库首页显示的就是它）：**

```
给你正在跑的 coding agent 配一个本地 Web 工作台：看过程、插话纠正、管模型与工具。支持 pi / Codex / Claude Code / opencode，会话就是引擎的落盘文件，不引数据库。
```

**备选（更短，适合口播/朋友圈转述）：**

```
本机跑 agent，网页里看它干活、随时插话纠正。支持 pi / Codex / Claude Code / opencode。
```

**Website 字段（填这个）：**

```
https://duzhenxun.github.io/oh-my-agent-web/
```

> 别填 npm 页或 README 锚点：这里放**落地页**，落地页上有截图、有安装命令、有 GitHub 链接，
> 从这里进来的人不会直接跳走。Pages 由 `.github/workflows/pages.yml` 发布
> （Settings → Pages → Source 必须选 **GitHub Actions**）。

**要不要勾 Topics / Discussions：**

- Discussions：**开**（Settings → General → Features）。0 issue 的仓库看起来像没人用，
  Discussions 至少给「装了但用不明白」的人一个比 issue 低的门槛。
- Issues：保持开，但**先加两个模板**（Bug、引擎适配请求），否则第一波反馈会全是
  「跑不起来」+ 没版本号没系统信息，回起来很贵。

---

## 3. Social Preview（分享卡片）

路径：Settings → General → Social preview → Upload image

- 用 **`docs/site/assets/og.png`**（1280×630，由 `node scripts/make-og.mjs` 从 `og.svg` 生成）
- 改图：编辑 `docs/site/assets/og.svg`（版式/文案/配色）→ `node scripts/make-og.mjs` → 提交 PNG
- 改完顺手刷新落地页的 `og:image` 绝对地址（`docs/site/index.html`，换域名时一起改）

**验证卡片效果**（发出去之前，别靠想象）：

- X / Telegram / 飞书 等：用 <https://cards-dev.twitter.com/validator> 或直接在群里贴链接看预览
- 微信：贴到「文件传输助手」看缩略图（微信不读 og，会抓第一张图——所以 README 第一张图也别乱放）

---

## 4. 发版前 5 分钟自查

- [ ] README 顶部的 npm 下载徽章数字在涨（不涨说明渠道没带量，别急着发下一条）
- [ ] About 里的 Website 打得开、且是**最新**落地页
- [ ] topics 里没有拼错（GitHub 不会自动纠错，`selfhosted` ≠ `self-hosted`）
- [ ] 落地页 `og:image` 是绝对地址且能直接打开
- [ ] `docs/docker.md` 里那条 `docker run` 复制出来能跑（这是新用户最省事的入口）
- [ ] Issues 模板在位；Discussions 已开

---

## 5. 一条命令验证仓库设置（可选的自动检查）

`gh` 已登录时，下面这条能直接确认（不能改，改仍要网页点）：

```bash
gh api repos/duzhenxun/oh-my-agent-web \
  --jq '{topics: .topics, about: .description, home: .homepage, has_discussions: .has_discussions}'
```

期望：`topics` 有 10 条、`home` 是落地页 URL、`has_discussions` 为 `true`。

> 别用 `gh repo view --json repositoryTopics`：那个字段在 CLI 里常常返回 `null`，看不出到底填没填。
