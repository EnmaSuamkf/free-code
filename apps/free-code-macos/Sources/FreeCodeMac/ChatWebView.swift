import AppKit
import SwiftUI
import WebKit

/// Hosts a `WKWebView` and forwards keyboard focus from SwiftUI/AppKit to WebKit.
/// Without this, clicks can show a caret in the `<textarea>` while key events still go to the previous app.
final class WebViewFocusContainer: NSView {
	let webView: WKWebView
	private var keyObserver: NSObjectProtocol?

	init(webView: WKWebView) {
		self.webView = webView
		super.init(frame: .zero)
		addSubview(webView)
		webView.translatesAutoresizingMaskIntoConstraints = false
		NSLayoutConstraint.activate([
			webView.leadingAnchor.constraint(equalTo: leadingAnchor),
			webView.trailingAnchor.constraint(equalTo: trailingAnchor),
			webView.topAnchor.constraint(equalTo: topAnchor),
			webView.bottomAnchor.constraint(equalTo: bottomAnchor),
		])
		// Register for file drag & drop at the NSView level so WKWebView never navigates
		registerForDraggedTypes([.fileURL, .URL, .string])
	}

	@available(*, unavailable)
	required init?(coder: NSCoder) {
		fatalError("init(coder:) has not been implemented")
	}

	deinit {
		if let keyObserver {
			NotificationCenter.default.removeObserver(keyObserver)
		}
	}

	override var acceptsFirstResponder: Bool { true }

	@discardableResult
	override func becomeFirstResponder() -> Bool {
		window?.makeFirstResponder(webView) ?? false
	}

	override func mouseDown(with event: NSEvent) {
		window?.makeFirstResponder(webView)
		super.mouseDown(with: event)
	}

	override func viewDidMoveToWindow() {
		super.viewDidMoveToWindow()
		if let keyObserver {
			NotificationCenter.default.removeObserver(keyObserver)
			self.keyObserver = nil
		}
		guard let window else { return }
		keyObserver = NotificationCenter.default.addObserver(
			forName: NSWindow.didBecomeKeyNotification,
			object: window,
			queue: .main,
		) { [weak self] _ in
			guard let self else { return }
			self.window?.makeFirstResponder(self.webView)
		}
	}

	// MARK: - Drag & Drop at NSView level

	override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
		if sender.draggingPasteboard.canReadObject(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) {
			return .copy
		}
		return []
	}

	override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
		guard let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL],
		      !urls.isEmpty else { return false }
		injectFilePaths(urls.map { $0.path })
		return true
	}

	/// Inject file paths into the webview as attachment chips.
	func injectFilePaths(_ paths: [String]) {
		let escaped = paths.map {
			$0.replacingOccurrences(of: "\\", with: "\\\\")
			  .replacingOccurrences(of: "\"", with: "\\\"")
		}
		let arr = escaped.map { "\"\($0)\"" }.joined(separator: ",")
		let js = "if(typeof insertChipsForPaths==='function'){insertChipsForPaths([\(arr)])}"
		webView.evaluateJavaScript(js, completionHandler: nil)
	}
}

struct ChatWebView: NSViewRepresentable {
	/// Finder-launched apps can fire menu `onReceive` before `@State webViewRef` is set (async assignment); keep a sync ref for native→JS inject.
	private static weak var activeWebViewForHostInject: WKWebView?

	@Binding var webViewRef: WKWebView?
	var workspaceRoot: URL?
	let onBridgeMessage: ([String: Any]) -> Void

	func makeCoordinator() -> Coordinator {
		Coordinator(onBridgeMessage: onBridgeMessage)
	}

	func makeNSView(context: Context) -> WebViewFocusContainer {
			let config = WKWebViewConfiguration()
			config.userContentController.add(context.coordinator, name: "freeCodeBridge")
		let wv = WKWebView(frame: .zero, configuration: config)
		wv.setValue(false, forKey: "drawsBackground")
		wv.navigationDelegate = context.coordinator
		context.coordinator.webView = wv
		let container = WebViewFocusContainer(webView: wv)
		context.coordinator.container = container
		Self.activeWebViewForHostInject = wv
		DispatchQueue.main.async {
			webViewRef = wv
		}
		return container
	}

	static func dismantleNSView(_ nsView: WebViewFocusContainer, coordinator: Coordinator) {
		if coordinator.webView === Self.activeWebViewForHostInject {
			Self.activeWebViewForHostInject = nil
		}
	}

	func updateNSView(_ container: WebViewFocusContainer, context: Context) {
		context.coordinator.workspaceRoot = workspaceRoot
		let webView = container.webView
		if context.coordinator.didLoadHTML { return }
		if let html = Bundle.module.url(forResource: "chat-mac", withExtension: "html", subdirectory: "Media") {
			let dir = html.deletingLastPathComponent()
			webView.loadFileURL(html, allowingReadAccessTo: dir)
			context.coordinator.didLoadHTML = true
		}
	}

	final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
		var onBridgeMessage: ([String: Any]) -> Void
		var didLoadHTML = false
		weak var webView: WKWebView?
		weak var container: WebViewFocusContainer?
		var workspaceRoot: URL?

		init(onBridgeMessage: @escaping ([String: Any]) -> Void) {
			self.onBridgeMessage = onBridgeMessage
		}

		func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
			guard message.name == "freeCodeBridge" else { return }
			if let body = message.body as? [String: Any],
			   let type = body["type"] as? String, type == "workspace_indicator_click" {
				// Open folder picker for workspace change
				let panel = NSOpenPanel()
				panel.canChooseFiles = false
				panel.canChooseDirectories = true
				panel.allowsMultipleSelection = false
				if let root = workspaceRoot {
					panel.directoryURL = root
				}
				if panel.runModal() == .OK, let url = panel.url {
					onBridgeMessage(["type": "change_workspace", "path": url.path])
				}
				return
			}
			if let body = message.body as? [String: Any],
			   let type = body["type"] as? String, type == "drop_request" {
				// Show native file picker starting at workspace root
				let panel = NSOpenPanel()
				panel.canChooseFiles = true
				panel.canChooseDirectories = true
				panel.allowsMultipleSelection = true
				if let root = workspaceRoot {
					panel.directoryURL = root
				}
				if panel.runModal() == .OK {
					let paths = panel.urls.map { $0.path }
					container?.injectFilePaths(paths)
				}
				return
			}
			if let body = message.body as? [String: Any] {
				onBridgeMessage(body)
			} else if let body = message.body as? [AnyHashable: Any] {
				let asDict = Dictionary(uniqueKeysWithValues: body.compactMap { k, v -> (String, Any)? in
					guard let ks = k as? String else { return nil }
					return (ks, v)
				})
				onBridgeMessage(asDict)
			}
		}

		func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
			webView.evaluateJavaScript("void 0", completionHandler: nil)
		}

		/// Block WKWebView from navigating to dropped/pasted file:// URLs.
		/// Only allow the initial local HTML load and fragment/same-page navigations.
		func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
			let url = navigationAction.request.url
			// Allow the initial file:// load of our bundled HTML
			if navigationAction.navigationType == .other {
				decisionHandler(.allow)
				return
			}
			// Block any file:// navigation triggered by drag/drop/link click
			if let url, url.isFileURL {
				// Inject the path as an attachment via the bridge
				let path = url.path
				let js = "if(typeof insertChipsForPaths==='function'){insertChipsForPaths([\"\(path.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\""))\"])}"
				webView.evaluateJavaScript(js, completionHandler: nil)
				decisionHandler(.cancel)
				return
			}
			decisionHandler(.allow)
		}
	}
}

extension ChatWebView {
	/// Push host payloads into the page as `window` message events (same as VS Code webview).
	static func injectHostMessage(webView: WKWebView?, payload: [String: Any]) {
		let target = webView ?? Self.activeWebViewForHostInject
		guard let webView = target,
		      let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
			let b64 = data.base64EncodedString()
			let js = "window.__freeCodeInjectHostPayloadB64('\(b64)');"
		webView.evaluateJavaScript(js, completionHandler: nil)
	}
}
