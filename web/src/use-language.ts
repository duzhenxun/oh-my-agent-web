import { useCallback, useEffect, useState } from "react";
import { EN } from "./i18n-en.ts";
import { LANGUAGE_KEY, applyDocumentLang, readLanguage, writeLanguage, type Language } from "./language.ts";

/**
 * 当前语言 + 切语言。和主题一样是**全局副作用**（改 `<html lang>`），状态靠事件同步：
 * 谁调的 `writeLanguage` 都行，所有订阅者一起更新（同标签页自定义事件、跨标签页 `storage`）。
 */
export function useLanguage(): { language: Language; setLanguage: (next: Language) => void } {
	const [language, setCurrent] = useState<Language>(() => readLanguage());

	useEffect(() => {
		const onCustom = (event: Event) => {
			const detail = (event as CustomEvent<Language>).detail;
			if (detail === "zh" || detail === "en") setCurrent(detail);
		};
		const onStorage = (event: StorageEvent) => {
			if (event.key !== LANGUAGE_KEY) return;
			setCurrent(event.newValue === "en" ? "en" : "zh");
		};
		window.addEventListener("agent-web:language", onCustom);
		window.addEventListener("storage", onStorage);
		return () => {
			window.removeEventListener("agent-web:language", onCustom);
			window.removeEventListener("storage", onStorage);
		};
	}, []);

	// 首帧就把 <html lang> 对齐（直接在地址栏刷新时不会经过 writeLanguage）
	useEffect(() => applyDocumentLang(language), [language]);

	return { language, setLanguage: writeLanguage };
}

/**
 * 就地取词：`t("保存")` 或 `t("保存", "Keep")`。
 *
 * 中文是主语言，**第一参永远写中文**：英文先查 `i18n-en.ts` 的对照表，
 * 查不到再退到第二参，最后回落中文 —— 所以没翻的句子只是暂时还是中文，不会空白。
 * 第二参只用于「同一句中文在不同位置要不同英文」的场合。
 */
export function translate(language: Language, zh: string, en?: string): string {
	if (language !== "en") return zh;
	return en ?? EN[zh] ?? zh;
}

/** React 之外取词（纯函数、模块级表、格式化器里用）：读当前语言，不订阅变化 */
export function tNow(zh: string, en?: string): string {
	return translate(readLanguage(), zh, en);
}

export function useT(): (zh: string, en?: string) => string {
	const { language } = useLanguage();
	return useCallback((zh: string, en?: string) => translate(language, zh, en), [language]);
}
