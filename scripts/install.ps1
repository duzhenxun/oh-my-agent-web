<#
  oh-my-agent-web 一行安装器（Windows / PowerShell）

    powershell -c "irm https://raw.githubusercontent.com/duzhenxun/oh-my-agent-web/main/scripts/install.ps1 | iex"

  和 install.sh 做同一件事：
    1. 找一个够新的 Node（>= 22.19，pi 1.x 的硬要求）；没有就下官方 zip 到 $HOME\.oh-my-agent-web\node；
    2. `npm install -g --prefix $HOME\.oh-my-agent-web` 装包（不碰系统全局 npm，不需要管理员权限）；
    3. 把 $HOME\.oh-my-agent-web 加进「用户 PATH」（-NoPath 可关）；
    4. 冒烟一次：版本号 + node-pty 能不能 load（终端能不能开）。

  为什么不用 param() 块：`irm | iex` 是把脚本文本直接交给表达式求值，param() 在那儿不合法。
  所以配置一律走环境变量，在同一个命令里带着就行：

    $env:OH_MY_AGENT_WEB_VERSION='0.6.0'
    powershell -c "irm .../install.ps1 | iex"

  环境变量：
    OH_MY_AGENT_WEB_VERSION        指定版本，默认 latest
    OH_MY_AGENT_WEB_HOME           安装目录，默认 $HOME\.oh-my-agent-web（就是数据目录：装进去的包/命令与 settings.json / uploads / logs 并排）
    OH_MY_AGENT_WEB_REGISTRY       npm 源，例如 https://registry.npmmirror.com
    OH_MY_AGENT_WEB_NODE           复用已有 node（node.exe 的路径，或它所在目录）
    OH_MY_AGENT_WEB_NODE_CHANNEL   自动装 Node 时用哪个通道，默认 v22.x
    OH_MY_AGENT_WEB_NO_PATH=1      不动 PATH
    OH_MY_AGENT_WEB_UNINSTALL=1    卸载（只删安装目录，数据目录不动）
#>

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 默认还是 TLS 1.0/1.1，连 nodejs.org 与 registry 都会直接失败
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

$Pkg = 'oh-my-agent-web'
# @earendil-works/pi-* 1.x 用到 Node 22.19 才有的 API；低于它运行时会炸，不该放进来
$MinNode = '22.19.0'
$NodeChannel = if ($env:OH_MY_AGENT_WEB_NODE_CHANNEL) { $env:OH_MY_AGENT_WEB_NODE_CHANNEL } else { 'v22.x' }
$HomeDir = if ($env:OH_MY_AGENT_WEB_HOME) { $env:OH_MY_AGENT_WEB_HOME } else { Join-Path $HOME '.oh-my-agent-web' }
$Version = if ($env:OH_MY_AGENT_WEB_VERSION) { $env:OH_MY_AGENT_WEB_VERSION } else { 'latest' }
$Registry = $env:OH_MY_AGENT_WEB_REGISTRY
$NoPath = $env:OH_MY_AGENT_WEB_NO_PATH -eq '1'
$DoUninstall = $env:OH_MY_AGENT_WEB_UNINSTALL -eq '1'

function Write-Step($text) { Write-Host "==> $text" -ForegroundColor White }
function Write-Ok($text) { Write-Host "  ✓ $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "  ! $text" -ForegroundColor Yellow }
function Fail($text) {
	Write-Host "安装中止：$text" -ForegroundColor Red
	exit 1
}

function Get-SemverTuple($value) {
	# '22.19.0' → @(22,19,0)；非数字段当 0（'22.19.0-nightly' 这种也认）
	$parts = ($value -replace '^v', '') -split '\.'
	$nums = @()
	foreach ($part in $parts) {
		$digits = [regex]::Match($part, '^\d+').Value
		$nums += if ($digits) { [int]$digits } else { 0 }
	}
	return $nums
}

function Test-SemverAtLeast($have, $want) {
	$a = Get-SemverTuple $have
	$b = Get-SemverTuple $want
	$len = [Math]::Max($a.Count, $b.Count)
	for ($i = 0; $i -lt $len; $i++) {
		$ai = if ($i -lt $a.Count) { $a[$i] } else { 0 }
		$bi = if ($i -lt $b.Count) { $b[$i] } else { 0 }
		if ($ai -gt $bi) { return $true }
		if ($ai -lt $bi) { return $false }
	}
	return $true
}

function Get-NodeVersion($exe) {
	try { return ((& $exe -v) -replace '^v', '').Trim() } catch { return $null }
}

function Install-StandaloneNode {
	switch ($env:PROCESSOR_ARCHITECTURE) {
		'AMD64' { $cpu = 'x64' }
		'ARM64' { $cpu = 'arm64' }
		'x86' { Fail '官方已经不再为 32 位 Windows 发 Node 包，请先装 64 位 Node 22+ 再回来' }
		default { Fail "认不出这台机器的架构：$($env:PROCESSOR_ARCHITECTURE)" }
	}
	$file = "node-*-win-$cpu.zip"

	Write-Step "下载 Node（$NodeChannel / win-${cpu}）到 $HomeDir\node"
	$tmp = Join-Path ([IO.Path]::GetTempPath()) ("oh-my-agent-web-" + [Guid]::NewGuid().ToString('N'))
	New-Item -ItemType Directory -Path $tmp -Force | Out-Null
	try {
		$shasums = Join-Path $tmp 'SHASUMS256.txt'
		Invoke-WebRequest -Uri "https://nodejs.org/dist/latest-$NodeChannel/SHASUMS256.txt" -OutFile $shasums -UseBasicParsing
		$entry = Select-String -Path $shasums -Pattern 'win-.*\.zip$' |
			Where-Object { $_.Line -match "\s$([regex]::Escape("win-$cpu.zip"))$" } |
			Select-Object -First 1
		if (-not $entry) { Fail "校验清单里没有 win-$cpu 的包" }
		$name = ($entry.Line -split '\s+')[-1]
		$expect = ($entry.Line -split '\s+')[0]

		$zip = Join-Path $tmp $name
		Write-Step "下载 $name"
		Invoke-WebRequest -Uri "https://nodejs.org/dist/latest-$NodeChannel/$name" -OutFile $zip -UseBasicParsing
		$actual = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLower()
		if ($actual -ne $expect.ToLower()) { Fail "校验不通过（期望 ${expect}，实际 ${actual}），已中止" }
		Write-Ok 'sha256 校验通过'

		Expand-Archive -Path $zip -DestinationPath $tmp -Force
		$extracted = Get-ChildItem -Path $tmp -Directory -Filter 'node-v*-win-*' | Select-Object -First 1
		$target = Join-Path $HomeDir 'node'
		if (Test-Path $target) { Remove-Item $target -Recurse -Force }
		New-Item -ItemType Directory -Path $HomeDir -Force | Out-Null
		Move-Item -Path $extracted.FullName -Destination $target
		Write-Ok "Node $(Get-NodeVersion (Join-Path $target 'node.exe')) 就绪"
	}
	finally {
		Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
	}
}

function Resolve-Node {
	$managedNode = Join-Path $HomeDir 'node\node.exe'
	$managedNpm = Join-Path $HomeDir 'node\npm.cmd'

	if ($env:OH_MY_AGENT_WEB_NODE) {
		$cand = $env:OH_MY_AGENT_WEB_NODE
		if (Test-Path $cand -PathType Container) { $cand = Join-Path $cand 'node.exe' }
		if (-not (Test-Path $cand)) { Fail "OH_MY_AGENT_WEB_NODE 指向的 node 不存在：$($env:OH_MY_AGENT_WEB_NODE)" }
		$script:NodeExe = $cand
		$npm = Join-Path (Split-Path $cand -Parent) 'npm.cmd'
		$script:NpmExe = if (Test-Path $npm) { $npm } else { (Get-Command npm.cmd).Source }
		if (-not $script:NpmExe) { Fail 'OH_MY_AGENT_WEB_NODE 旁边没有 npm（需要 node 与 npm 同一个 prefix）' }
		return
	}

	if (Test-Path $managedNode) {
		$script:NodeExe = $managedNode
		$script:NpmExe = $managedNpm
		return
	}

	$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
	$npmCmd = Get-Command npm -ErrorAction SilentlyContinue
	if ($nodeCmd -and $npmCmd) {
		$have = Get-NodeVersion $nodeCmd.Source
		if (Test-SemverAtLeast $have $MinNode) {
			$script:NodeExe = $nodeCmd.Source
			$script:NpmExe = $npmCmd.Source
			Write-Ok "用系统 Node v${have}（$($nodeCmd.Source)）"
			return
		}
		Write-Warn2 "系统 Node v$have 太老（要 >= ${MinNode}），改装一个独立副本"
	}
	else {
		Write-Warn2 '没找到 node / npm，装一个独立副本'
	}

	Install-StandaloneNode
	$script:NodeExe = $managedNode
	$script:NpmExe = $managedNpm
}

function Install-Package {
	Write-Step "安装 $Pkg@$Version 到 $HomeDir"
	New-Item -ItemType Directory -Path $HomeDir -Force | Out-Null
	# --prefix：bins（aw.cmd 等）落在 $HomeDir 根、包本体落在 $HomeDir\node_modules。
	# 系统全局 npm 目录一概不碰（那里通常要管理员权限）。
	$npmArgs = @('install', '--global', '--prefix', $HomeDir, '--no-audit', '--no-fund', "$Pkg@$Version")
	if ($Registry) { $npmArgs += @('--registry', $Registry) }
	# 输出先收下来再过滤：npm 会把「某个间接依赖已弃用」当 warn 打一屏（如 node-domexception，
	# 来自 pi 模型层的 gaxios → node-fetch → fetch-blob），既改不了也无从处理。
	# 只摺这一类，其它 warn / error 照旧全打印 —— 尤其是 allow-scripts 那几条。
	$out = & $script:NpmExe @npmArgs 2>&1
	$code = $LASTEXITCODE
	$lines = @($out | ForEach-Object { "$_" })
	$folded = @($lines | Where-Object { $_ -match 'npm warn deprecated' }).Count
	$lines | Where-Object { $_ -notmatch 'npm warn deprecated' -and $_.Trim() -ne '' } | ForEach-Object { Write-Host $_ }
	if ($code -ne 0) { Fail 'npm 安装失败（看上面 npm 的报错；网络/镜像源问题见 README「装不上时按这个顺序排查」）' }
	if ($folded -gt 0) { Write-Ok "已折起 $folded 条「依赖已弃用」提醒（都是间接依赖，不影响使用）" }

	$entry = Join-Path $HomeDir 'aw.cmd'
	if (-not (Test-Path $entry)) { Fail "装完了但没找到 ${entry}（npm 版本太老？npm >= 9 才支持 --prefix + -g 装 bin）" }
	Write-Ok "已装到 $HomeDir"
}

function Add-ToUserPath {
	if ($NoPath) { return }
	$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
	if (-not $userPath) { $userPath = '' }
	$parts = $userPath -split ';' | Where-Object { $_ }
	if ($parts -notcontains $HomeDir) {
		$next = if ($userPath.TrimEnd(';')) { "$($userPath.TrimEnd(';'));$HomeDir" } else { $HomeDir }
		[Environment]::SetEnvironmentVariable('Path', $next, 'User')
		Write-Ok "已把 $HomeDir 加进用户 PATH（新开终端生效）"
	}
	else {
		Write-Ok '用户 PATH 里已经有它了'
	}
	# 当前这个会话也立刻能用（否则用户在同一窗口里敲 aw 会说找不到）
	if (($env:Path -split ';') -notcontains $HomeDir) { $env:Path = "$HomeDir;$env:Path" }
}

function Invoke-SmokeTest {
	Write-Step '自检'
	$entry = Join-Path $HomeDir 'aw.cmd'
	$ver = & $entry version 2>&1 | Select-Object -First 1
	if ($LASTEXITCODE -ne 0) { Fail "跑不起来：aw version → $ver" }
	Write-Ok "$ver"

	# node-pty 是原生模块（终端全靠它）：load 不通 = 装了也开不了终端，这里提前问清楚
	$pkgRoot = Join-Path $HomeDir "node_modules\$Pkg"
	if (Test-Path (Join-Path $pkgRoot 'node_modules\node-pty')) {
		$probe = "require('node-pty')"
		& $script:NodeExe -e $probe --input-type=commonjs 2>$null | Out-Null
		if ($LASTEXITCODE -ne 0) {
			Push-Location $pkgRoot
			try { & $script:NodeExe -e $probe 2>$null | Out-Null } finally { Pop-Location }
			if ($LASTEXITCODE -ne 0) {
				Write-Warn2 'node-pty 加载失败：终端会开不起来（对话与文件管理不受影响）'
				Write-Warn2 "修：& '$($script:NpmExe)' rebuild --prefix '$HomeDir' node-pty"
				return
			}
		}
		Write-Ok 'node-pty 可用（终端能开）'
	}
}

function Invoke-Uninstall {
	Write-Step '卸载'
	# 只删「装进去的东西」：默认 prefix 就是数据目录（$HOME\.oh-my-agent-web），
	# 里面还有 settings.json / uploads / logs —— 整目录删会把配置一起干掉。
	$pkgRoot = Join-Path $HomeDir "node_modules\$Pkg"
	if (Test-Path $pkgRoot) { Remove-Item $pkgRoot -Recurse -Force }
	$managedNodeDir = Join-Path $HomeDir 'node'
	if (Test-Path $managedNodeDir) { Remove-Item $managedNodeDir -Recurse -Force }
	foreach ($name in @('aw', 'agent-web', 'oh-my-agent-web')) {
		foreach ($ext in @('', '.cmd', '.ps1')) {
			$shim = Join-Path $HomeDir ($name + $ext)
			if (Test-Path $shim) { Remove-Item $shim -Force }
		}
	}
	$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
	if ($userPath) {
		$kept = ($userPath -split ';' | Where-Object { $_ -and $_ -ne $HomeDir }) -join ';'
		[Environment]::SetEnvironmentVariable('Path', $kept, 'User')
	}
	Write-Ok "已删除装进去的 $Pkg 与那几个命令，并清掉用户 PATH 里的对应条目"
	Write-Host "  数据目录没动：settings.json / uploads / logs 都还在（不要了就删 ${HomeDir}）"
}

Write-Host ''
Write-Host "  oh-my-agent-web 安装器 · Windows $($env:PROCESSOR_ARCHITECTURE)" -ForegroundColor White
Write-Host ''

if ($DoUninstall) {
	Invoke-Uninstall
	exit 0
}

Write-Step "检查 Node（>= ${MinNode}）"
Resolve-Node
$npmVersion = (& $script:NpmExe -v) 2>$null
Write-Ok "node $(Get-NodeVersion $script:NodeExe) · npm $npmVersion"

Install-Package
Add-ToUserPath
Invoke-SmokeTest

Write-Host ''
Write-Host '  装好了。' -ForegroundColor Green
Write-Host ''
if ($NoPath) {
	Write-Host "  启动：& '$(Join-Path $HomeDir 'aw.cmd')'          （后台运行并开页）"
	Write-Host "         & '$(Join-Path $HomeDir 'aw.cmd')' -f    （前台；Ctrl-C 退出）"
}
else {
	Write-Host '  新开一个终端，然后：'
	Write-Host '        aw            （后台运行并打开页面；日志在 %USERPROFILE%\.oh-my-agent-web\daemon.log）'
	Write-Host '        aw -f         （前台；Ctrl-C 退出）'
}
Write-Host ''
Write-Host '  然后打开 http://127.0.0.1:25257'
Write-Host '  常用：aw status · aw restart · aw stop · aw upgrade · aw --help' -ForegroundColor DarkGray
Write-Host ''
