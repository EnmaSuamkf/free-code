import AppKit
import SwiftUI
import WebKit
struct ContentView: View {
	@EnvironmentObject private var hostModel: HostProcessModel
	@Environment(\.openWindow) private var openWindow
	@State private var webView: WKWebView?

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			if let err = hostModel.lastError {
				Text(err)
					.foregroundColor(.red)
					.font(.caption)
					.padding(.horizontal, 8)
					.padding(.vertical, 4)
					.background(Color(red: 0.12, green: 0.12, blue: 0.12))
			}

			ChatWebView(
				webViewRef: $webView,
				workspaceRoot: hostModel.workspaceRoot,
				onBridgeMessage: { body in
					if let type = body["type"] as? String, type == "terminal_detach" {
						openWindow(id: "detached-terminal")
						ChatWebView.injectHostMessage(
							webView: webView,
							payload: ["type": "terminal_set_docked", "docked": false],
						)
						return
					}
					if let type = body["type"] as? String, type == "change_workspace",
					   let path = body["path"] as? String {
						hostModel.workspaceRoot = URL(fileURLWithPath: path)
						hostModel.restart()
						return
					}
					hostModel.sendWebViewMessage(body)
				}
			)
			.onAppear {
				hostModel.onHostToWebView = { payload in
					ChatWebView.injectHostMessage(webView: webView, payload: payload)
					if let type = payload["type"] as? String {
						switch type {
						case "terminal_output":
							if let text = payload["text"] as? String {
								NotificationCenter.default.post(
									name: .terminalStreamFromHost,
									object: nil,
									userInfo: ["kind": "output", "text": text],
								)
							}
						case "terminal_error":
							if let text = payload["text"] as? String {
								NotificationCenter.default.post(
									name: .terminalStreamFromHost,
									object: nil,
									userInfo: ["kind": "error", "text": text],
								)
							}
						case "terminal_clear":
							NotificationCenter.default.post(
								name: .terminalStreamFromHost,
								object: nil,
								userInfo: ["kind": "clear"],
							)
						default:
							break
						}
					}
				}
				hostModel.startIfNeeded()
			}
		}
		.onReceive(NotificationCenter.default.publisher(for: .openWorkspaceFolder)) { _ in
			pickFolder()
		}
		.onReceive(NotificationCenter.default.publisher(for: .toggleSessionMonitor)) { _ in
			ChatWebView.injectHostMessage(webView: webView, payload: ["type": "session_monitor_toggle"])
		}
		.onReceive(NotificationCenter.default.publisher(for: .toggleTerminal)) { _ in
			ChatWebView.injectHostMessage(webView: webView, payload: ["type": "terminal_toggle"])
		}
		.onReceive(NotificationCenter.default.publisher(for: .dockDetachedTerminal)) { _ in
			ChatWebView.injectHostMessage(
				webView: webView,
				payload: ["type": "terminal_set_docked", "docked": true],
			)
		}
		.onReceive(NotificationCenter.default.publisher(for: .zoomIn)) { _ in
			ChatWebView.injectHostMessage(webView: webView, payload: ["type": "zoom_in"])
		}
		.onReceive(NotificationCenter.default.publisher(for: .zoomOut)) { _ in
			ChatWebView.injectHostMessage(webView: webView, payload: ["type": "zoom_out"])
		}
		.onReceive(NotificationCenter.default.publisher(for: .zoomReset)) { _ in
			ChatWebView.injectHostMessage(webView: webView, payload: ["type": "zoom_reset"])
		}
	}

	private func pickFolder() {
		let panel = NSOpenPanel()
		panel.canChooseFiles = false
		panel.canChooseDirectories = true
		panel.allowsMultipleSelection = false
		panel.directoryURL = hostModel.workspaceRoot
		if panel.runModal() == .OK, let url = panel.url {
			hostModel.workspaceRoot = url
			hostModel.restart()
		}
	}
}
