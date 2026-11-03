# Docker：一条命令先看见它长什么样

本机安装要 Node ≥ 22.19，Linux 上还得就地编 `node-pty`（`make` / `g++` / `python3`）。
只是想先看看这个工作台是什么样的时候，这些前置条件全是门槛。镜像把门槛挪进构建阶段：

```bash
docker build -t oh-my-agent-web:local .

docker run -d --name aw \
  -p 127.0.0.1:25257:25257 \
  -e AGENT_WEB_PASSWORD='换成你自己的' \
  -v aw-data:/data \
  -v "$PWD":/workspace \
  oh-my-agent-web:local
```

打开 <http://127.0.0.1:25257>。换仓库就换 `-v "$PWD":/workspace` 的左边；
删容器不丢会话（`/data` 是 volume），`docker rm -f aw` 之后重跑同一条命令即可。

或者用 compose（`docker-compose.yml` 已放在仓库根）：

```bash
export AGENT_WEB_PASSWORD='换成你自己的'
WORKSPACE=/path/to/repo docker compose up -d
```

## 为什么镜像里必须有密码

本机安装时，工作台默认只听 `127.0.0.1`，第一个密码可以在本机页面「设置 → 远程」里设。
容器里没有这个「本机页面」：`-H 0.0.0.0` 之后，第一个远程访问只会看到「请设置访问密码」，
而**远程不能设第一个密码** —— 于是端口通了、页面却永远进不去。

所以入口脚本在缺密码时**直接带原因退出**，而不是让你对着一个 403 猜。
密码来源有两条，`AGENT_WEB_PASSWORD` 环境变量优先；`/data/password` 是兜底
（本机装过、把 `~/.oh-my-agent-web` 挂成 `/data` 时，密码跟着过来）。

## 镜像里有什么，没什么

| | |
|---|---|
| 有 | 本包全量（含 **pi** 引擎，`@earendil-works/pi-*` 是它的 dependencies）、git、tini |
| 没有 | Codex / Claude Code / opencode / DeepSeek Harness 的 CLI —— 这些引擎各自的 loop 是**外部程序**，镜像不替它们做主 |
| 数据 | `/data`（会话、设置、上传、日志），`VOLUME` 声明过，不挂也不丢在容器层之外 |
| 代码 | `/workspace`，以 `node`（uid 1000）身份跑 |

要别的引擎，就在镜像上再加一层（示例，按各家 CLI 的真实安装方式改）：

```dockerfile
FROM oh-my-agent-web:local
USER root
RUN npm install -g @openai/codex        # 只是举例：以 Codex 官方文档为准
USER node
```

装完在页面底部的引擎切换里就能看到它；能力矩阵会照实显示这个引擎能做什么
（`server/engine/registry.ts`），不拿 pi 的配置冒充。

## 更新

```bash
docker build --build-arg OH_MY_AGENT_WEB_VERSION=latest -t oh-my-agent-web:local .
docker rm -f aw && docker run ... # 用上面那条 run
```

容器里关掉了「发现新版要不要升级」的问答（`AGENT_WEB_UPDATE_CHECK=off`）——
镜像的版本由镜像决定，不该在容器里 `npm install -g` 自己改自己。

## 排错

- **`绑定 25257 失败`**：本机已经有 `aw` 在跑。`docker run -p 127.0.0.1:25258:25257` 换个端口。
- **健康检查一直 unhealthy**：`docker logs aw`。多半天真被 `AGENT_WEB_HOST` / `AGENT_WEB_PORT` 覆盖成了别的值（健康检查读的是同一个端口）。
- **`/workspace` 里写的文件属主是 1000**：容器以 uid 1000 跑。宿主机 uid 不是 1000 时，
  用 `--user "$(id -u):$(id -g)"` 起容器（要和 `docker/entrypoint.sh` 的可读权限对齐）。
- **终端打不开**：node-pty 在构建阶段编好；如果构建机是 arm64、运行机是 amd64（或反过来），
  原生模块会加载失败 —— 在目标架构上构建（`docker buildx build --platform`）。
