import { describe, expect, it } from "vitest";
import {
	DEFAULT_DATA_DIR_NAME,
	DEFAULT_PORT,
	isForbiddenWorkspaceRoot,
	isForeignDataDir,
	normalizeDir,
	readConfig,
	validateConfig,
} from "../../server/util/env";

const HOME = "/Users/tester";
const CWD = "/Users/tester/code/agent-web";

describe("readConfig", () => {
	it("空环境给出默认值（端口 8790 / 数据目录 ~/.agent-web / info）", () => {
		const { config, problems } = readConfig({}, { home: HOME, cwd: CWD });
		expect(problems).toEqual([]);
		expect(config.port).toBe(DEFAULT_PORT);
		expect(config.host).toBe("127.0.0.1");
		expect(config.workspace).toBe(CWD);
		expect(config.dataDir).toBe(`${HOME}/${DEFAULT_DATA_DIR_NAME}`);
		expect(config.logLevel).toBe("info");
		expect(config.token).toBeNull();
	});

	it("读取四个环境变量", () => {
		const { config, problems } = readConfig(
			{
				AGENT_WEB_PORT: "8901",
				AGENT_WEB_CWD: "/tmp/work",
				AGENT_WEB_DATA_DIR: "/tmp/data",
				AGENT_WEB_LOG: "debug",
				AGENT_WEB_TOKEN: "secret",
			},
			{ home: HOME, cwd: CWD },
		);
		expect(problems).toEqual([]);
		expect(config.port).toBe(8901);
		expect(config.workspace).toBe("/tmp/work");
		expect(config.dataDir).toBe("/tmp/data");
		expect(config.logLevel).toBe("debug");
		expect(config.token).toBe("secret");
	});

	it("引擎选择：默认 pi，显式 fake 生效，非法值回落并报问题（ADR-0016）", () => {
		expect(readConfig({}, { home: HOME, cwd: CWD }).config.engine).toBe("pi");
		expect(readConfig({ AGENT_WEB_ENGINE: "fake" }, { home: HOME, cwd: CWD }).config.engine).toBe("fake");
		expect(readConfig({ AGENT_WEB_ENGINE: "FAKE" }, { home: HOME, cwd: CWD }).config.engine).toBe("fake");
		const bad = readConfig({ AGENT_WEB_ENGINE: "gpt" }, { home: HOME, cwd: CWD });
		expect(bad.config.engine).toBe("pi");
		expect(bad.problems).toHaveLength(1);
		expect(readConfig({ AGENT_WEB_ENGINE: "" }, { home: HOME, cwd: CWD }).problems).toEqual([]);
	});

	it("非法端口与非法日志级别回落默认值，并给出问题说明", () => {
		const { config, problems } = readConfig(
			{ AGENT_WEB_PORT: "abc", AGENT_WEB_LOG: "verbose" },
			{ home: HOME, cwd: CWD },
		);
		expect(config.port).toBe(DEFAULT_PORT);
		expect(config.logLevel).toBe("info");
		expect(problems).toHaveLength(2);
	});

	it("忽略空字符串形式的环境变量（视为未设置）", () => {
		const { config, problems } = readConfig(
			{ AGENT_WEB_PORT: "", AGENT_WEB_CWD: "", AGENT_WEB_DATA_DIR: "", AGENT_WEB_TOKEN: "" },
			{ home: HOME, cwd: CWD },
		);
		expect(problems).toEqual([]);
		expect(config.port).toBe(DEFAULT_PORT);
		expect(config.workspace).toBe(CWD);
		expect(config.dataDir).toBe(`${HOME}/${DEFAULT_DATA_DIR_NAME}`);
		expect(config.token).toBeNull();
	});
});

describe("工作区根约束（ADR-0006）", () => {
	it("家目录与文件系统根被拒", () => {
		expect(isForbiddenWorkspaceRoot(HOME, HOME)).toBe(true);
		expect(isForbiddenWorkspaceRoot(`${HOME}/`, HOME)).toBe(true);
		expect(isForbiddenWorkspaceRoot("/", HOME)).toBe(true);
	});

	it("家目录的子目录放行", () => {
		expect(isForbiddenWorkspaceRoot(`${HOME}/code/agent-web`, HOME)).toBe(false);
	});

	it("validateConfig 会把违规工作区报出来", () => {
		const { config } = readConfig({ AGENT_WEB_CWD: HOME }, { home: HOME, cwd: CWD });
		expect(validateConfig(config, { home: HOME })).toHaveLength(1);
	});
});

describe("数据目录隔离（ADR-0011）", () => {
	it("参考实现的目录名视为外来目录", () => {
		expect(isForeignDataDir(`${HOME}/.pi-web`)).toBe(true);
		expect(isForeignDataDir(`${HOME}/.pi`)).toBe(true);
	});

	it("自己的目录名放行", () => {
		expect(isForeignDataDir(`${HOME}/${DEFAULT_DATA_DIR_NAME}`)).toBe(false);
		expect(isForeignDataDir("/tmp/agent-web-test-123")).toBe(false);
	});

	it("validateConfig 会把共用数据目录报出来", () => {
		const { config } = readConfig({ AGENT_WEB_DATA_DIR: `${HOME}/.pi-web` }, { home: HOME, cwd: CWD });
		expect(validateConfig(config, { home: HOME })).toHaveLength(1);
	});
});

describe("normalizeDir", () => {
	it("去掉尾部分隔符但保留根", () => {
		expect(normalizeDir("/a/b/")).toBe("/a/b");
		expect(normalizeDir("/")).toBe("/");
		expect(normalizeDir("/a/./b")).toBe("/a/b");
	});
});
