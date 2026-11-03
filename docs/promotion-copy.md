# 投放文案（三篇，一篇只打一个差异点）

> 用法：每个渠道只发对应那一篇，不要把三篇揉在一起。三篇分别打三个不同的人群——
> 中文打「混用多个 agent」、Show HN 打「local-first / no DB」、X 打「中途插话」。
> 发之前把链接换成对应渠道的版本（见文末 UTM），方便两周后看哪条带来了真实下载。

---

## 一、中文社区（V2EX 分享创造 / Linux.do / 掘金）

**差异点：多引擎同框，不用给每个 agent 各装一个界面**

**标题**：`[开源] 我给本机在跑的 coding agent 做了个统一网页：pi / Codex / Claude Code / opencode 一个界面管`

**正文**：

事情是这样的：我现在手上同时用着 pi 和 Codex，偶尔还开 Claude Code。每个 agent 都有自己的一套终端界面，切来切去很烦——想看某个会话跑到哪了，得先想起来它是在哪个工具里开的。

所以就写了 oh-my-agent-web：一个跑在本机的网页工作台，把这几个 agent 放进同一个界面。

几个我觉得还不错的点：

- **各跑各的原生 loop**，不是套壳。pi 走原生 SDK，Codex 走 app-server，Claude Code / opencode 走 ACP。引擎没有的功能界面直接隐藏，不装。
- **过程摊开给你看**：思考块、工具调用（完整命令可复制）、改了哪些文件、token 和花费，都在对话流里。
- **能插话**：pi 引擎下回合跑到一半可以直接插一句纠正，不用等它跑完。
- **会话就是引擎自己的落盘文件**，不引数据库、不建账号。你 `ls` 一下数据目录，看到的就是引擎写的那些文件。

技术栈 Node + React，MIT 协议，npm 一条命令装：

```
npm -g install oh-my-agent-web
aw    # 起服务，自动开页面
```

截图和完整文档在 GitHub（默认英文，有中文版）：https://github.com/duzhenxun/oh-my-agent-web

想听听大家的意见，尤其是「你还希望它支持哪个 agent」。

> 备选标题（更口语）：`受够了一堆 agent 终端切来切去，我做了个统一网页管它们`

---

## 二、Show HN（英文，周一/周二 UTC 上午发）

**差异点：local-first，会话就是引擎的落盘文件，不引数据库**

**标题**：`Show HN: A local-first web UI for your coding agents – sessions stay on disk, no database`

**正文**：

I run several coding agents on my machine (pi, Codex, Claude Code, opencode). I wanted a single web page to watch them work, but everything I tried either moved my sessions into its own database or wanted me to sign up for a cloud account.

So I built oh-my-agent-web with one hard rule: **the engine's own on-disk files are the only source of truth for a conversation.** The web UI reads them, renames them, deletes them — that's it. No SQLite, no account system, no second copy of your session in our store. `ls` the data directory and you'll see exactly the files your engine wrote.

What it does:
- Multi-engine, each on its native loop (pi via SDK, Codex via app-server JSON-RPC, Claude Code / opencode via ACP). A capability matrix hides buttons an engine doesn't support instead of faking them.
- Watch the process: thinking blocks, tool calls (full commands, copyable), changed files, tokens and cost.
- Steer mid-turn on pi — cut into a running turn without waiting for it to finish.
- Single user, loopback-only by default; remote access requires setting a password first.

Node + React, MIT. `npm -g install oh-my-agent-web`, then `aw`.

Repo: https://github.com/duzhenxun/oh-my-agent-web
Comparison with other approaches (CloudCLI, Codex WebUI, Pi Web): https://github.com/duzhenxun/oh-my-agent-web/blob/main/docs/compare.md

Happy to hear which agent you'd want supported next, or where the "no database" tradeoff breaks down for you.

> 注意：Show HN 评论区很吃「诚实」这一套。有人质疑时别硬撑——多引擎但每个引擎定制不深、单用户不做协作，这些都是真实取舍，直接承认反而加分。

---

## 三、X / 即刻（短内容，一条只讲一个点）

**差异点：回合中途插话（steer），不用等它跑完**

**主推**（英文，配图用 docs/site/assets/en/selection.webp 或 hero.webp）：

> Your agent is mid-turn going the wrong direction. You can either wait 2 minutes for it to finish, or… just cut in.
>
> oh-my-agent-web lets you steer a running turn on pi — your message becomes the next instruction, immediately. No abort, no restart.
>
> Local-first, no database, sessions stay in your engine's own files.
>
> npm -g install oh-my-agent-web

**中文短版**（即刻 / 微博，配中文图）：

> agent 跑到一半发现方向不对，你只能干等它跑完？
> 我写的这个网页工作台支持「插队」：回合进行中直接插一句，立刻作为下一条指令生效，不用中断重开。
> 本机运行、不引数据库，会话就是引擎自己的文件。
> GitHub 搜 oh-my-agent-web

---

## 附：UTM 链接（发之前替换）

| 渠道 | 链接 |
|---|---|
| V2EX | `https://duzhenxun.github.io/oh-my-agent-web/zh.html?utm_source=v2ex` |
| Linux.do | `https://duzhenxun.github.io/oh-my-agent-web/zh.html?utm_source=linuxdo` |
| 掘金 | `https://duzhenxun.github.io/oh-my-agent-web/zh.html?utm_source=juejin` |
| Show HN | `https://duzhenxun.github.io/oh-my-agent-web/?utm_source=hackernews` |
| X | `https://duzhenxun.github.io/oh-my-agent-web/?utm_source=x` |

> 落地页是纯静态 GitHub Pages，UTM 参数本身不会被记录——要统计来源得在落地页加一点前端埋点，
> 或者干脆看「哪个渠道发完之后 npm 下载涨」。两周后回看，把带来真实下载最多的那篇文案角度复用一遍。
