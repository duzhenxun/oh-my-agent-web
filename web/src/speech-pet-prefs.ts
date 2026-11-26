/**
 * 朗读小宠物的两项本机偏好：**开不开**、**选哪只动物**。
 *
 * 判据跟主题、字号一样：这是「这台机器上怎么显示」的东西 —— 手机想要一只猫、桌面不想要，
 * 本来就该各记各的，所以存 `localStorage`，不进服务端快照。
 *
 * 显隐沿用 `ui-prefs.ts` 那套布尔通道（`useStoredBool`，同页事件 + 跨标签页 `storage`）；
 * 动物是个字符串，另开一条同形的事件（那个通道只带布尔，混用会把 🐱 当成 `true`）。
 */
import { useEffect, useState } from "react";
import { readStored, writeStored, writeStoredBool } from "./ui-prefs.ts";

/** 显隐：默认**开**（做了就是为了用的） */
export const PET_ENABLED_KEY = "agent-web.speech.pet.enabled";
/** 形象：存 emoji 本身（换样子只改这张表，不用迁移数据） */
export const PET_ANIMAL_KEY = "agent-web.speech.pet.animal";

/** 可选的动物（顺序就是设置里的顺序；emoji 就是它的 id） */
export const PET_ANIMALS = [
	{ emoji: "🐱", zh: "猫", en: "Cat" },
	{ emoji: "🦊", zh: "狐狸", en: "Fox" },
	{ emoji: "🐰", zh: "兔子", en: "Rabbit" },
	{ emoji: "🐧", zh: "企鹅", en: "Penguin" },
] as const;

export const DEFAULT_PET_ANIMAL = PET_ANIMALS[0].emoji;

/**
 * 关掉宠物（右键菜单里的「关闭宠物」）。
 *
 * 走 `ui-prefs` 的布尔通道，所以 `useStoredBool` 的订阅者（宠物自己、设置里那个勾选框）
 * 同一帧就一起更新 —— 不用刷新，也不会出现「关掉了下次又冒出来」。
 * 想再打开：设置 → 语音播报 → 朗读小宠物。
 */
export function writePetEnabled(enabled: boolean): void {
	writeStoredBool(PET_ENABLED_KEY, enabled);
}

const ANIMAL_EVENT = "agent-web:speech-pet-animal";

/** 读存下来的动物；不认识的值（手改过 / 以后删了某个形象）回默认 */
export function readPetAnimal(): string {
	const raw = readStored(PET_ANIMAL_KEY);
	return PET_ANIMALS.some((item) => item.emoji === raw) ? (raw as string) : DEFAULT_PET_ANIMAL;
}

export function writePetAnimal(emoji: string): void {
	writeStored(PET_ANIMAL_KEY, emoji);
	try {
		window.dispatchEvent(new CustomEvent<string>(ANIMAL_EVENT, { detail: emoji }));
	} catch {
		// 没有 window（SSR / 单测）就算了，本页自己已经拿到新值
	}
}

/** 当前动物 + 换一只（同页立刻生效；跨标签页靠 `storage`） */
export function usePetAnimal(): [string, (emoji: string) => void] {
	const [animal, setAnimal] = useState<string>(() => readPetAnimal());
	useEffect(() => {
		const onCustom = (event: Event) => setAnimal((event as CustomEvent<string>).detail);
		const onStorage = (event: StorageEvent) => {
			if (event.key === null || event.key === PET_ANIMAL_KEY) setAnimal(readPetAnimal());
		};
		window.addEventListener(ANIMAL_EVENT, onCustom);
		window.addEventListener("storage", onStorage);
		return () => {
			window.removeEventListener(ANIMAL_EVENT, onCustom);
			window.removeEventListener("storage", onStorage);
		};
	}, []);
	return [animal, writePetAnimal];
}
