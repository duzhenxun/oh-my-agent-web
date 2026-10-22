/**
 * id 生成（ADR-0019）。
 *
 * 为什么不用进程内自增计数器（曾经的做法，踩过）：**会话是跨进程持久的，而计数器不是**。
 * 重启后计数器从 1 重新开始 → 生成出磁盘上已存在的 `conv-1` → 两条会话被写进同一个
 * JSONL（连 meta 行都追加了两次）、消息 id 也重复 → 前端的「按 id 找到那条消息」全部错位。
 *
 * 规则：id 必须**全局唯一**，且不依赖进程状态。
 */
import { randomUUID } from "node:crypto";

/** 短 id：10 个十六进制字符（≈40 bit），单机自用场景足够 */
export function shortId(): string {
	return randomUUID().replace(/-/g, "").slice(0, 10);
}

/** 带前缀的 id 工厂：`msg-…`、`appr-…`、`notice-…`（会话不用它，见下面的 conversationId） */
export function makeIdFactory(): (prefix: string) => string {
	return (prefix: string) => `${prefix}-${shortId()}`;
}

/**
 * 会话 id：直接给 UUID，和 pi CLI 自己建会话时一模一样（`01a13d8d-a916-70b8-…`）。
 *
 * 为什么单独一个函数而不是 `makeIdFactory()("conv")`：会话 id 会**进入 pi 的会话文件名**
 * 和地址栏的 `?session=`，跟 pi 生成的会话用同一种格式，才不用去猜「这个 id 是谁建的」；
 * 另外 122 bit 随机比短 id 的 40 bit 更抗撞（会话是要长期保存的）。
 */
export function conversationId(): string {
	return randomUUID();
}
