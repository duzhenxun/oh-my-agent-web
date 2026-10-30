import { useAppSelector } from "../store.ts";
import type { ChatSurface } from "../chat-surface.ts";
import { setModel, setSettings } from "../ws.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import { ThinkingPicker } from "./ThinkingPicker.tsx";
import { useT } from "../use-language.ts";

/**
 * 「这一轮怎么跑」的两颗：**模型 + 思考强度**。
 *
 * 落点（用户 2026-10-28 定）：
 *  - **桌面端**：在**底部状态栏**，排在引擎那颗（`PI ▾`）**左边** —— 跟「放行」（审批模式）并排。
 *    它们本来就是一类的：审批 / 模型 / 强度 / 引擎都是「这一步用谁、跑多细」的开关，
 *    搁一条里比搁输入框上方更好找（以前就在状态栏，`statusbar.css` 里那套
 *    `.statusbar .model-trigger` 的缩小样式就是给这个位置留的）。
 *  - **手机端**：仍然留在输入框上方那一排（用户要求「手机版保持原样」）——
 *    手机的状态栏是一条横向可滚动的窄条，再塞两颗进去等于把它们藏到屏幕外。
 *  - **临时聊天**（`surface`）：留在它自己那条输入框上方。它是**另一条对话**，
 *    有自己的模型与默认模型偏好；状态栏那两颗说的是主对话，替不了它。
 *
 * 所以这一份 UI 有三个落点，抽成一个组件：占位（模型列表还没到）、回退、项目默认模型
 * 这些逻辑只写一遍，不会两边慢慢走形。
 */
export function ModelChips({ surface }: { surface?: ChatSurface }) {
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
			{snapshot && snapshot.models.length > 0 && snapshot.engineCapabilities.modelSwitch ? (
				<ModelPicker
					models={snapshot.models}
					// 面板里停用的模型不在选择器里出现（空白名单 = 全开）
					enabledAllowlist={snapshot.enabledModels ?? []}
					current={snapshot.model}
					defaultModel={defaultModels[activeWorkspace] ?? null}
					onSetDefault={setProjectDefault}
					onSwitch={surface ? surface.switchModel : setModel}
				/>
			) : (
				<span
					className="tool-chip tool-static mono"
					title={
						snapshot?.model
							? t("这个会话使用的模型", "The model this conversation uses")
							: t("还没打开会话，模型列表要等会话就绪", "No conversation yet — the model list appears once one is open")
					}
				>
					<span className="tool-icon" aria-hidden="true">
						🤖
					</span>
					<span>{snapshot?.model ?? t("模型未就绪", "Model not ready")}</span>
				</span>
			)}
			{/* 思考强度：只有该模型支持推理（档位列表非空）时才画，不支持就整颗不出现 */}
			<ThinkingPicker level={snapshot?.thinkingLevel ?? null} levels={snapshot?.thinkingLevels ?? []} />
		</>
	);
}
