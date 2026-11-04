/**
 * 「项目管理」那一栏的开关桥（`web/src/projects-panel.ts`）。
 *
 * 为什么单独测：这颗快捷键跨了两个上下文 —— 状态在 `Sidebar`、派发在 `App`，
 * 中间靠一个模块级回调连着。写错的表现很难看出来：按了没反应，或者侧栏被收起时
 * 误以为「已经切过了」而什么都不做。这里把三件事钉死：
 * 有人登记时能切、没人登记时如实返回 false、卸载后不会再被调用。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerProjectsToggle, toggleProjects } from "../../web/src/projects-panel.ts";

describe("项目管理开关桥", () => {
	it("登记之后能被快捷键切到", () => {
		let calls = 0;
		const off = registerProjectsToggle(() => {
			calls += 1;
		});
		assert.equal(toggleProjects(), true);
		assert.equal(calls, 1);
		off();
	});

	it("没人登记（侧栏收起 → Sidebar 没挂载）时返回 false，调用方据此展开侧栏", () => {
		assert.equal(toggleProjects(), false);
	});

	it("注销之后不再被调用", () => {
		let calls = 0;
		const off = registerProjectsToggle(() => {
			calls += 1;
		});
		off();
		assert.equal(toggleProjects(), false);
		assert.equal(calls, 0);
	});

	it("旧实例的注销不会把新实例顶掉（重挂载时的竞态）", () => {
		let first = 0;
		let second = 0;
		const offFirst = registerProjectsToggle(() => {
			first += 1;
		});
		const offSecond = registerProjectsToggle(() => {
			second += 1;
		});
		offFirst(); // 旧的卸载晚于新的挂载
		assert.equal(toggleProjects(), true);
		assert.equal(second, 1);
		assert.equal(first, 0);
		offSecond();
	});
});
