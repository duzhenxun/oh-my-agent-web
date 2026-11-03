# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# oh-my-agent-web 的容器镜像
#
# 目标：一条命令就能看它长什么样，不用先在本机装 Node 22.19+、再编 node-pty。
# 取舍（和 README 里那套本机安装的关系）：
#   - **同一个包**，从 npm 装（不是从仓库源码构建），版本可钉：--build-arg OH_MY_AGENT_WEB_VERSION=1.1.0
#   - 镜像里只带 **pi 引擎**（它的 SDK 是本包的 dependencies，装上就有）；
#     Codex / Claude Code / opencode / DeepSeek Harness 要各自装 CLI —— 见 docs/docker.md
#   - 数据目录 `/data`，代码目录 `/workspace`，都用 volume / bind mount 挂进来
#
# 为什么构建在 `node` 用户下做：`aw` 启动时会把 node-pty 里非本平台的预编译产物裁掉
# （server/util/prune-pty.ts，幂等、失败不影响启动）。装到 root 名下会让这一步在运行时
# 撞 EACCES，于是日志里多一条没用的噪音 —— 干脆让 /opt/aw 从一开始就属于 uid 1000。
# ─────────────────────────────────────────────────────────────────────────────

# ── 构建阶段：装包（含 node-pty 的 Linux 原生编译，要 python3/make/g++） ──
FROM node:22-bookworm-slim AS build

RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

ARG OH_MY_AGENT_WEB_VERSION=latest

ENV npm_config_prefix=/opt/aw \
	npm_config_fund=false \
	npm_config_audit=false

RUN mkdir -p /opt/aw && chown node:node /opt/aw

USER node

# 不用 --ignore-scripts：node-pty 是原生模块，必须让它编译（镜像是可信构建环境，没有 npm 11 那条 allow-scripts 顾虑）
RUN npm install -g "oh-my-agent-web@${OH_MY_AGENT_WEB_VERSION}"

# ── 运行阶段：只要 node + 编好的包 ──
FROM node:22-bookworm-slim

# tini：转 SIGTERM、回收子进程（终端与子代理会拉一串子进程，直接当 1 号进程容易留僵尸）
# git：文件面板的改动列表 / diff 要靠它
RUN apt-get update \
	&& apt-get install -y --no-install-recommends tini git ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=build --chown=node:node /opt/aw /opt/aw
COPY --chown=node:node --chmod=755 docker/entrypoint.sh /usr/local/bin/docker-entrypoint.sh

ENV PATH=/opt/aw/bin:$PATH \
	AGENT_WEB_DATA_DIR=/data \
	AGENT_WEB_HOST=0.0.0.0 \
	AGENT_WEB_PORT=25257 \
	AGENT_WEB_UPDATE_CHECK=off \
	AGENT_WEB_UPDATE_PROMPT=off \
	HOME=/home/node

RUN mkdir -p /data /workspace && chown node:node /data /workspace

USER node
WORKDIR /workspace

VOLUME ["/data"]
EXPOSE 25257

# 探活走 /api/health（不鉴权）；用 node 自带的 fetch，镜像里不额外装 curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:'+(process.env.AGENT_WEB_PORT||25257)+'/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["aw"]
