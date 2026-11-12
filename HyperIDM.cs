using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.IO.Pipes;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace HyperIDM
{
    internal static class Program
    {
        internal const int Port = 17890;
        internal static readonly string AppUrl = "http://127.0.0.1:17890";
        private const string MutexName = "Local\\HyperIDM_Ultra_SingleInstance_Mutex_v3";
        internal const string PipeName = "HyperIDM_Ultra_IPC_Pipe_v3";

        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        [STAThread]
        private static void Main(string[] args)
        {
            try { SetProcessDPIAware(); } catch { }
            ServicePointManager.Expect100Continue = false;
            ServicePointManager.DefaultConnectionLimit = 32;

            bool startMinimized = false;
            string initialUrl = ExtractUrlArg(args, out startMinimized);

            bool createdNew = false;
            using (Mutex mutex = new Mutex(true, MutexName, out createdNew))
            {
                if (!createdNew)
                {
                    SendToRunningInstance(!string.IsNullOrEmpty(initialUrl) ? ("URL|" + initialUrl) : (startMinimized ? "NOOP" : "SHOW_MAIN"));
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                using (TrayAgentContext context = new TrayAgentContext(initialUrl, startMinimized))
                {
                    Application.Run(context);
                }
            }
        }

        private static string ExtractUrlArg(string[] args, out bool startMinimized)
        {
            startMinimized = false;
            if (args == null) return null;

            for (int i = 0; i < args.Length; i++)
            {
                string a = (args[i] ?? "").Trim();
                if (string.IsNullOrEmpty(a)) continue;

                if (string.Equals(a, "--tray", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(a, "--minimized", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(a, "-tray", StringComparison.OrdinalIgnoreCase))
                {
                    startMinimized = true;
                    continue;
                }

                if (a.StartsWith("hyperidm://", StringComparison.OrdinalIgnoreCase))
                {
                    string raw = a.Substring("hyperidm://".Length).TrimStart('/');
                    if (raw.StartsWith("download?", StringComparison.OrdinalIgnoreCase))
                    {
                        Match m = Regex.Match(raw, @"(?:^|&)url=([^&]+)", RegexOptions.IgnoreCase);
                        if (m.Success) return Uri.UnescapeDataString(m.Groups[1].Value);
                    }
                    if (!raw.StartsWith("http://", StringComparison.OrdinalIgnoreCase) &&
                        !raw.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                    {
                        raw = "https://" + raw;
                    }
                    return raw;
                }

                if (a.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                    a.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                {
                    return a;
                }
            }
            return null;
        }

        private static void SendToRunningInstance(string payload)
        {
            if (payload == "NOOP") return;
            try
            {
                using (NamedPipeClientStream client = new NamedPipeClientStream(".", PipeName, PipeDirection.Out))
                {
                    client.Connect(1500);
                    byte[] data = Encoding.UTF8.GetBytes(payload);
                    client.Write(data, 0, data.Length);
                    client.Flush();
                }
            }
            catch
            {
                // Fallback if pipe is busy: open web UI directly
                if (payload == "SHOW_MAIN")
                {
                    OpenDesktopWindow();
                }
            }
        }

        internal static bool IsServerRunning()
        {
            try
            {
                using (TcpClient client = new TcpClient())
                {
                    IAsyncResult result = client.BeginConnect("127.0.0.1", Port, null, null);
                    bool success = result.AsyncWaitHandle.WaitOne(TimeSpan.FromMilliseconds(180));
                    if (!success) return false;
                    client.EndConnect(result);
                    return true;
                }
            }
            catch
            {
                return false;
            }
        }

        internal static void OpenDesktopWindow()
        {
            string[] browserCandidates = new string[]
            {
                @"C:\Program Files\Google\Chrome\Application\chrome.exe",
                @"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
                @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                @"C:\Program Files\Microsoft\Edge\Application\msedge.exe"
            };

            for (int i = 0; i < browserCandidates.Length; i++)
            {
                if (File.Exists(browserCandidates[i]))
                {
                    try
                    {
                        Process.Start(new ProcessStartInfo
                        {
                            FileName = browserCandidates[i],
                            Arguments = "--app=" + AppUrl + " --window-size=1380,860",
                            UseShellExecute = true
                        });
                        return;
                    }
                    catch { }
                }
            }

            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = AppUrl,
                    UseShellExecute = true
                });
            }
            catch { }
        }
    }

    internal sealed class TrayAgentContext : ApplicationContext
    {
        private readonly Control uiHost;
        private readonly NotifyIcon trayIcon;
        private readonly ContextMenuStrip trayMenu;
        private readonly ToolStripMenuItem menuClipboard;
        private readonly ToolStripMenuItem menuBrowser;
        private readonly System.Windows.Forms.Timer monitorTimer;
        private readonly System.Windows.Forms.Timer watchdogTimer;

        private readonly IntPtr iconHandle;
        private readonly Icon appIcon;

        private readonly Dictionary<string, DateTime> recentPromptedUrls = new Dictionary<string, DateTime>(StringComparer.OrdinalIgnoreCase);
        private readonly HashSet<string> activeDialogUrls = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        private bool clipboardEnabled = true;
        private bool browserInterceptEnabled = true;
        private string lastClipboardText = "";
        private int pollingQueueFlag = 0;
        private int watchdogBusyFlag = 0;
        private volatile bool isExiting = false;

        private Process serverProcess = null;
        private DateTime lastServerStartAttempt = DateTime.MinValue;
        private Thread pipeThread;

        private static readonly Regex DownloadExtRegex = new Regex(
            @"\.(zip|rar|7z|exe|msi|iso|ipsw|dmg|apk|mp4|mkv|pdf|bin|img|tar|gz|bz2|xz|tgz|deb|rpm|pkg|avi|mov|webm|mp3|flac|wav|aac)(?:$|[?#])",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);

        private static readonly Regex SpecialHostRegex = new Regex(
            @"^https?://(?:(?:www\.)?(?:ipsw\.me/download/|youtube\.com/(?:watch\?v=|shorts/)|youtu\.be/)|updates\.cdn-apple\.com/|appldnld\.apple\.com/)",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        private static extern bool DestroyIcon(IntPtr handle);

        public TrayAgentContext(string initialUrl, bool startMinimized)
        {
            uiHost = new Control();
            IntPtr forceHandle = uiHost.Handle; // Ensure UI handle exists for BeginInvoke before any Form opens
            if (forceHandle == IntPtr.Zero) { }

            appIcon = CreateHyperIdmIcon(out iconHandle);

            trayMenu = new ContextMenuStrip();
            trayMenu.ShowImageMargin = false;
            trayMenu.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);

            ToolStripMenuItem menuOpen = new ToolStripMenuItem("🚀 Mở HyperIDM Ultra");
            menuOpen.Font = new Font(trayMenu.Font, FontStyle.Bold);
            menuOpen.Click += delegate { Program.OpenDesktopWindow(); };

            ToolStripMenuItem menuAddUrl = new ToolStripMenuItem("➕ Thêm URL tải xuống mới...");
            menuAddUrl.Click += delegate { ShowDownloadDialog("", null, null, null, "Thêm URL thủ công"); };

            menuClipboard = new ToolStripMenuItem("📋 Tự động bắt link khi Copy (Clipboard) [✓]");
            menuClipboard.Checked = true;
            menuClipboard.Click += delegate
            {
                clipboardEnabled = !clipboardEnabled;
                menuClipboard.Checked = clipboardEnabled;
                menuClipboard.Text = clipboardEnabled
                    ? "📋 Tự động bắt link khi Copy (Clipboard) [✓]"
                    : "📋 Tự động bắt link khi Copy (Clipboard) [  ]";
            };

            menuBrowser = new ToolStripMenuItem("🌐 Bắt link từ Trình duyệt (Đang lắng nghe) [✓]");
            menuBrowser.Checked = true;
            menuBrowser.Click += delegate
            {
                browserInterceptEnabled = !browserInterceptEnabled;
                menuBrowser.Checked = browserInterceptEnabled;
                menuBrowser.Text = browserInterceptEnabled
                    ? "🌐 Bắt link từ Trình duyệt (Đang lắng nghe) [✓]"
                    : "🌐 Bắt link từ Trình duyệt (Đã tạm dừng) [  ]";
            };

            ToolStripMenuItem menuPauseAll = new ToolStripMenuItem("⏸️ Dừng tất cả tác vụ đang tải");
            menuPauseAll.Click += delegate { PauseAllActiveJobsAsync(); };

            ToolStripMenuItem menuOpenFolder = new ToolStripMenuItem("📂 Mở thư mục Tải xuống (Downloads\\HyperIDM)");
            menuOpenFolder.Click += delegate { OpenDownloadsFolder(); };

            ToolStripMenuItem menuExit = new ToolStripMenuItem("❌ Thoát hoàn toàn HyperIDM");
            menuExit.Click += delegate { ExitApplication(); };

            trayMenu.Items.Add(menuOpen);
            trayMenu.Items.Add(menuAddUrl);
            trayMenu.Items.Add(new ToolStripSeparator());
            trayMenu.Items.Add(menuClipboard);
            trayMenu.Items.Add(menuBrowser);
            trayMenu.Items.Add(new ToolStripSeparator());
            trayMenu.Items.Add(menuPauseAll);
            trayMenu.Items.Add(menuOpenFolder);
            trayMenu.Items.Add(new ToolStripSeparator());
            trayMenu.Items.Add(menuExit);

            trayIcon = new NotifyIcon();
            trayIcon.Icon = appIcon;
            trayIcon.Text = "HyperIDM Ultra 64-Bit — Đang chạy ngầm bắt link";
            trayIcon.ContextMenuStrip = trayMenu;
            trayIcon.Visible = true;
            trayIcon.DoubleClick += delegate { Program.OpenDesktopWindow(); };

            // Capture current clipboard so startup does not re-prompt old links
            try
            {
                if (Clipboard.ContainsText())
                {
                    lastClipboardText = Clipboard.GetText() ?? "";
                }
            }
            catch { }

            EnsureServerRunningSync(3500);
            StartPipeListener();

            monitorTimer = new System.Windows.Forms.Timer();
            monitorTimer.Interval = 600;
            monitorTimer.Tick += MonitorTimer_Tick;
            monitorTimer.Start();

            watchdogTimer = new System.Windows.Forms.Timer();
            watchdogTimer.Interval = 5000;
            watchdogTimer.Tick += WatchdogTimer_Tick;
            watchdogTimer.Start();

            if (!string.IsNullOrEmpty(initialUrl))
            {
                ShowDownloadDialog(initialUrl, null, null, null, "Liên kết khởi chạy");
            }
            else if (!startMinimized)
            {
                Program.OpenDesktopWindow();
                trayIcon.ShowBalloonTip(
                    2500,
                    "HyperIDM Ultra 64-Bit đang chạy ngầm",
                    "Sẵn sàng tự động bắt link từ Clipboard và Trình duyệt.",
                    ToolTipIcon.Info);
            }
        }

        internal Icon SharedIcon { get { return appIcon; } }

        private static Icon CreateHyperIdmIcon(out IntPtr hIcon)
        {
            using (Bitmap bmp = new Bitmap(32, 32, PixelFormat.Format32bppArgb))
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.Clear(Color.Transparent);

                // Shield / Orb silhouette with teal-cyan gradient
                using (GraphicsPath shield = new GraphicsPath())
                {
                    PointF[] pts = new PointF[]
                    {
                        new PointF(16f, 1.5f),
                        new PointF(28.5f, 5.5f),
                        new PointF(27.5f, 16.5f),
                        new PointF(23.0f, 25.0f),
                        new PointF(16f, 30.5f),
                        new PointF(9.0f, 25.0f),
                        new PointF(4.5f, 16.5f),
                        new PointF(3.5f, 5.5f)
                    };
                    shield.AddClosedCurve(pts, 0.25f);

                    using (LinearGradientBrush bgBrush = new LinearGradientBrush(
                        new Rectangle(0, 0, 32, 32),
                        Color.FromArgb(255, 0, 229, 255),
                        Color.FromArgb(255, 0, 105, 92),
                        LinearGradientMode.ForwardDiagonal))
                    {
                        ColorBlend blend = new ColorBlend();
                        blend.Colors = new Color[]
                        {
                            Color.FromArgb(255, 56, 239, 255),
                            Color.FromArgb(255, 0, 168, 150),
                            Color.FromArgb(255, 2, 74, 82)
                        };
                        blend.Positions = new float[] { 0f, 0.55f, 1f };
                        bgBrush.InterpolationColors = blend;
                        g.FillPath(bgBrush, shield);
                    }

                    using (Pen borderPen = new Pen(Color.FromArgb(220, 224, 255, 255), 1.4f))
                    {
                        g.DrawPath(borderPen, shield);
                    }
                }

                // Crisp gold lightning bolt in center
                PointF[] bolt = new PointF[]
                {
                    new PointF(18.2f, 5.5f),
                    new PointF(9.8f, 17.2f),
                    new PointF(15.6f, 17.2f),
                    new PointF(13.2f, 26.8f),
                    new PointF(22.6f, 14.3f),
                    new PointF(16.6f, 14.3f)
                };

                using (Pen boltOutline = new Pen(Color.FromArgb(200, 120, 53, 15), 2.0f))
                {
                    boltOutline.LineJoin = LineJoin.Round;
                    g.DrawPolygon(boltOutline, bolt);
                }

                using (LinearGradientBrush boltBrush = new LinearGradientBrush(
                    new Rectangle(9, 5, 14, 22),
                    Color.FromArgb(255, 255, 245, 110),
                    Color.FromArgb(255, 255, 171, 0),
                    LinearGradientMode.Vertical))
                {
                    g.FillPolygon(boltBrush, bolt);
                }

                hIcon = bmp.GetHicon();
                return Icon.FromHandle(hIcon);
            }
        }

        private void StartPipeListener()
        {
            pipeThread = new Thread(delegate()
            {
                while (!isExiting)
                {
                    try
                    {
                        using (NamedPipeServerStream server = new NamedPipeServerStream(
                            Program.PipeName,
                            PipeDirection.In,
                            4,
                            PipeTransmissionMode.Byte,
                            PipeOptions.None))
                        {
                            server.WaitForConnection();
                            if (isExiting) break;

                            using (MemoryStream ms = new MemoryStream())
                            {
                                byte[] buf = new byte[4096];
                                int read;
                                while ((read = server.Read(buf, 0, buf.Length)) > 0)
                                {
                                    ms.Write(buf, 0, read);
                                }
                                string msg = Encoding.UTF8.GetString(ms.ToArray()).Trim();
                                if (!string.IsNullOrEmpty(msg) && !isExiting)
                                {
                                    HandlePipeCommand(msg);
                                }
                            }
                        }
                    }
                    catch
                    {
                        if (isExiting) break;
                        Thread.Sleep(250);
                    }
                }
            });
            pipeThread.IsBackground = true;
            pipeThread.Start();
        }

        private void HandlePipeCommand(string msg)
        {
            try
            {
                uiHost.BeginInvoke(new MethodInvoker(delegate
                {
                    if (isExiting) return;
                    if (msg == "SHOW_MAIN")
                    {
                        Program.OpenDesktopWindow();
                    }
                    else if (msg.StartsWith("URL|", StringComparison.Ordinal))
                    {
                        string url = msg.Substring(4).Trim();
                        if (!string.IsNullOrEmpty(url))
                        {
                            ShowDownloadDialog(url, null, null, null, "Liên kết bên ngoài");
                        }
                    }
                }));
            }
            catch { }
        }

        private void MonitorTimer_Tick(object sender, EventArgs e)
        {
            if (isExiting) return;

            if (clipboardEnabled)
            {
                CheckClipboard();
            }

            if (browserInterceptEnabled)
            {
                PollBrowserInterceptQueueAsync();
            }
        }

        private void WatchdogTimer_Tick(object sender, EventArgs e)
        {
            if (isExiting) return;
            if (Interlocked.CompareExchange(ref watchdogBusyFlag, 1, 0) != 0) return;

            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    if (!isExiting && !Program.IsServerRunning())
                    {
                        if ((DateTime.UtcNow - lastServerStartAttempt).TotalSeconds >= 6)
                        {
                            StartEngineDaemon();
                        }
                    }
                }
                finally
                {
                    Interlocked.Exchange(ref watchdogBusyFlag, 0);
                }
            });
        }

        internal void EnsureServerRunningSync(int maxWaitMs)
        {
            if (Program.IsServerRunning()) return;
            StartEngineDaemon();
            int waited = 0;
            while (waited < maxWaitMs)
            {
                if (Program.IsServerRunning()) return;
                Thread.Sleep(150);
                waited += 150;
            }
        }

        private void StartEngineDaemon()
        {
            lastServerStartAttempt = DateTime.UtcNow;
            try
            {
                string baseDir = AppDomain.CurrentDomain.BaseDirectory;
                string serverJs = Path.Combine(baseDir, "server.js");
                if (!File.Exists(serverJs))
                {
                    string fallbackDir = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        @"Programs\HyperIDM");
                    string fallbackServer = Path.Combine(fallbackDir, "server.js");
                    if (File.Exists(fallbackServer))
                    {
                        baseDir = fallbackDir;
                        serverJs = fallbackServer;
                    }
                }
                if (!File.Exists(serverJs)) return;

                string nodePath = @"C:\Program Files\nodejs\node.exe";
                if (!File.Exists(nodePath))
                {
                    string nodeX86 = @"C:\Program Files (x86)\nodejs\node.exe";
                    nodePath = File.Exists(nodeX86) ? nodeX86 : "node.exe";
                }

                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = nodePath,
                    Arguments = "\"" + serverJs + "\"",
                    WorkingDirectory = baseDir,
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    WindowStyle = ProcessWindowStyle.Hidden
                };
                serverProcess = Process.Start(psi);
            }
            catch { }
        }

        private void CheckClipboard()
        {
            try
            {
                if (!Clipboard.ContainsText()) return;
                string text = Clipboard.GetText();
                if (string.IsNullOrEmpty(text)) return;

                if (string.Equals(text, lastClipboardText, StringComparison.Ordinal)) return;
                lastClipboardText = text;

                string candidate = text.Trim();
                if (IsDownloadableUrl(candidate) && CanPromptUrl(candidate))
                {
                    ShowDownloadDialog(candidate, null, null, null, "Bắt tự động từ Clipboard");
                }
            }
            catch { }
        }

        private static bool IsDownloadableUrl(string text)
        {
            if (string.IsNullOrEmpty(text) || text.Length > 2048) return false;
            if (text.IndexOf('\n') >= 0 || text.IndexOf('\r') >= 0 || text.IndexOf(' ') >= 0) return false;

            Uri uri;
            if (!Uri.TryCreate(text, UriKind.Absolute, out uri)) return false;
            if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) return false;
            if (uri.IsLoopback && uri.Port == Program.Port) return false;

            if (SpecialHostRegex.IsMatch(text)) return true;
            if (DownloadExtRegex.IsMatch(uri.AbsolutePath) || DownloadExtRegex.IsMatch(text)) return true;

            return false;
        }

        private bool CanPromptUrl(string url)
        {
            if (activeDialogUrls.Contains(url)) return false;

            DateTime lastShown;
            if (recentPromptedUrls.TryGetValue(url, out lastShown))
            {
                if ((DateTime.UtcNow - lastShown).TotalSeconds < 12) return false;
            }
            return true;
        }

        private void PollBrowserInterceptQueueAsync()
        {
            if (Interlocked.CompareExchange(ref pollingQueueFlag, 1, 0) != 0) return;

            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create(Program.AppUrl + "/api/intercept-queue");
                    req.Method = "GET";
                    req.Timeout = 800;
                    req.ReadWriteTimeout = 800;

                    using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                    using (Stream stream = resp.GetResponseStream())
                    using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
                    {
                        string json = reader.ReadToEnd();
                        if (string.IsNullOrEmpty(json)) return;

                        List<InterceptItem> items = ParseInterceptQueue(json);
                        if (items.Count == 0) return;

                        uiHost.BeginInvoke(new MethodInvoker(delegate
                        {
                            if (isExiting) return;
                            for (int i = 0; i < items.Count; i++)
                            {
                                InterceptItem item = items[i];
                                if (!string.IsNullOrEmpty(item.Url) && CanPromptUrl(item.Url))
                                {
                                    ShowDownloadDialog(item.Url, item.FileName, item.Referrer, item.Headers, "Bắt link từ Trình duyệt");
                                }
                            }
                        }));
                    }
                }
                catch
                {
                    // Endpoint may return 404 or server restarting; ignore silently
                }
                finally
                {
                    Interlocked.Exchange(ref pollingQueueFlag, 0);
                }
            });
        }

        private static List<InterceptItem> ParseInterceptQueue(string json)
        {
            List<InterceptItem> list = new List<InterceptItem>();
            try
            {
                JavaScriptSerializer js = new JavaScriptSerializer();
                object parsed = js.DeserializeObject(json);
                object[] rawItems = parsed as object[];

                if (rawItems == null)
                {
                    Dictionary<string, object> dict = parsed as Dictionary<string, object>;
                    if (dict != null)
                    {
                        object arrObj;
                        if (dict.TryGetValue("items", out arrObj) || dict.TryGetValue("queue", out arrObj))
                        {
                            rawItems = arrObj as object[];
                        }
                    }
                }

                if (rawItems == null) return list;

                for (int i = 0; i < rawItems.Length; i++)
                {
                    Dictionary<string, object> obj = rawItems[i] as Dictionary<string, object>;
                    if (obj == null) continue;

                    string url = GetDictString(obj, "url");
                    if (string.IsNullOrEmpty(url)) continue;

                    InterceptItem item = new InterceptItem();
                    item.Url = url;
                    item.FileName = GetDictString(obj, "fileName");
                    item.Referrer = GetDictString(obj, "referrer");

                    object headersObj;
                    if (obj.TryGetValue("headers", out headersObj))
                    {
                        Dictionary<string, object> hDict = headersObj as Dictionary<string, object>;
                        if (hDict != null)
                        {
                            item.Headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                            foreach (KeyValuePair<string, object> kv in hDict)
                            {
                                if (kv.Value != null) item.Headers[kv.Key] = kv.Value.ToString();
                            }
                        }
                    }
                    list.Add(item);
                }
            }
            catch { }
            return list;
        }

        private static string GetDictString(Dictionary<string, object> dict, string key)
        {
            object val;
            if (dict.TryGetValue(key, out val) && val != null) return val.ToString();
            return null;
        }

        internal void ShowDownloadDialog(string url, string suggestedFileName, string referrer, Dictionary<string, string> headers, string sourceLabel)
        {
            string normalized = (url ?? "").Trim();
            if (!string.IsNullOrEmpty(normalized))
            {
                if (activeDialogUrls.Contains(normalized)) return;
                activeDialogUrls.Add(normalized);
                recentPromptedUrls[normalized] = DateTime.UtcNow;
            }

            DownloadFileInfoForm form = new DownloadFileInfoForm(this, normalized, suggestedFileName, referrer, headers, sourceLabel);
            form.FormClosed += delegate
            {
                if (!string.IsNullOrEmpty(normalized))
                {
                    activeDialogUrls.Remove(normalized);
                }
            };
            form.Show();
            form.Activate();
        }

        private void PauseAllActiveJobsAsync()
        {
            ThreadPool.QueueUserWorkItem(delegate
            {
                int pausedCount = 0;
                try
                {
                    string json = HttpRequest("GET", Program.AppUrl + "/api/jobs", null, 2500);
                    JavaScriptSerializer js = new JavaScriptSerializer();
                    Dictionary<string, object> root = js.DeserializeObject(json) as Dictionary<string, object>;
                    object jobsObj;
                    if (root != null && root.TryGetValue("jobs", out jobsObj))
                    {
                        object[] jobs = jobsObj as object[];
                        if (jobs != null)
                        {
                            for (int i = 0; i < jobs.Length; i++)
                            {
                                Dictionary<string, object> job = jobs[i] as Dictionary<string, object>;
                                if (job == null) continue;
                                string id = GetDictString(job, "id");
                                string status = (GetDictString(job, "status") ?? "").ToLowerInvariant();
                                if (!string.IsNullOrEmpty(id) &&
                                    (status == "downloading" || status == "probing" || status == "resolving" || status == "muxing" || status == "queued"))
                                {
                                    try
                                    {
                                        HttpRequest("POST", Program.AppUrl + "/api/jobs/" + Uri.EscapeDataString(id) + "/pause", "{}", 2500);
                                        pausedCount++;
                                    }
                                    catch { }
                                }
                            }
                        }
                    }
                }
                catch { }

                uiHost.BeginInvoke(new MethodInvoker(delegate
                {
                    if (isExiting) return;
                    trayIcon.ShowBalloonTip(
                        2000,
                        "HyperIDM Ultra",
                        pausedCount > 0
                            ? string.Format("Đã tạm dừng {0} tác vụ đang tải.", pausedCount)
                            : "Không có tác vụ nào đang tải.",
                        ToolTipIcon.Info);
                }));
            });
        }

        private static void OpenDownloadsFolder()
        {
            try
            {
                string dir = GetBaseDownloadDir();
                Directory.CreateDirectory(dir);
                Process.Start(new ProcessStartInfo
                {
                    FileName = "explorer.exe",
                    Arguments = "\"" + dir + "\"",
                    UseShellExecute = true
                });
            }
            catch { }
        }

        internal static string GetBaseDownloadDir()
        {
            string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return Path.Combine(Path.Combine(profile, "Downloads"), "HyperIDM");
        }

        internal static string HttpRequest(string method, string url, string jsonBody, int timeoutMs)
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = method;
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            req.ContentType = "application/json; charset=utf-8";

            if (jsonBody != null)
            {
                byte[] bytes = Encoding.UTF8.GetBytes(jsonBody);
                req.ContentLength = bytes.Length;
                using (Stream s = req.GetRequestStream())
                {
                    s.Write(bytes, 0, bytes.Length);
                }
            }

            using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
            using (Stream rs = resp.GetResponseStream())
            using (StreamReader sr = new StreamReader(rs, Encoding.UTF8))
            {
                return sr.ReadToEnd();
            }
        }

        private void ExitApplication()
        {
            isExiting = true;
            try { monitorTimer.Stop(); monitorTimer.Dispose(); } catch { }
            try { watchdogTimer.Stop(); watchdogTimer.Dispose(); } catch { }
            try
            {
                trayIcon.Visible = false;
                trayIcon.Dispose();
            }
            catch { }
            try { trayMenu.Dispose(); } catch { }

            try
            {
                // Unblock pipe listener by making a dummy connection
                using (NamedPipeClientStream wake = new NamedPipeClientStream(".", Program.PipeName, PipeDirection.Out))
                {
                    wake.Connect(100);
                }
            }
            catch { }

            try
            {
                if (serverProcess != null && !serverProcess.HasExited)
                {
                    serverProcess.Kill();
                }
            }
            catch { }

            ExitThread();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                try { if (appIcon != null) appIcon.Dispose(); } catch { }
                if (iconHandle != IntPtr.Zero)
                {
                    try { DestroyIcon(iconHandle); } catch { }
                }
                try { if (uiHost != null) uiHost.Dispose(); } catch { }
            }
            base.Dispose(disposing);
        }
    }

    internal sealed class InterceptItem
    {
        public string Url;
        public string FileName;
        public string Referrer;
        public Dictionary<string, string> Headers;
    }

    internal sealed class CategoryInfo
    {
        public string DisplayName;
        public string FolderName;
        public Color BadgeColor;

        public CategoryInfo(string displayName, string folderName, Color badgeColor)
        {
            DisplayName = displayName;
            FolderName = folderName;
            BadgeColor = badgeColor;
        }
    }

    internal sealed class DownloadFileInfoForm : Form
    {
        private readonly TrayAgentContext agent;
        private readonly string referrer;
        private readonly Dictionary<string, string> headers;

        private TextBox txtUrl;
        private TextBox txtFileName;
        private Label lblCategoryBadge;
        private TextBox txtSaveDir;
        private ComboBox cmbThreads;
        private Label lblStatus;
        private Button btnStart;
        private Button btnLater;
        private Button btnCancel;

        private bool userEditedFileName = false;
        private bool userEditedSaveDir = false;
        private bool programmaticUpdate = false;

        public DownloadFileInfoForm(
            TrayAgentContext ownerAgent,
            string initialUrl,
            string suggestedFileName,
            string initialReferrer,
            Dictionary<string, string> initialHeaders,
            string sourceLabel)
        {
            agent = ownerAgent;
            referrer = initialReferrer;
            headers = initialHeaders;

            InitializeUi(sourceLabel);

            programmaticUpdate = true;
            txtUrl.Text = initialUrl ?? "";
            if (!string.IsNullOrEmpty(suggestedFileName))
            {
                txtFileName.Text = suggestedFileName;
                userEditedFileName = true;
            }
            programmaticUpdate = false;

            RefreshMetadataFromUrl();
            if (string.IsNullOrEmpty(txtUrl.Text))
            {
                // Auto-paste clipboard URL if user clicked "Thêm URL mới" and clipboard already has an HTTP link
                try
                {
                    if (Clipboard.ContainsText())
                    {
                        string clip = (Clipboard.GetText() ?? "").Trim();
                        if (clip.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                            clip.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                        {
                            txtUrl.Text = clip;
                            txtUrl.SelectAll();
                        }
                    }
                }
                catch { }
            }
        }

        private void InitializeUi(string sourceLabel)
        {
            Text = "⚡ Thông tin tệp tải xuống — HyperIDM Ultra 64-Bit";
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = true;
            TopMost = true;
            ShowInTaskbar = true;
            AutoScaleMode = AutoScaleMode.Font;
            ClientSize = new Size(640, 355);
            BackColor = Color.FromArgb(15, 23, 42);
            ForeColor = Color.FromArgb(241, 245, 249);
            Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);
            try { Icon = agent.SharedIcon; } catch { }

            // Header Banner
            Panel header = new Panel();
            header.Dock = DockStyle.Top;
            header.Height = 54;
            header.BackColor = Color.FromArgb(17, 29, 53);
            header.Paint += delegate(object s, PaintEventArgs pe)
            {
                using (Pen p = new Pen(Color.FromArgb(30, 58, 95), 1))
                {
                    pe.Graphics.DrawLine(p, 0, header.Height - 1, header.Width, header.Height - 1);
                }
            };

            Label lblTitle = new Label();
            lblTitle.Text = "⚡ Thông tin tệp tải xuống — HyperIDM Ultra 64-Bit";
            lblTitle.Font = new Font("Segoe UI", 11.5f, FontStyle.Bold);
            lblTitle.ForeColor = Color.FromArgb(56, 189, 248);
            lblTitle.AutoSize = true;
            lblTitle.Location = new Point(18, 9);

            Label lblSub = new Label();
            lblSub.Text = string.IsNullOrEmpty(sourceLabel) ? "TitanFetch 64/128-Luồng Engine" : ("Nguồn: " + sourceLabel + " • TitanFetch Multi-Segment Engine");
            lblSub.Font = new Font("Segoe UI", 8.5f, FontStyle.Regular);
            lblSub.ForeColor = Color.FromArgb(148, 163, 184);
            lblSub.AutoSize = true;
            lblSub.Location = new Point(20, 31);

            header.Controls.Add(lblTitle);
            header.Controls.Add(lblSub);
            Controls.Add(header);

            int labelX = 20;
            int inputX = 148;
            int inputW = 470;
            int y = 72;

            // 1. URL
            Label lUrl = MakeLabel("URL tải xuống:", labelX, y + 4);
            txtUrl = MakeTextBox(inputX, y, inputW);
            txtUrl.TextChanged += delegate
            {
                if (!programmaticUpdate) RefreshMetadataFromUrl();
            };
            Controls.Add(lUrl);
            Controls.Add(txtUrl);

            y += 42;

            // 2. File Name + Auto Category
            Label lFile = MakeLabel("Tên tệp:", labelX, y + 4);
            txtFileName = MakeTextBox(inputX, y, 290);
            txtFileName.TextChanged += delegate
            {
                if (!programmaticUpdate)
                {
                    userEditedFileName = true;
                    UpdateCategoryAndDir(txtUrl.Text, txtFileName.Text);
                }
            };

            Label lCatTitle = MakeLabel("Thể loại:", 448, y + 4);
            lCatTitle.ForeColor = Color.FromArgb(148, 163, 184);

            lblCategoryBadge = new Label();
            lblCategoryBadge.Location = new Point(512, y + 1);
            lblCategoryBadge.Size = new Size(106, 25);
            lblCategoryBadge.TextAlign = ContentAlignment.MiddleCenter;
            lblCategoryBadge.Font = new Font("Segoe UI", 8.5f, FontStyle.Bold);
            lblCategoryBadge.BackColor = Color.FromArgb(30, 64, 175);
            lblCategoryBadge.ForeColor = Color.White;
            lblCategoryBadge.Text = "Tệp tin khác";

            Controls.Add(lFile);
            Controls.Add(txtFileName);
            Controls.Add(lCatTitle);
            Controls.Add(lblCategoryBadge);

            y += 42;

            // 3. Save Directory + Browse Button
            Label lDir = MakeLabel("Lưu tại thư mục:", labelX, y + 4);
            txtSaveDir = MakeTextBox(inputX, y, 378);
            txtSaveDir.TextChanged += delegate
            {
                if (!programmaticUpdate) userEditedSaveDir = true;
            };

            Button btnBrowse = new Button();
            btnBrowse.Text = "Chọn...";
            btnBrowse.Location = new Point(534, y - 1);
            btnBrowse.Size = new Size(84, 27);
            btnBrowse.FlatStyle = FlatStyle.Flat;
            btnBrowse.FlatAppearance.BorderColor = Color.FromArgb(71, 85, 105);
            btnBrowse.BackColor = Color.FromArgb(30, 41, 59);
            btnBrowse.ForeColor = Color.FromArgb(226, 232, 240);
            btnBrowse.Cursor = Cursors.Hand;
            btnBrowse.Click += delegate
            {
                using (FolderBrowserDialog fbd = new FolderBrowserDialog())
                {
                    fbd.Description = "Chọn thư mục lưu tệp tải xuống HyperIDM Ultra";
                    if (Directory.Exists(txtSaveDir.Text)) fbd.SelectedPath = txtSaveDir.Text;
                    if (fbd.ShowDialog(this) == DialogResult.OK)
                    {
                        programmaticUpdate = true;
                        txtSaveDir.Text = fbd.SelectedPath;
                        programmaticUpdate = false;
                        userEditedSaveDir = true;
                    }
                }
            };

            Controls.Add(lDir);
            Controls.Add(txtSaveDir);
            Controls.Add(btnBrowse);

            y += 42;

            // 4. Threads selector
            Label lThreads = MakeLabel("Số luồng tải:", labelX, y + 4);
            cmbThreads = new ComboBox();
            cmbThreads.Location = new Point(inputX, y);
            cmbThreads.Size = new Size(250, 26);
            cmbThreads.DropDownStyle = ComboBoxStyle.DropDownList;
            cmbThreads.BackColor = Color.FromArgb(30, 41, 59);
            cmbThreads.ForeColor = Color.FromArgb(248, 250, 252);
            cmbThreads.FlatStyle = FlatStyle.Flat;
            cmbThreads.Items.Add("64 Luồng (Hyper-Turbo)");
            cmbThreads.Items.Add("128 Luồng (Max Speed)");
            cmbThreads.SelectedIndex = 0;

            Label lHint = new Label();
            lHint.Text = "Tự động kiểm tra SHA-1 / SHA-256 & nối mảnh 0-copy";
            lHint.ForeColor = Color.FromArgb(148, 163, 184);
            lHint.Font = new Font("Segoe UI", 8.5f, FontStyle.Italic);
            lHint.AutoSize = true;
            lHint.Location = new Point(406, y + 5);

            Controls.Add(lThreads);
            Controls.Add(cmbThreads);
            Controls.Add(lHint);

            y += 38;

            // Status line
            lblStatus = new Label();
            lblStatus.Location = new Point(labelX, y);
            lblStatus.Size = new Size(598, 22);
            lblStatus.ForeColor = Color.FromArgb(250, 204, 21);
            lblStatus.Font = new Font("Segoe UI", 8.8f, FontStyle.Regular);
            lblStatus.Text = "";
            Controls.Add(lblStatus);

            // Bottom Action Bar
            Panel footer = new Panel();
            footer.Dock = DockStyle.Bottom;
            footer.Height = 68;
            footer.BackColor = Color.FromArgb(17, 29, 53);
            footer.Paint += delegate(object s, PaintEventArgs pe)
            {
                using (Pen p = new Pen(Color.FromArgb(30, 58, 95), 1))
                {
                    pe.Graphics.DrawLine(p, 0, 0, footer.Width, 0);
                }
            };

            btnStart = new Button();
            btnStart.Text = "⚡ Bắt đầu tải ngay";
            btnStart.Location = new Point(20, 15);
            btnStart.Size = new Size(210, 38);
            btnStart.Font = new Font("Segoe UI", 10f, FontStyle.Bold);
            btnStart.FlatStyle = FlatStyle.Flat;
            btnStart.FlatAppearance.BorderSize = 0;
            btnStart.BackColor = Color.FromArgb(14, 165, 233);
            btnStart.ForeColor = Color.White;
            btnStart.Cursor = Cursors.Hand;
            btnStart.Click += delegate { SubmitJob(false); };

            btnLater = new Button();
            btnLater.Text = "🕒 Tải sau (Thêm vào danh sách chờ)";
            btnLater.Location = new Point(242, 15);
            btnLater.Size = new Size(258, 38);
            btnLater.Font = new Font("Segoe UI", 9.5f, FontStyle.Bold);
            btnLater.FlatStyle = FlatStyle.Flat;
            btnLater.FlatAppearance.BorderColor = Color.FromArgb(71, 85, 105);
            btnLater.BackColor = Color.FromArgb(30, 41, 59);
            btnLater.ForeColor = Color.FromArgb(250, 204, 21);
            btnLater.Cursor = Cursors.Hand;
            btnLater.Click += delegate { SubmitJob(true); };

            btnCancel = new Button();
            btnCancel.Text = "Hủy bỏ";
            btnCancel.Location = new Point(512, 15);
            btnCancel.Size = new Size(106, 38);
            btnCancel.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);
            btnCancel.FlatStyle = FlatStyle.Flat;
            btnCancel.FlatAppearance.BorderColor = Color.FromArgb(71, 85, 105);
            btnCancel.BackColor = Color.FromArgb(30, 41, 59);
            btnCancel.ForeColor = Color.FromArgb(203, 213, 225);
            btnCancel.Cursor = Cursors.Hand;
            btnCancel.Click += delegate { Close(); };

            footer.Controls.Add(btnStart);
            footer.Controls.Add(btnLater);
            footer.Controls.Add(btnCancel);
            Controls.Add(footer);

            AcceptButton = btnStart;
            CancelButton = btnCancel;
        }

        private static Label MakeLabel(string text, int x, int y)
        {
            Label lbl = new Label();
            lbl.Text = text;
            lbl.Location = new Point(x, y);
            lbl.AutoSize = true;
            lbl.ForeColor = Color.FromArgb(203, 213, 225);
            return lbl;
        }

        private static TextBox MakeTextBox(int x, int y, int w)
        {
            TextBox tb = new TextBox();
            tb.Location = new Point(x, y);
            tb.Size = new Size(w, 25);
            tb.BorderStyle = BorderStyle.FixedSingle;
            tb.BackColor = Color.FromArgb(30, 41, 59);
            tb.ForeColor = Color.FromArgb(248, 250, 252);
            return tb;
        }

        private void RefreshMetadataFromUrl()
        {
            string url = (txtUrl.Text ?? "").Trim();
            if (!userEditedFileName)
            {
                programmaticUpdate = true;
                txtFileName.Text = GuessFileName(url);
                programmaticUpdate = false;
            }
            UpdateCategoryAndDir(url, txtFileName.Text);
        }

        private void UpdateCategoryAndDir(string url, string fileName)
        {
            CategoryInfo cat = DetectCategory(url, fileName);
            lblCategoryBadge.Text = cat.DisplayName;
            lblCategoryBadge.BackColor = cat.BadgeColor;

            if (!userEditedSaveDir)
            {
                programmaticUpdate = true;
                txtSaveDir.Text = Path.Combine(TrayAgentContext.GetBaseDownloadDir(), cat.FolderName);
                programmaticUpdate = false;
            }
        }

        private static string GuessFileName(string url)
        {
            if (string.IsNullOrEmpty(url)) return "";
            try
            {
                Match yt = Regex.Match(url, @"(?:youtube\.com/(?:watch\?v=|shorts/)|youtu\.be/)([A-Za-z0-9_-]{6,})", RegexOptions.IgnoreCase);
                if (yt.Success) return "YouTube_" + yt.Groups[1].Value + ".mp4";

                if (Regex.IsMatch(url, @"ipsw\.me/download/", RegexOptions.IgnoreCase))
                {
                    return "Apple_Firmware.ipsw";
                }

                Uri uri;
                if (Uri.TryCreate(url, UriKind.Absolute, out uri))
                {
                    Match qfn = Regex.Match(uri.Query, @"(?:^|[?&])(?:filename|file|name)=([^&]+)", RegexOptions.IgnoreCase);
                    if (qfn.Success)
                    {
                        string decoded = SanitizeFileName(Uri.UnescapeDataString(qfn.Groups[1].Value));
                        if (!string.IsNullOrEmpty(decoded)) return decoded;
                    }

                    string lastSeg = Path.GetFileName(Uri.UnescapeDataString(uri.AbsolutePath));
                    lastSeg = SanitizeFileName(lastSeg);
                    if (!string.IsNullOrEmpty(lastSeg) && lastSeg != "/") return lastSeg;
                }
            }
            catch { }
            return "download_file";
        }

        private static string SanitizeFileName(string name)
        {
            if (string.IsNullOrEmpty(name)) return "";
            char[] invalid = Path.GetInvalidFileNameChars();
            StringBuilder sb = new StringBuilder(name.Length);
            for (int i = 0; i < name.Length; i++)
            {
                char c = name[i];
                if (Array.IndexOf(invalid, c) >= 0) sb.Append('_');
                else sb.Append(c);
            }
            return sb.ToString().Trim();
        }

        private static CategoryInfo DetectCategory(string url, string fileName)
        {
            string target = ((fileName ?? "") + " " + (url ?? "")).ToLowerInvariant();
            string fn = (fileName ?? "").ToLowerInvariant();

            string ext = "";
            try
            {
                if (Regex.IsMatch(fn, @"\.tar\.(gz|bz2|xz|zst|md5)$"))
                {
                    if (fn.EndsWith(".tar.md5")) return new CategoryInfo("Firmware / ISO", "Firmware_ISO", Color.FromArgb(14, 116, 144));
                    return new CategoryInfo("Dữ liệu nén", "Compressed", Color.FromArgb(180, 83, 9));
                }
                ext = Path.GetExtension(fn).TrimStart('.');
                if (string.IsNullOrEmpty(ext) && !string.IsNullOrEmpty(url))
                {
                    Uri uri;
                    if (Uri.TryCreate(url, UriKind.Absolute, out uri))
                    {
                        ext = Path.GetExtension(uri.AbsolutePath).TrimStart('.').ToLowerInvariant();
                    }
                }
            }
            catch { }

            if (Regex.IsMatch(target, @"ipsw\.me/|updates\.cdn-apple\.com/.*\.ipsw") ||
                ext == "ipsw" || ext == "iso" || ext == "img" || ext == "bin" || ext == "vhd" || ext == "vhdx" || ext == "wim" || ext == "esd" || ext == "ova")
            {
                return new CategoryInfo("Firmware / ISO", "Firmware_ISO", Color.FromArgb(14, 116, 144));
            }

            if (ext == "zip" || ext == "rar" || ext == "7z" || ext == "tar" || ext == "gz" || ext == "tgz" || ext == "bz2" || ext == "xz" || ext == "zst" || ext == "cab")
            {
                return new CategoryInfo("Dữ liệu nén", "Compressed", Color.FromArgb(180, 83, 9));
            }

            if (ext == "exe" || ext == "msi" || ext == "msix" || ext == "apk" || ext == "dmg" || ext == "pkg" || ext == "deb" || ext == "rpm" || ext == "appimage")
            {
                return new CategoryInfo("Chương trình", "Programs", Color.FromArgb(37, 99, 235));
            }

            if (Regex.IsMatch(target, @"youtube\.com/(watch|shorts)|youtu\.be/") ||
                ext == "mp4" || ext == "mkv" || ext == "avi" || ext == "mov" || ext == "webm" || ext == "flv" || ext == "m4v" || ext == "ts")
            {
                return new CategoryInfo("Video", "Video", Color.FromArgb(147, 51, 234));
            }

            if (ext == "mp3" || ext == "flac" || ext == "wav" || ext == "aac" || ext == "m4a" || ext == "ogg" || ext == "opus")
            {
                return new CategoryInfo("Âm nhạc", "Music", Color.FromArgb(219, 39, 119));
            }

            if (ext == "pdf" || ext == "doc" || ext == "docx" || ext == "xls" || ext == "xlsx" || ext == "ppt" || ext == "pptx" || ext == "epub" || ext == "txt" || ext == "csv")
            {
                return new CategoryInfo("Tài liệu", "Documents", Color.FromArgb(5, 150, 105));
            }

            return new CategoryInfo("Tệp tin khác", "General", Color.FromArgb(71, 85, 105));
        }

        private void SubmitJob(bool queueForLater)
        {
            string url = (txtUrl.Text ?? "").Trim();
            if (!url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) &&
                !url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            {
                lblStatus.ForeColor = Color.FromArgb(248, 113, 113);
                lblStatus.Text = "Vui lòng nhập URL hợp lệ (bắt đầu bằng http:// hoặc https://).";
                txtUrl.Focus();
                return;
            }

            string fileName = SanitizeFileName((txtFileName.Text ?? "").Trim());
            string saveDir = (txtSaveDir.Text ?? "").Trim();
            if (string.IsNullOrEmpty(saveDir)) saveDir = TrayAgentContext.GetBaseDownloadDir();

            int threads = cmbThreads.SelectedIndex == 1 ? 128 : 64;

            SetBusy(true, queueForLater ? "Đang thêm vào danh sách chờ..." : "Đang khởi tạo 64/128 luồng tải siêu tốc...");

            ThreadPool.QueueUserWorkItem(delegate
            {
                string errorMsg = null;
                try
                {
                    agent.EnsureServerRunningSync(4000);
                    Directory.CreateDirectory(saveDir);

                    Dictionary<string, object> payload = new Dictionary<string, object>();
                    payload["url"] = url;
                    if (!string.IsNullOrEmpty(fileName)) payload["fileName"] = fileName;
                    payload["saveDir"] = saveDir;
                    payload["autoCategory"] = false;
                    payload["maxConnections"] = threads;
                    if (queueForLater) payload["paused"] = true;

                    Dictionary<string, string> mergedHeaders = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                    if (headers != null)
                    {
                        foreach (KeyValuePair<string, string> kv in headers) mergedHeaders[kv.Key] = kv.Value;
                    }
                    if (!string.IsNullOrEmpty(referrer) && !mergedHeaders.ContainsKey("Referer"))
                    {
                        mergedHeaders["Referer"] = referrer;
                    }
                    if (mergedHeaders.Count > 0) payload["headers"] = mergedHeaders;

                    JavaScriptSerializer js = new JavaScriptSerializer();
                    string bodyJson = js.Serialize(payload);
                    string respJson = TrayAgentContext.HttpRequest("POST", Program.AppUrl + "/api/jobs", bodyJson, 5000);

                    if (queueForLater && !string.IsNullOrEmpty(respJson))
                    {
                        try
                        {
                            Dictionary<string, object> respDict = js.DeserializeObject(respJson) as Dictionary<string, object>;
                            object idObj;
                            object statusObj;
                            if (respDict != null && respDict.TryGetValue("id", out idObj) && idObj != null)
                            {
                                string status = (respDict.TryGetValue("status", out statusObj) && statusObj != null)
                                    ? statusObj.ToString()
                                    : "";
                                if (!string.Equals(status, "paused", StringComparison.OrdinalIgnoreCase))
                                {
                                    TrayAgentContext.HttpRequest(
                                        "POST",
                                        Program.AppUrl + "/api/jobs/" + Uri.EscapeDataString(idObj.ToString()) + "/pause",
                                        "{}",
                                        3000);
                                }
                            }
                        }
                        catch { }
                    }
                }
                catch (Exception ex)
                {
                    errorMsg = "Lỗi kết nối Engine (127.0.0.1:17890): " + ex.Message;
                }

                try
                {
                    BeginInvoke(new MethodInvoker(delegate
                    {
                        if (errorMsg != null)
                        {
                            SetBusy(false, errorMsg);
                            lblStatus.ForeColor = Color.FromArgb(248, 113, 113);
                            return;
                        }

                        if (!queueForLater)
                        {
                            Program.OpenDesktopWindow();
                        }
                        Close();
                    }));
                }
                catch { }
            });
        }

        private void SetBusy(bool busy, string message)
        {
            btnStart.Enabled = !busy;
            btnLater.Enabled = !busy;
            btnCancel.Enabled = !busy;
            lblStatus.ForeColor = Color.FromArgb(250, 204, 21);
            lblStatus.Text = message ?? "";
        }
    }
}
