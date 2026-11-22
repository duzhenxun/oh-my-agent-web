#!/bin/sh
# 编译语音识别桥 → 一个最小的 .app bundle。
#
# 为什么不是裸 CLI（踩过）：TCC（隐私授权）要求**执行的那个东西**带
# NSSpeechRecognitionUsageDescription。把 plist 用 -sectcreate 塞进裸二进制
# 试过，仍然被判成「没有 usage description」直接 SIGABRT —— 因为从终端/服务
# 拉起时，责任主体不是那个二进制自己。做成 .app bundle 后就清楚了：
#   ASRBridge.app/Contents/Info.plist  +  Contents/MacOS/asr-bridge
# 再 ad-hoc 签名（codesign -s -），让它有一份**稳定的身份**：
# 不签的话每次重编译 TCC 都会当成新程序，又要重新授权一次。
#
# 用法：
#   ./build.sh             本机架构（开发用，几秒）
#   ./build.sh --release   通用二进制（arm64 + x86_64）+ 打 release/ASRBridge.zip
#
# 为什么要 --release 那一份：npm 的发布流水线跑在 ubuntu 上，**编不了 Swift**。
# 所以把编好的 zip 提交进仓库、随 npm 包一起发出去，用户那边「安装本地识别」
# 只是解压 + ad-hoc 验签，不需要装 Xcode 命令行工具（十来兆的东西，很多人没有）。
set -e
cd "$(dirname "$0")"

APP="ASRBridge.app"
BIN="$APP/Contents/MacOS/asr-bridge"
MODE="${1:-local}"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

# 最低 macOS 13：addsPunctuation（自动加标点）从 13 开始有，低了也能跑但没有标点
DEPLOY_TARGET="macos13.0"

if [ "$MODE" = "--release" ] || [ "$MODE" = "--universal" ]; then
	TMP="$(mktemp -d)"
	trap 'rm -rf "$TMP"' EXIT
	# 两个架构各编一次再 lipo：Intel Mac 上也要能跑（发布产物不能只服务 arm64）
	for arch in arm64 x86_64; do
		xcrun swiftc -O -target "$arch-apple-$DEPLOY_TARGET" main.swift -o "$TMP/asr-bridge-$arch"
	done
	lipo -create -output "$BIN" "$TMP/asr-bridge-arm64" "$TMP/asr-bridge-x86_64"
else
	xcrun swiftc -O main.swift -o "$BIN"
fi

# Info.plist 单独一份文件（不是 heredoc）：服务端的「安装」端点也要用它，
# 两处共用一个来源，改 plist 不会只改到一半。
cp Info.plist "$APP/Contents/Info.plist"

codesign --force --sign - "$APP" >/dev/null 2>&1 \
	|| echo "警告：ad-hoc 签名失败（不影响运行，但每次重编译 TCC 会重新问一次）"

echo "built: $(pwd)/$APP/Contents/MacOS/asr-bridge"

if [ "$MODE" = "--release" ]; then
	# ditto 而不是 zip：保住可执行位、符号链接和扩展属性（签名相关的东西在 _CodeSignature 里）
	mkdir -p release
	rm -f release/ASRBridge.zip
	ditto -c -k --keepParent "$APP" release/ASRBridge.zip
	echo "packed: $(pwd)/release/ASRBridge.zip（这个要提交进仓库，npm 包里带的就是它）"
fi
