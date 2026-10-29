/**
 * 非本机访问时的登录页（ADR-0031 修订）：自包含单页，不依赖前端构建产物。
 *
 * 为什么不再用浏览器原生 Basic 弹窗：
 *   1. 各处实现不一致（有的不显示中文提示、有的不记住密码、手机上弹出体验很差）；
 *   2. 弹窗无法表达「登录状态保存 7 天」这类产品语义；
 *   3. 它只是一张表单 —— 自己渲染 20 行 HTML 就够了，还能顺手控制视觉。
 *
 * 约定：
 *   - 无 JS 时也能用：表单 `method=post` 直接打到 `/api/auth/login`，服务端 303 回 `/`；
 *   - 页面里不出现任何用户数据（只有品牌名），所以未登录时返回它并不扩大攻击面。
 */
import { BRAND_NAME } from "../brand.js";

/** 极简转义：这里只会插品牌名与错误文案，但仍然按不可信对待 */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

const STYLES = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
	display: flex;
	align-items: center;
	justify-content: center;
	background: #fff;
	color: #1b2530;
	font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
	padding: 24px clamp(20px, 8vw, 48px);
}
.login { width: 100%; max-width: 520px; }
.head { display: flex; align-items: center; gap: 18px; }
.mark {
	width: 60px;
	height: 60px;
	flex: none;
	border: 1px solid #e8e8e8;
	border-radius: 14px;
	display: flex;
	align-items: center;
	justify-content: center;
	background: #fff;
}
.mark img { width: 44px; height: 44px; display: block; }
h1 { margin: 0; font-size: 26px; line-height: 1.3; font-weight: 500; }
.sub { margin: 2px 0 0; font-size: 14px; color: #8b95a1; }
.field {
	margin-top: 28px;
	display: flex;
	align-items: center;
	gap: 8px;
	border: 1px solid #e4e7ec;
	border-radius: 16px;
	padding: 5px 5px 5px 18px;
	background: #fff;
	transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.field:focus-within { border-color: #d3d8df; box-shadow: 0 0 0 4px rgba(17, 24, 39, 0.04); }
input {
	flex: 1 1 auto;
	min-width: 0;
	height: 44px;
	padding: 0;
	border: 0;
	outline: 0;
	background: transparent;
	font: inherit;
	font-size: 17px;
	color: inherit;
}
input::placeholder { color: #a8b0ba; }
button {
	flex: none;
	display: inline-flex;
	align-items: center;
	gap: 5px;
	height: 44px;
	padding: 0 16px;
	border: 0;
	border-radius: 12px;
	background: #f1f2f4;
	color: #2b3440;
	font: inherit;
	font-size: 16px;
	cursor: pointer;
}
button:hover { background: #e8eaed; }
button:active { background: #e0e3e7; }
button[disabled] { opacity: 0.6; cursor: default; }
.arrow { font-size: 15px; line-height: 1; }
.error { margin: 10px 4px 0; font-size: 14px; color: #c62828; }
.error[hidden] { display: none; }
`;

/** 登录页脚本：只做「提交 → 成功就原地刷新 → 失败显示原因」，不引入任何依赖 */
const SCRIPT = `
(function () {
	var form = document.getElementById("form");
	var input = document.getElementById("password");
	var button = document.getElementById("submit");
	var error = document.getElementById("error");
	if (!form || !input || !button || !error) return;

	function showError(text) {
		error.textContent = text;
		error.hidden = false;
	}

	function fail(text) {
		showError(text);
		button.disabled = false;
		input.select();
	}

	form.addEventListener("submit", function (event) {
		event.preventDefault();
		if (button.disabled) return;
		var password = input.value;
		if (!password) {
			showError("请输入密码");
			input.focus();
			return;
		}
		error.hidden = true;
		button.disabled = true;
		fetch("/api/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ password: password }),
			credentials: "same-origin",
		})
			.then(function (response) {
				if (response.ok) {
					location.replace(location.pathname + location.search);
					return;
				}
				return response
					.json()
					.catch(function () {
						return null;
					})
					.then(function (body) {
						fail((body && body.error) || "密码不正确");
					});
			})
			.catch(function () {
				fail("网络异常，请重试");
			});
	});
})();
`;

export function renderLoginPage(options: { brandName?: string; error?: string } = {}): string {
	const brand = escapeHtml(options.brandName ?? BRAND_NAME);
	const error = options.error ? escapeHtml(options.error) : "";
	return `<!doctype html>
<html lang="zh-CN">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<meta name="robots" content="noindex, nofollow" />
		<title>登录 · ${brand}</title>
		<link rel="icon" href="/favicon.ico?v=4" sizes="16x16 32x32 48x48" />
		<link rel="icon" type="image/svg+xml" href="/favicon.svg?v=4" />
		<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon-180.png?v=4" />
		<meta name="theme-color" content="#ffffff" />
		<style>${STYLES}</style>
	</head>
	<body>
		<main class="login">
			<div class="head">
				<span class="mark"><img src="/favicon.svg?v=4" alt="" width="44" height="44" /></span>
				<div>
					<h1>${brand}</h1>
					<p class="sub">登录后继续使用</p>
				</div>
			</div>
			<form class="field" id="form" method="post" action="/api/auth/login">
				<input
					id="password"
					name="password"
					type="password"
					placeholder="密码"
					autocomplete="current-password"
					aria-label="访问密码"
					autofocus
					required
				/>
				<button type="submit" id="submit"><span class="arrow" aria-hidden="true">→</span>登录</button>
			</form>
			<p class="error" id="error" role="alert"${error ? "" : " hidden"}>${error}</p>
		</main>
		<script>${SCRIPT}</script>
	</body>
</html>
`;
}

/** 设置页的脚本：两次输入一致、至少 4 位，成功后直接进主界面 */
const SETUP_SCRIPT = `
(function () {
	var form = document.getElementById("form");
	var first = document.getElementById("password");
	var second = document.getElementById("password2");
	var button = document.getElementById("submit");
	var error = document.getElementById("error");
	if (!form || !first || !second || !button || !error) return;

	function fail(text) {
		error.textContent = text;
		error.hidden = false;
		button.disabled = false;
	}

	form.addEventListener("submit", function (event) {
		event.preventDefault();
		if (button.disabled) return;
		var password = first.value;
		if (password.length < 4) {
			fail("密码至少 4 位");
			first.focus();
			return;
		}
		if (password !== second.value) {
			fail("两次输入的密码不一样");
			second.select();
			return;
		}
		error.hidden = true;
		button.disabled = true;
		fetch("/api/auth/setup", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ password: password }),
			credentials: "same-origin",
		})
			.then(function (response) {
				if (response.ok) {
					location.replace("/");
					return;
				}
				return response
					.json()
					.catch(function () {
						return null;
					})
					.then(function (body) {
						fail((body && body.error) || "设置失败，请重试");
					});
			})
			.catch(function () {
				fail("网络异常，请重试");
			});
	});
})();
`;

/**
 * 「还没设访问密码」时给远程访客看的设置页。
 *
 * 为什么需要它：没密码时的老行为是直接 403 一段纯文本，手机上打开就只是白屏 + 一行英文错误 ——
 * 用户根本不知道下一步该干什么。这里直接给表单：设完就种 cookie 进主界面，不用回终端重启。
 *
 * 前提：只有**主动用 `-H 0.0.0.0` 暴露**时才会遇到这个页；默认只听回环，这个页不可达。
 */
export function renderSetupPage(options: { brandName?: string } = {}): string {
	const brand = escapeHtml(options.brandName ?? BRAND_NAME);
	return `<!doctype html>
<html lang="zh-CN">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<meta name="robots" content="noindex, nofollow" />
		<title>设置访问密码 · ${brand}</title>
		<link rel="icon" href="/favicon.ico?v=4" sizes="16x16 32x32 48x48" />
		<link rel="icon" type="image/svg+xml" href="/favicon.svg?v=4" />
		<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon-180.png?v=4" />
		<meta name="theme-color" content="#ffffff" />
		<style>${STYLES}
.field + .field { margin-top: 12px; }
.hint { margin: 12px 4px 0; font-size: 13px; color: #8b95a1; line-height: 1.6; }
</style>
	</head>
	<body>
		<main class="login">
			<div class="head">
				<span class="mark"><img src="/favicon.svg?v=4" alt="" width="44" height="44" /></span>
				<div>
					<h1>${brand}</h1>
					<p class="sub">先设一个访问密码，之后远程访问都用它登录</p>
				</div>
			</div>
			<form id="form" method="post" action="/api/auth/setup">
				<div class="field">
					<input
						id="password"
						name="password"
						type="password"
						placeholder="设置密码（至少 4 位）"
						autocomplete="new-password"
						aria-label="设置访问密码"
						autofocus
						required
					/>
				</div>
				<div class="field">
					<input
						id="password2"
						name="password2"
						type="password"
						placeholder="再输一次"
						autocomplete="new-password"
						aria-label="再输一次"
						required
					/>
					<button type="submit" id="submit"><span class="arrow" aria-hidden="true">→</span>保存并进入</button>
				</div>
			</form>
			<p class="error" id="error" role="alert" hidden></p>
			<p class="hint">密码存在运行服务的这台机器上（数据目录里的 <code>password</code>），忘了就删掉它再重启。本机 127.0.0.1 访问不需要密码。</p>
		</main>
		<script>${SETUP_SCRIPT}</script>
	</body>
</html>
`;
}
