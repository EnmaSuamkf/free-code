import AppKit
import Foundation

final class HostProcessModel: ObservableObject {
	/// Finder-launched `.app` often has `currentDirectoryPath` `/`; default workspace to home like Terminal `~`.
	private static func initialWorkspaceRootForMacApp() -> URL {
		let cwd = FileManager.default.currentDirectoryPath
		if cwd == "/" || cwd.isEmpty {
			return FileManager.default.homeDirectoryForCurrentUser
		}
		return URL(fileURLWithPath: cwd)
	}

	@Published var workspaceRoot: URL = HostProcessModel.initialWorkspaceRootForMacApp()
	@Published var lastError: String?

	private var process: Process?
	private var pipeIn: Pipe?
	private var pipeOut: Pipe?
	private var lineBuffer = Data()

	/// WebView → host JSON lines received before `pipeIn` exists (startup races with the zsh PATH probe).
	private var pendingWebviewToHostLines: [[String: Any]] = []
	private let pendingWebviewLock = NSLock()
	private static let pendingWebviewMax = 128

	var onHostToWebView: (([String: Any]) -> Void)?

	private static let pathProbeBegin = "FREE_CODE_MAC_PATH_BEGIN"
	private static let pathProbeEnd = "FREE_CODE_MAC_PATH_END"
	private static let networkEnvProbeBegin = "FREE_CODE_MAC_NETENV_BEGIN"
	private static let networkEnvProbeEnd = "FREE_CODE_MAC_NETENV_END"
	private static let pathCacheLock = NSLock()
	private static var cachedLoginPathExtra: String?
	private static var didProbeLoginPath = false
	private static var cachedLoginNetworkEnv: [String: String]?
	private static var didProbeLoginNetworkEnv = false

	/// Keys often set in `~/.zprofile` / `~/.zshrc` but missing from Finder-launched GUI `ProcessInfo` (breaks Node `fetch` / TLS).
	private static let zshNetworkEnvKeys = [
		"HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy",
		"ALL_PROXY", "NO_PROXY", "no_proxy",
		"SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO",
		"NODE_OPTIONS",
	]

	/// Finder-launched apps get a minimal PATH; prepend Homebrew bin dirs so `node` resolves.
	private static func augmentFinderPathWithHomebrew(_ env: inout [String: String]) {
		let brewPrefix = "/opt/homebrew/bin:/usr/local/bin"
		if let path = env["PATH"], !path.isEmpty {
			if !path.contains("/opt/homebrew/bin") && !path.contains("/usr/local/bin") {
				env["PATH"] = brewPrefix + ":" + path
			}
		} else {
			env["PATH"] = brewPrefix + ":/usr/bin:/bin:/usr/sbin:/sbin"
		}
	}

	/// PATH after `~/.zprofile` / `~/.zshrc` (same `-ilc` model as the in-app terminal). Cached for all host children.
	private static func captureZshLoginInteractivePath() -> String? {
		guard FileManager.default.isExecutableFile(atPath: "/bin/zsh") else { return nil }
		var probeEnv = ProcessInfo.processInfo.environment
		augmentFinderPathWithHomebrew(&probeEnv)
		probeEnv["TERM"] = "dumb"
		probeEnv["HOME"] = FileManager.default.homeDirectoryForCurrentUser.path
		let proc = Process()
		proc.executableURL = URL(fileURLWithPath: "/bin/zsh")
		// Delimit PATH so stray `echo` in rc files does not corrupt the parse.
		let cmd = "builtin print -rn -- \"\(pathProbeBegin)\"$PATH\"\(pathProbeEnd)\""
		proc.arguments = ["-ilc", cmd]
		proc.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
		proc.environment = probeEnv
		let out = Pipe()
		proc.standardOutput = out
		proc.standardError = Pipe()
		do {
			try proc.run()
			proc.waitUntilExit()
		} catch {
			return nil
		}
		guard proc.terminationStatus == 0 else { return nil }
		let data = out.fileHandleForReading.readDataToEndOfFile()
		guard var raw = String(data: data, encoding: .utf8) else { return nil }
		raw = raw.trimmingCharacters(in: .whitespacesAndNewlines)
		guard let beginR = raw.range(of: pathProbeBegin) else { return nil }
		let afterBegin = beginR.upperBound
		guard let endR = raw.range(of: pathProbeEnd, range: afterBegin..<raw.endIndex) else { return nil }
		let inner = raw[afterBegin..<endR.lowerBound]
		let s = String(inner).trimmingCharacters(in: .whitespacesAndNewlines)
		return s.isEmpty ? nil : s
	}

	/// Proxy / TLS-related env from login zsh (same `-ilc` model as PATH). Finder GUI processes often omit these, which breaks Node `fetch` to GitHub.
	private static func captureZshLoginNetworkEnv() -> [String: String] {
		guard FileManager.default.isExecutableFile(atPath: "/bin/zsh") else { return [:] }
		let keysJoined = zshNetworkEnvKeys.joined(separator: " ")
		var probeEnv = ProcessInfo.processInfo.environment
		augmentFinderPathWithHomebrew(&probeEnv)
		probeEnv["TERM"] = "dumb"
		probeEnv["HOME"] = FileManager.default.homeDirectoryForCurrentUser.path
		let proc = Process()
		proc.executableURL = URL(fileURLWithPath: "/bin/zsh")
		let us = "\u{1f}"
		let cmd =
			"builtin print -rn -- \"\(networkEnvProbeBegin)\"; for k in \(keysJoined); do v=\"${(P)k}\"; if [[ -n $v ]]; then builtin print -rn -- \"$k\"\(us)\"$v\"\(us); fi; done; builtin print -rn -- \"\(networkEnvProbeEnd)\""
		proc.arguments = ["-ilc", cmd]
		proc.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
		proc.environment = probeEnv
		let out = Pipe()
		proc.standardOutput = out
		proc.standardError = Pipe()
		do {
			try proc.run()
			proc.waitUntilExit()
		} catch {
			return [:]
		}
		guard proc.terminationStatus == 0 else { return [:] }
		let data = out.fileHandleForReading.readDataToEndOfFile()
		guard let raw = String(data: data, encoding: .utf8) else { return [:] }
		guard let beginR = raw.range(of: networkEnvProbeBegin) else { return [:] }
		let afterBegin = beginR.upperBound
		guard let endR = raw.range(of: networkEnvProbeEnd, range: afterBegin..<raw.endIndex) else { return [:] }
		let inner = String(raw[afterBegin..<endR.lowerBound])
		if inner.isEmpty { return [:] }
		let sep = Character(us)
		let parts = inner.split(separator: sep, omittingEmptySubsequences: false).map(String.init).filter { !$0.isEmpty }
		var outMap: [String: String] = [:]
		var i = 0
		while i + 1 < parts.count {
			let key = parts[i]
			let val = parts[i + 1]
			if !key.isEmpty, !val.isEmpty {
				outMap[key] = val
			}
			i += 2
		}
		return outMap
	}

	private static func loginInteractivePathExtra() -> String? {
		pathCacheLock.lock()
		defer { pathCacheLock.unlock() }
		if didProbeLoginPath {
			return cachedLoginPathExtra
		}
		didProbeLoginPath = true
		cachedLoginPathExtra = captureZshLoginInteractivePath()
		return cachedLoginPathExtra
	}

	private static func loginInteractiveNetworkEnv() -> [String: String] {
		pathCacheLock.lock()
		defer { pathCacheLock.unlock() }
		if didProbeLoginNetworkEnv {
			return cachedLoginNetworkEnv ?? [:]
		}
		didProbeLoginNetworkEnv = true
		cachedLoginNetworkEnv = captureZshLoginNetworkEnv()
		return cachedLoginNetworkEnv ?? [:]
	}

	private static func clearLoginPathCache() {
		pathCacheLock.lock()
		defer { pathCacheLock.unlock() }
		didProbeLoginPath = false
		cachedLoginPathExtra = nil
		didProbeLoginNetworkEnv = false
		cachedLoginNetworkEnv = nil
	}

	/// Finder-launched apps get a minimal PATH; `/usr/bin/env node` then fails even when Node exists
	/// under Homebrew, Volta, or nvm. Prepends login-interactive zsh PATH (nvm, fnm, npm globals) like Terminal.app.
	/// Used for the Node host, spawned `free-code`, and the in-app terminal.
	private static func hostChildEnvironment() -> [String: String] {
		var env = ProcessInfo.processInfo.environment
		augmentFinderPathWithHomebrew(&env)
		let extra = loginInteractivePathExtra()
		if let e = extra, !e.isEmpty, let p = env["PATH"], !p.isEmpty {
			env["PATH"] = e + ":" + p
		} else if let e = extra, !e.isEmpty {
			env["PATH"] = e
		}
		let net = loginInteractiveNetworkEnv()
		for (k, v) in net where !v.isEmpty {
			env[k] = v
		}
		return env
	}

	private static func nodeFromVoltaShim() -> URL? {
		let nodeURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".volta/bin/node")
		if FileManager.default.isExecutableFile(atPath: nodeURL.path) { return nodeURL }
		return nil
	}

	private static func nodeFromNvmVersionsDir() -> URL? {
		let fm = FileManager.default
		let base = fm.homeDirectoryForCurrentUser.appendingPathComponent(".nvm/versions/node")
		guard let entries = try? fm.contentsOfDirectory(
			at: base,
			includingPropertiesForKeys: [.contentModificationDateKey],
			options: [.skipsHiddenFiles]
		) else { return nil }
		var bestURL: URL?
		var bestDate = Date.distantPast
		for dirURL in entries {
			var isDir: ObjCBool = false
			guard fm.fileExists(atPath: dirURL.path, isDirectory: &isDir), isDir.boolValue else { continue }
			let node = dirURL.appendingPathComponent("bin/node")
			guard fm.isExecutableFile(atPath: node.path) else { continue }
			let keys: Set<URLResourceKey> = [.contentModificationDateKey]
			let mod = (try? node.resourceValues(forKeys: keys))?.contentModificationDate ?? .distantPast
			if mod >= bestDate {
				bestDate = mod
				bestURL = node
			}
		}
		return bestURL
	}

	private static func nodeExecutable() -> URL {
		let candidates = [
			"/opt/homebrew/bin/node",
			"/usr/local/bin/node",
			"/usr/bin/node",
		]
		for c in candidates {
			if FileManager.default.isExecutableFile(atPath: c) {
				return URL(fileURLWithPath: c)
			}
		}
		if let u = nodeFromVoltaShim() { return u }
		if let u = nodeFromNvmVersionsDir() { return u }
		return URL(fileURLWithPath: "/usr/bin/env")
	}

	/// Parses `~/.free-code/agent/.env` for `free-code.env` on the RPC child. Finder-launched apps do not
	/// inherit shell `export`; set `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` here for Vertex.
	private static func loadAgentEnvForRpc() -> [String: String] {
		let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".free-code/agent/.env")
		guard let data = try? Data(contentsOf: url),
		      var text = String(data: data, encoding: .utf8) else { return [:] }
		if text.hasPrefix("\u{FEFF}") {
			text.removeFirst()
		}
		var out: [String: String] = [:]
		for raw in text.components(separatedBy: CharacterSet.newlines) {
			let line = raw.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
			if line.isEmpty || line.hasPrefix("#") { continue }
			var rest = line
			if rest.hasPrefix("export ") {
				rest = String(rest.dropFirst(7)).trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
			}
			guard let eq = rest.firstIndex(of: "=") else { continue }
			let key = String(rest[..<eq]).trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
			if key.isEmpty { continue }
			var val = String(rest[rest.index(after: eq)...]).trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
			val = stripEnvValueQuotes(val)
			out[key] = val
		}
		return out
	}

	private static func stripEnvValueQuotes(_ s: String) -> String {
		guard s.count >= 2 else { return s }
		let f = s.first!, l = s.last!
		if (f == "\"" && l == "\"") || (f == "'" && l == "'") {
			return String(s.dropFirst().dropLast()).trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
		}
		return s
	}

	func restart() {
		stop()
		startIfNeeded()
		// After restart, re-send webview_ready so the host emits workspace/profile/model indicators
		DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
			self?.sendWebViewMessage(["type": "webview_ready"])
		}
	}

	func stop() {
		Self.clearLoginPathCache()
		stopShell()
		pipeOut?.fileHandleForReading.readabilityHandler = nil
		process?.terminate()
		process = nil
		pipeIn = nil
		pipeOut = nil
		lineBuffer = Data()
		discardPendingWebviewLines()
	}

	func startIfNeeded() {
		guard process == nil else { return }
		guard let hostDir = Bundle.module.url(forResource: "stdio-mac", withExtension: "mjs", subdirectory: "HostSrc")?
			.deletingLastPathComponent() else {
			lastError = "HostSrc not found in bundle"
			discardPendingWebviewLines()
			return
		}
		let script = hostDir.appendingPathComponent("stdio-mac.mjs")
		let node = Self.nodeExecutable()
		let p = Process()
		if node.lastPathComponent == "env" {
			p.executableURL = node
			p.arguments = ["node", script.path]
		} else {
			p.executableURL = node
			p.arguments = [script.path]
		}
		p.currentDirectoryURL = hostDir
		p.environment = Self.hostChildEnvironment()

		let pipeIn = Pipe()
		let pipeOut = Pipe()
		p.standardInput = pipeIn
		p.standardOutput = pipeOut
		p.standardError = FileHandle.standardError

		do {
			try p.run()
		} catch {
			lastError = error.localizedDescription
			discardPendingWebviewLines()
			return
		}

		self.process = p
		self.pipeIn = pipeIn
		self.pipeOut = pipeOut
		lastError = nil

		pipeOut.fileHandleForReading.readabilityHandler = { [weak self] handle in
			let data = handle.availableData
			if data.isEmpty {
				// Pipe closed: process likely died or terminated
				DispatchQueue.main.async { [weak self] in
					guard let self else { return }
					if let proc = self.process, !proc.isRunning {
						self.lastError =
							"Host process exited (status \(proc.terminationStatus)). stderr: Terminal if you launched from there; otherwise Console.app (process FreeCodeMac)."
					} else {
						self.lastError = "Host process terminated unexpectedly."
					}
					self.stop()
					self.startIfNeeded()
				}
				return
			}
			self?.consumeHostStdout(data)
		}

		if sendInitSucceeded() {
			flushPendingWebviewLines()
		} else {
			discardPendingWebviewLines()
		}
	}

	@discardableResult
	private func sendInitSucceeded() -> Bool {
		guard let media = Bundle.module.url(forResource: "chat-mac", withExtension: "html", subdirectory: "Media")?
			.deletingLastPathComponent() else {
			lastError = "Media bundle missing"
			return false
		}
		let payload: [String: Any] = [
			"workspaceRoot": workspaceRoot.path,
			"mediaRoot": media.path,
			"settings": [
				"freeCode": [
					"executablePath": "free-code",
					"cwd": "",
					"provider": "",
					"model": "",
					"env": Self.loadAgentEnvForRpc(),
					"noExtensions": false,
					"noAgentsFiles": false,
				] as [String: Any],
			],
		]
		let line: [String: Any] = ["dir": "init", "payload": payload]
		writeJsonLine(line)
		return true
	}

	private func discardPendingWebviewLines() {
		pendingWebviewLock.lock()
		defer { pendingWebviewLock.unlock() }
		pendingWebviewToHostLines.removeAll()
	}

	private func enqueuePendingWebviewLine(_ obj: [String: Any]) {
		pendingWebviewLock.lock()
		defer { pendingWebviewLock.unlock() }
		if pendingWebviewToHostLines.count < Self.pendingWebviewMax {
			pendingWebviewToHostLines.append(obj)
		}
	}

	private func flushPendingWebviewLines() {
		var batch: [[String: Any]] = []
		pendingWebviewLock.lock()
		batch = pendingWebviewToHostLines
		pendingWebviewToHostLines.removeAll()
		pendingWebviewLock.unlock()
		for obj in batch {
			writeJsonLineIntoConnectedPipe(obj)
		}
	}

	/// Writes one JSON line to stdin of the running host (expects a live `pipeIn`).
	private func writeJsonLineIntoConnectedPipe(_ obj: [String: Any]) {
		guard let pipeIn = pipeIn else { return }
		guard let data = try? JSONSerialization.data(withJSONObject: obj),
		      var s = String(data: data, encoding: .utf8) else {
			DispatchQueue.main.async { [weak self] in
				self?.lastError = "Failed to serialize message to host"
			}
			return
		}
		s.append("\n")
		guard let out = s.data(using: .utf8) else { return }
		do {
			try pipeIn.fileHandleForWriting.write(contentsOf: out)
		} catch {
			DispatchQueue.main.async { [weak self] in
				guard let self else { return }
				self.lastError = "Host write failed: \(error.localizedDescription)"
				self.stop()
				self.startIfNeeded()
			}
		}
	}

	func writeJsonLine(_ obj: [String: Any]) {
		guard pipeIn != nil else {
			enqueuePendingWebviewLine(obj)
			return
		}
		writeJsonLineIntoConnectedPipe(obj)
	}

	func sendWebViewMessage(_ body: [String: Any]) {
		if let type = body["type"] as? String {
			if type == "terminal_exec", let cmd = body["command"] as? String {
				executeTerminalCommand(cmd)
				return
			}
		}
		let line: [String: Any] = ["dir": "webview_to_host", "payload": body]
		writeJsonLine(line)
	}

	// MARK: - Terminal (persistent cwd, one process per command)

	private var terminalCwd: URL?

	private func executeTerminalCommand(_ command: String) {
		let cwd = terminalCwd ?? workspaceRoot
		let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)

		// Handle `cd` locally — update terminalCwd
		if trimmed == "cd" || trimmed.hasPrefix("cd ") {
			let arg = trimmed == "cd" ? "~" : String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
			let resolved: URL
			if arg == "~" || arg.isEmpty {
				resolved = FileManager.default.homeDirectoryForCurrentUser
			} else if arg.hasPrefix("/") {
				resolved = URL(fileURLWithPath: arg)
			} else if arg.hasPrefix("~") {
				resolved = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(String(arg.dropFirst(2)))
			} else {
				resolved = cwd.appendingPathComponent(arg).standardized
			}
			var isDir: ObjCBool = false
			if FileManager.default.fileExists(atPath: resolved.path, isDirectory: &isDir), isDir.boolValue {
				terminalCwd = resolved
				DispatchQueue.main.async { [weak self] in
					self?.onHostToWebView?(["type": "terminal_output", "text": resolved.path + "\n"])
				}
			} else {
				DispatchQueue.main.async { [weak self] in
					self?.onHostToWebView?(["type": "terminal_error", "text": "cd: no such directory: \(arg)\n"])
				}
			}
			return
		}

		// Handle `clear`
		if trimmed == "clear" {
			DispatchQueue.main.async { [weak self] in
				self?.onHostToWebView?(["type": "terminal_clear"])
			}
			return
		}

		DispatchQueue.global(qos: .userInitiated).async { [weak self] in
			guard let self else { return }
			let proc = Process()
			proc.executableURL = URL(fileURLWithPath: "/bin/zsh")
			// Interactive + login: sources ~/.zprofile and ~/.zshrc like Terminal.app, so PATH
			// includes Homebrew, google-cloud-sdk, nvm shims, etc. (plain -lc skips .zshrc.)
			proc.arguments = ["-ilc", trimmed]
			proc.currentDirectoryURL = cwd
			var env = Self.hostChildEnvironment()
			env["TERM"] = "dumb"
			proc.environment = env

			let outPipe = Pipe()
			let errPipe = Pipe()
			proc.standardOutput = outPipe
			proc.standardError = errPipe

			outPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
				let data = handle.availableData
				guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
				DispatchQueue.main.async {
					self?.onHostToWebView?(["type": "terminal_output", "text": text])
				}
			}
			errPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
				let data = handle.availableData
				guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
				DispatchQueue.main.async {
					self?.onHostToWebView?(["type": "terminal_error", "text": text])
				}
			}

			do {
				try proc.run()
				proc.waitUntilExit()
			} catch {
				DispatchQueue.main.async { [weak self] in
					self?.onHostToWebView?(["type": "terminal_error", "text": "Error: \(error.localizedDescription)\n"])
				}
			}

			outPipe.fileHandleForReading.readabilityHandler = nil
			errPipe.fileHandleForReading.readabilityHandler = nil
		}
	}

	private func stopShell() {
		terminalCwd = nil
	}

	private func consumeHostStdout(_ chunk: Data) {
		lineBuffer.append(chunk)
		let nl = UInt8(ascii: "\n")
		while true {
			guard let idx = lineBuffer.firstIndex(of: nl) else { break }
			let lineData = lineBuffer[..<idx]
			lineBuffer.removeSubrange(lineBuffer.startIndex ... idx)
			guard let obj = try? JSONSerialization.jsonObject(with: Data(lineData)) as? [String: Any],
			      let dir = obj["dir"] as? String else { continue }
			if dir == "host_to_webview", let payload = obj["payload"] as? [String: Any] {
				DispatchQueue.main.async { [weak self] in
					self?.onHostToWebView?(payload)
				}
			} else if dir == "host_to_native", let payload = obj["payload"] as? [String: Any] {
				DispatchQueue.main.async { [weak self] in
					self?.handleNativeRequest(payload)
				}
			}
		}
	}

	private func handleNativeRequest(_ payload: [String: Any]) {
		let type = payload["type"] as? String ?? ""
		let dialogId = payload["dialogId"] as? String ?? ""

		if type == "show_open_dialog" {
			let panel = NSOpenPanel()
			panel.canChooseFiles = true
			panel.canChooseDirectories = true
			panel.allowsMultipleSelection = true
			let response = panel.runModal()
			var paths: [String] = []
			if response == .OK { paths = panel.urls.map(\.path) }
			writeJsonLine(["dir": "native_to_host",
				"payload": ["type": "open_dialog_result", "paths": paths]])
			return
		}

		if type == "show_save_dialog" {
			let panel = NSSavePanel()
			if let title = payload["title"] as? String, !title.isEmpty { panel.title = title }
			if let saveLabel = payload["saveLabel"] as? String, !saveLabel.isEmpty { panel.prompt = saveLabel }
			if let defaultPath = payload["defaultPath"] as? String, !defaultPath.isEmpty {
				let url = URL(fileURLWithPath: defaultPath)
				panel.nameFieldStringValue = url.lastPathComponent
				let dir = url.deletingLastPathComponent()
				if FileManager.default.fileExists(atPath: dir.path) {
					panel.directoryURL = dir
				}
			}
			let response = panel.runModal()
			if !dialogId.isEmpty {
				if response == .OK, let url = panel.url {
					sendNativeDialogResult(dialogId: dialogId, result: ["cancelled": false, "path": url.path])
				} else {
					sendNativeDialogResult(dialogId: dialogId, result: ["cancelled": true])
				}
			}
			return
		}

		if type == "show_message" {
			let message = payload["message"] as? String ?? ""
			let level = payload["level"] as? String ?? "info"
			let buttons = payload["buttons"] as? [String] ?? []
			// Notifications (no buttons) — show in chat status, never as a popup
			if buttons.isEmpty {
				if !dialogId.isEmpty {
					sendNativeDialogResult(dialogId: dialogId, result: ["cancelled": false])
				}
				// Surface as a non-blocking status message in the webview instead
				DispatchQueue.main.async { [weak self] in
					if level == "error" {
						self?.onHostToWebView?(["type": "status", "text": "⚠️ \(message)"])
					}
					// info/warning: silently ignore — they're just status updates
				}
				return
			}
			let alert = NSAlert()
			alert.messageText = message
			alert.alertStyle = level == "error" ? .critical : level == "warning" ? .warning : .informational
			do {
				for btn in buttons { alert.addButton(withTitle: btn) }
				let response = alert.runModal()
				let idx = response.rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
				let picked = idx >= 0 && idx < buttons.count ? buttons[idx] : nil
				if !dialogId.isEmpty {
					if let picked {
						sendNativeDialogResult(dialogId: dialogId, result: [
							"cancelled": false,
							"value": picked,
							"confirmed": picked == buttons.first  // Allow/Deny pattern
						])
					} else {
						sendNativeDialogResult(dialogId: dialogId, result: ["cancelled": true])
					}
				}
			}
			return
		}

		if type == "show_quick_pick" {
			let title = payload["title"] as? String ?? "Select"
			let items = payload["items"] as? [String] ?? []
			let alert = NSAlert()
			alert.messageText = title
			alert.alertStyle = .informational
			let list = NSComboBox(frame: NSRect(x: 0, y: 0, width: 340, height: 24))
			list.addItems(withObjectValues: items)
			list.selectItem(at: 0)
			alert.accessoryView = list
			alert.addButton(withTitle: "OK")
			alert.addButton(withTitle: "Cancel")
			let response = alert.runModal()
			if !dialogId.isEmpty {
				if response == .alertFirstButtonReturn {
					let idx = list.indexOfSelectedItem
					sendNativeDialogResult(dialogId: dialogId, result: ["cancelled": false, "index": idx])
				} else {
					sendNativeDialogResult(dialogId: dialogId, result: ["cancelled": true])
				}
			}
			return
		}

		if type == "show_input_box" {
			let title = payload["title"] as? String ?? "Input"
			let placeholder = payload["placeholder"] as? String ?? ""
			let prefill = payload["value"] as? String ?? ""
			let alert = NSAlert()
			alert.messageText = title
			alert.alertStyle = .informational
			alert.addButton(withTitle: "OK")
			alert.addButton(withTitle: "Cancel")
			let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 340, height: 24))
			field.stringValue = prefill
			field.placeholderString = placeholder
			alert.accessoryView = field
			alert.window.initialFirstResponder = field
			let response = alert.runModal()
			if !dialogId.isEmpty {
				if response == .alertFirstButtonReturn {
					sendNativeDialogResult(dialogId: dialogId, result: ["cancelled": false, "value": field.stringValue])
				} else {
					sendNativeDialogResult(dialogId: dialogId, result: ["cancelled": true])
				}
			}
			return
		}

		if type == "open_external", let urlStr = payload["url"] as? String, !urlStr.isEmpty,
		   let url = URL(string: urlStr), url.scheme != nil {
			NSWorkspace.shared.open(url)
			return
		}

		if type == "open_file", let path = payload["path"] as? String, !path.isEmpty {
			NSWorkspace.shared.open(URL(fileURLWithPath: path))
		}
	}

	private func sendNativeDialogResult(dialogId: String, result: [String: Any]) {
		writeJsonLine([
			"dir": "native_to_host",
			"payload": ["type": "native_dialog_result", "dialogId": dialogId, "result": result]
		])
	}
}
