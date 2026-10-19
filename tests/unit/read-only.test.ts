/**
 * 只读命令判定（ADR-0006 补充）：读操作不要再弹窗。
 * 重点是**不误伤**：带写文件重定向、sed -i、rm 之类必须仍然询问。
 */
import { describe, expect, it } from "vitest";
import { isReadOnlyCommand } from "../../server/approval/read-only.js";

describe("只读命令（不询问）", () => {
	it("常见的看/查/统计", () => {
		expect(isReadOnlyCommand("ls -la")).toBe(true);
		expect(isReadOnlyCommand("cat README.md")).toBe(true);
		expect(isReadOnlyCommand("sed -n 425,470p /tmp/a.md")).toBe(true);
		expect(isReadOnlyCommand('grep -rn "foo" server')).toBe(true);
		expect(isReadOnlyCommand("wc -l server/*.ts")).toBe(true);
		expect(isReadOnlyCommand("head -20 a.txt && tail -5 b.txt")).toBe(true);
		expect(isReadOnlyCommand("cat a | grep b | wc -l")).toBe(true);
		expect(isReadOnlyCommand("/usr/bin/find . -name '*.ts'")).toBe(true);
	});

	it("允许 2>&1 / 2>/dev/null 这类无害重定向", () => {
		expect(isReadOnlyCommand("grep -rn foo . 2>&1")).toBe(true);
		expect(isReadOnlyCommand("cat a 2> /dev/null")).toBe(true);
	});
});

describe("写操作（仍然询问）", () => {
	it("写文件重定向", () => {
		expect(isReadOnlyCommand("echo hi > out.txt")).toBe(false);
		expect(isReadOnlyCommand("cat a >> log.txt")).toBe(false);
	});

	it("sed -i / rm / mv / cp / git / npm 等", () => {
		expect(isReadOnlyCommand("sed -i '' 's/a/b/' f.txt")).toBe(false);
		expect(isReadOnlyCommand("rm -rf build")).toBe(false);
		expect(isReadOnlyCommand("mv a b")).toBe(false);
		expect(isReadOnlyCommand("git status")).toBe(false);
		expect(isReadOnlyCommand("npm run test")).toBe(false);
	});

	it("命令替换 / 反引号内容不可预知 → 询问", () => {
		expect(isReadOnlyCommand("cat $(ls)")).toBe(false);
		expect(isReadOnlyCommand("cat `ls`")).toBe(false);
	});

	it("混合命令里只要有一个写操作就询问", () => {
		expect(isReadOnlyCommand("cat a && rm b")).toBe(false);
		expect(isReadOnlyCommand("grep x . ; mv a b")).toBe(false);
	});

	it("空命令不算只读", () => {
		expect(isReadOnlyCommand("   ")).toBe(false);
	});
});
