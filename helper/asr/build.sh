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
set -e
cd "$(dirname "$0")"

APP="ASRBridge.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

xcrun swiftc -O main.swift -o "$APP/Contents/MacOS/asr-bridge"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>asr-bridge</string>
	<key>CFBundleIdentifier</key>
	<string>web.ohmyagent.asr-bridge</string>
	<key>CFBundleName</key>
	<string>ASRBridge</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<!-- 后台小工具：不出现在 Dock / 应用切换器里 -->
	<key>LSUIElement</key>
	<true/>
	<key>NSSpeechRecognitionUsageDescription</key>
	<string>oh-my-agent-web 用系统自带的离线语音识别，把你说的话转成输入框里的文字（不联网）。</string>
</dict>
</plist>
PLIST

codesign --force --sign - "$APP" >/dev/null 2>&1 || echo "警告：ad-hoc 签名失败（不影响运行，但每次重编译 TCC 会重新问一次）"
echo "built: $(pwd)/$APP/Contents/MacOS/asr-bridge"
