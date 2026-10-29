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

```bash
npm version patch          # 或 minor / major；会改 package.json + lock，并提交 + 打 vX.Y.Z 标签
git push --follow-tags     # 标签推到 GitHub，release.yml 自动跑：校验 → typecheck → lint → build → publish
```

`npm version` 打的是**附注标签**（`--follow-tags` 只认附注的；手敲 `git tag v1.2.3` 是轻量标签，推不上去，得 `git push origin v1.2.3`）。

手动补发（CI 挂过 / 想把当前 `package.json` 的版本直接发出去）：GitHub → Actions → `release` → **Run workflow**。
手动触发时不做「tag 与 package.json 一致」校验，发的是默认分支上 `package.json` 里那个版本。

发布成功后 npm 页面会带 **Provenance** 徽标（构建来源可溯）。

## 四、踩坑对照表

| 现象 | 原因 |
|---|---|
| `EOTP` / `This operation requires a one-time password` | 还在走 token 发布。检查两处：`permissions: id-token: write` 在不在；工作流里有没有 `NODE_AUTH_TOKEN` / `NPM_TOKEN`（**空值也算**） |
| `404 Not Found - PUT` + `ENEEDAUTH` | npm 上那条信任关系没配，或仓库 / 文件名 / 环境名对不上 |
| `npm warn Unknown ...` 之后静默用 token | 给 `actions/setup-node` 传了 `registry-url`：它会写 `_authToken=${NODE_AUTH_TOKEN}`，npm 会优先用它 |
| `This command requires a newer version of npm` | npm < 11.5.1。工作流里有 `npm install -g npm@latest`，本地跑发版则先 `npm i -g npm@latest` |
| `tag v1.2.3 与 package.json 的 1.2.2 对不上` | 工作流主动拦的：先 `npm version` 再打标签，别手工错位 |
| 发布出来的包是空壳 | 忘了 `npm run build`：`dist/`、`web/dist/` 都在 `files` 里但都不入库，必须现构建 |

## 五、已知的 CI 边界

- **单测没进流水线**：`tests/unit` 现在有 33 个失败（与发布无关的历史遗留），拿它当门禁会把发版全卡住。修完之后再把
  `node --import tsx --test tests/unit/*.test.ts` 加进 `release.yml` 就行。
- **`format:check` 也没门禁**：仓库里有 7 个文件没过 Prettier，`npm run lint`（oxlint）是干净的，先只卡它。
- 工作流里不跑 `prettier`，也不自动改文件 —— 发布流程只读。
