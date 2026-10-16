/**
 * 协议 shim（ADR-0002 纪律①）。
 *
 * ⚠️ 这个文件**只允许重导出** `server/protocol.ts`：不许定义类型、不许写逻辑。
 * 守卫 `scripts/check-protocol-sync.mjs` 会检查「每一句都是 export … from …」，
 * 以及「protocol.ts 里的每个协议类型都在这里出现」。
 */
export type {
	ApprovalDecision,
	ApproveRequest,
	ClientRequest,
	ClientRequestType,
	ConversationMeta,
	ErrorBlock,
	FilesMeta,
	GetStateRequest,
	InterruptRequest,
	MessageBlock,
	MessageDeltaEvent,
	NewChatRequest,
	Notice,
	NoticeEvent,
	PendingApproval,
	ProtocolError,
	RunningState,
	SendMessageRequest,
	ServerEvent,
	ServerMessage,
	ServerReply,
	SwitchConversationRequest,
	Snapshot,
	SnapshotEvent,
	TerminalMeta,
	TextBlock,
	ToolBlock,
	UiMessage,
} from "../../server/protocol.ts";

export { PROTOCOL_VERSION, SNAPSHOT_MESSAGE_LIMIT, TOOL_EXCERPT_CHARS } from "../../server/protocol.ts";
