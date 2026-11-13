import Cocoa
import WebKit
import Foundation

@main
@MainActor
final class DuytaiMacApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var statusItem: NSStatusItem!
    private var serverProcess: Process?
    private var clipboardTimer: Timer?
    private var sigTermSource: DispatchSourceSignal?
    private var sigIntSource: DispatchSourceSignal?
    private var lastChangeCount: Int = NSPasteboard.general.changeCount
    private let serverPort: Int = Int(ProcessInfo.processInfo.environment["HYPER_IDM_PORT"] ?? "17890") ?? 17890
    private var coreDir: String = ""
    private let dataDir: String = NSHomeDirectory() + "/Library/Application Support/Duytai"

    private let mediaExts: Set<String> = [
        "3gp","7z","aac","ace","aif","apk","arj","asf","avi","bin","bz2","dmg",
        "exe","flac","gz","gzip","img","ipsw","iso","lzh","m4a","m4v","mkv",
        "mov","mp3","mp4","mpa","mpe","mpeg","mpg","msi","msu","ogg","ogv",
        "pdf","pkg","plj","pps","ppt","qt","ra","rar","rm","rmvb","sea",
        "sit","sitx","tar","tif","tiff","wav","webm","wma","wmv","z","zip"
    ]

    static func main() {
        let app = NSApplication.shared
        let delegate = DuytaiMacApp()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        try? FileManager.default.createDirectory(atPath: dataDir, withIntermediateDirectories: true)
        coreDir = resolveCoreDir()
        installSignalHandlers()
        startNodeCore()
        setupMainMenu()
        setupStatusBar()
        setupMainWindow()
        startClipboardMonitor()
        waitAndLoadUI()
    }

    func applicationWillTerminate(_ notification: Notification) {
        clipboardTimer?.invalidate()
        stopNodeCore()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showMainWindow() }
        return true
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            handleCustomScheme(url)
        }
        showMainWindow()
    }

    private func resolveCoreDir() -> String {
        let fm = FileManager.default
        if let res = Bundle.main.resourcePath {
            let bundled = (res as NSString).appendingPathComponent("core")
            if fm.fileExists(atPath: (bundled as NSString).appendingPathComponent("server.js")) {
                return bundled
            }
        }
        let appSupport = NSHomeDirectory() + "/Library/Application Support/Duytai/core"
        if fm.fileExists(atPath: appSupport + "/server.js") { return appSupport }
        let cwd = fm.currentDirectoryPath
        if fm.fileExists(atPath: cwd + "/server.js") { return cwd }
        return (cwd as NSString).deletingLastPathComponent
    }

    private func findNodeBinary() -> String {
        var candidates = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/opt/homebrew/opt/node/bin/node",
            NSHomeDirectory() + "/.volta/bin/node",
            NSHomeDirectory() + "/.fnm/current/bin/node",
            NSHomeDirectory() + "/.nvm/versions/node/current/bin/node",
            "/usr/bin/node"
        ]
        let nvmRoot = NSHomeDirectory() + "/.nvm/versions/node"
        if let vers = try? FileManager.default.contentsOfDirectory(atPath: nvmRoot).sorted() {
            for v in vers.reversed() {
                candidates.append("\(nvmRoot)/\(v)/bin/node")
            }
        }
        for c in candidates where FileManager.default.isExecutableFile(atPath: c) {
            return c
        }
        return "/usr/bin/env"
    }

    private func readAuthToken() -> String {
        let tokenPath = (dataDir as NSString).appendingPathComponent("auth.token")
        if let tok = try? String(contentsOfFile: tokenPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
           !tok.isEmpty {
            return tok
        }
        return ""
    }

    private func startNodeCore() {
        let serverJs = (coreDir as NSString).appendingPathComponent("server.js")
        guard FileManager.default.fileExists(atPath: serverJs) else { return }

        let nodeBin = findNodeBinary()
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodeBin)
        proc.arguments = nodeBin.hasSuffix("/env")
            ? ["node", "--max-old-space-size=384", serverJs]
            : ["--max-old-space-size=384", serverJs]
        proc.currentDirectoryURL = URL(fileURLWithPath: coreDir)
        var env = ProcessInfo.processInfo.environment
        env["HYPER_IDM_PORT"] = String(serverPort)
        env["DUYTAI_DATA_DIR"] = dataDir
        env["HYPER_IDM_HISTORY_FILE"] = (dataDir as NSString).appendingPathComponent("history.json")
        let extraPath = "/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin")
        env["PATH"] = extraPath
        proc.environment = env
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            serverProcess = proc
        } catch {
            NSLog("Duytai core launch error: \(error)")
        }
    }

    private func stopNodeCore() {
        if let shutdownURL = URL(string: "http://127.0.0.1:\(serverPort)/api/shutdown") {
            var req = URLRequest(url: shutdownURL)
            req.httpMethod = "POST"
            req.timeoutInterval = 1.0
            let tok = readAuthToken()
            if !tok.isEmpty { req.setValue(tok, forHTTPHeaderField: "X-Duytai-Token") }
            let sem = DispatchSemaphore(value: 0)
            URLSession.shared.dataTask(with: req) { _, _, _ in sem.signal() }.resume()
            _ = sem.wait(timeout: .now() + 1.0)
        }
        guard let proc = serverProcess, proc.isRunning else { return }
        proc.terminate()
    }

    private func installSignalHandlers() {
        signal(SIGTERM, SIG_IGN)
        signal(SIGINT, SIG_IGN)
        let termSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        termSrc.setEventHandler { NSApp.terminate(nil) }
        termSrc.resume()
        sigTermSource = termSrc

        let intSrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
        intSrc.setEventHandler { NSApp.terminate(nil) }
        intSrc.resume()
        sigIntSource = intSrc
    }

    private func setupMainMenu() {
        let mainMenu = NSMenu()
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenu.addItem(NSMenuItem(title: "Mở Duytai Downloader", action: #selector(showMainWindowAction), keyEquivalent: "o"))
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(NSMenuItem(title: "Thoát Duytai", action: #selector(quitAppAction), keyEquivalent: "q"))
        appMenuItem.submenu = appMenu

        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(NSMenuItem(title: "Undo", action: Selector(("undo:")), keyEquivalent: "z"))
        editMenu.addItem(NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "Z"))
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        editMenu.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        editMenu.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        editMenu.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        editMenuItem.submenu = editMenu

        NSApp.mainMenu = mainMenu
    }

    private func setupStatusBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "⚡Duytai"
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Mở Duytai Downloader", action: #selector(showMainWindowAction), keyEquivalent: "o"))
        menu.addItem(NSMenuItem(title: "Tải link từ Clipboard", action: #selector(pasteFromClipboardAction), keyEquivalent: "v"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Thoát Duytai", action: #selector(quitAppAction), keyEquivalent: "q"))
        statusItem.menu = menu
    }

    private func setupMainWindow() {
        let rect = NSRect(x: 0, y: 0, width: 1240, height: 820)
        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Duytai Downloader — macOS Native (64/128 Threads)"
        window.center()

        let cfg = WKWebViewConfiguration()
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
        webView = WKWebView(frame: rect, configuration: cfg)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.autoresizingMask = [.width, .height]
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func waitAndLoadUI() {
        let targetURL = URL(string: "http://127.0.0.1:\(serverPort)")!
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var serverReady = false
            for _ in 0..<40 {
                if (try? Data(contentsOf: targetURL)) != nil {
                    serverReady = true
                    break
                }
                Thread.sleep(forTimeInterval: 0.15)
            }
            let ready = serverReady
            DispatchQueue.main.async {
                guard let self = self else { return }
                if ready {
                    self.webView.load(URLRequest(url: targetURL))
                } else {
                    let diagHtml = """
                    <!doctype html><html lang="vi"><head><meta charset="utf-8"><style>
                    body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:40px;background:#f8fafc;color:#0f172a}
                    .card{max-width:620px;margin:40px auto;background:#fff;border:1px solid #cbd5e1;border-radius:10px;padding:24px}
                    h2{color:#0284c7;margin-top:0} code{background:#f1f5f9;padding:3px 6px;border-radius:4px}
                    </style></head><body><div class="card">
                    <h2>⚡ Duytai Downloader v7.5 — Cần Node.js Runtime</h2>
                    <p>Không tìm thấy hoặc không thể khởi chạy máy chủ Node.js cục bộ tại cổng <code>\(self.serverPort)</code>.</p>
                    <p>Vui lòng cài đặt Node.js 22+ trên macOS (ví dụ: <code>brew install node</code> hoặc tải từ <code>https://nodejs.org</code>), sau đó khởi động lại ứng dụng <b>Duytai.app</b>.</p>
                    </div></body></html>
                    """
                    self.webView.loadHTMLString(diagHtml, baseURL: nil)
                }
            }
        }
    }

    private func startClipboardMonitor() {
        clipboardTimer = Timer.scheduledTimer(withTimeInterval: 1.2, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.checkClipboardForDownloadableUrl()
                self?.pollInterceptQueue()
            }
        }
    }

    private func checkClipboardForDownloadableUrl() {
        let pb = NSPasteboard.general
        guard pb.changeCount != lastChangeCount else { return }
        lastChangeCount = pb.changeCount
        guard let str = pb.string(forType: .string)?.trimmingCharacters(in: .whitespacesAndNewlines),
              let url = URL(string: str),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else { return }
        let ext = url.pathExtension.lowercased()
        let isRarPart = ext.range(of: #"^r\d+$"#, options: .regularExpression) != nil
        if mediaExts.contains(ext) || isRarPart || url.host?.contains("ipsw.me") == true {
            let alert = NSAlert()
            alert.messageText = "Duytai Downloader — Phát hiện link tải trong Clipboard"
            alert.informativeText = "Bạn có muốn tải tệp này với 64 luồng không?\n\(str)"
            alert.addButton(withTitle: "Tải ngay")
            alert.addButton(withTitle: "Bỏ qua")
            if alert.runModal() == .alertFirstButtonReturn {
                enqueueDownload(urlString: str, source: "macOS Clipboard")
                showMainWindow()
            }
        }
    }

    private func pollInterceptQueue() {
        guard let qURL = URL(string: "http://127.0.0.1:\(serverPort)/api/intercept-queue") else { return }
        var req = URLRequest(url: qURL)
        req.timeoutInterval = 1.0
        let tok = readAuthToken()
        if !tok.isEmpty { req.setValue(tok, forHTTPHeaderField: "X-Duytai-Token") }
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
            guard let self = self,
                  let http = resp as? HTTPURLResponse, http.statusCode == 200,
                  let data = data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let items = obj["items"] as? [[String: Any]], !items.isEmpty else { return }
            let pairs: [(String, String)] = items.compactMap { item in
                guard let u = item["url"] as? String, !u.isEmpty else { return nil }
                return (u, (item["source"] as? String) ?? "Browser Extension")
            }
            guard !pairs.isEmpty else { return }
            DispatchQueue.main.async {
                self.showMainWindow()
                for (u, src) in pairs {
                    self.enqueueDownload(urlString: u, source: src)
                }
            }
        }.resume()
    }

    private func handleCustomScheme(_ url: URL) {
        if let comp = URLComponents(url: url, resolvingAgainstBaseURL: false),
           let target = comp.queryItems?.first(where: { $0.name == "url" })?.value {
            enqueueDownload(urlString: target, source: "macOS URL Scheme")
        } else {
            let raw = url.absoluteString.replacingOccurrences(of: "duytai://", with: "")
            if raw.hasPrefix("http") {
                enqueueDownload(urlString: raw, source: "macOS URL Scheme")
            }
        }
    }

    private func enqueueDownload(urlString: String, source: String) {
        guard let apiURL = URL(string: "http://127.0.0.1:\(serverPort)/api/jobs") else { return }
        var req = URLRequest(url: apiURL)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let tok = readAuthToken()
        if !tok.isEmpty { req.setValue(tok, forHTTPHeaderField: "X-Duytai-Token") }
        let payload: [String: Any] = [
            "url": urlString,
            "maxConnections": 64,
            "source": source,
            "autoCategory": true
        ]
        req.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        URLSession.shared.dataTask(with: req).resume()
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = "Duytai Downloader"
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = "Duytai Downloader"
        alert.informativeText = message
        alert.addButton(withTitle: "Đồng ý")
        alert.addButton(withTitle: "Hủy")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = "Duytai Downloader"
        alert.informativeText = prompt
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Hủy")
        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        input.stringValue = defaultText ?? ""
        alert.accessoryView = input
        completionHandler(alert.runModal() == .alertFirstButtonReturn ? input.stringValue : nil)
    }

    @objc private func showMainWindowAction() { showMainWindow() }

    private func showMainWindow() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func pasteFromClipboardAction() {
        if let str = NSPasteboard.general.string(forType: .string)?.trimmingCharacters(in: .whitespacesAndNewlines),
           str.hasPrefix("http") {
            enqueueDownload(urlString: str, source: "Menu Paste")
            showMainWindow()
        }
    }

    @objc private func quitAppAction() {
        NSApp.terminate(nil)
    }
}
