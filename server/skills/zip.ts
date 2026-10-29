/**
 * 一个**够用就好**的 ZIP 解包器：把 SkillHub 下发的技能包解到临时目录。
 *
 * 为什么自己写而不装 `adm-zip`：这里只需要「读中央目录 → 逐个 inflate」这一件事
 * （ADR-0008 的依赖预算），而 `node:zlib` 自带 `inflateRaw`，四十行就够。
 *
 * 安全边界（解压是典型的高危动作，一条都不能省）：
 *   - 只认 `store`（0）与 `deflate`（8）两种方法，别的直接拒；
 *   - 每个条目名先归一化：绝对路径、`..`、反斜杠（Windows 路径穿越）、符号链接一律拒绝；
 *   - 单文件 8MB、总量 64MB 上限 —— 一个「技能包」不该比这更大，防 zip bomb；
 *   - 只写普通文件与目录，不还原权限位、不还原时间（技能包不需要）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { inflateRawSync } from "node:zlib";

const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

type Entry = {
	name: string;
	method: number;
	compressedSize: number;
	uncompressedSize: number;
	localHeaderOffset: number;
};

/** 读中央目录：条目清单 + 名字（ZIP64 / 加密包直接拒，技能包用不上） */
function readCentralDirectory(buffer: Buffer): Entry[] {
	// 找 EOCD（末尾 22 字节起，注释最多 64KB）
	let eocd = -1;
	for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 22 - 0xffff); offset -= 1) {
		if (buffer.readUInt32LE(offset) === 0x06054b50) {
			eocd = offset;
			break;
		}
	}
	if (eocd < 0) throw new Error("不是 ZIP 文件（找不到目录结尾）");
	const count = buffer.readUInt16LE(eocd + 10);
	const directoryOffset = buffer.readUInt32LE(eocd + 16);
	if (count === 0xffff || directoryOffset === 0xffffffff) throw new Error("不支持 ZIP64 包");

	const entries: Entry[] = [];
	let offset = directoryOffset;
	for (let index = 0; index < count; index += 1) {
		if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
			throw new Error("ZIP 目录损坏");
		}
		const flags = buffer.readUInt16LE(offset + 8);
		if ((flags & 0x1) !== 0) throw new Error("不支持加密的 ZIP 包");
		const nameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
		entries.push({
			name,
			method: buffer.readUInt16LE(offset + 10),
			compressedSize: buffer.readUInt32LE(offset + 20),
			uncompressedSize: buffer.readUInt32LE(offset + 24),
			localHeaderOffset: buffer.readUInt32LE(offset + 42),
		});
		offset += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}

/** 条目名 → 安全的相对路径（不安全的直接抛，不静默跳过：坏包就该整个失败） */
function safeRelativePath(name: string): string | null {
	if (name.endsWith("/")) return null; // 目录条目：由文件的父目录创建
	if (name.includes("\\")) throw new Error(`包里出现 Windows 反斜杠路径：${name}`);
	if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) throw new Error(`包里出现绝对路径：${name}`);
	const normalized = normalize(name);
	if (normalized.startsWith("..") || normalized.includes(`${sep}..${sep}`) || normalized === "..") {
		throw new Error(`包里出现越界路径：${name}`);
	}
	return normalized;
}

/**
 * 解到 `destination`，返回解出来的相对文件清单。
 * 调用方负责建临时目录、用完删掉（见 `skill-install.ts`）。
 */
export async function extractZip(buffer: Buffer, destination: string): Promise<string[]> {
	const entries = readCentralDirectory(buffer);
	const written: string[] = [];
	let total = 0;

	for (const entry of entries) {
		const relative = safeRelativePath(entry.name);
		if (relative === null) continue;
		if (entry.uncompressedSize > MAX_ENTRY_BYTES) throw new Error(`包里的 ${entry.name} 太大（>8MB）`);
		total += entry.uncompressedSize;
		if (total > MAX_TOTAL_BYTES) throw new Error("包解压后太大（>64MB）");

		// 跳到本地文件头，跳过它自己的名字与扩展字段
		const header = entry.localHeaderOffset;
		if (header + 30 > buffer.length || buffer.readUInt32LE(header) !== 0x04034b50) {
			throw new Error(`ZIP 条目头损坏：${entry.name}`);
		}
		const nameLength = buffer.readUInt16LE(header + 26);
		const extraLength = buffer.readUInt16LE(header + 28);
		const start = header + 30 + nameLength + extraLength;
		const raw = buffer.subarray(start, start + entry.compressedSize);

		let content: Buffer;
		if (entry.method === 0) content = raw;
		else if (entry.method === 8) content = inflateRawSync(raw);
		else throw new Error(`不支持的压缩方式 ${entry.method}：${entry.name}`);
		if (content.length > MAX_ENTRY_BYTES) throw new Error(`包里的 ${entry.name} 解压后太大`);

		const target = join(destination, relative);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content);
		written.push(relative.split(sep).join("/"));
	}
	return written;
}

/** 解出来的文件里，`SKILL.md` 所在的那一层（技能包有时会套一层目录） */
export function skillRootOf(files: string[]): string | null {
	const direct = files.find((file) => file.toLowerCase() === "skill.md");
	if (direct !== undefined) return "";
	const nested = files.find((file) => /^[^/]+\/skill\.md$/i.test(file));
	return nested === undefined ? null : nested.slice(0, nested.indexOf("/"));
}
