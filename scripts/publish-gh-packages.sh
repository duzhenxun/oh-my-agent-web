#!/usr/bin/env bash
# 把 npm 上**已经发布**的某个版本，原样镜像一份到 GitHub Packages。
#
# 为什么要在临时目录里改包名：
#   GitHub Packages 要求包名是 @OWNER/name —— 这里得是 @duzhenxun/oh-my-agent-web；
#   而 npm 上它叫 oh-my-agent-web。直接把仓库里的 package.json 改名，会把 npm 那条
#   发布线一起改掉（而且是个破坏性改名）。所以这里：下载 npm 上的 tarball →
#   解包 → 只在临时目录里改 name / publishConfig → 发 → 临时目录整个删掉。
#   **仓库里的 package.json 一个字都不动**，npm 发布流程完全不受影响。
#
# 用法：
#   scripts/publish-gh-packages.sh               # 发 package.json 里的版本
#   scripts/publish-gh-packages.sh 0.1.4         # 发指定版本（必须已在 npm 上）
#   scripts/publish-gh-packages.sh --dry-run     # 只准备、不真发，打印将要发什么
#
# 凭证（二选一）：
#   export GITHUB_PACKAGES_TOKEN=ghp_xxx         # classic PAT，勾上 write:packages
#   gh auth refresh -h github.com -s write:packages   # 之后本脚本自动取 `gh auth token`
#
# 注意：`gh auth login` 的默认 scope 里**没有** packages，必须 refresh 一次，
# 否则发布时报 403。--dry-run 不需要任何凭证。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OWNER="duzhenxun"                                  # 必须等于仓库 owner（GitHub Packages 的硬规则）
NPM_NAME="oh-my-agent-web"                               # npm 上的名字（不带 scope）
GH_NAME="@${OWNER}/${NPM_NAME}"                    # GitHub Packages 上的名字
GH_REGISTRY="https://npm.pkg.github.com"
NPM_REGISTRY="https://registry.npmjs.org"

DRY_RUN=0
VERSION=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "未知参数：$arg" >&2; exit 2 ;;
    *) VERSION="$arg" ;;
  esac
done

if [ -z "$VERSION" ]; then
  VERSION="$(cd "$REPO_ROOT" && node -p "require('./package.json').version")"
fi

echo "→ 镜像 ${NPM_NAME}@${VERSION} 为 ${GH_NAME}@${VERSION}"

TOKEN="${GITHUB_PACKAGES_TOKEN:-}"
if [ -z "$TOKEN" ] && command -v gh >/dev/null 2>&1; then
  TOKEN="$(gh auth token 2>/dev/null || true)"
fi
if [ -z "$TOKEN" ] && [ "$DRY_RUN" -eq 0 ]; then
  cat >&2 <<'EOF'
✗ 没有可用的凭证。二选一：
    export GITHUB_PACKAGES_TOKEN=<classic PAT，勾 write:packages>
    gh auth refresh -h github.com -s write:packages
EOF
  exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/oh-my-agent-web-ghp.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

# 1. 取 npm 上已发布的 tarball（不本地构建：保证两边内容一模一样）
echo "→ 从 npm 取 tarball"
(cd "$WORK" && npm pack "${NPM_NAME}@${VERSION}" \
  --registry "$NPM_REGISTRY" --pack-destination "$WORK" --silent >/dev/null)
TGZ="$(ls "$WORK"/*.tgz | head -1)"
echo "  $(basename "$TGZ")"

# 2. 解包
mkdir -p "$WORK/out"
tar xzf "$TGZ" -C "$WORK/out"
SRC="$WORK/out/package"
[ -f "$SRC/package.json" ] || { echo "✗ 解包后没找到 package.json" >&2; exit 1; }

# 3. 只改临时目录里那份 package.json：名字带 scope、指定 registry
GH_NAME="$GH_NAME" GH_REGISTRY="$GH_REGISTRY" node -e '
const fs = require("fs");
const file = process.argv[1];
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
pkg.name = process.env.GH_NAME;
pkg.publishConfig = { ...(pkg.publishConfig || {}), registry: process.env.GH_REGISTRY, access: "public" };
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
' "$SRC/package.json"

echo "  临时 package.json → name=${GH_NAME} version=${VERSION} registry=${GH_REGISTRY}"

# 4. 写临时 .npmrc（600，随目录删除）；@scope 的 registry 也一起指过去
if [ -n "$TOKEN" ]; then
  (umask 077 && printf '@%s:registry=%s\n//npm.pkg.github.com/:_authToken=%s\n' \
    "$OWNER" "$GH_REGISTRY" "$TOKEN" > "$SRC/.npmrc")
fi

# 5. 先看这个版本是不是已经发过了 —— 重跑不该报红
if [ -n "$TOKEN" ]; then
  if (cd "$SRC" && npm view "${GH_NAME}@${VERSION}" version \
      --registry "$GH_REGISTRY" >/dev/null 2>&1); then
    echo "✓ ${GH_NAME}@${VERSION} 已在 GitHub Packages 上，跳过"
    exit 0
  fi
fi

# 6. 发布。--ignore-scripts 是必须的：tarball 里的 package.json 带着
#    `prepack: npm run build`，而这里没有源码也没有 node_modules，
#    不忽略脚本就会去跑构建然后失败。
ARGS=(publish --registry "$GH_REGISTRY" --access public --ignore-scripts)
if [ "$DRY_RUN" -eq 1 ]; then
  ARGS+=(--dry-run)
  echo "→ dry-run：只准备，不发"
fi

(cd "$SRC" && npm "${ARGS[@]}")

if [ "$DRY_RUN" -eq 0 ]; then
  cat <<EOF

✓ 已发布到 GitHub Packages：${GH_NAME}@${VERSION}

两件事要手动做（GitHub 没有对应 API）：
  1. 首次发布出来的包默认是 **private**，去改成 public：
     https://github.com/users/${OWNER}/packages/npm/${NPM_NAME}/settings
  2. 装的时候要带 scope 并指 registry（GitHub Packages 连公开包都要求 token）：
     npm install -g ${GH_NAME} --registry=${GH_REGISTRY}
EOF
fi
