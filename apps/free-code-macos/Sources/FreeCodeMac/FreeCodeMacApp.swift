import AppKit
import Darwin
import SwiftUI
import WebKit

@main
struct FreeCodeMacApp: App {
	init() {
		// Writing to the Node host stdin after the child exits raises SIGPIPE by default,
		// which terminates the GUI process. Ignore so writes fail with EPIPE instead.
		signal(SIGPIPE, SIG_IGN)
	}

	@StateObject private var hostModel = HostProcessModel()
	@State private var profileNames: [String] = []
	@State private var activeProfile: String? = nil
	@State private var mcpServerNames: [String] = []
	@State private var envCredentials: [(key: String, hasValue: Bool)] = []

	private var agentDir: URL {
		FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".free-code/agent")
	}
	private var mcpJsonURL: URL {
		agentDir.appendingPathComponent("mcp.json")
	}
	private var envFileURL: URL {
		agentDir.appendingPathComponent(".env")
	}

	var body: some Scene {
		WindowGroup {
			ContentView()
				.environmentObject(hostModel)
				.background(Color(red: 0.118, green: 0.118, blue: 0.118))
				.preferredColorScheme(.dark)
				.onAppear {
					NSApp.setActivationPolicy(.regular)
					NSApp.activate(ignoringOtherApps: true)
					if let window = NSApp.windows.first {
						window.titlebarAppearsTransparent = true
						window.backgroundColor = NSColor(red: 0.118, green: 0.118, blue: 0.118, alpha: 1)
						window.isOpaque = true
					}
					reloadProfiles()
					reloadMCPs()
				}
		}
		.commands {
			CommandGroup(replacing: .newItem) {}
			CommandGroup(after: .appInfo) {
				Button("Session monitor") {
					NotificationCenter.default.post(name: .toggleSessionMonitor, object: nil)
				}
				.keyboardShortcut("i", modifiers: [.command, .shift])

				Button("Terminal") {
					NotificationCenter.default.post(name: .toggleTerminal, object: nil)
				}
				.keyboardShortcut("`", modifiers: [.command])
			}
			CommandGroup(after: .toolbar) {
				Button("Zoom In") {
					NotificationCenter.default.post(name: .zoomIn, object: nil)
				}
				.keyboardShortcut("+", modifiers: [.command])

				Button("Zoom Out") {
					NotificationCenter.default.post(name: .zoomOut, object: nil)
				}
				.keyboardShortcut("-", modifiers: [.command])

				Button("Reset Zoom") {
					NotificationCenter.default.post(name: .zoomReset, object: nil)
				}
				.keyboardShortcut("0", modifiers: [.command])
			}
			CommandMenu("Folder") {
				Button("Open workspace folder…") {
					NotificationCenter.default.post(name: .openWorkspaceFolder, object: nil)
				}
				.keyboardShortcut("o", modifiers: [.command])
			}
			CommandMenu("Tools") {
				Button("Pick tools…") {
					sendCommand("/pick-tools")
				}
				.keyboardShortcut("t", modifiers: [.command, .shift])

				Button("List active tools") {
					sendCommand("/tools")
				}
			}
			CommandMenu("Skills") {
				Button("Pick skills…") {
					sendCommand("/pick-skill")
				}
				.keyboardShortcut("k", modifiers: [.command, .shift])
			}
			CommandMenu("MCPs") {
				Menu("Servers") {
					if mcpServerNames.isEmpty {
						Text("No MCP servers configured")
					} else {
						ForEach(mcpServerNames, id: \.self) { name in
							Text("\u{2713} \(name)")
						}
					}
				}

				Divider()

				Button("Import…") {
					sendCommand("/mcp-import")
				}

				Divider()

				Button("Add MCP server…") {
					addMCPServer()
				}

				Menu("Remove MCP server") {
					if mcpServerNames.isEmpty {
						Text("No servers to remove")
					} else {
						ForEach(mcpServerNames, id: \.self) { name in
							Button(name) {
								removeMCPServer(name: name)
							}
						}
					}
				}

				Divider()

				Menu("Set credential") {
					if envCredentials.isEmpty {
						Text("No .env file found")
					} else {
						ForEach(envCredentials, id: \.key) { cred in
							Button("\(cred.key)\(cred.hasValue ? " ✓" : " ✗")") {
								editEnvCredential(key: cred.key)
							}
						}
					}
				}

				Button("Add credential…") {
					addEnvCredential()
				}

				Divider()

				Button("Edit mcp.json…") {
					NSWorkspace.shared.open(mcpJsonURL)
				}

				Button("Edit .env…") {
					NSWorkspace.shared.open(envFileURL)
				}

				Button("Reveal in Finder") {
					NSWorkspace.shared.selectFile(mcpJsonURL.path, inFileViewerRootedAtPath: agentDir.path)
				}

				Divider()

				Button("Reset MCP tools cache") {
					let cache = agentDir.appendingPathComponent("mcp-tools-cache.json")
					try? FileManager.default.removeItem(at: cache)
					hostModel.restart()
				}

				Button("Refresh") {
					reloadMCPs()
				}
			}
			CommandMenu("Profile") {
				Button("Choose profile…") {
					sendProfileCommand("/profile")
				}
				.keyboardShortcut("p", modifiers: [.command, .shift])

				Divider()

				Menu("Use profile") {
					if profileNames.isEmpty {
						Text("No profiles found")
					} else {
						ForEach(profileNames, id: \.self) { name in
							Button("\(name)\(name == activeProfile ? " ✓" : "")") {
								sendProfileCommand("/profile use \(name)")
							}
						}
					}
				}

				Menu("Info") {
					if profileNames.isEmpty {
						Text("No profiles found")
					} else {
						ForEach(profileNames, id: \.self) { name in
							Button(name) {
								sendProfileCommand("/profile info \(name)")
							}
						}
					}
				}

				Divider()

				Button("List profiles") {
					sendProfileCommand("/profile list")
				}
				.keyboardShortcut("l", modifiers: [.command, .shift])

				Button("Create profile…") {
					promptForName(title: "Create Profile", message: "Enter a name for the new profile:") { name in
						sendProfileCommand("/profile create \(name)")
					}
				}

				Button("Save current profile") {
					sendProfileCommand("/profile save")
				}
				.keyboardShortcut("s", modifiers: [.command, .shift])

				Button("Save as…") {
					promptForName(title: "Save Profile As", message: "Enter a name to save the profile as:") { name in
						sendProfileCommand("/profile save \(name)")
					}
				}

				Divider()

				Menu("Delete profile") {
					let deletable = profileNames.filter { $0 != "default" }
					if deletable.isEmpty {
						Text("No deletable profiles")
					} else {
						ForEach(deletable, id: \.self) { name in
							Button(name) {
								confirmDelete(name: name)
							}
						}
					}
				}

				Divider()

				Button("Refresh list") {
					reloadProfiles()
				}
			}
		}
		Window("Terminal", id: "detached-terminal") {
			DetachedTerminalView()
				.environmentObject(hostModel)
				.background(Color(red: 0.118, green: 0.118, blue: 0.118))
				.preferredColorScheme(.dark)
		}
	}

	// MARK: - Profile helpers

	private func sendCommand(_ command: String) {
		hostModel.sendWebViewMessage(["type": "prompt", "text": command, "attachments": [String]()])
	}

	private func sendProfileCommand(_ command: String) {
		sendCommand(command)
		DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
			reloadProfiles()
		}
	}

	private func reloadProfiles() {
		let profilesPath = FileManager.default.homeDirectoryForCurrentUser
			.appendingPathComponent(".free-code/agent/profiles.json").path
		guard let data = FileManager.default.contents(atPath: profilesPath),
		      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
			profileNames = []
			activeProfile = nil
			return
		}
		activeProfile = json["activeProfile"] as? String
		if let profiles = json["profiles"] as? [String: Any] {
			var names = Array(profiles.keys)
			names.sort { a, b in
				if a == "default" { return true }
				if b == "default" { return false }
				return a.localizedCompare(b) == .orderedAscending
			}
			profileNames = names
		} else {
			profileNames = []
		}
	}

	private func promptForName(title: String, message: String, onConfirm: @escaping (String) -> Void) {
		let alert = NSAlert()
		alert.messageText = title
		alert.informativeText = message
		alert.alertStyle = .informational
		alert.addButton(withTitle: "OK")
		alert.addButton(withTitle: "Cancel")
		let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
		input.placeholderString = "profile-name"
		alert.accessoryView = input
		alert.window.initialFirstResponder = input
		if alert.runModal() == .alertFirstButtonReturn {
			let name = input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
			if !name.isEmpty { onConfirm(name) }
		}
	}

	// MARK: - MCP helpers

	private func reloadMCPs() {
		// Load server names from mcp.json
		if let data = FileManager.default.contents(atPath: mcpJsonURL.path),
		   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
		   let servers = json["mcpServers"] as? [String: Any] {
			mcpServerNames = Array(servers.keys).sorted()
		} else {
			mcpServerNames = []
		}
		// Load credentials from .env
		if let content = try? String(contentsOf: envFileURL, encoding: .utf8) {
			var creds: [(key: String, hasValue: Bool)] = []
			for line in content.components(separatedBy: .newlines) {
				let trimmed = line.trimmingCharacters(in: .whitespaces)
				if trimmed.isEmpty || trimmed.hasPrefix("#") { continue }
				let parts = trimmed.split(separator: "=", maxSplits: 1)
				guard let key = parts.first else { continue }
				let keyStr = String(key).trimmingCharacters(in: .whitespaces)
				if keyStr.isEmpty { continue }
				let val = parts.count > 1 ? String(parts[1]).trimmingCharacters(in: .whitespaces) : ""
				let hasValue = !val.isEmpty && !val.contains("your-") && !val.contains("your_") && val != "your-token-here"
				creds.append((key: keyStr, hasValue: hasValue))
			}
			envCredentials = creds
		} else {
			envCredentials = []
		}
	}

	private func addMCPServer() {
		let alert = NSAlert()
		alert.messageText = "Add MCP Server"
		alert.informativeText = "Enter the server name and command.\nFor npx servers: command=npx, args=-y @package/name\nFor docker: command=docker, args=run --rm -i image:tag"
		alert.alertStyle = .informational
		alert.addButton(withTitle: "Add")
		alert.addButton(withTitle: "Cancel")

		let stack = NSStackView(frame: NSRect(x: 0, y: 0, width: 380, height: 100))
		stack.orientation = .vertical
		stack.alignment = .leading
		stack.spacing = 6

		let nameField = NSTextField(frame: NSRect(x: 0, y: 0, width: 380, height: 24))
		nameField.placeholderString = "Server name (e.g. mcp-brave-search)"
		let cmdField = NSTextField(frame: NSRect(x: 0, y: 0, width: 380, height: 24))
		cmdField.placeholderString = "Command (e.g. npx, docker, node)"
		let argsField = NSTextField(frame: NSRect(x: 0, y: 0, width: 380, height: 24))
		argsField.placeholderString = "Args (space-separated, e.g. -y @brave/brave-search-mcp-server)"

		for f in [nameField, cmdField, argsField] {
			f.translatesAutoresizingMaskIntoConstraints = false
			f.widthAnchor.constraint(equalToConstant: 380).isActive = true
			stack.addArrangedSubview(f)
		}

		alert.accessoryView = stack
		alert.window.initialFirstResponder = nameField

		guard alert.runModal() == .alertFirstButtonReturn else { return }
		let name = nameField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
		let cmd = cmdField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
		let argsStr = argsField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !name.isEmpty, !cmd.isEmpty else { return }

		let args = argsStr.components(separatedBy: .whitespaces).filter { !$0.isEmpty }
		var json = loadMCPJson()
		var servers = json["mcpServers"] as? [String: Any] ?? [:]
		servers[name] = ["command": cmd, "args": args] as [String: Any]
		json["mcpServers"] = servers
		saveMCPJson(json)
		reloadMCPs()
	}

	private func removeMCPServer(name: String) {
		let alert = NSAlert()
		alert.messageText = "Remove MCP server \"\(name)\"?"
		alert.informativeText = "This will remove it from mcp.json."
		alert.alertStyle = .warning
		alert.addButton(withTitle: "Remove")
		alert.addButton(withTitle: "Cancel")
		guard alert.runModal() == .alertFirstButtonReturn else { return }

		var json = loadMCPJson()
		var servers = json["mcpServers"] as? [String: Any] ?? [:]
		servers.removeValue(forKey: name)
		json["mcpServers"] = servers
		saveMCPJson(json)
		reloadMCPs()
	}

	private func editEnvCredential(key: String) {
		// Read current value
		let lines = (try? String(contentsOf: envFileURL, encoding: .utf8))?.components(separatedBy: .newlines) ?? []
		var currentValue = ""
		for line in lines {
			let parts = line.split(separator: "=", maxSplits: 1)
			if let k = parts.first, String(k).trimmingCharacters(in: .whitespaces) == key {
				currentValue = parts.count > 1 ? String(parts[1]).trimmingCharacters(in: .whitespaces) : ""
				break
			}
		}

		let alert = NSAlert()
		alert.messageText = "Set credential: \(key)"
		alert.informativeText = "Enter the value for this credential."
		alert.alertStyle = .informational
		alert.addButton(withTitle: "Save")
		alert.addButton(withTitle: "Cancel")
		let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24))
		input.stringValue = currentValue
		input.placeholderString = "token or value"
		alert.accessoryView = input
		alert.window.initialFirstResponder = input

		guard alert.runModal() == .alertFirstButtonReturn else { return }
		let newValue = input.stringValue
		updateEnvValue(key: key, value: newValue)
		reloadMCPs()
	}

	private func addEnvCredential() {
		let alert = NSAlert()
		alert.messageText = "Add Credential"
		alert.informativeText = "Add a new environment variable to ~/.free-code/agent/.env"
		alert.alertStyle = .informational
		alert.addButton(withTitle: "Add")
		alert.addButton(withTitle: "Cancel")

		let stack = NSStackView(frame: NSRect(x: 0, y: 0, width: 360, height: 58))
		stack.orientation = .vertical
		stack.alignment = .leading
		stack.spacing = 6

		let keyField = NSTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24))
		keyField.placeholderString = "KEY_NAME (e.g. BRAVE_API_KEY)"
		let valField = NSTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24))
		valField.placeholderString = "value"

		for f in [keyField, valField] {
			f.translatesAutoresizingMaskIntoConstraints = false
			f.widthAnchor.constraint(equalToConstant: 360).isActive = true
			stack.addArrangedSubview(f)
		}

		alert.accessoryView = stack
		alert.window.initialFirstResponder = keyField

		guard alert.runModal() == .alertFirstButtonReturn else { return }
		let key = keyField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
		let val = valField.stringValue
		guard !key.isEmpty else { return }

		// Append to .env
		var content = (try? String(contentsOf: envFileURL, encoding: .utf8)) ?? ""
		if !content.hasSuffix("\n") { content += "\n" }
		content += "\(key)=\(val)\n"
		try? content.write(to: envFileURL, atomically: true, encoding: .utf8)
		reloadMCPs()
	}

	private func updateEnvValue(key: String, value: String) {
		guard let content = try? String(contentsOf: envFileURL, encoding: .utf8) else { return }
		var lines = content.components(separatedBy: "\n")
		var found = false
		for i in lines.indices {
			let parts = lines[i].split(separator: "=", maxSplits: 1)
			if let k = parts.first, String(k).trimmingCharacters(in: .whitespaces) == key {
				lines[i] = "\(key)=\(value)"
				found = true
				break
			}
		}
		if !found { lines.append("\(key)=\(value)") }
		try? lines.joined(separator: "\n").write(to: envFileURL, atomically: true, encoding: .utf8)
	}

	private func loadMCPJson() -> [String: Any] {
		guard let data = FileManager.default.contents(atPath: mcpJsonURL.path),
		      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
			return ["mcpServers": [String: Any]()]
		}
		return json
	}

	private func saveMCPJson(_ json: [String: Any]) {
		guard let data = try? JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys]) else { return }
		// Ensure directory exists
		try? FileManager.default.createDirectory(at: agentDir, withIntermediateDirectories: true)
		try? data.write(to: mcpJsonURL)
	}

	private func confirmDelete(name: String) {
		let alert = NSAlert()
		alert.messageText = "Delete profile \"\(name)\"?"
		alert.informativeText = "This cannot be undone."
		alert.alertStyle = .warning
		alert.addButton(withTitle: "Delete")
		alert.addButton(withTitle: "Cancel")
		if alert.runModal() == .alertFirstButtonReturn {
			sendProfileCommand("/profile delete \(name)")
		}
	}
}

extension Notification.Name {
	static let openWorkspaceFolder = Notification.Name("openWorkspaceFolder")
	static let toggleSessionMonitor = Notification.Name("toggleSessionMonitor")
	static let toggleTerminal = Notification.Name("toggleTerminal")
	static let zoomIn = Notification.Name("freeCodeZoomIn")
	static let zoomOut = Notification.Name("freeCodeZoomOut")
	static let zoomReset = Notification.Name("freeCodeZoomReset")
	/// Terminal stdout/stderr from `HostProcessModel` for the detached window.
	static let terminalStreamFromHost = Notification.Name("terminalStreamFromHost")
	static let dockDetachedTerminal = Notification.Name("dockDetachedTerminal")
}
