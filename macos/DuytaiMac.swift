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
    private var lastChangeCount: Int = NSPasteboard.general.changeCount
    private let serverPort: Int = Int(ProcessInfo.processInfo.environment["HYPER_IDM_PORT"] ?? "17890") ?? 17890
    private var coreDir: String = ""

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
        coreDir = resolveCoreDir()
        installSignalHandlers()
        startNodeCore()
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
        let candidates = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/opt/homebrew/opt/node/bin/node",
            NSHomeDirectory() + "/.nvm/versions/node/current/bin/node",
            "/usr/bin/node"
        ]
        for c in candidates where FileManager.default.isExecutableFile(atPath: c) {
            return c
        }
        return "/usr/bin/env"
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
        guard let proc = serverProcess, proc.isRunning else { return }
        proc.terminate()
    }

    private func installSignalHandlers() {
        signal(SIGTERM) { _ in exit(0) }
        signal(SIGINT) { _ in exit(0) }
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
        DispatchQueue.global(qos: .userInitiated).async {
            for _ in 0..<40 {
                var req = URLRequest(url: targetURL)
                req.timeoutInterval = 0.3
                let sem = DispatchSemaphore(value: 0)
                var ready = false
                URLSession.shared.dataTask(with: req) { _, resp, _ in
                    if let http = resp as? HTTPURLResponse, http.statusCode < 500 {
                        ready = true
                    }
                    sem.signal()
                }.resume()
                sem.wait()
                if ready { break }
                Thread.sleep(forTimeInterval: 0.15)
            }
            DispatchQueue.main.async { [weak self] in
                self?.webView.load(URLRequest(url: targetURL))
            }
        }
    }

    private func startClipboardMonitor() {
        clipboardTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.checkClipboardForDownloadableUrl()
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
            enqueueDownload(urlString: str, source: "macOS Clipboard Auto")
        }
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
        let payload: [String: Any] = [
            "url": urlString,
            "maxConnections": 64,
            "source": source,
            "autoCategory": true
        ]
        req.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        URLSession.shared.dataTask(with: req).resume()
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
