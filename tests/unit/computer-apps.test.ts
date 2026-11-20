/**
 * 应用模糊搜索：用户输入的是「微信」，名单要的是 `com.tencent.xinWeChat`。
 * 这里只测纯函数（不碰文件系统），覆盖中文名、别名校验和排序优先级。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { searchApps, type InstalledApp } from "../../server/computer/apps.js";

const app = (name: string, bundleId: string, aliases: string[] = []): InstalledApp => ({
	name,
	aliases: [name, ...aliases],
	bundleId,
	path: `/Applications/${name}.app`,
});

const apps: InstalledApp[] = [
	app("微信", "com.tencent.xinWeChat", ["WeChat"]),
	app("微信开发者工具", "com.tencent.webplusdevtools", ["wechatwebdevtools"]),
	app("Google Chrome", "com.google.Chrome"),
	app("备忘录", "com.apple.Notes", ["Notes"]),
	app("腾讯会议", "com.tencent.meeting", ["TencentMeeting"]),
];

describe("searchApps", () => {
	it("中文名能搜到（本地化名就是关键）", () => {
		const hits = searchApps(apps, "微信");
		assert.equal(hits[0]?.name, "微信");
		assert.ok(hits.some((item) => item.name === "微信开发者工具"));
	});

	it("英文别名和 bundle id 也能搜到", () => {
		assert.equal(searchApps(apps, "wechat")[0]?.bundleId, "com.tencent.xinWeChat");
		assert.equal(searchApps(apps, "xinwechat")[0]?.bundleId, "com.tencent.xinWeChat");
		assert.equal(searchApps(apps, "com.apple.Notes")[0]?.name, "备忘录");
	});

	it("精确 > 前缀 > 包含，短名字优先", () => {
		const hits = searchApps(apps, "微信");
		// 「微信」是精确匹配，必须排在「微信开发者工具」前面
		assert.deepEqual(
			hits.map((item) => item.name).slice(0, 2),
			["微信", "微信开发者工具"],
		);
	});

	it("大小写无关", () => {
		assert.equal(searchApps(apps, "CHROME")[0]?.bundleId, "com.google.Chrome");
	});

	it("空查询不返回全部（避免一聚焦就刷一大片）", () => {
		assert.deepEqual(searchApps(apps, "   "), []);
	});

	it("按 limit 截断，且搜不到时为空", () => {
		assert.equal(searchApps(apps, "meeting", 1).length, 1);
		assert.deepEqual(searchApps(apps, "不存在的应用"), []);
	});
});
