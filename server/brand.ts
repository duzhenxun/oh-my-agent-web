/** 服务端侧的同一个自称（登录框 realm、推送通知兜底标题）——与 web/src/brand.ts 保持一致 */
export const BRAND_NAME = "oh-my-agent-web";

/**
 * 项目迁移目标：这个仓库已经不再往下演进，接手的是 pop-agent。
 *
 * 为什么单独抽常量而不是就地写字符串：命令行有三处要印它（前台 banner、后台启动回执、
 * `--help`），抄三遍迟早漏一处；web 那边也有自己的一份 `MIGRATION_URL`
 * （web 不能 import server，见 ADR-0002 纪律①）——改地址时两处一起改。
 */
export const MIGRATION_URL = "https://github.com/duzhenxun/pop-agent";

/** 命令行里用的那句（终端文案统一英文，理由见 index.ts 的 printStartBanner 注释） */
export const MIGRATION_NOTICE = `This project has been upgraded — please use ${MIGRATION_URL}`;
