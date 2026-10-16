/**
 * 审批归类（ADR-0006 审批粒度）：命令取可执行名、文件取目标目录。
 * 这是「总是允许这类」能不能真正命中的关键 —— 归类太细就永远命中不了。
 */
import { describe, expect, it } from "vitest";
import { classifyScope, commandExecutable, READ_ONLY_TOOLS, targetDirectory } from "../../server/approval/scope.js";

const workspace = "/repo";

describe("commandExecutable（从命令行里取可执行名）", () => {
	it("取第一个 token", () => {
		expect(commandExecutable("npm test")).toBe("npm");
		expect(commandExecutable("ls -la")).toBe("ls");
	});

	it("跳过环境变量前缀", () => {
		expect(commandExecutable("FOO=1 BAR=2 npm run build")).toBe("npm");
	});

	it("跳过 sudo / env / nohup 等包装与它们的选项", () => {
		expect(commandExecutable("sudo rm -rf /tmp/x")).toBe("rm");
		expect(commandExecutable("sudo -u root npm ci")).toBe("npm");
		expect(commandExecutable("env FOO=1 python3 -V")).toBe("python3");
		expect(commandExecutable("nohup ./server.sh")).toBe("server.sh");
	});

	it("剥掉路径前缀（同一件事不该因为写法不同而分成两类）", () => {
		expect(commandExecutable("/usr/bin/git push -f")).toBe("git");
		expect(commandExecutable("./scripts/deploy.sh prod")).toBe("deploy.sh");
	});

	it("空命令给出可读占位", () => {
		expect(commandExecutable("   ")).toBe("(空命令)");
	});
});

describe("targetDirectory（文件类取目标目录）", () => {
	it("绝对路径取父目录", () => {
		expect(targetDirectory("/repo/docs/notes.md", workspace)).toBe("/repo/docs");
	});

	it("相对路径按工作区根解析", () => {
		expect(targetDirectory("docs/notes.md", workspace)).toBe("/repo/docs");
		expect(targetDirectory("notes.md", workspace)).toBe("/repo");
	});

	it("空路径退回工作区根", () => {
		expect(targetDirectory("", workspace)).toBe(workspace);
	});
});

describe("classifyScope", () => {
	it("只读工具不问", () => {
		for (const tool of READ_ONLY_TOOLS) {
			expect(classifyScope({ toolName: tool, args: { path: "/repo/a.ts" }, workspace }).dangerous).toBe(false);
		}
	});

	it("写/改/跑命令要问", () => {
		expect(classifyScope({ toolName: "write", args: { path: "docs/a.md" }, workspace }).dangerous).toBe(true);
		expect(classifyScope({ toolName: "edit", args: { path: "src/a.ts" }, workspace }).dangerous).toBe(true);
		expect(classifyScope({ toolName: "bash", args: { command: "npm test" }, workspace }).dangerous).toBe(true);
	});

	it("两条 npm 命令归成同一「这类」（scopeKey 相同）", () => {
		const first = classifyScope({ toolName: "bash", args: { command: "npm test" }, workspace });
		const second = classifyScope({ toolName: "bash", args: { command: "npm run build --silent" }, workspace });
		expect(first.scopeKey).toBe("bash|npm");
		expect(second.scopeKey).toBe(first.scopeKey);
		expect(first.scopeHint).toBe("命令 npm");
	});

	it("同一目录下的两个文件归成同一「这类」", () => {
		const first = classifyScope({ toolName: "write", args: { path: "docs/a.md" }, workspace });
		const second = classifyScope({ toolName: "write", args: { path: "/repo/docs/b.md" }, workspace });
		expect(first.scopeKey).toBe("write|/repo/docs");
		expect(second.scopeKey).toBe(first.scopeKey);
		expect(first.scopeHint).toContain("/repo/docs");
	});

	it("不同可执行名是不同「这类」", () => {
		const npm = classifyScope({ toolName: "bash", args: { command: "npm test" }, workspace });
		const rm = classifyScope({ toolName: "bash", args: { command: "rm -rf build" }, workspace });
		expect(npm.scopeKey).not.toBe(rm.scopeKey);
	});

	it("参数摘要只给命令行本身（不把整个 JSON 塞进界面）", () => {
		const scope = classifyScope({ toolName: "bash", args: { command: "npm test", timeout: 5000 }, workspace });
		expect(scope.argsSummary).toBe("npm test");
	});

	it("风险说明是人话（能看懂为什么被问）", () => {
		expect(classifyScope({ toolName: "bash", args: { command: "npm test" }, workspace }).riskNote).toContain("命令");
		expect(classifyScope({ toolName: "write", args: { path: "a.md" }, workspace }).riskNote).toContain("写文件");
	});

	it("认不出的工具退回「所有 X 调用」这类（宁可问得粗，不可放行）", () => {
		const scope = classifyScope({ toolName: "mystery_tool", args: { foo: 1 }, workspace });
		expect(scope.dangerous).toBe(true);
		expect(scope.scopeKey).toBe("mystery_tool|*");
	});

	it("参数缺失也不崩（坏参数不该让审批环节挂掉）", () => {
		expect(classifyScope({ toolName: "bash", args: null, workspace }).scopeKey).toBe("bash|(空命令)");
		expect(classifyScope({ toolName: "bash", args: undefined, workspace }).argsSummary).toBeTruthy();
	});

	it("超长参数被截断（界面与规则文件都不该被撑爆）", () => {
		const scope = classifyScope({ toolName: "write", args: { path: `docs/${"x".repeat(500)}.md` }, workspace });
		expect(scope.argsSummary.length).toBeLessThanOrEqual(201);
	});
});
