/**
 * 写剪贴板。
 *
 * 两个坑：
 *   - `navigator.clipboard` 在非 https / 无权限 / iframe 里会 reject；
 *   - 那就退回「隐藏 textarea + execCommand」，它虽然过时但在这些场景里还是唯一能用的路。
 * 抽出来是因为现在有两个调用方（复制按钮、文件预览的右键菜单），各写一份必然会有一份忘了兜底。
 */
export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		// 继续走兜底
	}
	const area = document.createElement("textarea");
	area.value = text;
	area.setAttribute("readonly", "");
	area.style.position = "fixed";
	area.style.opacity = "0";
	document.body.appendChild(area);
	area.select();
	try {
		document.execCommand("copy");
		return true;
	} catch {
		return false;
	} finally {
		area.remove();
	}
}
