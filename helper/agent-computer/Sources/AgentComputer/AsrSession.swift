import AVFoundation
import Foundation
import Speech

/// 本地语音识别（原先是独立的 ASRBridge.app，2026-11 合并进 helper）。
///
/// 为什么必须在原生侧：网页拿不到 Apple 的离线识别引擎（`SFSpeechRecognizer`），
/// Chrome 的 Web Speech 必须把音频传到 Google —— 断网或连不上 Google 时直接报 network。
/// 这条通道补的就是这一格：浏览器采音 → 服务端 → 这里识别 → partial/final 回去。
///
/// 和原桥的区别（合并时改的）：
///   - 原来是一支独立进程，用 `open -n -a` 拉起，自己连服务端的 socket；
///     现在常驻在 helper 里，由 RPC 的 `asr.*` 方法驱动。
///   - 原来结果直接往 socket 写（服务端被动接收）；现在结果放进共享状态，
///     由 `asr.feed` / `asr.end` 的返回值取走 —— 协议保持"一问一答"，不引入事件推送。
///
/// 线程模型：识别回调来自 SFSpeech 自己的队列，RPC 来自 socket 线程，两边都只碰
/// 这几个带锁的状态；会话操作走独立的 `queue`，**不占 Protocol 的串行队列** ——
/// 一句话要跑好几秒，占着的话点击/截图全被堵死。
final class AsrSession {
	static let shared = AsrSession()

	struct Status {
		let authorized: Bool
		let locale: String
		let onDevice: Bool
		let message: String?
	}

	private let queue = DispatchQueue(label: "com.computeruseturbo.minhelper.asr")
	private let lock = NSLock()

	/// 识别语言：默认中文，可用环境变量覆盖（与原来那支桥保持一致）
	private var localeIdentifier =
		ProcessInfo.processInfo.environment["OH_MY_AGENT_ASR_LOCALE"] ?? "zh-CN"

	private var recognizer: SFSpeechRecognizer?
	private var current: Utterance?
	/// 已经 endAudio、还在等 final 的句子：持有引用，别让它被回收（回调还要用）
	private var finishing: [Utterance] = []

	/// 最新一次 partial（`asr.feed` 直接把它带回去）
	private var latestText = ""
	/// `asr.end` 等 final 用的信号量
	private var finalSignal: DispatchSemaphore?
	private var finalText: String?

	private init() {}

	// MARK: - 状态

	/// 只报告，不弹系统授权框（面板轮询会频繁调它）
	func status() -> Status {
		let authorization = SFSpeechRecognizer.authorizationStatus()
		let authorized = authorization == .authorized
		let locale = localeIdentifier
		if authorized {
			let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale))
			let onDevice = recognizer?.supportsOnDeviceRecognition ?? false
			return Status(
				authorized: true,
				locale: locale,
				onDevice: onDevice,
				message: onDevice ? nil : "\(locale) 在这台机器上不支持离线识别"
			)
		}
		let message: String?
		switch authorization {
		case .denied, .restricted:
			message = "语音识别未授权：系统设置 → 隐私与安全性 → 语音识别，允许 Agent Computer 后再试"
		default:
			message = nil
		}
		return Status(authorized: false, locale: locale, onDevice: false, message: message)
	}

	// MARK: - 准备（授权 + 识别器）

	/// 首次调用可能弹系统授权框（用户不点就一直等，最多 60 秒）
	func prepare() throws -> Status {
		let authorization = requestAuthorization()
		guard authorization == .authorized else {
			throw HelperError(
				"asrNotAuthorized",
				"语音识别未授权（status=\(authorization.rawValue)）：系统设置 → 隐私与安全性 → 语音识别，允许 Agent Computer 后再试",
				retryable: false
			)
		}
		guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier)) else {
			throw HelperError("asrUnavailable", "系统里没有 \(localeIdentifier) 的语音识别器", retryable: false)
		}
		guard recognizer.supportsOnDeviceRecognition else {
			throw HelperError(
				"asrUnavailable",
				"\(localeIdentifier) 在这台机器上不支持离线识别（这条通道刻意不走联网识别）",
				retryable: false
			)
		}
		queue.sync { self.recognizer = recognizer }
		return Status(authorized: true, locale: localeIdentifier, onDevice: true, message: nil)
	}

	private func requestAuthorization() -> SFSpeechRecognizerAuthorizationStatus {
		var status = SFSpeechRecognizer.authorizationStatus()
		if status != .notDetermined { return status }
		let semaphore = DispatchSemaphore(value: 0)
		SFSpeechRecognizer.requestAuthorization { next in
			status = next
			semaphore.signal()
		}
		// 系统弹框没人点的时候别把 RPC 挂死：60 秒后按「没授权」处理
		_ = semaphore.wait(timeout: .now() + 60)
		return status
	}

	// MARK: - 一句话

	/// 开始新的一句（上一句没结束时先丢弃）
	func begin() throws {
		var started: Utterance?
		queue.sync {
			guard let recognizer = self.recognizer else { return }
			started = self.makeUtterance(recognizer: recognizer)
		}
		guard started != nil else {
			throw HelperError("asrNotReady", "识别器还没准备好，先调 asr.start", retryable: true)
		}
	}

	/// 切语言（识别器在 `prepare()` 里按它重建）
	func setLocale(_ identifier: String) {
		queue.sync {
			guard !identifier.isEmpty, identifier != self.localeIdentifier else { return }
			self.localeIdentifier = identifier
			// 语言变了，旧识别器作废，下次 prepare 重建
			self.recognizer = nil
		}
	}

	/// 在 `queue` 上创建一份新会话（调用方负责已在 queue 内）
	private func makeUtterance(recognizer: SFSpeechRecognizer) -> Utterance {
		setLatest("")
		setFinal(nil)
		current = nil
		let session = Utterance(
			recognizer: recognizer,
			onPartial: { [weak self] text in self?.setLatest(text) },
			onFinal: { [weak self] text in self?.resolveFinal(text) },
			onError: { [weak self] message in self?.failCurrent(message) }
		)
		current = session
		return session
	}

	/// 追加一块 16kHz 单声道 int16 小端 PCM；返回当前 partial（边说边出，会回改前面的字）
	func feed(_ pcm: Data) -> String {
		queue.sync {
			// 没显式 start 也能用：第一块音频自己开一句（与原桥 opAudio 的行为一致）
			if self.current == nil, let recognizer = self.recognizer {
				_ = self.makeUtterance(recognizer: recognizer)
			}
			self.current?.append(pcm)
		}
		lock.lock()
		defer { lock.unlock() }
		return latestText
	}

	/// 这一句说完了：等 final 落地后返回全文（超时就把已经认出来的当成结果）
	func end(timeout: TimeInterval = 8) -> String {
		let signal = DispatchSemaphore(value: 0)
		queue.sync {
			guard let session = self.current else { return }
			self.finishing.append(session)
			self.current = nil
			self.setFinal(nil)
			self.setFinalSignal(signal)
			session.endAudio()
			// final 落地后把引用放掉：finishing 只增不减的话，每说一句就永久留一个
			// 已结束的会话（连同它的 SFSpeechRecognitionTask）在内存里。
			self.queue.asyncAfter(deadline: .now() + 30) { [weak self] in
				guard let self, !self.finishing.isEmpty else { return }
				self.finishing.removeFirst()
			}
		}
		let waited = signal.wait(timeout: .now() + timeout)
		lock.lock()
		let text = finalText ?? latestText
		finalSignal = nil
		lock.unlock()
		if waited == .timedOut {
			Log.write("asr.end 等待 final 超时（\(Int(timeout))s），返回已有结果")
		}
		return text
	}

	/// 放弃当前这句（用户取消听写）
	func cancel() {
		queue.sync {
			self.current = nil
			self.setLatest("")
			self.setFinal(nil)
			self.finishing.removeAll()
		}
	}

	// MARK: - 回调

	private func setLatest(_ text: String) {
		lock.lock()
		latestText = text
		lock.unlock()
	}

	private func setFinal(_ text: String?) {
		lock.lock()
		finalText = text
		lock.unlock()
	}

	private func setFinalSignal(_ signal: DispatchSemaphore?) {
		lock.lock()
		finalSignal = signal
		lock.unlock()
	}

	private func resolveFinal(_ text: String) {
		lock.lock()
		latestText = text
		finalText = text
		let signal = finalSignal
		finalSignal = nil
		lock.unlock()
		signal?.signal()
	}

	private func failCurrent(_ message: String) {
		// 出错也把等待方放开，否则 asr.end 会一直等到超时
		lock.lock()
		let text = latestText
		finalText = text
		let signal = finalSignal
		finalSignal = nil
		lock.unlock()
		Log.write("asr 识别出错：\(message)")
		signal?.signal()
	}
}

// MARK: - 一句一次识别

/// 16kHz 单声道 int16：SFSpeech 最认的格式，也正好是浏览器 WebAudio 能直接给出的
private final class Utterance {
	let format = AVAudioFormat(
		commonFormat: .pcmFormatFloat32,
		sampleRate: 16_000,
		channels: 1,
		interleaved: false
	)!
	private let request = SFSpeechAudioBufferRecognitionRequest()
	private var task: SFSpeechRecognitionTask?
	private var lastEmitted = ""
	private var closed = false

	private let onPartial: (String) -> Void
	private let onFinal: (String) -> Void
	private let onError: (String) -> Void

	init(
		recognizer: SFSpeechRecognizer,
		onPartial: @escaping (String) -> Void,
		onFinal: @escaping (String) -> Void,
		onError: @escaping (String) -> Void
	) {
		self.onPartial = onPartial
		self.onFinal = onFinal
		self.onError = onError

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
					self.onPartial(text)
				}
				if result.isFinal {
					self.onFinal(text)
					self.task = nil
				}
			}
			if let error {
				// 203/1110「没听到话」、216「被取消」这些不是故障：把已经认出来的当成结果
				let code = (error as NSError).code
				let benign = code == 203 || code == 216 || code == 1110
				if benign {
					self.onFinal(self.lastEmitted)
				} else {
					self.onError(error.localizedDescription)
				}
				self.task = nil
			}
		}
	}

	func append(_ pcm: Data) {
		guard !closed, pcm.count >= 2 else { return }
		let frames = AVAudioFrameCount(pcm.count / 2)
		guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return }
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
