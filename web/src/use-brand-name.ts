import { useEffect, useState } from "react";
import {
	currentBrandLogo,
	currentBrandLogoShown,
	currentBrandName,
	currentBrandShown,
	onBrandNameChange,
	onBrandShownChange,
	resetBrandName,
	setBrandLogo,
	setBrandLogoShown,
	setBrandName,
	setBrandShown,
	storedBrandName,
} from "./brand-name.ts";

/**
 * 顶栏门面（logo + 名字）+ 读写它（顶栏、浏览器标题、新会话抬头、设置面板共用这一份）。
 *
 * 与 `use-theme.ts` / `use-chat-display.ts` 同一个模式：状态靠事件同步，
 * 所以设置面板里改一个字、换一张图，顶栏立刻跟着变，不用保存、不用刷新。
 */
export function useBrandName(): {
	/** 界面上该显示的名字（用户没改过 = 默认名） */
	name: string;
	/** 用户自己起的名字（没改过 = 空串；设置面板的输入框用它） */
	custom: string;
	/** 顶栏要不要显示这串名字 */
	shown: boolean;
	/** 自定义 logo 的 data URL（没换过 = 空串 → 用产品自带那个） */
	logo: string;
	/** 顶栏要不要显示 logo */
	logoShown: boolean;
	setName: (value: string) => void;
	setShown: (value: boolean) => void;
	setLogo: (dataUrl: string | null) => void;
	setLogoShown: (value: boolean) => void;
	reset: () => void;
} {
	const [state, setState] = useState(() => readAll());
	useEffect(() => {
		const sync = () => setState(readAll());
		const offName = onBrandNameChange(sync);
		const offShown = onBrandShownChange((shown) =>
			setState((current) => (current.shown === shown ? current : { ...current, shown })),
		);
		return () => {
			offName();
			offShown();
		};
	}, []);
	return {
		name: state.name,
		custom: state.custom,
		shown: state.shown,
		logo: state.logo,
		logoShown: state.logoShown,
		setName: setBrandName,
		setShown: setBrandShown,
		setLogo: setBrandLogo,
		setLogoShown: setBrandLogoShown,
		reset: resetBrandName,
	};
}

function readAll() {
	return {
		name: currentBrandName(),
		custom: storedBrandName(),
		shown: currentBrandShown(),
		logo: currentBrandLogo(),
		logoShown: currentBrandLogoShown(),
	};
}
