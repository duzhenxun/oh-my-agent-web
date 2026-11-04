# 官网（单页）

`index.html`（英文）与 `zh.html`（中文）是产品官网，`assets/` 是它俩用到的截图。

- **纯静态、可离线打开**：没有 CDN、没有外部字体、没有请求，双击 `index.html` 就能看。
- **自动深浅色**：跟随系统的 `prefers-color-scheme`。
- **图片**：WebP，1.1.0 真实运行实例（演示工作区 `demo-app` / `ledger-api`），没有拼图。
  点任意截图可看大图。

## 本地预览

```bash
# 直接打开
open index.html

# 或起一个静态服务（推荐，路径与缓存行为更接近线上）
python3 -m http.server 8080 --directory docs/site
```

## 改内容

文案与结构都在 `index.html`（英文）和 `zh.html`（中文）里，两份**内容一一对应、要改一起改**，按下面的顺序排：

| 区块 | 内容 |
|---|---|
| Hero | 一句话定位 + 安装命令 + 主截图 |
| `#rules` | 三条硬纪律（不引数据库 / 不假装 / 不越界） |
| `#features` | 对话：过程、回合控制、标注、`@` 与 `/` |
| `#workspace` | 右栏：文件与改动、真终端、网页标注闭环 |
| `#panels` | 模型 / 技能 / MCP / 子代理 / 插件 / 推送语音 |
| `#tour` | 界面巡览（标签切换：全景 / 设置 / 斜杠 / 手机） |
| `#engines` | 多引擎与能力矩阵 |
| `#install` | 安装三步 + 命令表 |
| `#security` | 安全模型与数据落盘 |
| `#faq` | 常见问题 |

改截图时保持 `width` / `height` 属性与真实文件尺寸一致 —— 属性值会被浏览器当作固定高度参与排版（曾是留白问题的来源）。

## 分享卡片（og 图）

`assets/og.png`（1280×630）是链接贴到 X / Slack / 钉钉 / 微信时的第一眼。它**不是手改的**：

```bash
node scripts/make-og.mjs   # 读 assets/og.svg + docs/screenshots/01-chat.png → 生成 og.png
```

改版式/文案/配色就改 `assets/og.svg`（截图在 SVG 里写的是相对路径，脚本渲染前会换成 data URI——
rsvg-convert 对相对路径的外部位图会**静默跳过**，右侧会变成空框）。
两个 HTML 里的 `og:url` / `og:locale` 各指自己那一页（`zh.html` 与根路径），换域名时三处一起改。

## 截图怎么来的

见仓库根目录 `docs/screenshots/README.md` 的流程：起一个独立的演示实例（独立 `HOME` +
`AGENT_WEB_DATA_DIR` + 演示工作区），用 Playwright 抓图，再按需要的区域裁切、压缩成 WebP。
