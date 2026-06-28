import AppKit
import SwiftUI

/// Standalone window that mirrors the in-webview terminal stream and shares `HostProcessModel` cwd / exec path.
struct DetachedTerminalView: View {
	@EnvironmentObject private var hostModel: HostProcessModel
	@State private var transcript = ""
	@State private var command = ""

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			HStack {
				Text("Terminal")
					.font(.headline)
					.foregroundColor(.secondary)
				Spacer()
				Button("Dock to chat") {
					dockToChat()
				}
			}
			.padding(.horizontal, 12)
			.padding(.vertical, 8)
			.background(Color(red: 0.12, green: 0.12, blue: 0.12))

			ScrollViewReader { proxy in
				ScrollView {
					Text(transcript)
						.font(.system(.body, design: .monospaced))
						.foregroundColor(Color(red: 0.78, green: 0.78, blue: 0.78))
						.frame(maxWidth: .infinity, alignment: .leading)
						.textSelection(.enabled)
						.padding(10)
						.id("detachedTermEnd")
				}
				.onChange(of: transcript) { _ in
					DispatchQueue.main.async {
						withAnimation(.easeOut(duration: 0.05)) {
							proxy.scrollTo("detachedTermEnd", anchor: .bottom)
						}
					}
				}
			}
			.frame(maxWidth: .infinity, maxHeight: .infinity)
			.background(Color(red: 0.094, green: 0.094, blue: 0.094))

			Divider()
				.background(Color.white.opacity(0.08))

			HStack(spacing: 8) {
				Text("$")
					.font(.system(.body, design: .monospaced))
					.foregroundColor(.secondary)
				TextField("command", text: $command)
					.textFieldStyle(.plain)
					.font(.system(.body, design: .monospaced))
					.foregroundColor(.primary)
					.onSubmit(runCommand)
				Button("Run") { runCommand() }
					.keyboardShortcut(.defaultAction)
			}
			.padding(.horizontal, 12)
			.padding(.vertical, 8)
			.background(Color(red: 0.11, green: 0.11, blue: 0.11))
		}
		.frame(minWidth: 520, minHeight: 360)
		.background(Color(red: 0.118, green: 0.118, blue: 0.118))
		.onReceive(NotificationCenter.default.publisher(for: .terminalStreamFromHost)) { note in
			guard let kind = note.userInfo?["kind"] as? String else { return }
			switch kind {
			case "clear":
				transcript = ""
			case "error":
				if let text = note.userInfo?["text"] as? String {
					appendTranscript(text)
				}
			case "output":
				if let text = note.userInfo?["text"] as? String {
					appendTranscript(text)
				}
			default:
				break
			}
		}
	}

	private func appendTranscript(_ text: String) {
		if transcript.count > 400_000 {
			transcript = String(transcript.suffix(300_000))
		}
		transcript += text
	}

	private func runCommand() {
		let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !trimmed.isEmpty else { return }
		appendTranscript("❯ " + trimmed + "\n")
		command = ""
		hostModel.sendWebViewMessage(["type": "terminal_exec", "command": trimmed])
	}

	private func dockToChat() {
		NotificationCenter.default.post(name: .dockDetachedTerminal, object: nil)
		NSApp.keyWindow?.close()
	}
}
