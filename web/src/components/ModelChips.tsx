import { useAppSelector } from "../store.ts";
import type { ChatSurface } from "../chat-surface.ts";
import { setModel, setSettings } from "../ws.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import { ThinkingPicker } from "./ThinkingPicker.tsx";
import { useT } from "../use-language.ts";
import { ModelIcon } from "./ModelIcon.tsx";

/**
 * 「这一轮怎么跑」的两颗：**模型 + 思考强度**。
 *
 * 落点（**2026-11-23 统一**）：输入框上方那排、**提示词前面**，主对话 / 手机 / 临时聊天都一样。
 *
 * 来龙去脉：2026-10-28 曾把桌面端挪到底部状态栏（跟引擎、放行同一类：都是「这一步怎么跑」），
 * 手机端与临时聊天留在输入框上方 —— 也就是一份 UI 三个落点。2026-11-23 用户重新定：
 * 「放提示词前面」，于是状态栏那两颗撤掉，三处合一（见 `Composer` 的 `chipsHere`）。
 * 理由：模型与强度是**每轮都可能改**的，贴着输入框比沉在底部更顺手。
 *
 * 抽成组件仍然有意义：占位（模型列表还没到）、回退、项目默认模型这些逻辑只写一遍；
 * `part` 参数保留着（以前状态栏要把模型 / 强度拆成两个可排序项），现在两份都在同一排。
 */
export function ModelChips({
	surface,
	part = "both",
}: {
	surface?: ChatSurface;
	/** 状态栏可把模型和思考强度拆成两个可排序的项目；输入框上方默认仍然一起画。 */
	part?: "model" | "thinking" | "both";
}) {
	const t = useT();
	// hook 不能条件调用：这一面自己带快照时也照样订阅（代价只是这一片的订阅，不是全量 state）
	const appSnapshot = useAppSelector((state) => state.snapshot);
	const snapshot = surface ? surface.snapshot : appSnapshot;
	// 当前项目 = 当前会话的工作区（新会话还没落盘时退回文件树根）；「项目默认模型」按它存
	const activeWorkspace =
		snapshot?.conversations.find((item) => item.id === snapshot.active.conversationId)?.workspace ??
		snapshot?.files?.root ??
		"";
	const defaultModels = snapshot?.settings.defaultModels ?? {};
	/** 点行尾的图钉：把这个模型设成**当前项目的**默认（新会话按它起步） */
	const setProjectDefault = (modelId: string | null) => {
		if (!activeWorkspace) return;
		// 临时聊天不写主对话的「项目默认模型」：它没有会话，也不该改别人那一份偏好
		if (surface) {
			surface.setProjectDefaultModel?.(activeWorkspace, modelId);
			return;
		}
		const next = { ...defaultModels };
		if (modelId) next[activeWorkspace] = modelId;
		else delete next[activeWorkspace];
		setSettings({ defaultModels: next });
	};
	return (
		<>
			{/* 模型槽位**永远在**：列表没到 / 引擎暂时取不到时显示占位，
			    免得用户以为功能坏了（"怎么又不见了" 就是清空列表造成的） */}
			{part !== "thinking" && snapshot && snapshot.models.length > 0 && snapshot.engineCapabilities.modelSwitch ? (
				<ModelPicker
					models={snapshot.models}
					// 面板里停用的模型不在选择器里出现（空白名单 = 全开）
					enabledAllowlist={snapshot.enabledModels ?? []}
					current={snapshot.model}
					defaultModel={defaultModels[activeWorkspace] ?? null}
					onSetDefault={setProjectDefault}
					onSwitch={
						surface
							? surface.switchModel
							: (modelId) => setModel(modelId, snapshot?.active.conversationId ?? null)
					}
				/>
			) : part !== "thinking" ? (
				<span
					className="tool-chip tool-static mono"
					title={
						snapshot?.model
							? t("这个会话使用的模型", "The model this conversation uses")
							: t("还没打开会话，模型列表要等会话就绪", "No conversation yet — the model list appears once one is open")
					}
				>
					<span className="tool-icon" aria-hidden="true">
						<ModelIcon />
					</span>
					<span>{snapshot?.model ?? t("模型未就绪", "Model not ready")}</span>
				</span>
			) : null}
			{/* 思考强度：只有该模型支持推理（档位列表非空）时才画，不支持就整颗不出现 */}
			{part !== "model" ? (
				<ThinkingPicker level={snapshot?.thinkingLevel ?? null} levels={snapshot?.thinkingLevels ?? []} />
			) : null}
		</>
	);
}
