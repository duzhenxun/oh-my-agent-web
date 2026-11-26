#!/bin/bash
# 把 SwiftPM 产物打成一个最小 .app：面板和 paths.ts 都按这个路径找 helper。
#
#   ./scripts/build-app.sh              # 构建 + 打到 dist/
#   ./scripts/build-app.sh --install    # 再装到 /Applications（不可写时退到 ~/Applications）
#
# 用 ad-hoc 签名（本机自用足够）。注意：重编译后 cdhash 变化，
# 「辅助功能」授权可能需要重新勾一次 —— 这不是 bug，是 TCC 按签名记账。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
app_name="Agent Computer"
bundle_id="com.computeruseturbo.minhelper"
dist="$root/dist"
app="$dist/$app_name.app"

echo "==> 构建（release）"
cd "$root"
swift build -c release
binary="$(swift build -c release --show-bin-path)/AgentComputer"

# 内嵌用的裸二进制：oh-my-agent-web.app 直接 spawn 它，用 stdio 帧通信，
# 用户不再需要单独安装 Agent Computer.app。只拷 binary，不带 .app / zip。
release_dir="$root/release"
mkdir -p "$release_dir"
write_embedded_binary() {
	cp "$binary" "$release_dir/agent-computer"
	chmod +x "$release_dir/agent-computer"
	echo "==> 内嵌二进制：$release_dir/agent-computer"
}

echo "==> 组装 $app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$binary" "$app/Contents/MacOS/AgentComputer"
cp "$root/Resources/Info.plist" "$app/Contents/Info.plist"

# 图标：没有或源码更新过就重新生成（生成一次约 1 秒）
if [[ ! -f "$root/Resources/AppIcon.icns" || "$root/scripts/make-icon.swift" -nt "$root/Resources/AppIcon.icns" ]]; then
	echo "==> 生成图标"
	swift "$root/scripts/make-icon.swift" "$root/Resources/AppIcon.icns" >/dev/null
fi
cp "$root/Resources/AppIcon.icns" "$app/Contents/Resources/AppIcon.icns"

# 签名身份：优先用本机已有的代码签名证书（Apple Development / Developer ID）。
# 为什么不用 ad-hoc：ad-hoc 每次重编译 CDHash 都变，macOS 会当成新程序，
# 之前授予的「辅助功能 / 屏幕录制」就失效，用户得反复勾选。
# 用固定证书后，code requirement 不变，授权可以长期有效。
sign_identity="${CUT_SIGN_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' 'NR==1{print $2}')}"
if [[ -n "$sign_identity" ]]; then
	echo "==> 签名（${sign_identity}）"
	codesign --force --sign "$sign_identity" --identifier "$bundle_id" --timestamp=none "$app" >/dev/null
else
	echo "==> 签名（ad-hoc；找不到证书，重编译后需要重新授权）"
	codesign --force --sign - --identifier "$bundle_id" --timestamp=none "$app" >/dev/null
fi
codesign --verify --verbose=1 "$app" 2>&1 | sed 's/^/    /'
echo "    版本：$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")"

if [[ "${1:-}" == "--install" ]]; then
	# 默认装到 /Applications：Finder 边栏的「应用程序」就是它，
	# 装到 ~/Applications 用户根本找不到（默认不显示）。
	if [[ -w /Applications ]]; then
		target="/Applications/$app_name.app"
	else
		target="$HOME/Applications/$app_name.app"
		mkdir -p "$HOME/Applications"
	fi
	echo "==> 安装到 $target"
	# 先停掉正在跑的旧实例，否则替换中途会留下半新半旧的进程
	pkill -f "$target/Contents/MacOS/AgentComputer" 2>/dev/null || true
	# 二进制没变就别重装：ad-hoc 签名下重装会换指纹，导致用户得重新授权一次
	if [[ -d "$target" ]]; then
		old_hash="$(codesign -dv --verbose=4 "$target" 2>&1 | awk -F= '/^CDHash=/{print $2}')"
		new_hash="$(codesign -dv --verbose=4 "$app" 2>&1 | awk -F= '/^CDHash=/{print $2}')"
		if [[ -n "$old_hash" && "$old_hash" == "$new_hash" ]]; then
			echo "    二进制没变，跳过替换（避免让系统重新要求授权）"
			# 注意这里会 exit 0：内嵌二进制仍然要更新，否则 release/ 会停在旧版本
			write_embedded_binary
			# 分发用 zip：放进仓库，前端「未安装」时直接给下载链接。
# 用 ditto（不是 zip 命令）：它能保留 .app 的可执行权限、签名和资源分支。
release_dir="$root/release"
mkdir -p "$release_dir"
echo "==> 打包分发 zip"
rm -f "$release_dir/Agent Computer.zip"
ditto -c -k --keepParent "$app" "$release_dir/Agent Computer.zip"
echo "    大小：$(du -h "$release_dir/Agent Computer.zip" | cut -f1)"

echo "==> 产物：$app"
			exit 0
		fi
		echo "    注意：二进制变了，签名指纹会变；如果之前授权失效，重新在系统设置里勾一次"
	fi
	rm -rf "$target"
	cp -R "$app" "$target"
	chmod -R u+w "$target"
	echo "    完成。启动：open -a \"$target\""
	# Finder 会缓存旧图标；碰一下 bundle 让它重读
	touch "$target"
	echo "    权限：系统设置 → 隐私与安全性 → 辅助功能 / 屏幕录制，勾上「${app_name}」"
fi

# 分发用 zip：放进仓库，前端「未安装」时直接给下载链接。
# 用 ditto（不是 zip 命令）：它能保留 .app 的可执行权限、签名和资源分支。
release_dir="$root/release"
mkdir -p "$release_dir"
echo "==> 打包分发 zip"
rm -f "$release_dir/Agent Computer.zip"
ditto -c -k --keepParent "$app" "$release_dir/Agent Computer.zip"
echo "    大小：$(du -h "$release_dir/Agent Computer.zip" | cut -f1)"

echo "==> 产物：$app"

write_embedded_binary
