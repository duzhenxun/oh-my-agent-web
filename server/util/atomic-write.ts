/**
 * 原子写的公共细节：**临时文件名必须唯一**。
 *
 * 以前各处都是 `${path}.tmp-${process.pid}-${Date.now()}`，看起来够随机，其实不然：
 * 同一个进程在**同一个毫秒**里发起两次写（两个并发 HTTP 请求、一次扫描撞上一次保存），
 * 两次算出来的临时路径**完全相同**。先完成的那个把临时文件 rename 走了，
 * 后一个 rename 就直接 `ENOENT`（实测过：并发 upsert 24 个 provider 会抛
 * `ENOENT ... rename models.json.tmp-3018-1793030893334`）。
 *
 * 这里在 pid + 时间戳之后再加一个进程内自增序号，彻底消掉撞名 ——
 * 即使调用方没有串行化（队列之外本来也还有别的写者），也不会互相踩。
 */
let sequence = 0;

/** 给某个目标路径生成一个**进程内唯一**的临时路径 */
export function tempPathFor(path: string): string {
	sequence = (sequence + 1) % Number.MAX_SAFE_INTEGER;
	return `${path}.tmp-${process.pid}-${Date.now()}-${sequence}`;
}
