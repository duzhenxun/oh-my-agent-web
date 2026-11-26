/**
 * 朗读小宠物的两项本机偏好（`web/src/speech-pet-prefs.ts`）。
 *
 * 用户 2026-11-24：「宠物可选，设置里给宠物加个开关和动物选择（🐱🦊🐰🐧）」。
 *
 * 这里钉三件事：
 *   1. 没存过 / 存了不认识的值（手改过、以后删掉某个形象）→ 回默认那只，不炸；
 *   2. 换一只当场广播（设置里点一下就变，不用刷新）；
 *   3. 存的只是 emoji 本身 —— 以后加/删形象不用迁移数据。
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	DEFAULT_PET_ANIMAL,
	PET_ANIMALS,
	PET_ANIMAL_KEY,
	readPetAnimal,
	writePetAnimal,
} from "../../web/src/speech-pet-prefs.ts";

const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const savedStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

/** 装一套假的 window（EventTarget）+ localStorage（Map） */
function stubBrowser(seed: Record<string, string> = {}): Map<string, string> {
	const store = new Map(Object.entries(seed));
	Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: new EventTarget() });
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		writable: true,
		value: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => void store.set(key, value),
			removeItem: (key: string) => void store.delete(key),
		},
	});
	return store;
}

beforeEach(() => stubBrowser());
afterEach(() => {
	if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow);
	else Reflect.deleteProperty(globalThis, "window");
	if (savedStorage) Object.defineProperty(globalThis, "localStorage", savedStorage);
	else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("宠物形象", () => {
	it("没存过 → 默认那只", () => {
		stubBrowser();
		assert.equal(readPetAnimal(), DEFAULT_PET_ANIMAL);
	});

	it("存了表里的 emoji → 原样读回来", () => {
		for (const item of PET_ANIMALS) {
			stubBrowser({ [PET_ANIMAL_KEY]: item.emoji });
			assert.equal(readPetAnimal(), item.emoji);
		}
	});

	it("存了不认识的值（手改 / 已下架的形象）→ 回默认，不抛", () => {
		stubBrowser({ [PET_ANIMAL_KEY]: "🐉" });
		assert.equal(readPetAnimal(), DEFAULT_PET_ANIMAL);
	});

	it("换一只：写进本机 + 当场广播（设置里点一下，宠物立刻变）", () => {
		const store = stubBrowser();
		const seen: string[] = [];
		window.addEventListener("agent-web:speech-pet-animal", (event) =>
			seen.push((event as CustomEvent<string>).detail),
		);
		writePetAnimal("🦊");
		assert.deepEqual(seen, ["🦊"]);
		assert.equal(store.get(PET_ANIMAL_KEY), "🦊");
		assert.equal(readPetAnimal(), "🦊");
	});
});
