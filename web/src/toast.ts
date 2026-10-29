/**
 * 底部那条「轻提示」+「撤销」按钮。
 *
 * 为什么需要它：侧栏每一行都有一枚归档按钮，挨着「⋯」，很容易误点 ——
 * 而归档会把会话从列表里**藏起来**，用户当场就看不到它了。所以归档后立刻给一条
 * `已归档「标题」 撤销 查看 ×`：撤销 = 一步还原，查看 = 跳到归档视图找。
 *
 * 为什么不复用服务端的 notices：那些是「事实播报」（会一直挂着、没有交互按钮）；
 * 这条是**可撤销的瞬时动作**，几秒后该自己消失（鼠标停在上面时暂停计时）。
 */
import { useSyncExternalStore } from "react";

type ToastAction = { label: string; onClick: () => void };

export type ToastItem = {
	id: number;
	text: string;
	actions: ToastAction[];
	/** 多少毫秒后自动消失（悬停时暂停） */
	ttl: number;
};

let items: readonly ToastItem[] = [];
const listeners = new Set<() => void>();
let seq = 0;

function emit(): void {
	for (const listener of listeners) listener();
}

function setItems(next: readonly ToastItem[]): void {
	items = next;
	emit();
}

/** 弹一条轻提示（默认 8 秒后自己消失：够看清、也够点撤销） */
export function showToast(input: { text: string; actions?: ToastAction[]; ttl?: number }): number {
	seq += 1;
	const item: ToastItem = {
		id: seq,
		text: input.text,
		actions: input.actions ?? [],
		ttl: input.ttl ?? 8000,
	};
	// 最多同时留 3 条：再多就把最老的挤掉（底部不该堆成一条横幅）
	setItems([...items, item].slice(-3));
	return item.id;
}

export function dismissToast(id: number): void {
	setItems(items.filter((item) => item.id !== id));
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function getSnapshot(): readonly ToastItem[] {
	return items;
}

/** 订阅当前所有提示（`ToastHost` 用；空数组时渲染 null） */
export function useToasts(): readonly ToastItem[] {
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
