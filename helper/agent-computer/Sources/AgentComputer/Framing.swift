import Foundation

/// helper socket 的帧格式：`uint32 小端长度 + UTF-8 JSON`。
/// 必须与 oh-my-agent-web 的 `server/computer/framing.ts` 完全一致。
enum Framing {
	static let headerBytes = 4
	static let maxFrameBytes = 8 * 1024 * 1024

	static func encode(_ value: [String: Any]) throws -> Data {
		let body = try JSONSerialization.data(withJSONObject: value, options: [])
		guard !body.isEmpty, body.count <= maxFrameBytes else {
			throw HelperError("badArguments", "帧大小超出范围：\(body.count)")
		}
		var out = Data(capacity: headerBytes + body.count)
		var length = UInt32(body.count).littleEndian
		withUnsafeBytes(of: &length) { out.append(contentsOf: $0) }
		out.append(body)
		return out
	}

	/// 增量解帧：socket 的字节流可能切在任意位置，攒够一帧才解析。
	final class Decoder {
		private var buffer = Data()

		/// 返回本次新解出的完整帧；数据不够时返回空数组。
		func push(_ chunk: Data) throws -> [[String: Any]] {
			buffer.append(chunk)
			var frames: [[String: Any]] = []
			while buffer.count >= Framing.headerBytes {
				let header = buffer.prefix(Framing.headerBytes)
				let length = header.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
				guard length > 0, Int(length) <= Framing.maxFrameBytes else {
					throw HelperError("helperFault", "帧长度非法：\(length)")
				}
				let total = Framing.headerBytes + Int(length)
				guard buffer.count >= total else { break }
				let body = buffer.subdata(in: Framing.headerBytes..<total)
				buffer.removeSubrange(0..<total)
				let parsed = try JSONSerialization.jsonObject(with: body)
				guard let dict = parsed as? [String: Any] else {
					throw HelperError("helperFault", "帧内容不是 JSON 对象")
				}
				frames.append(dict)
			}
			return frames
		}
	}
}
