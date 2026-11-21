// 语音识别桥（macOS 原生 SFSpeechRecognizer，**强制离线**）。
//
// 为什么需要它：网页拿不到 Apple 的离线识别引擎（SFSpeechRecognizer 只在原生侧），
// 而 Chrome 的 Web Speech 必须把音频传到 Google —— 在连不上 Google 的网络里直接报 network。
// 这支小桥就是补上这一格：浏览器采音 → 服务端 → 这里识别 → partial 结果回去。
//
// 启动方式（两种）：
//   asr-bridge --socket /path/to/asr.sock   ← 服务端用 LaunchServices（open）拉起，
//                                              这样 TCC 认的主体是**它自己**（见 README）；
//   asr-bridge                              ← 直接读写 stdin/stdout，调试用。
//
// 输入（二进制分帧）：4 字节大端长度 + 载荷
//   载荷首字节 = 操作码：
//     'A'  音频（其余是 16kHz 单声道 int16 小端 PCM）
//     'E'  这一句说完了（endAudio，等 final）
//     'X'  退出
// 输出（stdout，每行一个 JSON）：
//   {"type":"auth","status":"authorized"}
//   {"type":"ready","locale":"zh-CN","onDevice":true}
//   {"type":"partial","text":"…"}   边说边出，会回改前面的字（流式识别的正常现象）
//   {"type":"final","text":"…"}
//   {"type":"error","message":"…"}
//
// 生命周期：服务端常驻拉起一支，模型/识别器只初始化一次；每句话复用同一进程。

import AVFoundation
import Foundation
import Speech

let opAudio: UInt8 = 0x41
let opEnd: UInt8 = 0x45
let opQuit: UInt8 = 0x58

let outQueue = DispatchQueue(label: "asr.out")
/// 输出句柄：socket 模式下就是那条 socket，否则 stdout
let stdoutHandle: FileHandle = {
	if socketPathFromArguments() == nil { return FileHandle.standardOutput }
	// 先连上；连不上就没有地方吐结果了，直接失败（stderr 留一行给服务端日志）
	guard let fd = connectUnixSocket(socketPathFromArguments()!) else {
		FileHandle.standardError.write(Data("asr-bridge: 连不上服务端 socket\n".utf8))
		exit(2)
	}
	return FileHandle(fileDescriptor: fd, closeOnDealloc: true)
}()

// 连上了就先报一声：系统授权提示这时可能还没弹（服务端据此显示「等待授权」）
emit(["type": "starting"])

/// 一行一个 JSON，串行写（回调来自不同队列，不能交错）
func emit(_ object: [String: Any]) {
	guard let data = try? JSONSerialization.data(withJSONObject: object, options: []),
		var text = String(data: data, encoding: .utf8)
	else { return }
	text += "\n"
	outQueue.async {
		stdoutHandle.write(Data(text.utf8))
	}
}

func fail(_ message: String) -> Never {
	emit(["type": "error", "message": message])
	exit(1)
}

// ---- unix socket（由服务端用 open 拉起时走这条路）--------------------------
/// 连到服务端预先 bind 好的 unix socket；最多重试 ~5 秒（open 启动有延迟）
func connectUnixSocket(_ path: String) -> Int32? {
	for attempt in 0..<25 {
		let fd = socket(AF_UNIX, SOCK_STREAM, 0)
		if fd >= 0 {
			var addr = sockaddr_un()
			addr.sun_family = sa_family_t(AF_UNIX)
			let bytes = Array(path.utf8)
			if bytes.count < MemoryLayout.size(ofValue: addr.sun_path) {
				withUnsafeMutablePointer(to: &addr.sun_path) { pointer in
					pointer.withMemoryRebound(to: CChar.self, capacity: bytes.count + 1) { destination in
						for (index, byte) in bytes.enumerated() { destination[index] = CChar(bitPattern: byte) }
						destination[bytes.count] = 0
					}
				}
				let size = socklen_t(MemoryLayout<sockaddr_un>.size)
				let connected = withUnsafePointer(to: &addr) { raw in
					raw.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, size) }
				}
				if connected == 0 { return fd }
			}
			close(fd)
		}
		// 服务端可能还没 bind（open 比它快的时候）
		if attempt < 24 { usleep(200_000) }
	}
	return nil
}

/// 解析 `--socket <path>`
func socketPathFromArguments() -> String? {
	var index = 1
	let args = CommandLine.arguments
	while index < args.count {
		if args[index] == "--socket", index + 1 < args.count { return args[index + 1] }
		index += 1
	}
	return nil
}

// ---- 授权 ----------------------------------------------------------------
// CLI 也要走这一步：TCC 认的是 Info.plist 里的 NSSpeechRecognitionUsageDescription
// （见 build.sh 里 -sectcreate 把 plist 嵌进二进制的那一段）。
func requestAuthorization() -> SFSpeechRecognizerAuthorizationStatus {
	var status = SFSpeechRecognizer.authorizationStatus()
	if status != .notDetermined { return status }
	let semaphore = DispatchSemaphore(value: 0)
	SFSpeechRecognizer.requestAuthorization { next in
		status = next
		semaphore.signal()
	}
	// 系统提示框没人点的时候别把进程挂死：60 秒后按「没授权」处理
	_ = semaphore.wait(timeout: .now() + 60)
	return status
}

let authorization = requestAuthorization()
guard authorization == .authorized else {
	fail("语音识别未授权（status=\(authorization.rawValue)）：系统设置 → 隐私与安全性 → 语音识别，允许运行本服务的程序后再试")
}
emit(["type": "auth", "status": "authorized"])

// ---- 识别器（强制离线）----------------------------------------------------
let localeIdentifier = ProcessInfo.processInfo.environment["OH_MY_AGENT_ASR_LOCALE"] ?? "zh-CN"
guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier)) else {
	fail("系统里没有 \(localeIdentifier) 的语音识别器")
}
guard recognizer.supportsOnDeviceRecognition else {
	fail("\(localeIdentifier) 在这台机器上不支持离线识别（不要联网识别，所以这里直接报错）")
}
emit(["type": "ready", "locale": localeIdentifier, "onDevice": true])

// ---- 一句一次识别 --------------------------------------------------------
/// 16kHz 单声道 int16：SFSpeech 最认的格式，也正好是浏览器 WebAudio 能直接给出的
final class Utterance {
	let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
	private let request = SFSpeechAudioBufferRecognitionRequest()
	private var task: SFSpeechRecognitionTask?
	private var lastEmitted = ""
	private var closed = false

	init(recognizer: SFSpeechRecognizer) {
		request.shouldReportPartialResults = true
		// **强制离线**：不联网、不问 Apple 的服务器（这正是这条通道存在的理由）
		request.requiresOnDeviceRecognition = true
		request.taskHint = .dictation
		if #available(macOS 13.0, *) {
			// 原生识别的标点质量比流式小模型好得多，没必要让用户听一段没标点的文字
			request.addsPunctuation = true
		}
		task = recognizer.recognitionTask(with: request) { [weak self] result, error in
			guard let self else { return }
			if let result {
				let text = result.bestTranscription.formattedString
				if text != self.lastEmitted {
					self.lastEmitted = text
					emit(["type": "partial", "text": text])
				}
				if result.isFinal {
					emit(["type": "final", "text": text])
					self.task = nil
				}
			}
			if let error {
				// 203/1110「没听到话」、216「被取消」这些不是故障：把已经认出来的当成结果
				let code = (error as NSError).code
				let benign = code == 203 || code == 216 || code == 1110
				if benign {
					emit(["type": "final", "text": self.lastEmitted])
				} else {
					emit(["type": "error", "message": error.localizedDescription])
				}
				self.task = nil
			}
		}
	}

	func append(_ pcm: Data) {
		guard !closed, pcm.count >= 2 else { return }
		let frames = AVAudioFrameCount(pcm.count / 2)
		guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else {
			return
		}
		buffer.frameLength = frames
		// 入参是 16k 单声道 int16 小端：转成 float32（SFSpeech 最认的格式）
		pcm.withUnsafeBytes { raw in
			guard let base = raw.baseAddress?.assumingMemoryBound(to: Int16.self),
				let channel = buffer.floatChannelData?[0]
			else { return }
			let count = Int(frames)
			for index in 0..<count {
				channel[index] = Float(Int16(littleEndian: base[index])) / 32768.0
			}
		}
		request.append(buffer)
	}

	func endAudio() {
		guard !closed else { return }
		closed = true
		request.endAudio()
	}
}

var current: Utterance?
/// 已经 endAudio、还在等 final 的句子：持有引用，别让它被回收（回调还要用）
var finishing: [Utterance] = []

// ---- 读帧（socket 或 stdin，同一套分帧）-----------------------
let stdinHandle: FileHandle = {
	if socketPathFromArguments() != nil {
		// 和输出共用同一个 fd（unix socket 全双工）
		return FileHandle(fileDescriptor: stdoutHandle.fileDescriptor)
	}
	return FileHandle.standardInput
}()

func readExactly(_ count: Int) -> Data? {
	var data = Data(capacity: count)
	while data.count < count {
		guard let piece = try? stdinHandle.read(upToCount: count - data.count), !piece.isEmpty
		else { return nil }  // 父进程关掉了管子
		data.append(piece)
	}
	return data
}

func bigEndianLength(_ header: Data) -> Int {
	let bytes = [UInt8](header)
	return (Int(bytes[0]) << 24) | (Int(bytes[1]) << 16) | (Int(bytes[2]) << 8) | Int(bytes[3])
}

/// 会话状态只在这条串行队列上改（读帧在后台线程，识别回调在别的线程）
let stateQueue = DispatchQueue(label: "asr.state")

func handle(_ opcode: UInt8, _ body: Data) {
	switch opcode {
	case opAudio:
		stateQueue.async {
			if current == nil { current = Utterance(recognizer: recognizer) }
			current?.append(body)
		}
	case opEnd:
		stateQueue.async {
			guard let session = current else { return }
			finishing.append(session)
			session.endAudio()
			current = nil
			// 等 final 落地后把引用放掉（异常情况下也别越攒越多）
			DispatchQueue.global().asyncAfter(deadline: .now() + 30) {
				stateQueue.async { if !finishing.isEmpty { finishing.removeFirst() } }
			}
		}
	case opQuit:
		exit(0)
	default:
		return
	}
}

// 读帧放后台线程：主线程要留给 SFSpeech 的回调（踩过：主线程死在 read 上，
// 识别任务创建成功、音频也 append 了，但 partial/final 一个都不出来）。
DispatchQueue.global(qos: .userInitiated).async {
	while true {
		guard let header = readExactly(4) else { break }
		let length = bigEndianLength(header)
		guard length > 0, let payload = readExactly(length) else { break }
		handle(payload[payload.startIndex], Data(payload.dropFirst()))
	}
	exit(0)
}

// 主线程交给 dispatch：不然 run loop 不转，回调同样不会来
dispatchMain()
