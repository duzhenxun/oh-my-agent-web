import { useCallback, useEffect, useState } from "react";
import { LANGUAGE_KEY, applyDocumentLang, readLanguage, writeLanguage, type Language } from "./language.ts";

/**
 * 英文词条表**按需下载**：`i18n-en.ts` 有 400 多条词条、打包后约 13KB，
 * 而中文用户（默认语言）一条都用不上 —— 静态 import 等于给所有人的入口白加 13KB。
 * 所以它只在这里被 `import()`，成一个独立 chunk（见 main.tsx 的启动顺序）。
 *
 * 代价是「表可能不在手上」：那期间 `translate` 回落中文（这本来就是没翻译时的既有行为），
 * 所以这里**不等表就切语言**是安全的，只是会先看到一屏中文再跳一遍。为了不跳，
 * 所有切英语言的入口（首帧、设置里点、别的标签页改）都先 `await loadEnTable()` 再真正生效。
 */
let enTable: Record<string, string> | null = null;
let enLoading: Promise<void> | null = null;

/** 下载英文词条表（幂等）。失败不抛：界面回落中文，只在控制台留一条 warn */
export function loadEnTable(): Promise<void> {
	if (enTable) return Promise.resolve();
	if (!enLoading) {
		enLoading = import("./i18n-en.ts")
			.then((mod) => {
				enTable = mod.EN;
			})
			.catch((error: unknown) => {
				enLoading = null; // 允许下次再试（比如刚才是离线）
				console.warn("[i18n] 英文词条加载失败，界面回落中文", error);
			});
	}
	return enLoading;
}

/**
 * 当前语言 + 切语言。和主题一样是**全局副作用**（改 `<html lang>`），状态靠事件同步：
 * 谁调的 `writeLanguage` 都行，所有订阅者一起更新（同标签页自定义事件、跨标签页 `storage`）。
 */
export function useLanguage(): { language: Language; setLanguage: (next: Language) => void } {
	const [language, setCurrent] = useState<Language>(() => readLanguage());

	useEffect(() => {
		// 切到英文之前先把表拿下来：表没到位就切，界面会整屏中文再跳一遍（默认语言是中文，
		// 所以「切英文」是唯一需要等的方向；切回中文永远同步生效）
		const apply = (next: Language) => {
			if (next !== "en") {
				setCurrent(next);
				return;
			}
			void loadEnTable().then(() => setCurrent("en"));
		};
		const onCustom = (event: Event) => {
			const detail = (event as CustomEvent<Language>).detail;
			if (detail === "zh" || detail === "en") apply(detail);
		};
		const onStorage = (event: StorageEvent) => {
			if (event.key !== LANGUAGE_KEY) return;
			apply(event.newValue === "en" ? "en" : "zh");
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

	// 走 writeLanguage 而不是直接 setState：它负责写存储 + 改 <html lang> + 广播，
	// 本组件靠上面那个事件监听同一张表更新（和其它订阅者走同一条路，不分叉）
	const setLanguage = useCallback((next: Language) => {
		if (next !== "en") {
			writeLanguage(next);
			return;
		}
		void loadEnTable().then(() => writeLanguage(next));
	}, []);

	return { language, setLanguage };
}

/**
 * 就地取词：`t("保存")` 或 `t("保存", "Keep")`。
 *
 * 中文是主语言，**第一参永远写中文**：英文先看第二参，再查 `i18n-en.ts` 的对照表，
 * 最后回落中文 —— 所以没翻的句子只是暂时还是中文，不会空白。
 * 第二参只用于「同一句中文在不同位置要不同英文」的场合。
 *
 * 同步返回，因为它被 140 多处渲染路径调用（包括 React 之外的格式化函数，见 `tNow`）；
 * 表没下载完时回落中文，顺手补一次下载（正常路径上表早就到位了，见文件头）。
 */
export function translate(language: Language, zh: string, en?: string): string {
	if (language !== "en") return zh;
	if (en) return en;
	if (!enTable) {
		void loadEnTable();
		return zh;
	}
	return enTable[zh] ?? zh;
}

/** React 之外取词（纯函数、模块级表、格式化器里用）：读当前语言，不订阅变化 */
export function tNow(zh: string, en?: string): string {
	return translate(readLanguage(), zh, en);
}

export function useT(): (zh: string, en?: string) => string {
	const { language } = useLanguage();
	return useCallback((zh: string, en?: string) => translate(language, zh, en), [language]);
}
