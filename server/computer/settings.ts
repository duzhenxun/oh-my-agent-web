/**
 * 电脑控制的设置：直接读写 helper 自己的 `settings.json` 与 `allow-protected.txt`。
 *
 * 不在本项目里另存一份配置：helper 才是读这些文件的人，两边各存一份必然会不一致（ADR-0021 的教训）。
 * 写入时只改我们管的键，文件里别的键原样保留；JSON 损坏时拒绝写入，避免覆盖用户手改的内容。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { allowProtectedPath, settingsPath } from "./paths.js";

export type ComputerSettings = {
	/** focus.activateTarget：用户空闲时允许把目标应用临时拉到前台（默认关） */
	activateTarget: boolean;
	/** focus.borrowFront：需要前台的步骤可以短暂借一下前台（默认开） */
	borrowFront: boolean;
	/** preview.enabled：helper 旁边的实时预览浮窗（默认开） */
	previewEnabled: boolean;
	/** watermark.enabled：操作时屏幕边缘的水印提示（默认开） */
	watermarkEnabled: boolean;
	/** pointer.enabled：agent 自己的指针动画（默认开） */
	pointerEnabled: boolean;
	/** pointer.speed：0.25–4（默认 1） */
	pointerSpeed: number;
	/** typing.keyDelayMs：逐键输入的间隔，0–200 毫秒（默认 12） */
	typingKeyDelayMs: number;
	/** allow-protected.txt：从默认保护名单里解除保护的应用 bundle id */
	unprotectedApps: string[];
};

export const COMPUTER_DEFAULTS: Readonly<ComputerSettings> = Object.freeze({
	activateTarget: false,
	borrowFront: true,
	previewEnabled: true,
	watermarkEnabled: true,
	pointerEnabled: true,
	pointerSpeed: 1,
	typingKeyDelayMs: 12,
	unprotectedApps: [],
});

export const POINTER_SPEED_RANGE = { min: 0.25, max: 4 } as const;
export const KEY_DELAY_RANGE = { min: 0, max: 200 } as const;
/** bundle id：字母数字开头，可含 . - _；与 helper 解析允许名单时的常见写法一致 */
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFile(file: string): JsonObject {
	if (!existsSync(file)) return {};
	const text = readFileSync(file, "utf8");
	const parsed: unknown = JSON.parse(text);
	if (!isObject(parsed)) throw new Error(`${file} 顶层不是 JSON 对象`);
	return parsed;
}

function readAllowProtected(home: string): string[] {
	const file = allowProtectedPath(home);
	if (!existsSync(file)) return [];
	const ids: string[] = [];
	for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
		const line = rawLine.split("#")[0] ?? "";
		for (const item of line.split(",")) {
			const id = item.trim();
			if (id && !ids.includes(id)) ids.push(id);
		}
	}
	return ids;
}

/** 读取当前设置；文件缺失或损坏时用默认值（读取不报错，写入才报错） */
export function readSettings(home: string = homedir()): ComputerSettings {
	let root: JsonObject = {};
	try {
		root = readJsonFile(settingsPath(home));
	} catch {
		root = {};
	}
	const focus = isObject(root.focus) ? root.focus : {};
	const preview = isObject(root.preview) ? root.preview : {};
	const watermark = isObject(root.watermark) ? root.watermark : {};
	const pointer = isObject(root.pointer) ? root.pointer : {};
	const typing = isObject(root.typing) ? root.typing : {};
	return {
		activateTarget: bool(focus.activateTarget, COMPUTER_DEFAULTS.activateTarget),
		borrowFront: bool(focus.borrowFront, COMPUTER_DEFAULTS.borrowFront),
		previewEnabled: bool(preview.enabled, COMPUTER_DEFAULTS.previewEnabled),
		watermarkEnabled: bool(watermark.enabled, COMPUTER_DEFAULTS.watermarkEnabled),
		pointerEnabled: bool(pointer.enabled, COMPUTER_DEFAULTS.pointerEnabled),
		pointerSpeed: clamp(number(pointer.speed, COMPUTER_DEFAULTS.pointerSpeed), POINTER_SPEED_RANGE),
		typingKeyDelayMs: Math.round(clamp(number(typing.keyDelayMs, COMPUTER_DEFAULTS.typingKeyDelayMs), KEY_DELAY_RANGE)),
		unprotectedApps: readAllowProtected(home),
	};
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function number(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, range: { min: number; max: number }): number {
	return Math.min(range.max, Math.max(range.min, value));
}

/** 校验并规整一次写入的补丁；非法值直接抛错（路由会返回 400），不做静默修正 */
export function validateSettingsPatch(patch: unknown): Partial<ComputerSettings> {
	if (!isObject(patch)) throw new Error("设置必须是 JSON 对象");
	const out: Partial<ComputerSettings> = {};
	const boolKeys = ["activateTarget", "borrowFront", "previewEnabled", "pointerEnabled", "watermarkEnabled"] as const;
	for (const key of boolKeys) {
		if (patch[key] === undefined) continue;
		if (typeof patch[key] !== "boolean") throw new Error(`${key} 必须是布尔值`);
		out[key] = patch[key];
	}
	if (patch.pointerSpeed !== undefined) {
		const v = patch.pointerSpeed;
		if (typeof v !== "number" || !Number.isFinite(v) || v < POINTER_SPEED_RANGE.min || v > POINTER_SPEED_RANGE.max) {
			throw new Error(`pointerSpeed 必须在 ${POINTER_SPEED_RANGE.min}–${POINTER_SPEED_RANGE.max} 之间`);
		}
		out.pointerSpeed = v;
	}
	if (patch.typingKeyDelayMs !== undefined) {
		const v = patch.typingKeyDelayMs;
		if (typeof v !== "number" || !Number.isInteger(v) || v < KEY_DELAY_RANGE.min || v > KEY_DELAY_RANGE.max) {
			throw new Error(`typingKeyDelayMs 必须是 ${KEY_DELAY_RANGE.min}–${KEY_DELAY_RANGE.max} 之间的整数`);
		}
		out.typingKeyDelayMs = v;
	}
	if (patch.unprotectedApps !== undefined) {
		if (!Array.isArray(patch.unprotectedApps)) throw new Error("unprotectedApps 必须是数组");
		const ids: string[] = [];
		for (const item of patch.unprotectedApps) {
			if (typeof item !== "string" || !BUNDLE_ID.test(item.trim())) {
				throw new Error(`不是合法的 bundle id：${String(item)}`);
			}
			const id = item.trim();
			if (!ids.includes(id)) ids.push(id);
		}
		out.unprotectedApps = ids;
	}
	return out;
}

function writeAtomic(file: string, text: string): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, text, "utf8");
	renameSync(tmp, file);
}

/**
 * 写入设置：只改补丁里出现的键，别的键原样保留。
 * `settings.json` 损坏时抛错，不覆盖用户手改的内容。
 */
export function writeSettings(patch: unknown, home: string = homedir()): ComputerSettings {
	const next = validateSettingsPatch(patch);
	const file = settingsPath(home);
	const root = readJsonFile(file);

	const setNested = (section: string, key: string, value: unknown) => {
		const current = isObject(root[section]) ? (root[section] as JsonObject) : {};
		root[section] = { ...current, [key]: value };
	};
	if (next.activateTarget !== undefined) setNested("focus", "activateTarget", next.activateTarget);
	if (next.borrowFront !== undefined) setNested("focus", "borrowFront", next.borrowFront);
	if (next.previewEnabled !== undefined) setNested("preview", "enabled", next.previewEnabled);
	if (next.watermarkEnabled !== undefined) setNested("watermark", "enabled", next.watermarkEnabled);
	if (next.pointerEnabled !== undefined) setNested("pointer", "enabled", next.pointerEnabled);
	if (next.pointerSpeed !== undefined) setNested("pointer", "speed", next.pointerSpeed);
	if (next.typingKeyDelayMs !== undefined) setNested("typing", "keyDelayMs", next.typingKeyDelayMs);

	if (Object.keys(root).length > 0 || Object.keys(next).length > 0) {
		writeAtomic(file, `${JSON.stringify(root, null, 2)}\n`);
	}
	if (next.unprotectedApps !== undefined) {
		const header = "# 由 oh-my-agent-web 的「电脑控制」设置维护；手改请注意下次保存会覆盖\n";
		writeAtomic(
			allowProtectedPath(home),
			header + next.unprotectedApps.join("\n") + (next.unprotectedApps.length ? "\n" : ""),
		);
	}
	return readSettings(home);
}
