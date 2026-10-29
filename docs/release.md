# 发版（Trusted Publishing / OIDC）

推一个 `v*` 标签，GitHub Actions 就编译 + 发布，**不需要任何 token，也不需要输 OTP**。

```
改代码 → npm version patch|minor|major → git push --follow-tags → CI 发布
```

## 一、先确认三件事

| 事 | 现状 | 说明 |
|---|---|---|
| 包已存在于 npm | ✅ `oh-my-agent-web@1.0.3` | Trusted Publishing **不能用于包名从未发布过**的情况：那种必须先手动发一个版本，再回来配 |
| 工作流文件 | ✅ `.github/workflows/release.yml` | 配白名单时填的文件名就是 `release.yml` |
| 仓库 | ✅ `duzhenxun/oh-my-agent-web` | 配白名单时填 `duzhenxun/oh-my-agent-web` |

## 二、npm 网页端配一次（只有你能做）

打开 <https://www.npmjs.com/package/oh-my-agent-web> → **Settings** → **Trusted publishing** → **Add publisher**：

| 字段 | 填什么 |
|---|---|
| Publisher | GitHub Actions |
| Organization or user | `duzhenxun` |
| Repository | `oh-my-agent-web` |
| Workflow filename | `release.yml`（**只写文件名**，不要 `.github/workflows/` 前缀） |
| Environment name | 留空（本仓库没在 job 里写 `environment:`；写了就必须和这里一致） |
| Allowed actions | `npm publish`（默认就有；要发 beta 再加 `npm stage publish`） |

> 这一步必须**本人登录网页交互完成**：npm 明确禁止用绕过 2FA 的 token 去建这条信任关系，否则等于没有 2FA。

配好之后，这个仓库的 `release.yml` 就能用 OIDC 令牌换发布凭证；**其他仓库 / 其他工作流文件一律发不出去**。

## 三、以后怎么发版

**合并/推送到 `main` 不发版。** 发版只有两步，都在本地：

```bash
npm version patch          # 或 1.0.8 / minor / major —— 改 package.json + lock，提交，打附注标签
git push --follow-tags     # 把 main 和标签一起推上去 → release.yml 自动跑
```

推上去之后 CI 依次做：校验「标签版本 == package.json 版本」→ `npm ci` → typecheck → lint → build
→ 确认产物进包 → `npm publish`（OIDC，无需 OTP）。

关于版本号参数：

| 命令 | 结果 |
|---|---|
| `npm version patch` | `1.0.7` → `1.0.8` |
| `npm version minor` | `1.0.7` → `1.1.0` |
| `npm version major` | `1.0.7` → `2.0.0` |
| `npm version 1.2.3` | 直接指定 |

`npm version` 打的是**附注标签**。`--follow-tags` 只推附注标签 —— 手敲 `git tag v1.2.3` 是轻量标签，
推不上去（`git push --follow-tags` 会静默跳过），得显式 `git push origin v1.2.3`。

### 重试 / 补发

GitHub → Actions → `release` → **Run workflow**：发布默认分支 `package.json` 里的那个版本，
不做标签校验、也不会 +1。发布挂了就用这个补，别重复 `npm version`（那会白跳一个号）。

### 为什么不让 main 自动 +1

试过：每次推送都 `patch` +1，包括只改文档的提交；版本号涨得飞快，还会出现「合并了但发布失败」
留下一个空号。标签驱动下版本号由你决定、失败可以原地重试，历史也干净。
## 四、踩坑对照表

| 现象 | 原因 |
|---|---|
| `EOTP` / `This operation requires a one-time password` | 还在走 token 发布。检查两处：`permissions: id-token: write` 在不在；工作流里有没有 `NODE_AUTH_TOKEN` / `NPM_TOKEN`（**空值也算**） |
| `404 Not Found - PUT` + `ENEEDAUTH` | npm 上那条信任关系没配，或仓库 / 文件名 / 环境名对不上 |
| `npm warn Unknown ...` 之后静默用 token | 给 `actions/setup-node` 传了 `registry-url`：它会写 `_authToken=${NODE_AUTH_TOKEN}`，npm 会优先用它 |
| `This command requires a newer version of npm` | npm < 11.5.1。工作流里有 `npm install -g npm@latest`，本地跑发版则先 `npm i -g npm@latest` |
| `tag v1.2.3 与 package.json 的 1.2.2 对不上` | 工作流主动拦的：先 `npm version` 再打标签，别手工错位 |
| 发布出来的包是空壳 | 忘了 `npm run build`：`dist/`、`web/dist/` 都在 `files` 里但都不入库，必须现构建 |
| `npm ci` 报 `EUSAGE ... package.json and package-lock.json are in sync` | 锁文件过期（本地 `node_modules` 是新的所以看不出来）。本地跑 `npm install --package-lock-only`，提交 `package-lock.json` 后再触发 |
| 合并到 main 但没发版 | 本来就不会发：发版认的是 **`v*` 标签**，不是分支推送 |
| 标签推上去了但没触发 | 标签是**轻量**的（`git tag v1.2.3`）。用 `npm version` 生成附注标签，或 `git push origin v1.2.3` 显式推 |

## 五、已知的 CI 边界

- **单测没进流水线**：`tests/unit` 现在有 33 个失败（与发布无关的历史遗留），拿它当门禁会把发版全卡住。修完之后再把
  `node --import tsx --test tests/unit/*.test.ts` 加进 `release.yml` 就行。
- **`format:check` 也没门禁**：仓库里有 7 个文件没过 Prettier，`npm run lint`（oxlint）是干净的，先只卡它。
- 工作流里不跑 `prettier`，也不自动改文件 —— 发布流程只读。
