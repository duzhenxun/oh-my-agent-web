/**
 * 「纯文本输入框」的公共属性包：让**浏览器和系统输入法别乱猜**。
 *
 * 用户 2026-10-30（手机版）：「点那个输入框的时候，输入法上面默认出来几个小图标」——
 * 就是 iOS 键盘上方那排 QuickType 条，里面最扎眼的是**密码钥匙**（AutoFill）
 * 和猜词/定位之类系统塞进来的东西。它们出现的原因不是我们画的，而是：
 *   ① Safari 把这一格当成「可能是账号/密码框」，于是挂上钥匙、自动填充；
 *   ② 没关自动更正/拼写检查，系统就常驻一条「猜你下一句」的联想条。
 *
 * 网页能做的只有这两件事，都靠属性：
 *   - `autoComplete="off"` + 不像登录字段的 `name` → 不触发 AutoFill（钥匙消失）；
 *     注意：Safari 对 `type="password"` 会**无视** off，所以别给文本格套 password 类型；
 *   - `autoCorrect="off"` + `spellCheck={false}` → 关掉自动更正/拼写检查，联想条大概率一起收掉；
 *   - `autoCapitalize="sentences"`：英文按句首大写（中文无所谓），别用 `off` 把英文用户坑了。
 *
 * **它压不掉什么**（写在这儿免得下次又当成 bug 查）：键盘本身的切换键、语音、表情、
 * 剪贴板这些按键是输入法自己画的界面，网页既看不见也删不掉；用户真嫌多，
 * 只能在系统设置里关（iOS：设置 › 通用 › 键盘 › 预测），或者在输入法 App 里关它的工具栏。
 *
 * 用法：`<textarea {...PLAIN_TEXT_INPUT} />`（`input` 也通用）；需要单独定 `enterKeyHint`
 * 的场合照常写在后面，别塞进这个包 —— 它跟「别猜」无关，是「回车键印什么字」。
 */
export const PLAIN_TEXT_INPUT = {
	/* 中性名字：`user` / `email` / `password` / `tel` 这些会被 Safari 认成登录字段，
	 * 一旦命中就会挂上钥匙和「自动填充」建议，所以名字起个跟语义无关的。 */
	name: "oh-my-agent-web-text",
	autoComplete: "off",
	autoCorrect: "off",
	autoCapitalize: "sentences",
	spellCheck: false,
	/* 明确声明是纯文本：不声明时个别输入法会往「搜索/网址」那套联想上靠 */
	inputMode: "text",
} as const;
