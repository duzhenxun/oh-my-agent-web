#!/bin/sh
#
# oh-my-agent-web 一行安装器（macOS / Linux）
#
#   curl -fsSL https://raw.githubusercontent.com/duzhenxun/oh-my-agent-web/main/scripts/install.sh | sh
#
# 它做的事，按顺序：
#   1. 找一个够新的 Node（>= 22.19，pi 1.x 的硬要求）；没有就自己下官方包到 $OH_MY_AGENT_WEB_HOME/node；
#   2. Linux 上先查 node-pty 的编译三件套（它只给 macOS / Windows 带预编译产物）；
#   3. `npm install -g --prefix $OH_MY_AGENT_WEB_HOME` 装包（**不污染系统的全局 npm**，也不用 sudo）；
#   4. 把 aw / agent-web / oh-my-agent-web 挂到 ~/.local/bin（必要时补 PATH）；
#   5. 冒烟一次：版本号 + node-pty 能不能真的 require（终端能不能开）。
#
# 为什么不用 `npm i -g` 直接装：全局目录常常要 sudo，或者被 Homebrew / nvm 的 prefix 抢走，
# 装完 `aw` 不在 PATH 上。装到自己的 prefix 里，"升级 / 卸载 / 换 Node" 都只动一个目录。
#
# 环境变量（也可以走同名命令行选项）：
#   OH_MY_AGENT_WEB_VERSION        指定版本，默认 latest
#   OH_MY_AGENT_WEB_HOME           安装目录，默认 ~/.oh-my-agent-web（**就是数据目录**：装进去的 bin/ lib/ node/ 和 settings.json / uploads / logs 并排）
#   OH_MY_AGENT_WEB_REGISTRY       走镜像源，例如 https://registry.npmmirror.com
#   OH_MY_AGENT_WEB_NODE           复用已有的 node（给二进制路径，或它所在的 bin 目录）
#   OH_MY_AGENT_WEB_NODE_CHANNEL   需要自动装 Node 时用哪个通道，默认 v22.x
#   OH_MY_AGENT_WEB_NO_PATH=1      不碰 shell 配置、不建 ~/.local/bin 里的软链
#   OH_MY_AGENT_WEB_BUILD_TOOLS=1  Linux 上缺编译工具时尝试用 sudo 装（apt / dnf / apk / pacman）
#   OH_MY_AGENT_WEB_SKIP_BUILD_CHECK=1  Linux 上跳过编译工具检查（自己知道有工具链时用）
#
# 卸载：sh install.sh --uninstall   （只删装进去的包、bin 里的命令和 ~/.local/bin 里的软链；settings / 密码 / 上传 / 日志一律不动）

set -eu

PKG="oh-my-agent-web"
# @earendil-works/pi-* 1.x 用到 Node 22.19 才有的 API；低于它会在运行时炸，不该放进来
MIN_NODE="22.19.0"
NODE_CHANNEL="${OH_MY_AGENT_WEB_NODE_CHANNEL:-v22.x}"
HOMEDIR="${OH_MY_AGENT_WEB_HOME:-$HOME/.oh-my-agent-web}"
VERSION="${OH_MY_AGENT_WEB_VERSION:-latest}"
REGISTRY="${OH_MY_AGENT_WEB_REGISTRY:-}"
NO_PATH="${OH_MY_AGENT_WEB_NO_PATH:-0}"
BUILD_TOOLS="${OH_MY_AGENT_WEB_BUILD_TOOLS:-0}"
SKIP_BUILD_CHECK="${OH_MY_AGENT_WEB_SKIP_BUILD_CHECK:-0}"
DO_UNINSTALL=0

# ---------- 输出 ----------
# 走管道时 stdout 不是 tty，颜色码会变成乱码夹在日志里，所以只在终端里上色
if [ -t 1 ]; then
	BOLD=$(printf '\033[1m')
	DIM=$(printf '\033[2m')
	RED=$(printf '\033[31m')
	GRN=$(printf '\033[32m')
	YEL=$(printf '\033[33m')
	OFF=$(printf '\033[0m')
else
	BOLD=""
	DIM=""
	RED=""
	GRN=""
	YEL=""
	OFF=""
fi

say() { printf '%s\n' "$*"; }
step() { printf '%s==>%s %s\n' "$BOLD" "$OFF" "$*"; }
ok() { printf '  %s✓%s %s\n' "$GRN" "$OFF" "$*"; }
warn() { printf '  %s!%s %s\n' "$YEL" "$OFF" "$*" >&2; }
die() {
	printf '%s安装中止：%s%s\n' "$RED" "$OFF" "$*" >&2
	exit 1
}

usage() {
	cat <<EOF
用法: install.sh [选项]

选项:
  --version <v>        指定版本（默认 latest）
  --home <dir>         安装目录（默认 ~/.oh-my-agent-web，与数据目录同一个）
  --registry <url>     npm 源（默认用你本机的 npm 配置）
  --no-modify-path     不改 shell 配置、不建 ~/.local/bin 软链
  --with-build-tools   Linux 缺编译工具时用 sudo 装
  --skip-build-check   Linux 跳过编译工具检查
  --uninstall          卸载（只删装进去的包与命令；数据目录里的配置/上传不动）
  -h, --help           显示本帮助

也可以直接用环境变量（同名，OH_MY_AGENT_WEB_ 前缀），例如：
  curl -fsSL .../install.sh | OH_MY_AGENT_WEB_VERSION=0.6.0 sh
EOF
}

while [ $# -gt 0 ]; do
	case "$1" in
		--version | -v)
			VERSION="${2:-}"
			[ -n "$VERSION" ] || die "--version 需要一个值"
			shift 2
			;;
		--home)
			HOMEDIR="${2:-}"
			[ -n "$HOMEDIR" ] || die "--home 需要一个值"
			shift 2
			;;
		--registry)
			REGISTRY="${2:-}"
			[ -n "$REGISTRY" ] || die "--registry 需要一个值"
			shift 2
			;;
		--no-modify-path) NO_PATH=1; shift ;;
		--with-build-tools) BUILD_TOOLS=1; shift ;;
		--skip-build-check) SKIP_BUILD_CHECK=1; shift ;;
		--uninstall) DO_UNINSTALL=1; shift ;;
		-h | --help) usage; exit 0 ;;
		*) die "不认识的选项：$1（--help 看用法）" ;;
	esac
done

BIN_DIR="$HOMEDIR/bin"
ENTRY="$BIN_DIR/aw"
LOCAL_BIN="$HOME/.local/bin"

# ---------- 小工具 ----------
fetch() { # fetch <url> <输出文件>
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL --retry 2 --connect-timeout 15 "$1" -o "$2"
	elif command -v wget >/dev/null 2>&1; then
		wget -q -T 20 -O "$2" "$1"
	else
		die "需要 curl 或 wget 才能下载（装一个再试）"
	fi
}

sha256_of() { # 各平台的 sha256 工具名不一样，挨个试
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d' ' -f1
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | cut -d' ' -f1
	elif command -v openssl >/dev/null 2>&1; then
		openssl dgst -sha256 "$1" | awk '{print $NF}'
	else
		return 1
	fi
}

# semver 比较：$1 >= $2 返回 0（不用 sort -V —— macOS 的 sort 没有这个）
semver_ge() {
	awk -v a="$1" -v b="$2" 'BEGIN{
		n = split(a, x, "."); m = split(b, y, ".");
		len = (n > m) ? n : m;
		for (i = 1; i <= len; i++) {
			ai = (i <= n) ? x[i] : 0; bi = (i <= m) ? y[i] : 0;
			ai += 0; bi += 0;
			if (ai > bi) exit 0;
			if (ai < bi) exit 1;
		}
		exit 0;
	}'
}

node_version_of() { # 打出来的可能是 v22.19.0 或 22.19.0
	"$1" -v 2>/dev/null | sed 's/^v//'
}

# musl（Alpine 之类）装不了官方 glibc 包：先认出来，别下完才炸
is_musl() {
	[ "$(uname -s)" = "Linux" ] || return 1
	(ldd --version 2>&1 || true) | head -1 | grep -qi musl
}

# ---------- 1. Node ----------
ensure_node() {
	# (a) 用户指了就用他的
	if [ -n "${OH_MY_AGENT_WEB_NODE:-}" ]; then
		cand="$OH_MY_AGENT_WEB_NODE"
		# 允许给二进制路径，也允许给目录（`set -e` 下别用 `[ ] &&`，条件为假会把脚本带走）
		if [ -d "$cand" ]; then cand="$cand/node"; fi
		[ -x "$cand" ] || die "OH_MY_AGENT_WEB_NODE 指向的 node 不可执行：$OH_MY_AGENT_WEB_NODE"
		NODE_BIN="$cand"
		NPM_BIN="$(dirname "$cand")/npm"
		[ -x "$NPM_BIN" ] || NPM_BIN="$(command -v npm || true)"
		[ -n "$NPM_BIN" ] || die "OH_MY_AGENT_WEB_NODE 旁边没有 npm（需要 node 与 npm 同一个 prefix）"
		return 0
	fi

	# (b) 上次装到 $OH_MY_AGENT_WEB_HOME/node 里的那份
	if [ -x "$HOMEDIR/node/bin/node" ]; then
		NODE_BIN="$HOMEDIR/node/bin/node"
		NPM_BIN="$HOMEDIR/node/bin/npm"
		return 0
	fi

	# (c) 系统里的
	if command -v node >/dev/null 2>&1; then
		NODE_BIN="$(command -v node)"
		NPM_BIN="$(command -v npm || true)"
		if [ -n "$NPM_BIN" ]; then
			have="$(node_version_of "$NODE_BIN")"
			if semver_ge "$have" "$MIN_NODE"; then
				ok "用系统 Node v${have}（${NODE_BIN}）"
				return 0
			fi
			warn "系统 Node v$have 太老（要 >= ${MIN_NODE}），改装一个独立副本"
		else
			warn "有 node 但没有 npm（Homebrew 的 node 包不带 npm 时会这样），改装一个独立副本"
		fi
	fi

	install_standalone_node
}

install_standalone_node() {
	if is_musl; then
		die "这台机器是 musl libc（Alpine 之类），官方 Node 包跑不了。
  先装 Node 再回来（会复用你的 Node）：
    apk add nodejs npm
    curl -fsSL .../install.sh | sh"
	fi

	os="$(uname -s)"
	arch="$(uname -m)"
	case "$os" in
		Darwin) plat="darwin" ;;
		Linux) plat="linux" ;;
		*) die "不支持的系统：${os}（Windows 请用 PowerShell 版：install.ps1）" ;;
	esac
	case "$arch" in
		x86_64 | amd64) cpu="x64" ;;
		arm64 | aarch64) cpu="arm64" ;;
		armv7l) cpu="armv7l" ;;
		ppc64le) cpu="ppc64le" ;;
		s390x) cpu="s390x" ;;
		*) die "不支持的架构：$arch" ;;
	esac

	step "下载 Node（$NODE_CHANNEL / $plat-${cpu}）到 $HOMEDIR/node"
	tmp="$(mktemp -d)"
	trap 'rm -rf "$tmp"' EXIT INT TERM

	shasums="$tmp/SHASUMS256.txt"
	fetch "https://nodejs.org/dist/latest-$NODE_CHANNEL/SHASUMS256.txt" "$shasums" ||
		die "取不到 Node 的校验清单（网络？代理？）"
	file="$(awk -v suffix="-$plat-$cpu.tar.gz" 'index($2, suffix) { print $2; exit }' "$shasums")"
	[ -n "$file" ] || die "校验清单里没有 $plat-$cpu 的包（这个平台官方不发 tar.gz）"
	expect="$(awk -v name="$file" '$2 == name { print $1; exit }' "$shasums")"

	tarball="$tmp/$file"
	step "下载 $file"
	fetch "https://nodejs.org/dist/latest-$NODE_CHANNEL/$file" "$tarball" || die "下载失败：$file"
	actual="$(sha256_of "$tarball" || true)"
	if [ -n "$actual" ]; then
		[ "$actual" = "$expect" ] || die "校验不通过（期望 ${expect}，实际 ${actual}），已中止"
		ok "sha256 校验通过"
	else
		warn "这台机器没有 sha256 工具（sha256sum / shasum / openssl），跳过校验"
	fi

	tar -xzf "$tarball" -C "$tmp" || die "解压失败"
	rm -rf "$HOMEDIR/node"
	mkdir -p "$HOMEDIR"
	mv "$tmp"/node-v* "$HOMEDIR/node" || die "展开 Node 失败"
	NODE_BIN="$HOMEDIR/node/bin/node"
	NPM_BIN="$HOMEDIR/node/bin/npm"
	ok "Node $(node_version_of "$NODE_BIN") 就绪"
}

# ---------- 2. Linux 编译工具（node-pty 只给 macOS / Windows 带预编译产物）----------
check_build_tools() {
	[ "$(uname -s)" = "Linux" ] || return 0
	if [ "$SKIP_BUILD_CHECK" = "1" ]; then return 0; fi

	missing=""
	command -v make >/dev/null 2>&1 || missing="$missing make"
	command -v python3 >/dev/null 2>&1 || missing="$missing python3"
	if ! command -v c++ >/dev/null 2>&1 && ! command -v g++ >/dev/null 2>&1; then
		missing="$missing g++"
	fi
	[ -n "$missing" ] || return 0

	if [ "$BUILD_TOOLS" = "1" ]; then
		step "装编译工具（$missing ）"
		sudo=""
		[ "$(id -u)" = "0" ] || sudo="sudo"
		if command -v apt-get >/dev/null 2>&1; then
			$sudo apt-get update && $sudo apt-get install -y build-essential python3
		elif command -v dnf >/dev/null 2>&1; then
			$sudo dnf install -y gcc-c++ make python3
		elif command -v yum >/dev/null 2>&1; then
			$sudo yum install -y gcc-c++ make python3
		elif command -v apk >/dev/null 2>&1; then
			$sudo apk add --no-cache build-base python3 linux-headers
		elif command -v pacman >/dev/null 2>&1; then
			$sudo pacman -S --needed --noconfirm base-devel python
		else
			die "认不出包管理器，请手动装：make / python3 / g++"
		fi
		return 0
	fi

	die "缺编译工具：$missing
  node-pty 只给 macOS / Windows 带预编译产物，Linux 上要就地编译 PTY。
  装上它们再重跑（或者由本脚本代劳）：
    Debian/Ubuntu:  sudo apt-get install -y build-essential python3
    Fedora/RHEL:    sudo dnf install -y gcc-c++ make python3
    Alpine:         sudo apk add build-base python3 linux-headers
    Arch:           sudo pacman -S --needed base-devel python
  或直接：curl -fsSL .../install.sh | sh -s -- --with-build-tools"
}

# ---------- 3. 装包 ----------
install_pkg() {
	step "安装 $PKG@$VERSION 到 $HOMEDIR"
	mkdir -p "$HOMEDIR"
	# --prefix 让 bins 落在 $HOMEDIR/bin、包本体落在 $HOMEDIR/lib/node_modules：
	# 系统 npm 的全局目录（可能要 sudo、可能被 nvm/Homebrew 抢）一概不碰。
	set -- install --global --prefix "$HOMEDIR" --no-audit --no-fund "$PKG@$VERSION"
	if [ -n "$REGISTRY" ]; then set -- "$@" --registry "$REGISTRY"; fi
	# 先落盘再过滤（不用管道：`set -e` 看的是管道末端的退出码，npm 失败会被吞掉）
	npmlog="$(mktemp)"
	if ! "$NPM_BIN" "$@" >"$npmlog" 2>&1; then
		cat "$npmlog"
		rm -f "$npmlog"
		die "npm 安装失败（看上面 npm 的报错；网络/镜像源问题见 README「装不上时按这个顺序排查」）"
	fi
	folded=$(grep -c 'npm warn deprecated' "$npmlog" || true)
	grep -v 'npm warn deprecated' "$npmlog" | sed '/^[[:space:]]*$/d' || true
	rm -f "$npmlog"
	if [ "${folded:-0}" -gt 0 ]; then
		ok "已折起 $folded 条「依赖已弃用」提醒（都是间接依赖，不影响使用）"
	fi
	[ -x "$ENTRY" ] || die "装完了但没找到 ${ENTRY}（npm 版本太老？npm >= 9 才支持 --prefix + -g 装 bin）"
	ok "已装到 $HOMEDIR"
}

# ---------- 4. PATH ----------
link_entry() {
	if [ "$NO_PATH" = "1" ]; then return 0; fi
	mkdir -p "$LOCAL_BIN"
	for name in aw agent-web oh-my-agent-web; do
		if [ -e "$BIN_DIR/$name" ]; then ln -sf "$BIN_DIR/$name" "$LOCAL_BIN/$name"; fi
	done
	ok "软链：$LOCAL_BIN/aw → $ENTRY"

	case ":$PATH:" in
		*":$LOCAL_BIN:"*) return 0 ;;
	esac

	shell_name="$(basename "${SHELL:-sh}")"
	case "$shell_name" in
		fish) rc="$HOME/.config/fish/config.fish"; line="fish_add_path $LOCAL_BIN" ;;
		zsh) rc="${ZDOTDIR:-$HOME}/.zshrc"; line="export PATH=\"$LOCAL_BIN:\$PATH\"" ;;
		*) rc="$HOME/.bashrc"; line="export PATH=\"$LOCAL_BIN:\$PATH\"" ;;
	esac
	mkdir -p "$(dirname "$rc")" 2>/dev/null || true
	if [ -f "$rc" ] && grep -F "$LOCAL_BIN" "$rc" >/dev/null 2>&1; then
		ok "$rc 里已经有 PATH 了"
	else
		printf '\n# oh-my-agent-web\n%s\n' "$line" >>"$rc"
		ok "已把 $LOCAL_BIN 写进 ${rc}（新开终端生效）"
	fi
}

# ---------- 5. 冒烟 ----------
verify() {
	step "自检"
	ver="$("$ENTRY" version 2>&1 | head -1)" || die "跑不起来：$ENTRY version → $ver"
	ok "$ver"

	# node-pty 是原生模块（终端全靠它）：require 不通就是「装了也开不了终端」，
	# 这一步提前问清楚，比等用户点开终端看红字好。
	pkgroot="$HOMEDIR/lib/node_modules/$PKG"
	if [ -d "$pkgroot/node_modules/node-pty" ]; then
		if ! (cd "$pkgroot" && "$NODE_BIN" -e "require('node-pty')" >/dev/null 2>&1); then
			warn "node-pty 加载失败：终端会开不起来（对话与文件管理不受影响）"
			warn "修：$NPM_BIN rebuild --prefix $HOMEDIR node-pty    （或先装好 make / g++ / python3）"
			return 0
		fi
		ok "node-pty 可用（终端能开）"
	fi
}

uninstall() {
	step "卸载"
	# 只删「装进去的东西」：默认 prefix 就是数据目录（~/.oh-my-agent-web），
	# 里面还躺着 settings.json / password / uploads / logs —— 整目录 rm -rf 会连配置和上传一起干掉。
	rm -rf "$HOMEDIR/lib/node_modules/$PKG"
	rm -rf "$HOMEDIR/node"            # 安装器自己下的那份 Node（用系统 Node 时本来就不存在）
	for name in aw agent-web oh-my-agent-web; do
		rm -f "$HOMEDIR/bin/$name"
		rm -f "$LOCAL_BIN/$name"
	done
	# bin / lib 空了就顺手收掉，别在数据目录里留两个空壳
	rmdir "$HOMEDIR/bin" "$HOMEDIR/lib/node_modules" "$HOMEDIR/lib" 2>/dev/null || true
	ok "已删除装进去的 ${PKG}、$HOMEDIR/bin 下的命令与 $LOCAL_BIN 下的软链"
	say "  数据目录没动：settings.json / password / uploads / logs 都还在（不要了就 rm -rf ${HOMEDIR}）"
}

main() {
	say ""
	say "  ${BOLD}oh-my-agent-web${OFF} ${DIM}安装器 · $(uname -s) $(uname -m)${OFF}"
	say ""

	if [ "$DO_UNINSTALL" = "1" ]; then
		uninstall
		exit 0
	fi

	step "检查 Node（>= ${MIN_NODE}）"
	ensure_node
	ok "node $(node_version_of "$NODE_BIN") · npm $("$NPM_BIN" -v 2>/dev/null || echo '?')"

	check_build_tools
	install_pkg
	link_entry
	verify

	say ""
	say "  ${GRN}装好了。${OFF}"
	say ""
	if [ "$NO_PATH" = "1" ]; then
		say "  启动：$ENTRY                      （前台；Ctrl-C 退出）"
		say "        $ENTRY                    （后台；日志在 ~/.oh-my-agent-web/daemon.log）"
	else
		say "  新开一个终端，然后："
		say "        aw                        （后台运行并打开页面；日志在 ~/.oh-my-agent-web/daemon.log）"
		say "        aw -f                     （前台；Ctrl-C 退出）"
	fi
	say ""
	say "  然后打开 ${BOLD}http://127.0.0.1:25257${OFF}"
	say "  ${DIM}常用：aw status · aw restart · aw stop · aw upgrade · aw --help${OFF}"
	say ""
}

main
