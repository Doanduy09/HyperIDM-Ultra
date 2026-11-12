using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Globalization;
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
using Microsoft.Win32;

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
            for (int attempt = 0; attempt < 3; attempt++)
            {
                try
                {
                    using (NamedPipeClientStream client = new NamedPipeClientStream(".", PipeName, PipeDirection.Out))
                    {
                        client.Connect(1200);
                        byte[] data = Encoding.UTF8.GetBytes(payload);
                        client.Write(data, 0, data.Length);
                        client.Flush();
                        return;
                    }
                }
                catch
                {
                    Thread.Sleep(250);
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

        internal static void OpenWebBrowserFallback()
        {
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

    internal static class IdmFormat
    {
        private static readonly NumberFormatInfo CommaNum;

        static IdmFormat()
        {
            CommaNum = (NumberFormatInfo)CultureInfo.InvariantCulture.NumberFormat.Clone();
            CommaNum.NumberDecimalSeparator = ",";
            CommaNum.NumberGroupSeparator = ".";
        }

        public static string FormatBytes(long bytes)
        {
            if (bytes < 0) bytes = 0;
            if (bytes == 0) return "0 B";
            if (bytes < 1024L) return bytes.ToString() + " B";
            double kb = bytes / 1024.0;
            if (kb < 1024.0) return kb.ToString("0.00", CommaNum) + " KB";
            double mb = kb / 1024.0;
            if (mb < 1024.0) return mb.ToString("0.00", CommaNum) + " MB";
            double gb = mb / 1024.0;
            return gb.ToString("0.00", CommaNum) + " GB";
        }

        public static string FormatSpeed(long bps, bool useSecWord)
        {
            if (bps <= 0) return "";
            string unitSuffix = useSecWord ? "/sec" : "/s";
            if (bps < 1024L) return bps.ToString() + " B" + unitSuffix;
            double kb = bps / 1024.0;
            if (kb < 1024.0) return kb.ToString("0.00", CommaNum) + " KB" + unitSuffix;
            double mb = kb / 1024.0;
            if (mb < 1024.0) return mb.ToString("0.00", CommaNum) + " MB" + unitSuffix;
            double gb = mb / 1024.0;
            return gb.ToString("0.00", CommaNum) + " GB" + unitSuffix;
        }

        public static string FormatPercent(double pct)
        {
            if (pct < 0) pct = 0;
            if (pct > 100) pct = 100;
            return pct.ToString("0.00", CommaNum) + "%";
        }

        public static string FormatEta(int etaSec, bool hasEta, string status)
        {
            string st = (status ?? "").ToLowerInvariant();
            if (st == "completed") return "0 giây";
            if (!hasEta || etaSec < 0) return "";
            if (etaSec < 60) return etaSec.ToString() + " giây";
            int mins = etaSec / 60;
            int secs = etaSec % 60;
            if (mins < 60) return string.Format("{0} phút {1} giây", mins, secs);
            int hrs = mins / 60;
            mins = mins % 60;
            return string.Format("{0} giờ {1} phút", hrs, mins);
        }

        public static string TranslateStatus(string status, double progress, string error)
        {
            string st = (status ?? "").ToLowerInvariant();
            if (st == "completed") return "Hoàn thành";
            if (st == "downloading") return FormatPercent(progress);
            if (st == "probing") return "Đang dò kết nối...";
            if (st == "resolving") return "Đang phân giải...";
            if (st == "muxing") return "Đang ghép MP4...";
            if (st == "paused") return progress > 0 ? ("Tạm dừng (" + FormatPercent(progress) + ")") : "Tạm dừng";
            if (st == "queued") return "Đang chờ tải";
            if (st == "error") return string.IsNullOrEmpty(error) ? "Lỗi tải xuống" : ("Lỗi: " + error);
            if (st == "canceled") return "Đã hủy";
            return status ?? "";
        }

        public static bool IsActiveStatus(string status)
        {
            string st = (status ?? "").ToLowerInvariant();
            return st == "downloading" || st == "probing" || st == "resolving" || st == "muxing";
        }

        public static string SanitizeFileName(string name)
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

        public static string GuessFileName(string url)
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

        public static CategoryInfo DetectCategory(string url, string fileName)
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

    internal sealed class SegmentSnapshot
    {
        public int Id;
        public long Start;
        public long Current;
        public long End;
        public string Status;
        public long SpeedBps;
        public string Ip;
        public int Progress;
    }

    internal sealed class JobSnapshot
    {
        public string Id;
        public string Url;
        public string FinalUrl;
        public string ResolverType;
        public string FileName;
        public string FilePath;
        public string SaveDir;
        public string Status;
        public string Error;
        public long TotalBytes;
        public long DownloadedBytes;
        public double Progress;
        public int MaxConnections;
        public bool AcceptRanges;
        public string ExpectedSha1;
        public long CurrentSpeedBps;
        public long PeakSpeedBps;
        public int EtaSeconds;
        public bool HasEta;
        public long ElapsedMs;
        public string CategoryFolder;
        public string ChecksumStatus;
        public string ChecksumAlgo;
        public string ChecksumActual;
        public string LastTryTime;
        public List<SegmentSnapshot> Segments = new List<SegmentSnapshot>();
    }

    internal sealed class JobsSnapshotResponse
    {
        public string DefaultSaveDir;
        public long GlobalLimitBps;
        public List<JobSnapshot> Jobs = new List<JobSnapshot>();
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
        private readonly Dictionary<string, IdmProgressForm> progressForms = new Dictionary<string, IdmProgressForm>(StringComparer.Ordinal);
        private readonly Dictionary<string, string> idmKnownKeys = new Dictionary<string, string>(StringComparer.Ordinal);

        private MainIdmForm mainForm;

        private bool clipboardEnabled = true;
        private bool browserInterceptEnabled = true;
        private bool autoShowProgress = true;
        private int defaultThreads = 64;
        private string lastClipboardText = "";
        private int pollingQueueFlag = 0;
        private int watchdogBusyFlag = 0;
        private volatile bool isExiting = false;
        private bool shownTrayHint = false;

        private Process serverProcess = null;
        private DateTime lastServerStartAttempt = DateTime.MinValue;
        private Thread pipeThread;

        private static readonly Regex DownloadExtRegex = new Regex(
            @"\.(zip|rar|7z|exe|msi|msix|iso|ipsw|dmg|apk|mp4|mkv|pdf|bin|img|tar|gz|bz2|xz|tgz|zst|deb|rpm|pkg|avi|mov|webm|flv|m4v|ts|mp3|flac|wav|aac|m4a|ogg|opus|doc|docx|xls|xlsx|ppt|pptx|epub|vhd|vhdx|wim|esd|ova)(?:$|[?#])",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);

        private static readonly Regex SpecialHostRegex = new Regex(
            @"^https?://(?:(?:www\.)?(?:ipsw\.me/download/|youtube\.com/(?:watch\?v=|shorts/)|youtu\.be/)|updates\.cdn-apple\.com/|appldnld\.apple\.com/|github\.com/.+/releases/download/|huggingface\.co/.+/resolve/)",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        private static extern bool DestroyIcon(IntPtr handle);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        public TrayAgentContext(string initialUrl, bool startMinimized)
        {
            uiHost = new Control();
            IntPtr forceHandle = uiHost.Handle;
            if (forceHandle == IntPtr.Zero) { }

            appIcon = CreateIdmGlobeIcon(out iconHandle);

            trayMenu = new ContextMenuStrip();
            trayMenu.ShowImageMargin = false;
            trayMenu.Font = new Font("Segoe UI", 9.25f, FontStyle.Regular);

            ToolStripMenuItem menuOpen = new ToolStripMenuItem("Mở HyperIDM Ultra (Cửa sổ chính)");
            menuOpen.Font = new Font(trayMenu.Font, FontStyle.Bold);
            menuOpen.Click += delegate { ShowMainForm(); };

            ToolStripMenuItem menuAddUrl = new ToolStripMenuItem("Thêm URL tải xuống mới...");
            menuAddUrl.Click += delegate { ShowDownloadDialog("", null, null, null, "Thêm URL thủ công"); };

            menuClipboard = new ToolStripMenuItem("Tự động bắt link khi Copy (Clipboard) [Bật]");
            menuClipboard.Checked = true;
            menuClipboard.Click += delegate { SetClipboardEnabled(!clipboardEnabled); };

            menuBrowser = new ToolStripMenuItem("Tự động bắt link từ Trình duyệt [Bật]");
            menuBrowser.Checked = true;
            menuBrowser.Click += delegate { SetBrowserInterceptEnabled(!browserInterceptEnabled); };

            ToolStripMenuItem menuPauseAll = new ToolStripMenuItem("Dừng tất cả tác vụ đang tải");
            menuPauseAll.Click += delegate { PauseAllActiveJobsAsync(); };

            ToolStripMenuItem menuOpenFolder = new ToolStripMenuItem("Mở thư mục Tải xuống (Downloads\\HyperIDM)");
            menuOpenFolder.Click += delegate { OpenDownloadsFolder(); };

            ToolStripMenuItem menuExit = new ToolStripMenuItem("Thoát hoàn toàn HyperIDM");
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
            trayIcon.Text = "Internet Download Manager 6.43 — HyperIDM Ultra 64-Bit";
            trayIcon.ContextMenuStrip = trayMenu;
            trayIcon.Visible = true;
            trayIcon.DoubleClick += delegate { ShowMainForm(); };

            try
            {
                if (Clipboard.ContainsText())
                {
                    lastClipboardText = Clipboard.GetText() ?? "";
                }
            }
            catch { }

            InitIdmRegistrySnapshot();
            EnsureServerRunningSync(3500);
            StartPipeListener();

            monitorTimer = new System.Windows.Forms.Timer();
            monitorTimer.Interval = 400;
            monitorTimer.Tick += MonitorTimer_Tick;
            monitorTimer.Start();

            watchdogTimer = new System.Windows.Forms.Timer();
            watchdogTimer.Interval = 5000;
            watchdogTimer.Tick += WatchdogTimer_Tick;
            watchdogTimer.Start();

            mainForm = new MainIdmForm(this);
            mainForm.ShowInTaskbar = true;

            if (!string.IsNullOrEmpty(initialUrl))
            {
                if (!startMinimized)
                {
                    this.MainForm = mainForm;
                    ShowMainForm();
                }
                ShowDownloadDialog(initialUrl, null, null, null, "Liên kết khởi chạy");
            }
            else if (!startMinimized)
            {
                this.MainForm = mainForm;
                ShowMainForm();
            }
        }

        internal Icon SharedIcon { get { return appIcon; } }
        internal bool IsExiting { get { return isExiting; } }
        internal bool ClipboardEnabled { get { return clipboardEnabled; } }
        internal bool BrowserInterceptEnabled { get { return browserInterceptEnabled; } }
        internal bool AutoShowProgress { get { return autoShowProgress; } set { autoShowProgress = value; } }
        internal int DefaultThreads { get { return defaultThreads; } set { defaultThreads = (value == 128) ? 128 : 64; } }

        internal void SetClipboardEnabled(bool value)
        {
            clipboardEnabled = value;
            menuClipboard.Checked = value;
            menuClipboard.Text = value
                ? "Tự động bắt link khi Copy (Clipboard) [Bật]"
                : "Tự động bắt link khi Copy (Clipboard) [Tắt]";
            if (mainForm != null && !mainForm.IsDisposed) mainForm.UpdateCaptureStatusLabel();
        }

        internal void SetBrowserInterceptEnabled(bool value)
        {
            browserInterceptEnabled = value;
            menuBrowser.Checked = value;
            menuBrowser.Text = value
                ? "Tự động bắt link từ Trình duyệt [Bật]"
                : "Tự động bắt link từ Trình duyệt [Tắt]";
            if (mainForm != null && !mainForm.IsDisposed) mainForm.UpdateCaptureStatusLabel();
        }

        internal void ShowMainForm()
        {
            if (isExiting) return;
            if (mainForm == null || mainForm.IsDisposed)
            {
                mainForm = new MainIdmForm(this);
            }
            mainForm.Show();
            mainForm.WindowState = FormWindowState.Normal;
            try
            {
                ShowWindow(mainForm.Handle, 1);
                SetForegroundWindow(mainForm.Handle);
            }
            catch { }
            mainForm.Activate();
            mainForm.BringToFront();
            mainForm.TriggerImmediateRefresh();
        }

        internal void NotifyHiddenToTray()
        {
            if (shownTrayHint || isExiting) return;
            shownTrayHint = true;
            try
            {
                trayIcon.ShowBalloonTip(
                    2200,
                    "HyperIDM Ultra 64-Bit vẫn đang chạy",
                    "Ứng dụng đang chạy ngầm ở khay hệ thống để tự động bắt mọi link tải.",
                    ToolTipIcon.Info);
            }
            catch { }
        }

        internal void ShowBalloon(string title, string text, ToolTipIcon icon)
        {
            if (isExiting) return;
            try { trayIcon.ShowBalloonTip(2500, title, text, icon); } catch { }
        }

        internal void OpenProgressForm(string jobId, string initialFileName, string initialUrl, int threads)
        {
            if (isExiting || string.IsNullOrEmpty(jobId)) return;
            IdmProgressForm existing;
            if (progressForms.TryGetValue(jobId, out existing) && existing != null && !existing.IsDisposed)
            {
                if (!existing.Visible) existing.Show();
                if (existing.WindowState == FormWindowState.Minimized) existing.WindowState = FormWindowState.Normal;
                existing.Activate();
                existing.BringToFront();
                return;
            }

            IdmProgressForm pf = new IdmProgressForm(this, jobId, initialFileName, initialUrl, threads);
            progressForms[jobId] = pf;
            pf.FormClosed += delegate
            {
                progressForms.Remove(jobId);
            };
            pf.Show();
            pf.Activate();
        }

        internal void RefreshMainFormNow()
        {
            if (mainForm != null && !mainForm.IsDisposed && mainForm.Visible)
            {
                mainForm.TriggerImmediateRefresh();
            }
        }

        private static Icon CreateIdmGlobeIcon(out IntPtr hIcon)
        {
            using (Bitmap bmp = new Bitmap(32, 32, PixelFormat.Format32bppArgb))
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.Clear(Color.Transparent);

                // Classic IDM green/teal 3D globe
                RectangleF globeRect = new RectangleF(2f, 2f, 28f, 28f);
                using (GraphicsPath path = new GraphicsPath())
                {
                    path.AddEllipse(globeRect);
                    using (PathGradientBrush pgb = new PathGradientBrush(path))
                    {
                        pgb.CenterPoint = new PointF(11f, 10f);
                        pgb.CenterColor = Color.FromArgb(255, 110, 231, 183);
                        pgb.SurroundColors = new Color[] { Color.FromArgb(255, 5, 120, 95) };
                        g.FillEllipse(pgb, globeRect);
                    }
                    g.SetClip(path);

                    // Latitude & longitude meridian arcs
                    using (Pen gridPen = new Pen(Color.FromArgb(170, 236, 253, 245), 1.25f))
                    {
                        g.DrawEllipse(gridPen, new RectangleF(9f, 2f, 14f, 28f));
                        g.DrawLine(gridPen, 16f, 2f, 16f, 30f);
                        g.DrawLine(gridPen, 2f, 16f, 30f, 16f);
                        g.DrawArc(gridPen, new RectangleF(2f, 5f, 28f, 10f), 15, 150);
                        g.DrawArc(gridPen, new RectangleF(2f, 17f, 28f, 10f), 195, 150);
                    }
                    g.ResetClip();
                }

                using (Pen rimPen = new Pen(Color.FromArgb(255, 6, 95, 70), 1.5f))
                {
                    g.DrawEllipse(rimPen, globeRect);
                }

                // Crisp gold/orange download lightning accent at bottom-right
                PointF[] arrow = new PointF[]
                {
                    new PointF(19f, 11f),
                    new PointF(25f, 11f),
                    new PointF(25f, 20f),
                    new PointF(29f, 20f),
                    new PointF(22f, 29f),
                    new PointF(15f, 20f),
                    new PointF(19f, 20f)
                };
                using (Pen arrowBorder = new Pen(Color.FromArgb(240, 124, 45, 18), 1.4f))
                {
                    arrowBorder.LineJoin = LineJoin.Round;
                    g.DrawPolygon(arrowBorder, arrow);
                }
                using (LinearGradientBrush arrowBrush = new LinearGradientBrush(
                    new Rectangle(15, 11, 14, 18),
                    Color.FromArgb(255, 254, 240, 138),
                    Color.FromArgb(255, 245, 158, 11),
                    LinearGradientMode.Vertical))
                {
                    g.FillPolygon(arrowBrush, arrow);
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
                        ShowMainForm();
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
                CheckIdmRegistryIntercept();
                PollBrowserInterceptQueueAsync();
            }
        }

        private void InitIdmRegistrySnapshot()
        {
            try
            {
                using (RegistryKey dmKey = Registry.CurrentUser.OpenSubKey(@"Software\DownloadManager", false))
                {
                    if (dmKey == null) return;
                    string[] names = dmKey.GetSubKeyNames();
                    for (int i = 0; i < names.Length; i++)
                    {
                        int numId;
                        if (!int.TryParse(names[i], out numId)) continue;
                        try
                        {
                            using (RegistryKey sub = dmKey.OpenSubKey(names[i], false))
                            {
                                if (sub == null) continue;
                                object stObj = sub.GetValue("st_time");
                                string stTime = stObj != null ? Convert.ToString(stObj, CultureInfo.InvariantCulture) : "";
                                idmKnownKeys[names[i]] = stTime;
                            }
                        }
                        catch { }
                    }
                }
            }
            catch { }
        }

        private void CheckIdmRegistryIntercept()
        {
            try
            {
                using (RegistryKey dmKey = Registry.CurrentUser.OpenSubKey(@"Software\DownloadManager", false))
                {
                    if (dmKey == null) return;
                    string[] names = dmKey.GetSubKeyNames();
                    for (int i = 0; i < names.Length; i++)
                    {
                        int numId;
                        if (!int.TryParse(names[i], out numId)) continue;
                        try
                        {
                            using (RegistryKey sub = dmKey.OpenSubKey(names[i], false))
                            {
                                if (sub == null) continue;
                                object stObj = sub.GetValue("st_time");
                                string stTime = stObj != null ? Convert.ToString(stObj, CultureInfo.InvariantCulture) : "";

                                string prevSt;
                                if (idmKnownKeys.TryGetValue(names[i], out prevSt) && string.Equals(prevSt, stTime, StringComparison.Ordinal))
                                {
                                    continue;
                                }
                                idmKnownKeys[names[i]] = stTime;

                                string url0 = (sub.GetValue("Url0") as string ?? "").Trim();
                                if (!url0.StartsWith("http://", StringComparison.OrdinalIgnoreCase) &&
                                    !url0.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                                {
                                    continue;
                                }

                                string decodedName = "";
                                string frFncd = sub.GetValue("FR_FNCD") as string;
                                if (!string.IsNullOrEmpty(frFncd))
                                {
                                    try
                                    {
                                        decodedName = IdmFormat.SanitizeFileName(Uri.UnescapeDataString(frFncd.Replace("+", " ")));
                                    }
                                    catch { decodedName = IdmFormat.SanitizeFileName(frFncd); }
                                }
                                if (string.IsNullOrEmpty(decodedName))
                                {
                                    string rawFn = sub.GetValue("FileName") as string;
                                    if (!string.IsNullOrEmpty(rawFn))
                                    {
                                        int qIdx = rawFn.IndexOf('?');
                                        if (qIdx > 0) rawFn = rawFn.Substring(0, qIdx);
                                        decodedName = IdmFormat.SanitizeFileName(rawFn);
                                    }
                                }

                                string cookie = sub.GetValue("Cookie") as string;
                                string referer = sub.GetValue("Referer") as string;
                                string ua = sub.GetValue("UA") as string;

                                Dictionary<string, string> hdrs = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                                if (!string.IsNullOrEmpty(cookie)) hdrs["Cookie"] = cookie;
                                if (!string.IsNullOrEmpty(referer)) hdrs["Referer"] = referer;
                                if (!string.IsNullOrEmpty(ua)) hdrs["User-Agent"] = ua;

                                try
                                {
                                    Process[] oldIdm = Process.GetProcessesByName("IDMan");
                                    for (int k = 0; k < oldIdm.Length; k++)
                                    {
                                        try { oldIdm[k].Kill(); } catch { }
                                        try { oldIdm[k].Dispose(); } catch { }
                                    }
                                }
                                catch { }

                                if (CanPromptUrl(url0))
                                {
                                    ShowDownloadDialog(
                                        url0,
                                        string.IsNullOrEmpty(decodedName) ? null : decodedName,
                                        referer,
                                        hdrs.Count > 0 ? hdrs : null,
                                        "Bắt tự động từ Chrome/Edge (IDM Registry)");
                                }
                            }
                        }
                        catch { }
                    }
                }
            }
            catch { }
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

        internal static bool IsDownloadableUrl(string text)
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
                catch { }
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

        internal static string GetDictString(Dictionary<string, object> dict, string key)
        {
            if (dict == null) return null;
            object val;
            if (dict.TryGetValue(key, out val) && val != null) return val.ToString();
            return null;
        }

        internal static long GetDictLong(Dictionary<string, object> dict, string key, long fallback)
        {
            if (dict == null) return fallback;
            object val;
            if (dict.TryGetValue(key, out val) && val != null)
            {
                try { return Convert.ToInt64(val, CultureInfo.InvariantCulture); } catch { }
            }
            return fallback;
        }

        internal static double GetDictDouble(Dictionary<string, object> dict, string key, double fallback)
        {
            if (dict == null) return fallback;
            object val;
            if (dict.TryGetValue(key, out val) && val != null)
            {
                try { return Convert.ToDouble(val, CultureInfo.InvariantCulture); } catch { }
            }
            return fallback;
        }

        internal static bool GetDictBool(Dictionary<string, object> dict, string key, bool fallback)
        {
            if (dict == null) return fallback;
            object val;
            if (dict.TryGetValue(key, out val) && val != null)
            {
                try { return Convert.ToBoolean(val, CultureInfo.InvariantCulture); } catch { }
            }
            return fallback;
        }

        internal static JobsSnapshotResponse FetchJobsSnapshot(int timeoutMs)
        {
            string json = HttpRequest("GET", Program.AppUrl + "/api/jobs", null, timeoutMs);
            JavaScriptSerializer js = new JavaScriptSerializer();
            js.MaxJsonLength = 32 * 1024 * 1024;
            Dictionary<string, object> root = js.DeserializeObject(json) as Dictionary<string, object>;
            JobsSnapshotResponse resp = new JobsSnapshotResponse();
            if (root == null) return resp;

            resp.DefaultSaveDir = GetDictString(root, "defaultSaveDir") ?? GetBaseDownloadDir();
            resp.GlobalLimitBps = GetDictLong(root, "globalLimitBps", 0);

            object jobsObj;
            if (root.TryGetValue("jobs", out jobsObj))
            {
                object[] arr = jobsObj as object[];
                if (arr != null)
                {
                    for (int i = 0; i < arr.Length; i++)
                    {
                        Dictionary<string, object> jd = arr[i] as Dictionary<string, object>;
                        if (jd == null) continue;
                        resp.Jobs.Add(ParseJobSnapshot(jd));
                    }
                }
            }
            return resp;
        }

        internal static JobSnapshot ParseJobSnapshot(Dictionary<string, object> jd)
        {
            JobSnapshot job = new JobSnapshot();
            job.Id = GetDictString(jd, "id") ?? "";
            job.Url = GetDictString(jd, "url") ?? "";
            job.FinalUrl = GetDictString(jd, "finalUrl") ?? job.Url;
            job.ResolverType = GetDictString(jd, "resolverType") ?? "direct";
            job.FileName = GetDictString(jd, "fileName") ?? "download.bin";
            job.FilePath = GetDictString(jd, "filePath") ?? "";
            job.SaveDir = GetDictString(jd, "saveDir") ?? "";
            job.Status = GetDictString(jd, "status") ?? "queued";
            job.Error = GetDictString(jd, "error") ?? "";
            job.TotalBytes = GetDictLong(jd, "totalBytes", 0);
            job.DownloadedBytes = GetDictLong(jd, "downloadedBytes", 0);
            job.Progress = GetDictDouble(jd, "progress", 0);
            job.MaxConnections = (int)GetDictLong(jd, "maxConnections", 64);
            job.AcceptRanges = GetDictBool(jd, "acceptRanges", false);
            job.ExpectedSha1 = GetDictString(jd, "expectedSha1") ?? "";
            job.CurrentSpeedBps = GetDictLong(jd, "currentSpeedBps", 0);
            job.PeakSpeedBps = GetDictLong(jd, "peakSpeedBps", 0);
            job.ElapsedMs = GetDictLong(jd, "elapsedMs", 0);
            job.LastTryTime = GetDictString(jd, "lastTryTime") ?? "";

            object etaObj;
            if (jd.TryGetValue("etaSeconds", out etaObj) && etaObj != null)
            {
                try
                {
                    job.EtaSeconds = Convert.ToInt32(etaObj, CultureInfo.InvariantCulture);
                    job.HasEta = true;
                }
                catch { job.HasEta = false; }
            }

            object idmObj;
            if (jd.TryGetValue("idm", out idmObj))
            {
                Dictionary<string, object> idm = idmObj as Dictionary<string, object>;
                if (idm != null)
                {
                    object catObj;
                    if (idm.TryGetValue("category", out catObj))
                    {
                        Dictionary<string, object> catDict = catObj as Dictionary<string, object>;
                        if (catDict != null)
                        {
                            job.CategoryFolder = GetDictString(catDict, "category") ?? GetDictString(catDict, "folder");
                        }
                        else if (catObj != null)
                        {
                            job.CategoryFolder = catObj.ToString();
                        }
                    }

                    object csObj;
                    if (idm.TryGetValue("checksum", out csObj))
                    {
                        Dictionary<string, object> cs = csObj as Dictionary<string, object>;
                        if (cs != null)
                        {
                            job.ChecksumStatus = GetDictString(cs, "status") ?? "";
                            job.ChecksumAlgo = GetDictString(cs, "algo") ?? GetDictString(cs, "algorithm") ?? "";
                            job.ChecksumActual = GetDictString(cs, "actual") ?? "";
                        }
                    }
                }
            }

            if (string.IsNullOrEmpty(job.CategoryFolder))
            {
                job.CategoryFolder = IdmFormat.DetectCategory(job.Url, job.FileName).FolderName;
            }

            object segsObj;
            if (jd.TryGetValue("segments", out segsObj))
            {
                object[] segArr = segsObj as object[];
                if (segArr != null)
                {
                    for (int i = 0; i < segArr.Length; i++)
                    {
                        Dictionary<string, object> sd = segArr[i] as Dictionary<string, object>;
                        if (sd == null) continue;
                        SegmentSnapshot seg = new SegmentSnapshot();
                        seg.Id = (int)GetDictLong(sd, "id", i);
                        seg.Start = GetDictLong(sd, "start", 0);
                        seg.Current = GetDictLong(sd, "current", 0);
                        seg.End = GetDictLong(sd, "end", -1);
                        seg.Status = GetDictString(sd, "status") ?? "pending";
                        seg.SpeedBps = GetDictLong(sd, "speedBps", 0);
                        seg.Ip = GetDictString(sd, "ip") ?? "";
                        seg.Progress = (int)GetDictLong(sd, "progress", 0);
                        job.Segments.Add(seg);
                    }
                }
            }

            return job;
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

        internal void StartQuickDownload(string url, string fileName, int threads, string sourceLabel)
        {
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    EnsureServerRunningSync(4000);
                    CategoryInfo cat = IdmFormat.DetectCategory(url, fileName);
                    string saveDir = Path.Combine(GetBaseDownloadDir(), cat.FolderName);
                    Directory.CreateDirectory(saveDir);

                    Dictionary<string, object> payload = new Dictionary<string, object>();
                    payload["url"] = url;
                    if (!string.IsNullOrEmpty(fileName)) payload["fileName"] = fileName;
                    payload["saveDir"] = saveDir;
                    payload["autoCategory"] = false;
                    payload["maxConnections"] = threads > 0 ? threads : defaultThreads;

                    JavaScriptSerializer js = new JavaScriptSerializer();
                    string respJson = HttpRequest("POST", Program.AppUrl + "/api/jobs", js.Serialize(payload), 6000);
                    Dictionary<string, object> resp = js.DeserializeObject(respJson) as Dictionary<string, object>;
                    string jobId = GetDictString(resp, "id");
                    string respName = GetDictString(resp, "fileName") ?? fileName ?? IdmFormat.GuessFileName(url);

                    uiHost.BeginInvoke(new MethodInvoker(delegate
                    {
                        RefreshMainFormNow();
                        if (!string.IsNullOrEmpty(jobId) && autoShowProgress)
                        {
                            OpenProgressForm(jobId, respName, url, threads > 0 ? threads : defaultThreads);
                        }
                    }));
                }
                catch (Exception ex)
                {
                    uiHost.BeginInvoke(new MethodInvoker(delegate
                    {
                        ShowBalloon("HyperIDM Ultra — Lỗi khởi tạo", ex.Message, ToolTipIcon.Error);
                    }));
                }
            });
        }

        internal void PauseAllActiveJobsAsync()
        {
            ThreadPool.QueueUserWorkItem(delegate
            {
                int pausedCount = 0;
                try
                {
                    string json = HttpRequest("POST", Program.AppUrl + "/api/pause-all", "{}", 3000);
                    JavaScriptSerializer js = new JavaScriptSerializer();
                    Dictionary<string, object> d = js.DeserializeObject(json) as Dictionary<string, object>;
                    pausedCount = (int)GetDictLong(d, "pausedCount", 0);
                }
                catch { }

                uiHost.BeginInvoke(new MethodInvoker(delegate
                {
                    if (isExiting) return;
                    RefreshMainFormNow();
                    ShowBalloon(
                        "HyperIDM Ultra",
                        pausedCount > 0 ? string.Format("Đã tạm dừng {0} tác vụ đang tải.", pausedCount) : "Không có tác vụ nào đang tải.",
                        ToolTipIcon.Info);
                }));
            });
        }

        internal static void OpenDownloadsFolder()
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

        internal static void OpenFolderSelectFile(string filePath, string fallbackDir)
        {
            try
            {
                if (!string.IsNullOrEmpty(filePath) && File.Exists(filePath))
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = "explorer.exe",
                        Arguments = "/select,\"" + filePath + "\"",
                        UseShellExecute = true
                    });
                    return;
                }
                string dir = !string.IsNullOrEmpty(fallbackDir) && Directory.Exists(fallbackDir)
                    ? fallbackDir
                    : GetBaseDownloadDir();
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

        internal void ExitApplication()
        {
            isExiting = true;
            try { monitorTimer.Stop(); monitorTimer.Dispose(); } catch { }
            try { watchdogTimer.Stop(); watchdogTimer.Dispose(); } catch { }

            try
            {
                List<IdmProgressForm> copy = new List<IdmProgressForm>(progressForms.Values);
                for (int i = 0; i < copy.Count; i++)
                {
                    try { copy[i].Close(); } catch { }
                }
                if (mainForm != null && !mainForm.IsDisposed)
                {
                    mainForm.Close();
                }
            }
            catch { }

            try
            {
                trayIcon.Visible = false;
                trayIcon.Dispose();
            }
            catch { }
            try { trayMenu.Dispose(); } catch { }

            try
            {
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

    internal sealed class IdmWhiteColorTable : ProfessionalColorTable
    {
        public override Color MenuStripGradientBegin { get { return Color.White; } }
        public override Color MenuStripGradientEnd { get { return Color.White; } }
        public override Color MenuItemSelected { get { return Color.FromArgb(229, 243, 255); } }
        public override Color MenuItemSelectedGradientBegin { get { return Color.FromArgb(229, 243, 255); } }
        public override Color MenuItemSelectedGradientEnd { get { return Color.FromArgb(229, 243, 255); } }
        public override Color MenuItemBorder { get { return Color.FromArgb(153, 209, 255); } }
        public override Color MenuItemPressedGradientBegin { get { return Color.FromArgb(204, 232, 255); } }
        public override Color MenuItemPressedGradientEnd { get { return Color.FromArgb(204, 232, 255); } }
        public override Color ToolStripDropDownBackground { get { return Color.White; } }
        public override Color ImageMarginGradientBegin { get { return Color.FromArgb(248, 249, 251); } }
        public override Color ImageMarginGradientMiddle { get { return Color.FromArgb(248, 249, 251); } }
        public override Color ImageMarginGradientEnd { get { return Color.FromArgb(248, 249, 251); } }
    }

    internal sealed class DoubleBufferedDataGridView : DataGridView
    {
        public DoubleBufferedDataGridView()
        {
            DoubleBuffered = true;
        }
    }

    internal sealed class DoubleBufferedListView : ListView
    {
        public DoubleBufferedListView()
        {
            DoubleBuffered = true;
        }
    }

    internal sealed class IdmToolbarButtonDef
    {
        public string Label;
        public string Tooltip;
        public int IconKind;
        public Color FillColor;
        public Color RingColor;
        public Color GlyphColor;
    }

    internal sealed class IdmToolbarPanel : Panel
    {
        private readonly List<IdmToolbarButtonDef> buttons = new List<IdmToolbarButtonDef>();
        private readonly ToolTip tip = new ToolTip();
        private int hoverIndex = -1;
        private int pressedIndex = -1;
        private int lastTipIndex = -1;

        public event Action<int, Rectangle> ButtonClicked;

        public IdmToolbarPanel()
        {
            DoubleBuffered = true;
            Height = 68;
            BackColor = Color.White;
            Dock = DockStyle.Top;
            Cursor = Cursors.Hand;

            buttons.Add(new IdmToolbarButtonDef { Label = "Thêm URL", Tooltip = "Thêm địa chỉ tải xuống mới", IconKind = 0, FillColor = Color.FromArgb(224, 249, 244), RingColor = Color.FromArgb(13, 148, 136), GlyphColor = Color.FromArgb(5, 150, 105) });
            buttons.Add(new IdmToolbarButtonDef { Label = "Tải tiếp", Tooltip = "Tiếp tục tải tệp đã chọn", IconKind = 1, FillColor = Color.FromArgb(219, 234, 254), RingColor = Color.FromArgb(37, 99, 235), GlyphColor = Color.FromArgb(37, 99, 235) });
            buttons.Add(new IdmToolbarButtonDef { Label = "Dừng", Tooltip = "Tạm dừng tệp đã chọn", IconKind = 2, FillColor = Color.FromArgb(241, 245, 249), RingColor = Color.FromArgb(185, 28, 28), GlyphColor = Color.FromArgb(220, 38, 38) });
            buttons.Add(new IdmToolbarButtonDef { Label = "Dừng tất cả", Tooltip = "Tạm dừng tất cả các tệp đang tải", IconKind = 3, FillColor = Color.FromArgb(255, 237, 213), RingColor = Color.FromArgb(234, 88, 12), GlyphColor = Color.FromArgb(234, 88, 12) });
            buttons.Add(new IdmToolbarButtonDef { Label = "Xóa", Tooltip = "Xóa tệp đã chọn khỏi danh sách", IconKind = 4, FillColor = Color.FromArgb(252, 231, 243), RingColor = Color.FromArgb(225, 29, 72), GlyphColor = Color.FromArgb(220, 38, 38) });
            buttons.Add(new IdmToolbarButtonDef { Label = "Xóa các ...", Tooltip = "Xóa các tệp đã hoàn thành khỏi danh sách", IconKind = 5, FillColor = Color.FromArgb(252, 231, 243), RingColor = Color.FromArgb(219, 39, 119), GlyphColor = Color.FromArgb(219, 39, 119) });
            buttons.Add(new IdmToolbarButtonDef { Label = "Tùy chọn", Tooltip = "Cấu hình số luồng (64/128) & Tự động bắt link", IconKind = 6, FillColor = Color.FromArgb(243, 232, 255), RingColor = Color.FromArgb(147, 51, 234), GlyphColor = Color.FromArgb(126, 34, 206) });
            buttons.Add(new IdmToolbarButtonDef { Label = "Lập lịch", Tooltip = "Tải hàng loạt & Test nhanh IPSW.me / YouTube", IconKind = 7, FillColor = Color.FromArgb(255, 228, 230), RingColor = Color.FromArgb(225, 29, 72), GlyphColor = Color.FromArgb(190, 18, 60) });
            buttons.Add(new IdmToolbarButtonDef { Label = "Bắt đầu ...", Tooltip = "Bắt đầu tải toàn bộ mục đang chờ", IconKind = 8, FillColor = Color.FromArgb(220, 252, 231), RingColor = Color.FromArgb(22, 163, 74), GlyphColor = Color.FromArgb(21, 128, 61) });
            buttons.Add(new IdmToolbarButtonDef { Label = "Dừng da...", Tooltip = "Dừng toàn bộ hàng đợi tải", IconKind = 9, FillColor = Color.FromArgb(255, 237, 213), RingColor = Color.FromArgb(217, 119, 6), GlyphColor = Color.FromArgb(180, 83, 9) });
            buttons.Add(new IdmToolbarButtonDef { Label = "Nói với bạ...", Tooltip = "Test tải nhanh IPSW.me Mac15,12 • YouTube • Node.js ZIP", IconKind = 10, FillColor = Color.FromArgb(219, 234, 254), RingColor = Color.FromArgb(37, 99, 235), GlyphColor = Color.FromArgb(37, 99, 235) });
        }

        private Rectangle GetSlotRect(int idx)
        {
            int marginX = 6;
            int avail = Math.Max(660, Width - marginX * 2);
            int slotW = Math.Min(88, Math.Max(62, avail / buttons.Count));
            return new Rectangle(marginX + idx * slotW, 3, slotW - 2, Height - 7);
        }

        private int HitTest(Point pt)
        {
            for (int i = 0; i < buttons.Count; i++)
            {
                if (GetSlotRect(i).Contains(pt)) return i;
            }
            return -1;
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            int idx = HitTest(e.Location);
            if (idx != hoverIndex)
            {
                hoverIndex = idx;
                Invalidate();
            }
            if (idx != lastTipIndex)
            {
                lastTipIndex = idx;
                tip.SetToolTip(this, idx >= 0 ? buttons[idx].Tooltip : "");
            }
            Cursor = idx >= 0 ? Cursors.Hand : Cursors.Default;
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            hoverIndex = -1;
            pressedIndex = -1;
            lastTipIndex = -1;
            Invalidate();
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button == MouseButtons.Left)
            {
                pressedIndex = HitTest(e.Location);
                Invalidate();
            }
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            int idx = HitTest(e.Location);
            int downIdx = pressedIndex;
            pressedIndex = -1;
            Invalidate();
            if (e.Button == MouseButtons.Left && idx >= 0 && idx == downIdx)
            {
                if (ButtonClicked != null)
                {
                    ButtonClicked(idx, GetSlotRect(idx));
                }
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

            // Bottom subtle separator #E2E5EA
            using (Pen borderPen = new Pen(Color.FromArgb(226, 229, 234), 1f))
            {
                g.DrawLine(borderPen, 0, Height - 1, Width, Height - 1);
            }

            using (Font labelFont = new Font("Segoe UI", 8.2f, FontStyle.Regular))
            using (StringFormat sf = new StringFormat())
            {
                sf.Alignment = StringAlignment.Center;
                sf.LineAlignment = StringAlignment.Near;
                sf.Trimming = StringTrimming.EllipsisCharacter;
                sf.FormatFlags = StringFormatFlags.NoWrap;

                for (int i = 0; i < buttons.Count; i++)
                {
                    IdmToolbarButtonDef btn = buttons[i];
                    Rectangle slot = GetSlotRect(i);

                    if (i == hoverIndex || i == pressedIndex)
                    {
                        Color bg = i == pressedIndex
                            ? Color.FromArgb(204, 232, 255)
                            : Color.FromArgb(232, 244, 255);
                        using (SolidBrush hb = new SolidBrush(bg))
                        using (Pen hp = new Pen(Color.FromArgb(147, 197, 253), 1f))
                        using (GraphicsPath gp = RoundedRect(slot, 5))
                        {
                            g.FillPath(hb, gp);
                            g.DrawPath(hp, gp);
                        }
                    }

                    int offset = (i == pressedIndex) ? 1 : 0;
                    int circleSize = 34;
                    int cx = slot.X + (slot.Width - circleSize) / 2 + offset;
                    int cy = slot.Y + 4 + offset;
                    Rectangle circleRect = new Rectangle(cx, cy, circleSize, circleSize);

                    using (LinearGradientBrush cBrush = new LinearGradientBrush(
                        circleRect,
                        Color.White,
                        btn.FillColor,
                        LinearGradientMode.Vertical))
                    {
                        g.FillEllipse(cBrush, circleRect);
                    }
                    using (Pen ringPen = new Pen(btn.RingColor, 1.5f))
                    {
                        g.DrawEllipse(ringPen, circleRect);
                    }

                    DrawGlyph(g, btn.IconKind, circleRect, btn.GlyphColor);

                    Rectangle textRect = new Rectangle(slot.X + 1, slot.Y + 42, slot.Width - 2, 18);
                    using (SolidBrush tb = new SolidBrush(Color.FromArgb(30, 41, 59)))
                    {
                        g.DrawString(btn.Label, labelFont, tb, textRect, sf);
                    }
                }
            }
        }

        private static GraphicsPath RoundedRect(Rectangle r, int radius)
        {
            GraphicsPath path = new GraphicsPath();
            int d = radius * 2;
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        private static void DrawGlyph(Graphics g, int kind, Rectangle r, Color c)
        {
            float mx = r.X + r.Width / 2f;
            float my = r.Y + r.Height / 2f;

            switch (kind)
            {
                case 0: // Thêm URL: Bold Green/Teal '+'
                    using (Pen p = new Pen(c, 3.2f))
                    {
                        p.StartCap = LineCap.Round;
                        p.EndCap = LineCap.Round;
                        g.DrawLine(p, mx - 7f, my, mx + 7f, my);
                        g.DrawLine(p, mx, my - 7f, mx, my + 7f);
                    }
                    break;

                case 1: // Tải tiếp: Blue triangle ▶
                    using (SolidBrush b = new SolidBrush(c))
                    {
                        PointF[] tri = new PointF[]
                        {
                            new PointF(mx - 4.5f, my - 7f),
                            new PointF(mx + 7.5f, my),
                            new PointF(mx - 4.5f, my + 7f)
                        };
                        g.FillPolygon(b, tri);
                    }
                    break;

                case 2: // Dừng: Red/Gray square ■
                    using (SolidBrush b = new SolidBrush(c))
                    {
                        g.FillRectangle(b, mx - 5.5f, my - 5.5f, 11f, 11f);
                    }
                    break;

                case 3: // Dừng tất cả: Stop hand
                    using (SolidBrush b = new SolidBrush(c))
                    {
                        g.FillEllipse(b, mx - 5.5f, my - 1f, 11f, 9f);
                        using (Pen fp = new Pen(c, 2.1f))
                        {
                            fp.StartCap = LineCap.Round;
                            fp.EndCap = LineCap.Round;
                            g.DrawLine(fp, mx - 4.5f, my, mx - 5.5f, my - 6.5f);
                            g.DrawLine(fp, mx - 1.5f, my - 1f, mx - 1.5f, my - 8.5f);
                            g.DrawLine(fp, mx + 1.5f, my - 1f, mx + 2f, my - 8f);
                            g.DrawLine(fp, mx + 4.5f, my, mx + 5.5f, my - 5.5f);
                        }
                    }
                    break;

                case 4: // Xóa: Red trash can
                    DrawTrashIcon(g, mx, my, c, false);
                    break;

                case 5: // Xóa các ...: Trash can + gold star
                    DrawTrashIcon(g, mx - 1.5f, my + 1f, c, true);
                    break;

                case 6: // Tùy chọn: Gear
                    using (Pen p = new Pen(c, 2.2f))
                    {
                        g.DrawEllipse(p, mx - 5f, my - 5f, 10f, 10f);
                        for (int a = 0; a < 8; a++)
                        {
                            double ang = a * Math.PI / 4.0;
                            float x1 = mx + (float)Math.Cos(ang) * 5.5f;
                            float y1 = my + (float)Math.Sin(ang) * 5.5f;
                            float x2 = mx + (float)Math.Cos(ang) * 8.5f;
                            float y2 = my + (float)Math.Sin(ang) * 8.5f;
                            g.DrawLine(p, x1, y1, x2, y2);
                        }
                    }
                    break;

                case 7: // Lập lịch: Alarm clock
                    using (Pen p = new Pen(c, 1.8f))
                    {
                        g.DrawEllipse(p, mx - 6.5f, my - 5.5f, 13f, 13f);
                        g.DrawLine(p, mx - 6.5f, my - 6.5f, mx - 3.5f, my - 8.5f);
                        g.DrawLine(p, mx + 6.5f, my - 6.5f, mx + 3.5f, my - 8.5f);
                        g.DrawLine(p, mx, my + 1f, mx, my - 3f);
                        g.DrawLine(p, mx, my + 1f, mx + 3.5f, my + 2.5f);
                    }
                    break;

                case 8: // Bắt đầu hàng đợi: Green play over list bars
                    using (Pen p = new Pen(Color.FromArgb(148, 163, 184), 1.8f))
                    {
                        g.DrawLine(p, mx - 7f, my - 5f, mx + 1f, my - 5f);
                        g.DrawLine(p, mx - 7f, my, mx - 1f, my);
                        g.DrawLine(p, mx - 7f, my + 5f, mx + 1f, my + 5f);
                    }
                    using (SolidBrush b = new SolidBrush(c))
                    {
                        PointF[] tri = new PointF[]
                        {
                            new PointF(mx + 1f, my - 5f),
                            new PointF(mx + 8.5f, my),
                            new PointF(mx + 1f, my + 5f)
                        };
                        g.FillPolygon(b, tri);
                    }
                    break;

                case 9: // Dừng danh sách: Orange stop over list bars
                    using (Pen p = new Pen(Color.FromArgb(148, 163, 184), 1.8f))
                    {
                        g.DrawLine(p, mx - 7f, my - 5f, mx + 1f, my - 5f);
                        g.DrawLine(p, mx - 7f, my, mx - 1f, my);
                        g.DrawLine(p, mx - 7f, my + 5f, mx + 1f, my + 5f);
                    }
                    using (SolidBrush b = new SolidBrush(c))
                    {
                        g.FillRectangle(b, mx + 1f, my - 4f, 7f, 8f);
                    }
                    break;

                case 10: // Nói với bạn bè: Thumbs Up
                    using (SolidBrush b = new SolidBrush(c))
                    {
                        g.FillRectangle(b, mx - 7f, my - 1f, 3.5f, 8f);
                        PointF[] thumb = new PointF[]
                        {
                            new PointF(mx - 2.5f, my - 1f),
                            new PointF(mx + 0.5f, my - 7.5f),
                            new PointF(mx + 2.8f, my - 7.5f),
                            new PointF(mx + 2.5f, my - 2f),
                            new PointF(mx + 7.5f, my - 2f),
                            new PointF(mx + 6.5f, my + 7f),
                            new PointF(mx - 2.5f, my + 7f)
                        };
                        g.FillPolygon(b, thumb);
                    }
                    break;
            }
        }

        private static void DrawTrashIcon(Graphics g, float mx, float my, Color c, bool withStar)
        {
            using (Pen p = new Pen(c, 1.6f))
            {
                g.DrawLine(p, mx - 6.5f, my - 5f, mx + 6.5f, my - 5f);
                g.DrawLine(p, mx - 2.5f, my - 7.5f, mx + 2.5f, my - 7.5f);
                g.DrawRectangle(p, mx - 5f, my - 4.5f, 10f, 11.5f);
                g.DrawLine(p, mx - 2f, my - 2f, mx - 2f, my + 4.5f);
                g.DrawLine(p, mx + 2f, my - 2f, mx + 2f, my + 4.5f);
            }
            if (withStar)
            {
                using (SolidBrush starBrush = new SolidBrush(Color.FromArgb(245, 158, 11)))
                {
                    float sx = mx + 6.5f;
                    float sy = my - 6.5f;
                    g.FillEllipse(starBrush, sx - 3.5f, sy - 3.5f, 7f, 7f);
                }
            }
        }
    }

    internal sealed class MainIdmForm : Form
    {
        private readonly TrayAgentContext agent;
        private readonly System.Windows.Forms.Timer syncTimer;
        private int syncBusyFlag = 0;

        private MenuStrip menuStrip;
        private IdmToolbarPanel toolbar;
        private SplitContainer split;
        private Panel leftHeaderPanel;
        private TreeView treeCategories;
        private ImageList treeImages;
        private DoubleBufferedDataGridView gridJobs;
        private ContextMenuStrip rowContextMenu;
        private ContextMenuStrip quickTestMenu;
        private StatusStrip statusStrip;
        private ToolStripStatusLabel lblStatusEngine;
        private ToolStripStatusLabel lblStatusSummary;
        private ToolStripStatusLabel lblStatusCapture;
        private ToolStripMenuItem menuViewSidebar;

        private string currentFilterTag = "all";
        private List<JobSnapshot> lastJobs = new List<JobSnapshot>();

        public MainIdmForm(TrayAgentContext ownerAgent)
        {
            agent = ownerAgent;
            InitializeUi();

            syncTimer = new System.Windows.Forms.Timer();
            syncTimer.Interval = 500;
            syncTimer.Tick += delegate { TriggerImmediateRefresh(); };
            syncTimer.Start();

            TriggerImmediateRefresh();
        }

        private void InitializeUi()
        {
            Text = "Internet Download Manager 6.43 — HyperIDM Ultra 64-Bit";
            Size = new Size(1020, 620);
            MinimumSize = new Size(880, 500);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.White;
            Font = new Font("Segoe UI", 9f, FontStyle.Regular);
            try { Icon = agent.SharedIcon; } catch { }

            BuildMenus();
            BuildToolbar();
            BuildMainSplit();
            BuildStatusBar();
            BuildRowContextMenu();
            BuildQuickTestMenu();

            // WinForms dock z-order: Top controls added last appear highest
            Controls.Add(split);
            Controls.Add(toolbar);
            Controls.Add(menuStrip);
            Controls.Add(statusStrip);

            FormClosing += delegate(object s, FormClosingEventArgs e)
            {
                if (!agent.IsExiting && e.CloseReason == CloseReason.UserClosing)
                {
                    e.Cancel = true;
                    Hide();
                    agent.NotifyHiddenToTray();
                }
            };
        }

        private void BuildMenus()
        {
            menuStrip = new MenuStrip();
            menuStrip.BackColor = Color.White;
            menuStrip.Dock = DockStyle.Top;
            menuStrip.Font = new Font("Segoe UI", 9f, FontStyle.Regular);
            menuStrip.Renderer = new ToolStripProfessionalRenderer(new IdmWhiteColorTable());
            menuStrip.Paint += delegate(object s, PaintEventArgs pe)
            {
                using (Pen p = new Pen(Color.FromArgb(226, 229, 234), 1))
                {
                    pe.Graphics.DrawLine(p, 0, menuStrip.Height - 1, menuStrip.Width, menuStrip.Height - 1);
                }
            };

            ToolStripMenuItem mTasks = new ToolStripMenuItem("Công việc");
            mTasks.DropDownItems.Add("Thêm tác vụ tải mới (Thêm URL)...", null, delegate { agent.ShowDownloadDialog("", null, null, null, "Thêm URL thủ công"); });
            mTasks.DropDownItems.Add("Nhập danh sách tải hàng loạt / Lập lịch...", null, delegate { OpenBatchDialog(); });
            mTasks.DropDownItems.Add("Mở thư mục Tải xuống (Downloads\\HyperIDM)", null, delegate { TrayAgentContext.OpenDownloadsFolder(); });
            mTasks.DropDownItems.Add(new ToolStripSeparator());
            mTasks.DropDownItems.Add("Mở trình duyệt Web UI (127.0.0.1:17890)", null, delegate { Program.OpenWebBrowserFallback(); });
            mTasks.DropDownItems.Add(new ToolStripSeparator());
            mTasks.DropDownItems.Add("Ẩn xuống khay hệ thống", null, delegate { Hide(); });
            mTasks.DropDownItems.Add("Thoát hoàn toàn HyperIDM", null, delegate { agent.ExitApplication(); });

            ToolStripMenuItem mFile = new ToolStripMenuItem("Tệp tin");
            mFile.DropDownItems.Add("Mở tệp đã tải", null, delegate { OpenSelectedFile(); });
            mFile.DropDownItems.Add("Mở thư mục chứa tệp", null, delegate { OpenSelectedFolder(); });
            mFile.DropDownItems.Add("Mở cửa sổ tiến trình tải (64 Luồng)", null, delegate { OpenSelectedProgress(); });
            mFile.DropDownItems.Add(new ToolStripSeparator());
            mFile.DropDownItems.Add("Tải tiếp", null, delegate { ResumeSelectedJob(); });
            mFile.DropDownItems.Add("Dừng tải", null, delegate { PauseSelectedJob(); });
            mFile.DropDownItems.Add("Xóa khỏi danh sách", null, delegate { DeleteSelectedJob(false); });
            mFile.DropDownItems.Add("Xóa kèm tệp trên ổ đĩa", null, delegate { DeleteSelectedJob(true); });

            ToolStripMenuItem mDownload = new ToolStripMenuItem("Tải xuống");
            mDownload.DropDownItems.Add("Bắt đầu tải toàn bộ hàng đợi", null, delegate { StartAllQueuedJobs(); });
            mDownload.DropDownItems.Add("Dừng tất cả các tệp đang tải", null, delegate { agent.PauseAllActiveJobsAsync(); });
            mDownload.DropDownItems.Add("Xóa các mục đã hoàn thành", null, delegate { ClearCompletedJobs(); });
            mDownload.DropDownItems.Add(new ToolStripSeparator());

            ToolStripMenuItem mLimit = new ToolStripMenuItem("Giới hạn tốc độ toàn cục");
            mLimit.DropDownItems.Add("Không giới hạn (Max Speed)", null, delegate { SetGlobalSpeedLimit(0); });
            mLimit.DropDownItems.Add("50 MB/s", null, delegate { SetGlobalSpeedLimit(50L * 1024 * 1024); });
            mLimit.DropDownItems.Add("10 MB/s", null, delegate { SetGlobalSpeedLimit(10L * 1024 * 1024); });
            mLimit.DropDownItems.Add("5 MB/s", null, delegate { SetGlobalSpeedLimit(5L * 1024 * 1024); });
            mLimit.DropDownItems.Add("1 MB/s", null, delegate { SetGlobalSpeedLimit(1L * 1024 * 1024); });
            mDownload.DropDownItems.Add(mLimit);

            mDownload.DropDownItems.Add("Tùy chọn (Số luồng & Tự bắt link)...", null, delegate { OpenOptionsDialog(); });

            ToolStripMenuItem mView = new ToolStripMenuItem("Hiển thị");
            menuViewSidebar = new ToolStripMenuItem("Hiển thị khung Thể loại bên trái");
            menuViewSidebar.Checked = true;
            menuViewSidebar.Click += delegate
            {
                bool show = !menuViewSidebar.Checked;
                menuViewSidebar.Checked = show;
                split.Panel1Collapsed = !show;
            };
            mView.DropDownItems.Add(menuViewSidebar);
            mView.DropDownItems.Add("Làm mới danh sách ngay", null, delegate { TriggerImmediateRefresh(); });

            ToolStripMenuItem mHelp = new ToolStripMenuItem("Trợ giúp");
            mHelp.DropDownItems.Add("Test tải IPSW.me Mac15,12 (Apple Firmware)", null, delegate
            {
                agent.StartQuickDownload("https://ipsw.me/download/Mac15,12/23F79/", "", agent.DefaultThreads, "Test IPSW.me");
            });
            mHelp.DropDownItems.Add("Test tải YouTube KxMqSz8qVSg", null, delegate
            {
                agent.StartQuickDownload("https://www.youtube.com/watch?v=KxMqSz8qVSg", "", agent.DefaultThreads, "Test YouTube");
            });
            mHelp.DropDownItems.Add("Test tải Node.js x64 ZIP", null, delegate
            {
                agent.StartQuickDownload("https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip", "node-v22.14.0-win-x64.zip", agent.DefaultThreads, "Test Node.js ZIP");
            });
            mHelp.DropDownItems.Add(new ToolStripSeparator());
            mHelp.DropDownItems.Add("Giới thiệu HyperIDM Ultra 64-Bit", null, delegate
            {
                MessageBox.Show(
                    this,
                    "Internet Download Manager 6.43 — HyperIDM Ultra 64-Bit\nEngine: TitanFetch 64/128-Luồng + Sparse Pre-Allocation\nTự động bắt link: Clipboard + Chrome/Edge Extension + Smart IPSW/YouTube.",
                    "Giới thiệu HyperIDM Ultra",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
            });

            ToolStripMenuItem mRegister = new ToolStripMenuItem("Đăng ký");
            mRegister.Click += delegate
            {
                MessageBox.Show(
                    this,
                    "HyperIDM Ultra 64-Bit Pro Edition\nTrạng thái: Đã kích hoạt Bản quyền Vĩnh viễn (DOANDUY).",
                    "Đăng ký bản quyền",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
            };

            menuStrip.Items.Add(mTasks);
            menuStrip.Items.Add(mFile);
            menuStrip.Items.Add(mDownload);
            menuStrip.Items.Add(mView);
            menuStrip.Items.Add(mHelp);
            menuStrip.Items.Add(mRegister);
        }

        private void BuildToolbar()
        {
            toolbar = new IdmToolbarPanel();
            toolbar.ButtonClicked += delegate(int idx, Rectangle slotRect)
            {
                switch (idx)
                {
                    case 0: // Thêm URL
                        agent.ShowDownloadDialog("", null, null, null, "Thêm URL thủ công");
                        break;
                    case 1: // Tải tiếp
                        ResumeSelectedJob();
                        break;
                    case 2: // Dừng
                        PauseSelectedJob();
                        break;
                    case 3: // Dừng tất cả
                        agent.PauseAllActiveJobsAsync();
                        break;
                    case 4: // Xóa
                        DeleteSelectedJob(false);
                        break;
                    case 5: // Xóa các ...
                        ClearCompletedJobs();
                        break;
                    case 6: // Tùy chọn
                        OpenOptionsDialog();
                        break;
                    case 7: // Lập lịch
                        OpenBatchDialog();
                        break;
                    case 8: // Bắt đầu ...
                        StartAllQueuedJobs();
                        break;
                    case 9: // Dừng da...
                        agent.PauseAllActiveJobsAsync();
                        break;
                    case 10: // Nói với bạn bè / Menu test nhanh
                        quickTestMenu.Show(toolbar, new Point(slotRect.Left, toolbar.Height - 2));
                        break;
                }
            };
        }

        private void BuildMainSplit()
        {
            split = new SplitContainer();
            split.Size = new Size(1000, 500);
            split.Dock = DockStyle.Fill;
            split.Orientation = Orientation.Vertical;
            split.SplitterWidth = 3;
            split.FixedPanel = FixedPanel.Panel1;
            split.SplitterDistance = 165;
            split.BackColor = Color.FromArgb(226, 229, 234);

            split.Panel1.BackColor = Color.White;
            split.Panel2.BackColor = Color.White;

            // Left Panel Header ("Thể loại" + close '✕')
            leftHeaderPanel = new Panel();
            leftHeaderPanel.Dock = DockStyle.Top;
            leftHeaderPanel.Height = 24;
            leftHeaderPanel.BackColor = Color.FromArgb(245, 246, 248);
            leftHeaderPanel.Paint += delegate(object s, PaintEventArgs pe)
            {
                using (Pen p = new Pen(Color.FromArgb(226, 229, 234), 1))
                {
                    pe.Graphics.DrawLine(p, 0, leftHeaderPanel.Height - 1, leftHeaderPanel.Width, leftHeaderPanel.Height - 1);
                }
            };

            Label lblCatHeader = new Label();
            lblCatHeader.Text = "Thể loại";
            lblCatHeader.Location = new Point(8, 4);
            lblCatHeader.AutoSize = true;
            lblCatHeader.ForeColor = Color.FromArgb(51, 65, 85);
            lblCatHeader.Font = new Font("Segoe UI", 8.5f, FontStyle.Regular);

            Label btnHideSidebar = new Label();
            btnHideSidebar.Text = "✕";
            btnHideSidebar.Dock = DockStyle.Right;
            btnHideSidebar.Width = 22;
            btnHideSidebar.TextAlign = ContentAlignment.MiddleCenter;
            btnHideSidebar.ForeColor = Color.FromArgb(100, 116, 139);
            btnHideSidebar.Cursor = Cursors.Hand;
            btnHideSidebar.Click += delegate
            {
                split.Panel1Collapsed = true;
                if (menuViewSidebar != null) menuViewSidebar.Checked = false;
            };

            leftHeaderPanel.Controls.Add(lblCatHeader);
            leftHeaderPanel.Controls.Add(btnHideSidebar);

            // TreeView Categories
            treeImages = BuildCategoryImageList();
            treeCategories = new TreeView();
            treeCategories.Dock = DockStyle.Fill;
            treeCategories.BorderStyle = BorderStyle.None;
            treeCategories.BackColor = Color.White;
            treeCategories.ShowLines = true;
            treeCategories.ShowPlusMinus = true;
            treeCategories.ShowRootLines = true;
            treeCategories.HideSelection = false;
            treeCategories.ItemHeight = 21;
            treeCategories.ImageList = treeImages;
            treeCategories.Font = new Font("Segoe UI", 9f, FontStyle.Regular);

            TreeNode nodeAll = new TreeNode("Tất cả", 0, 0) { Tag = "all" };
            nodeAll.Nodes.Add(new TreeNode("Dữ liệu nén", 1, 1) { Tag = "cat:Compressed" });
            nodeAll.Nodes.Add(new TreeNode("Tài liệu", 2, 2) { Tag = "cat:Documents" });
            nodeAll.Nodes.Add(new TreeNode("Âm nhạc", 3, 3) { Tag = "cat:Music" });
            nodeAll.Nodes.Add(new TreeNode("Chương trình", 4, 4) { Tag = "cat:Programs" });
            nodeAll.Nodes.Add(new TreeNode("Video", 5, 5) { Tag = "cat:Video" });
            nodeAll.Nodes.Add(new TreeNode("Firmware / ISO", 6, 6) { Tag = "cat:Firmware_ISO" });

            TreeNode nodeUnfinished = new TreeNode("Chưa tải xong", 7, 7) { Tag = "unfinished" };
            TreeNode nodeFinished = new TreeNode("Đã tải xong", 8, 8) { Tag = "finished" };
            TreeNode nodeGrabber = new TreeNode("Grabber Project", 9, 9) { Tag = "grabber" };
            TreeNode nodeQueue = new TreeNode("Danh sách chờ tải", 10, 10) { Tag = "queued" };

            treeCategories.Nodes.Add(nodeAll);
            treeCategories.Nodes.Add(nodeUnfinished);
            treeCategories.Nodes.Add(nodeFinished);
            treeCategories.Nodes.Add(nodeGrabber);
            treeCategories.Nodes.Add(nodeQueue);
            nodeAll.Expand();
            treeCategories.SelectedNode = nodeAll;

            treeCategories.AfterSelect += delegate(object s, TreeViewEventArgs e)
            {
                if (e.Node != null && e.Node.Tag != null)
                {
                    currentFilterTag = e.Node.Tag.ToString();
                    RenderJobsGrid(lastJobs);
                }
            };

            split.Panel1.Controls.Add(treeCategories);
            split.Panel1.Controls.Add(leftHeaderPanel);

            // Right Panel DataGridView
            gridJobs = new DoubleBufferedDataGridView();
            gridJobs.Dock = DockStyle.Fill;
            gridJobs.BackgroundColor = Color.White;
            gridJobs.BorderStyle = BorderStyle.None;
            gridJobs.CellBorderStyle = DataGridViewCellBorderStyle.Single;
            gridJobs.GridColor = Color.FromArgb(234, 234, 234);
            gridJobs.RowHeadersVisible = false;
            gridJobs.SelectionMode = DataGridViewSelectionMode.FullRowSelect;
            gridJobs.MultiSelect = false;
            gridJobs.ReadOnly = true;
            gridJobs.AllowUserToAddRows = false;
            gridJobs.AllowUserToDeleteRows = false;
            gridJobs.AllowUserToResizeRows = false;
            gridJobs.EnableHeadersVisualStyles = false;
            gridJobs.ColumnHeadersBorderStyle = DataGridViewHeaderBorderStyle.Single;
            gridJobs.ColumnHeadersHeightSizeMode = DataGridViewColumnHeadersHeightSizeMode.DisableResizing;
            gridJobs.ColumnHeadersHeight = 25;
            gridJobs.RowTemplate.Height = 23;

            gridJobs.ColumnHeadersDefaultCellStyle.BackColor = Color.FromArgb(248, 249, 251);
            gridJobs.ColumnHeadersDefaultCellStyle.ForeColor = Color.FromArgb(30, 41, 59);
            gridJobs.ColumnHeadersDefaultCellStyle.Font = new Font("Segoe UI", 8.75f, FontStyle.Regular);
            gridJobs.ColumnHeadersDefaultCellStyle.Alignment = DataGridViewContentAlignment.MiddleLeft;
            gridJobs.ColumnHeadersDefaultCellStyle.SelectionBackColor = Color.FromArgb(248, 249, 251);

            gridJobs.DefaultCellStyle.BackColor = Color.White;
            gridJobs.DefaultCellStyle.ForeColor = Color.FromArgb(15, 23, 42);
            gridJobs.DefaultCellStyle.SelectionBackColor = Color.FromArgb(0, 120, 215);
            gridJobs.DefaultCellStyle.SelectionForeColor = Color.White;
            gridJobs.DefaultCellStyle.Font = new Font("Segoe UI", 8.75f, FontStyle.Regular);

            gridJobs.Columns.Add(CreateCol("colName", "Tên tệp ▲", 205, DataGridViewContentAlignment.MiddleLeft));
            gridJobs.Columns.Add(CreateCol("colQueue", "Kiểu chờ tải", 92, DataGridViewContentAlignment.MiddleLeft));
            gridJobs.Columns.Add(CreateCol("colSize", "Kích thước", 86, DataGridViewContentAlignment.MiddleRight));
            gridJobs.Columns.Add(CreateCol("colStatus", "Trạng thái", 100, DataGridViewContentAlignment.MiddleLeft));
            gridJobs.Columns.Add(CreateCol("colEta", "Thời gian còn lại", 98, DataGridViewContentAlignment.MiddleLeft));
            gridJobs.Columns.Add(CreateCol("colSpeed", "Tốc độ truyền", 92, DataGridViewContentAlignment.MiddleRight));
            gridJobs.Columns.Add(CreateCol("colLastTry", "Thử tải lần cuối", 125, DataGridViewContentAlignment.MiddleLeft));
            DataGridViewTextBoxColumn descCol = CreateCol("colDesc", "Mô tả", 150, DataGridViewContentAlignment.MiddleLeft);
            descCol.AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill;
            descCol.MinimumWidth = 120;
            gridJobs.Columns.Add(descCol);

            gridJobs.CellDoubleClick += delegate(object s, DataGridViewCellEventArgs e)
            {
                if (e.RowIndex >= 0) HandleRowDoubleClick(e.RowIndex);
            };
            gridJobs.MouseDown += delegate(object s, MouseEventArgs e)
            {
                if (e.Button == MouseButtons.Right)
                {
                    DataGridView.HitTestInfo hit = gridJobs.HitTest(e.X, e.Y);
                    if (hit.RowIndex >= 0)
                    {
                        gridJobs.ClearSelection();
                        gridJobs.Rows[hit.RowIndex].Selected = true;
                        rowContextMenu.Show(gridJobs, e.Location);
                    }
                }
            };
            gridJobs.KeyDown += delegate(object s, KeyEventArgs e)
            {
                if (e.KeyCode == Keys.Delete) DeleteSelectedJob(false);
                else if (e.KeyCode == Keys.F5) TriggerImmediateRefresh();
                else if (e.KeyCode == Keys.Enter && gridJobs.SelectedRows.Count > 0)
                {
                    HandleRowDoubleClick(gridJobs.SelectedRows[0].Index);
                }
            };

            split.Panel2.Controls.Add(gridJobs);
        }

        private static DataGridViewTextBoxColumn CreateCol(string name, string header, int width, DataGridViewContentAlignment align)
        {
            DataGridViewTextBoxColumn col = new DataGridViewTextBoxColumn();
            col.Name = name;
            col.HeaderText = header;
            col.Width = width;
            col.SortMode = DataGridViewColumnSortMode.NotSortable;
            col.DefaultCellStyle.Alignment = align;
            return col;
        }

        private static ImageList BuildCategoryImageList()
        {
            ImageList list = new ImageList();
            list.ImageSize = new Size(16, 16);
            list.ColorDepth = ColorDepth.Depth32Bit;

            Color[] colors = new Color[]
            {
                Color.FromArgb(245, 158, 11),  // 0: All (Gold folder)
                Color.FromArgb(217, 119, 6),   // 1: Compressed
                Color.FromArgb(16, 185, 129),  // 2: Documents
                Color.FromArgb(236, 72, 153),  // 3: Music
                Color.FromArgb(59, 130, 246),  // 4: Programs
                Color.FromArgb(147, 51, 234),  // 5: Video
                Color.FromArgb(14, 116, 144),  // 6: Firmware / ISO
                Color.FromArgb(249, 115, 22),  // 7: Unfinished
                Color.FromArgb(34, 197, 94),   // 8: Finished
                Color.FromArgb(100, 116, 139), // 9: Grabber
                Color.FromArgb(14, 165, 233)   // 10: Queue
            };

            for (int i = 0; i < colors.Length; i++)
            {
                Bitmap bmp = new Bitmap(16, 16, PixelFormat.Format32bppArgb);
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.Clear(Color.Transparent);
                    using (SolidBrush tabBrush = new SolidBrush(colors[i]))
                    {
                        g.FillRectangle(tabBrush, 2, 3, 5, 3);
                        g.FillRectangle(tabBrush, 2, 5, 12, 8);
                    }
                    using (Pen outline = new Pen(Color.FromArgb(180, 30, 41, 59), 0.8f))
                    {
                        g.DrawRectangle(outline, 2, 5, 11, 7);
                    }
                }
                list.Images.Add(bmp);
            }
            return list;
        }

        private void BuildStatusBar()
        {
            statusStrip = new StatusStrip();
            statusStrip.BackColor = Color.FromArgb(248, 249, 251);
            statusStrip.SizingGrip = true;
            statusStrip.Font = new Font("Segoe UI", 8.25f, FontStyle.Regular);

            lblStatusEngine = new ToolStripStatusLabel("● Engine: Đang kết nối 127.0.0.1:17890...");
            lblStatusEngine.ForeColor = Color.FromArgb(5, 150, 105);

            lblStatusSummary = new ToolStripStatusLabel("0 mục") { Spring = true, TextAlign = ContentAlignment.MiddleLeft };
            lblStatusCapture = new ToolStripStatusLabel();
            UpdateCaptureStatusLabel();

            statusStrip.Items.Add(lblStatusEngine);
            statusStrip.Items.Add(new ToolStripSeparator());
            statusStrip.Items.Add(lblStatusSummary);
            statusStrip.Items.Add(new ToolStripSeparator());
            statusStrip.Items.Add(lblStatusCapture);
        }

        internal void UpdateCaptureStatusLabel()
        {
            if (lblStatusCapture == null) return;
            lblStatusCapture.Text = string.Format(
                "Bắt Clipboard: {0} | Bắt Trình duyệt: {1} | Mặc định: {2} Luồng",
                agent.ClipboardEnabled ? "BẬT" : "TẮT",
                agent.BrowserInterceptEnabled ? "BẬT" : "TẮT",
                agent.DefaultThreads);
        }

        private void BuildRowContextMenu()
        {
            rowContextMenu = new ContextMenuStrip();
            rowContextMenu.Font = new Font("Segoe UI", 9f);
            rowContextMenu.Items.Add("Mở cửa sổ tiến trình tải", null, delegate { OpenSelectedProgress(); });
            rowContextMenu.Items.Add("Mở tệp", null, delegate { OpenSelectedFile(); });
            rowContextMenu.Items.Add("Mở thư mục chứa tệp", null, delegate { OpenSelectedFolder(); });
            rowContextMenu.Items.Add(new ToolStripSeparator());
            rowContextMenu.Items.Add("Tải tiếp", null, delegate { ResumeSelectedJob(); });
            rowContextMenu.Items.Add("Tạm dừng", null, delegate { PauseSelectedJob(); });
            rowContextMenu.Items.Add(new ToolStripSeparator());
            rowContextMenu.Items.Add("Sao chép URL", null, delegate
            {
                JobSnapshot job = GetSelectedJob();
                if (job != null && !string.IsNullOrEmpty(job.Url))
                {
                    try { Clipboard.SetText(job.Url); } catch { }
                }
            });
            rowContextMenu.Items.Add("Xóa khỏi danh sách", null, delegate { DeleteSelectedJob(false); });
            rowContextMenu.Items.Add("Xóa kèm tệp trên ổ đĩa", null, delegate { DeleteSelectedJob(true); });
        }

        private void BuildQuickTestMenu()
        {
            quickTestMenu = new ContextMenuStrip();
            quickTestMenu.Font = new Font("Segoe UI", 9f);
            quickTestMenu.Items.Add("Test tải IPSW.me Mac15,12 (Apple Firmware)", null, delegate
            {
                agent.StartQuickDownload("https://ipsw.me/download/Mac15,12/23F79/", "", agent.DefaultThreads, "Quick Test IPSW");
            });
            quickTestMenu.Items.Add("Test tải YouTube KxMqSz8qVSg", null, delegate
            {
                agent.StartQuickDownload("https://www.youtube.com/watch?v=KxMqSz8qVSg", "", agent.DefaultThreads, "Quick Test YouTube");
            });
            quickTestMenu.Items.Add("Test tải Node.js x64 ZIP (v22.14.0)", null, delegate
            {
                agent.StartQuickDownload("https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip", "node-v22.14.0-win-x64.zip", agent.DefaultThreads, "Quick Test Node.js");
            });
            quickTestMenu.Items.Add(new ToolStripSeparator());
            quickTestMenu.Items.Add("Mở Giao diện Web Dashboard (127.0.0.1:17890)", null, delegate { Program.OpenWebBrowserFallback(); });
        }

        internal void TriggerImmediateRefresh()
        {
            if (IsDisposed || agent.IsExiting) return;
            if (Interlocked.CompareExchange(ref syncBusyFlag, 1, 0) != 0) return;

            ThreadPool.QueueUserWorkItem(delegate
            {
                JobsSnapshotResponse snapshot = null;
                string err = null;
                try
                {
                    snapshot = TrayAgentContext.FetchJobsSnapshot(1800);
                }
                catch (Exception ex)
                {
                    err = ex.Message;
                }
                finally
                {
                    Interlocked.Exchange(ref syncBusyFlag, 0);
                }

                try
                {
                    if (!IsDisposed && IsHandleCreated)
                    {
                        BeginInvoke(new MethodInvoker(delegate
                        {
                            if (IsDisposed || agent.IsExiting) return;
                            if (snapshot != null)
                            {
                                lastJobs = snapshot.Jobs;
                                RenderJobsGrid(lastJobs);
                                UpdateStatusSummary(snapshot);
                            }
                            else
                            {
                                lblStatusEngine.Text = "○ Engine đang khởi động (127.0.0.1:17890)...";
                                lblStatusEngine.ForeColor = Color.FromArgb(217, 119, 6);
                                if (!string.IsNullOrEmpty(err)) { }
                            }
                        }));
                    }
                }
                catch { }
            });
        }

        private void UpdateStatusSummary(JobsSnapshotResponse snap)
        {
            int activeCount = 0;
            long totalSpeed = 0;
            for (int i = 0; i < snap.Jobs.Count; i++)
            {
                if (IdmFormat.IsActiveStatus(snap.Jobs[i].Status))
                {
                    activeCount++;
                    totalSpeed += snap.Jobs[i].CurrentSpeedBps;
                }
            }
            lblStatusEngine.Text = "● Engine: 127.0.0.1:17890 (Sẵn sàng)";
            lblStatusEngine.ForeColor = Color.FromArgb(5, 150, 105);

            string speedStr = totalSpeed > 0 ? (" • Tổng tốc độ: " + IdmFormat.FormatSpeed(totalSpeed, false)) : "";
            string limitStr = snap.GlobalLimitBps > 0 ? (" • Giới hạn: " + IdmFormat.FormatSpeed(snap.GlobalLimitBps, false)) : "";
            lblStatusSummary.Text = string.Format("Tổng: {0} tệp ({1} đang tải){2}{3}", snap.Jobs.Count, activeCount, speedStr, limitStr);
        }

        private List<JobSnapshot> FilterJobs(List<JobSnapshot> jobs)
        {
            List<JobSnapshot> result = new List<JobSnapshot>();
            for (int i = 0; i < jobs.Count; i++)
            {
                JobSnapshot j = jobs[i];
                string st = (j.Status ?? "").ToLowerInvariant();
                if (currentFilterTag == "all")
                {
                    result.Add(j);
                }
                else if (currentFilterTag == "unfinished")
                {
                    if (st != "completed") result.Add(j);
                }
                else if (currentFilterTag == "finished")
                {
                    if (st == "completed") result.Add(j);
                }
                else if (currentFilterTag == "queued")
                {
                    if (st == "queued" || st == "paused") result.Add(j);
                }
                else if (currentFilterTag == "grabber")
                {
                    if (j.ResolverType == "youtube" || j.ResolverType == "ipsw") result.Add(j);
                }
                else if (currentFilterTag.StartsWith("cat:", StringComparison.Ordinal))
                {
                    string targetCat = currentFilterTag.Substring(4);
                    if (string.Equals(j.CategoryFolder, targetCat, StringComparison.OrdinalIgnoreCase))
                    {
                        result.Add(j);
                    }
                }
            }
            return result;
        }

        private void RenderJobsGrid(List<JobSnapshot> allJobs)
        {
            List<JobSnapshot> filtered = FilterJobs(allJobs);
            string selectedId = null;
            if (gridJobs.SelectedRows.Count > 0)
            {
                JobSnapshot selJob = gridJobs.SelectedRows[0].Tag as JobSnapshot;
                if (selJob != null) selectedId = selJob.Id;
            }
            int firstVisible = gridJobs.FirstDisplayedScrollingRowIndex;

            // Adjust row count in-place to eliminate flicker
            while (gridJobs.Rows.Count > filtered.Count)
            {
                gridJobs.Rows.RemoveAt(gridJobs.Rows.Count - 1);
            }
            while (gridJobs.Rows.Count < filtered.Count)
            {
                gridJobs.Rows.Add();
            }

            int rowToSelect = -1;
            for (int i = 0; i < filtered.Count; i++)
            {
                JobSnapshot j = filtered[i];
                DataGridViewRow row = gridJobs.Rows[i];
                row.Tag = j;

                string queueType = MapCategoryDisplay(j.CategoryFolder);
                string sizeStr = j.TotalBytes > 0 ? IdmFormat.FormatBytes(j.TotalBytes) : (j.DownloadedBytes > 0 ? IdmFormat.FormatBytes(j.DownloadedBytes) : "Chưa rõ");
                string statusStr = IdmFormat.TranslateStatus(j.Status, j.Progress, j.Error);
                string etaStr = IdmFormat.FormatEta(j.EtaSeconds, j.HasEta, j.Status);
                string speedStr = IdmFormat.IsActiveStatus(j.Status) ? IdmFormat.FormatSpeed(j.CurrentSpeedBps, false) : "";
                string lastTry = !string.IsNullOrEmpty(j.LastTryTime) ? j.LastTryTime : DateTime.Now.ToString("dd/MM/yyyy HH:mm");
                string desc = BuildDescription(j);

                SetCellIfChanged(row.Cells[0], j.FileName);
                SetCellIfChanged(row.Cells[1], queueType);
                SetCellIfChanged(row.Cells[2], sizeStr);
                SetCellIfChanged(row.Cells[3], statusStr);
                SetCellIfChanged(row.Cells[4], etaStr);
                SetCellIfChanged(row.Cells[5], speedStr);
                SetCellIfChanged(row.Cells[6], lastTry);
                SetCellIfChanged(row.Cells[7], desc);

                if (selectedId != null && j.Id == selectedId) rowToSelect = i;
            }

            if (rowToSelect >= 0 && gridJobs.Rows.Count > rowToSelect)
            {
                if (!gridJobs.Rows[rowToSelect].Selected)
                {
                    gridJobs.ClearSelection();
                    gridJobs.Rows[rowToSelect].Selected = true;
                }
            }
            else if (gridJobs.Rows.Count > 0 && gridJobs.SelectedRows.Count == 0)
            {
                gridJobs.Rows[0].Selected = true;
            }

            if (firstVisible >= 0 && firstVisible < gridJobs.Rows.Count)
            {
                try { gridJobs.FirstDisplayedScrollingRowIndex = firstVisible; } catch { }
            }
        }

        private static void SetCellIfChanged(DataGridViewCell cell, string value)
        {
            string val = value ?? "";
            if (!string.Equals(cell.Value as string, val, StringComparison.Ordinal))
            {
                cell.Value = val;
            }
        }

        private static string MapCategoryDisplay(string folder)
        {
            if (string.Equals(folder, "Compressed", StringComparison.OrdinalIgnoreCase)) return "Dữ liệu nén";
            if (string.Equals(folder, "Documents", StringComparison.OrdinalIgnoreCase)) return "Tài liệu";
            if (string.Equals(folder, "Music", StringComparison.OrdinalIgnoreCase)) return "Âm nhạc";
            if (string.Equals(folder, "Programs", StringComparison.OrdinalIgnoreCase)) return "Chương trình";
            if (string.Equals(folder, "Video", StringComparison.OrdinalIgnoreCase)) return "Video";
            if (string.Equals(folder, "Firmware_ISO", StringComparison.OrdinalIgnoreCase)) return "Firmware / ISO";
            return "Chính";
        }

        private static string BuildDescription(JobSnapshot j)
        {
            if (!string.IsNullOrEmpty(j.Error)) return j.Error;
            if (!string.IsNullOrEmpty(j.ChecksumStatus) && j.ChecksumStatus != "none")
            {
                if (j.ChecksumStatus == "ok" || j.ChecksumStatus == "verified")
                {
                    return string.Format("{0} Hợp lệ", (j.ChecksumAlgo ?? "SHA").ToUpperInvariant());
                }
                if (j.ChecksumStatus == "verifying") return "Đang kiểm tra mã băm...";
                if (j.ChecksumStatus == "mismatch") return "Cảnh báo: Sai mã băm!";
            }
            if (IdmFormat.IsActiveStatus(j.Status))
            {
                return string.Format("{0} Luồng • {1}", j.MaxConnections, j.AcceptRanges ? "Hỗ trợ Resume" : "1 Luồng");
            }
            return j.Url;
        }

        private JobSnapshot GetSelectedJob()
        {
            if (gridJobs.SelectedRows.Count == 0) return null;
            return gridJobs.SelectedRows[0].Tag as JobSnapshot;
        }

        private void HandleRowDoubleClick(int rowIndex)
        {
            if (rowIndex < 0 || rowIndex >= gridJobs.Rows.Count) return;
            JobSnapshot job = gridJobs.Rows[rowIndex].Tag as JobSnapshot;
            if (job == null) return;

            if (string.Equals(job.Status, "completed", StringComparison.OrdinalIgnoreCase))
            {
                TrayAgentContext.OpenFolderSelectFile(job.FilePath, job.SaveDir);
            }
            else if (IdmFormat.IsActiveStatus(job.Status))
            {
                agent.OpenProgressForm(job.Id, job.FileName, job.Url, job.MaxConnections);
            }
            else
            {
                ResumeJobAndOpenProgress(job);
            }
        }

        private void OpenSelectedProgress()
        {
            JobSnapshot job = GetSelectedJob();
            if (job == null) return;
            agent.OpenProgressForm(job.Id, job.FileName, job.Url, job.MaxConnections);
        }

        private void OpenSelectedFolder()
        {
            JobSnapshot job = GetSelectedJob();
            if (job == null) { TrayAgentContext.OpenDownloadsFolder(); return; }
            TrayAgentContext.OpenFolderSelectFile(job.FilePath, job.SaveDir);
        }

        private void OpenSelectedFile()
        {
            JobSnapshot job = GetSelectedJob();
            if (job == null) return;
            if (!string.IsNullOrEmpty(job.FilePath) && File.Exists(job.FilePath))
            {
                try { Process.Start(new ProcessStartInfo { FileName = job.FilePath, UseShellExecute = true }); } catch { }
            }
            else
            {
                TrayAgentContext.OpenFolderSelectFile(job.FilePath, job.SaveDir);
            }
        }

        private void ResumeSelectedJob()
        {
            JobSnapshot job = GetSelectedJob();
            if (job == null) return;
            if (string.Equals(job.Status, "completed", StringComparison.OrdinalIgnoreCase))
            {
                TrayAgentContext.OpenFolderSelectFile(job.FilePath, job.SaveDir);
                return;
            }
            ResumeJobAndOpenProgress(job);
        }

        private void ResumeJobAndOpenProgress(JobSnapshot job)
        {
            agent.OpenProgressForm(job.Id, job.FileName, job.Url, job.MaxConnections);
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    TrayAgentContext.HttpRequest("POST", Program.AppUrl + "/api/jobs/" + Uri.EscapeDataString(job.Id) + "/resume", "{}", 3000);
                }
                catch { }
                TriggerImmediateRefresh();
            });
        }

        private void PauseSelectedJob()
        {
            JobSnapshot job = GetSelectedJob();
            if (job == null) return;
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    TrayAgentContext.HttpRequest("POST", Program.AppUrl + "/api/jobs/" + Uri.EscapeDataString(job.Id) + "/pause", "{}", 3000);
                }
                catch { }
                TriggerImmediateRefresh();
            });
        }

        private void DeleteSelectedJob(bool deleteFile)
        {
            JobSnapshot job = GetSelectedJob();
            if (job == null) return;
            if (deleteFile)
            {
                DialogResult dr = MessageBox.Show(
                    this,
                    string.Format("Xóa \"{0}\" khỏi danh sách VÀ xóa tệp trên ổ đĩa?", job.FileName),
                    "Xác nhận xóa tệp",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Warning);
                if (dr != DialogResult.Yes) return;
            }

            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    string url = Program.AppUrl + "/api/jobs/" + Uri.EscapeDataString(job.Id) + (deleteFile ? "?deleteFile=true" : "");
                    TrayAgentContext.HttpRequest("DELETE", url, null, 3000);
                }
                catch { }
                TriggerImmediateRefresh();
            });
        }

        private void ClearCompletedJobs()
        {
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    TrayAgentContext.HttpRequest("POST", Program.AppUrl + "/api/clear-completed", "{}", 3000);
                }
                catch { }
                TriggerImmediateRefresh();
            });
        }

        private void StartAllQueuedJobs()
        {
            List<JobSnapshot> snapshot = new List<JobSnapshot>(lastJobs);
            ThreadPool.QueueUserWorkItem(delegate
            {
                for (int i = 0; i < snapshot.Count; i++)
                {
                    string st = (snapshot[i].Status ?? "").ToLowerInvariant();
                    if (st == "paused" || st == "queued" || st == "error")
                    {
                        try
                        {
                            TrayAgentContext.HttpRequest("POST", Program.AppUrl + "/api/jobs/" + Uri.EscapeDataString(snapshot[i].Id) + "/resume", "{}", 2500);
                        }
                        catch { }
                    }
                }
                TriggerImmediateRefresh();
            });
        }

        private void SetGlobalSpeedLimit(long bps)
        {
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    JavaScriptSerializer js = new JavaScriptSerializer();
                    Dictionary<string, object> p = new Dictionary<string, object>();
                    p["bps"] = bps;
                    TrayAgentContext.HttpRequest("POST", Program.AppUrl + "/api/limit", js.Serialize(p), 2500);
                }
                catch { }
                TriggerImmediateRefresh();
            });
        }

        private void OpenOptionsDialog()
        {
            using (OptionsForm dlg = new OptionsForm(agent))
            {
                dlg.ShowDialog(this);
                UpdateCaptureStatusLabel();
                TriggerImmediateRefresh();
            }
        }

        private void OpenBatchDialog()
        {
            using (BatchSchedulerForm dlg = new BatchSchedulerForm(agent))
            {
                dlg.ShowDialog(this);
                TriggerImmediateRefresh();
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                try { if (syncTimer != null) { syncTimer.Stop(); syncTimer.Dispose(); } } catch { }
                try { if (treeImages != null) treeImages.Dispose(); } catch { }
            }
            base.Dispose(disposing);
        }
    }

    internal sealed class SegmentBarPanel : Panel
    {
        private List<SegmentSnapshot> segments = new List<SegmentSnapshot>();
        private long totalBytes = 0;

        public SegmentBarPanel()
        {
            DoubleBuffered = true;
            BackColor = Color.FromArgb(229, 231, 235);
            Height = 22;
        }

        public void UpdateSegments(List<SegmentSnapshot> segs, long total)
        {
            segments = segs ?? new List<SegmentSnapshot>();
            totalBytes = total;
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            Graphics g = e.Graphics;
            int w = Width - 2;
            int h = Height - 2;

            using (SolidBrush bg = new SolidBrush(Color.FromArgb(236, 240, 245)))
            {
                g.FillRectangle(bg, 1, 1, w, h);
            }

            if (segments != null && segments.Count > 0)
            {
                int n = segments.Count;
                for (int i = 0; i < n; i++)
                {
                    SegmentSnapshot s = segments[i];
                    float x0 = 1f + (float)(w * (double)i / n);
                    float x1 = 1f + (float)(w * (double)(i + 1) / n);
                    float segW = Math.Max(1f, x1 - x0);

                    double ratio = 0;
                    if (s.Status == "completed")
                    {
                        ratio = 1.0;
                    }
                    else if (s.End >= s.Start && s.End > 0)
                    {
                        long len = Math.Max(1L, s.End - s.Start + 1);
                        ratio = Math.Min(1.0, Math.Max(0.0, (double)(s.Current - s.Start) / len));
                    }
                    else if (totalBytes > 0)
                    {
                        ratio = Math.Min(1.0, Math.Max(0.0, s.Progress / 100.0));
                    }

                    if (ratio > 0)
                    {
                        float fillW = (float)(segW * ratio);
                        Color fillC = (s.Status == "downloading")
                            ? Color.FromArgb(14, 165, 233)
                            : Color.FromArgb(0, 120, 215);
                        using (SolidBrush sb = new SolidBrush(fillC))
                        {
                            g.FillRectangle(sb, x0, 1f, Math.Max(1f, fillW), h);
                        }
                    }

                    if (n <= 128 && i > 0)
                    {
                        using (Pen div = new Pen(Color.FromArgb(120, 255, 255, 255), 1f))
                        {
                            g.DrawLine(div, x0, 1f, x0, h + 1f);
                        }
                    }
                }
            }

            using (Pen border = new Pen(Color.FromArgb(180, 188, 200), 1f))
            {
                g.DrawRectangle(border, 0, 0, Width - 1, Height - 1);
            }
        }
    }

    internal sealed class IdmProgressForm : Form
    {
        private readonly TrayAgentContext agent;
        private readonly string jobId;
        private readonly System.Windows.Forms.Timer pollTimer;
        private int pollBusyFlag = 0;
        private bool completionHandled = false;

        private TabControl tabs;
        private Label lblUrlVal;
        private Label lblStatusVal;
        private Label lblTotalSizeVal;
        private Label lblDownloadedVal;
        private Label lblSpeedVal;
        private Label lblEtaVal;
        private Label lblResumeVal;
        private ProgressBar progressBar;
        private Button btnPauseResume;
        private Button btnCancelJob;
        private Button btnOpenFolder;
        private Button btnHide;

        private CheckBox chkJobLimit;
        private NumericUpDown numJobLimitKb;
        private Button btnApplyLimit;

        private CheckBox chkDoneOpenFolder;
        private CheckBox chkDoneCloseWindow;
        private CheckBox chkDoneNotify;

        private SegmentBarPanel segmentBar;
        private DoubleBufferedListView listSegments;

        private string currentStatus = "resolving";
        private string currentFilePath = "";
        private string currentSaveDir = "";

        public IdmProgressForm(TrayAgentContext ownerAgent, string id, string initialFileName, string initialUrl, int threads)
        {
            agent = ownerAgent;
            jobId = id;
            InitializeUi(initialFileName, initialUrl, threads);

            pollTimer = new System.Windows.Forms.Timer();
            pollTimer.Interval = 350;
            pollTimer.Tick += delegate { PollJobOnce(); };
            pollTimer.Start();
            PollJobOnce();
        }

        private void InitializeUi(string initialFileName, string initialUrl, int threads)
        {
            string fn = string.IsNullOrEmpty(initialFileName) ? "Đang tải..." : initialFileName;
            Text = string.Format("0,00% của {0} — HyperIDM Ultra ({1} Luồng)", fn, threads > 0 ? threads : 64);
            ClientSize = new Size(585, 470);
            MinimumSize = new Size(520, 420);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(245, 246, 248);
            Font = new Font("Segoe UI", 9f, FontStyle.Regular);
            try { Icon = agent.SharedIcon; } catch { }

            tabs = new TabControl();
            tabs.Location = new Point(10, 10);
            tabs.Size = new Size(565, 232);
            tabs.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;

            // Tab 1: Trạng thái tải xuống
            TabPage tabStatus = new TabPage("Trạng thái tải xuống");
            tabStatus.BackColor = Color.White;

            lblUrlVal = new Label();
            lblUrlVal.Location = new Point(12, 10);
            lblUrlVal.Size = new Size(535, 18);
            lblUrlVal.AutoEllipsis = true;
            lblUrlVal.ForeColor = Color.FromArgb(30, 64, 175);
            lblUrlVal.Text = initialUrl ?? "";

            int lx = 14, vx = 145, y = 35, dy = 21;
            tabStatus.Controls.Add(lblUrlVal);
            tabStatus.Controls.Add(MakeStaticLabel("Trạng thái", lx, y));
            lblStatusVal = MakeValueLabel("Đang kết nối máy chủ...", vx, y, Color.FromArgb(0, 102, 204), true);
            tabStatus.Controls.Add(lblStatusVal);
            y += dy;

            tabStatus.Controls.Add(MakeStaticLabel("Kích thước tệp", lx, y));
            lblTotalSizeVal = MakeValueLabel("Đang tính toán...", vx, y, Color.Black, false);
            tabStatus.Controls.Add(lblTotalSizeVal);
            y += dy;

            tabStatus.Controls.Add(MakeStaticLabel("Đã tải được", lx, y));
            lblDownloadedVal = MakeValueLabel("0 B (0,00%)", vx, y, Color.Black, false);
            tabStatus.Controls.Add(lblDownloadedVal);
            y += dy;

            tabStatus.Controls.Add(MakeStaticLabel("Tốc độ truyền", lx, y));
            lblSpeedVal = MakeValueLabel("0 KB/sec", vx, y, Color.FromArgb(5, 150, 105), true);
            tabStatus.Controls.Add(lblSpeedVal);
            y += dy;

            tabStatus.Controls.Add(MakeStaticLabel("Thời gian còn lại", lx, y));
            lblEtaVal = MakeValueLabel("Đang ước tính...", vx, y, Color.Black, false);
            tabStatus.Controls.Add(lblEtaVal);
            y += dy;

            tabStatus.Controls.Add(MakeStaticLabel("Khả năng tải tiếp", lx, y));
            lblResumeVal = MakeValueLabel("Có", vx, y, Color.Black, false);
            tabStatus.Controls.Add(lblResumeVal);

            progressBar = new ProgressBar();
            progressBar.Location = new Point(14, 165);
            progressBar.Size = new Size(340, 22);
            progressBar.Maximum = 1000;
            progressBar.Style = ProgressBarStyle.Continuous;
            tabStatus.Controls.Add(progressBar);

            btnPauseResume = MakeActionBtn("Tạm dừng", 364, 163, 90);
            btnPauseResume.Click += delegate { TogglePauseResume(); };

            btnCancelJob = MakeActionBtn("Hủy bỏ", 460, 163, 86);
            btnCancelJob.Click += delegate { CancelOrClose(); };

            btnOpenFolder = MakeActionBtn("Mở thư mục", 364, 132, 90);
            btnOpenFolder.Click += delegate { TrayAgentContext.OpenFolderSelectFile(currentFilePath, currentSaveDir); };

            btnHide = MakeActionBtn("Ẩn", 460, 132, 86);
            btnHide.Click += delegate { Close(); };

            tabStatus.Controls.Add(btnPauseResume);
            tabStatus.Controls.Add(btnCancelJob);
            tabStatus.Controls.Add(btnOpenFolder);
            tabStatus.Controls.Add(btnHide);

            // Tab 2: Giới hạn tốc độ
            TabPage tabLimit = new TabPage("Giới hạn tốc độ");
            tabLimit.BackColor = Color.White;

            chkJobLimit = new CheckBox();
            chkJobLimit.Text = "Sử dụng giới hạn tốc độ tải xuống cho tác vụ này";
            chkJobLimit.Location = new Point(18, 22);
            chkJobLimit.AutoSize = true;

            Label lblLimitUnit = new Label();
            lblLimitUnit.Text = "Tốc độ tối đa (KB/s):";
            lblLimitUnit.Location = new Point(18, 58);
            lblLimitUnit.AutoSize = true;

            numJobLimitKb = new NumericUpDown();
            numJobLimitKb.Location = new Point(155, 55);
            numJobLimitKb.Size = new Size(120, 24);
            numJobLimitKb.Minimum = 64;
            numJobLimitKb.Maximum = 1024000;
            numJobLimitKb.Value = 5120;

            btnApplyLimit = MakeActionBtn("Áp dụng", 290, 53, 95);
            btnApplyLimit.Click += delegate { ApplyJobLimit(); };

            tabLimit.Controls.Add(chkJobLimit);
            tabLimit.Controls.Add(lblLimitUnit);
            tabLimit.Controls.Add(numJobLimitKb);
            tabLimit.Controls.Add(btnApplyLimit);

            // Tab 3: Tùy chọn khi hoàn tất
            TabPage tabDone = new TabPage("Tùy chọn khi hoàn tất");
            tabDone.BackColor = Color.White;

            chkDoneOpenFolder = new CheckBox { Text = "Tự động mở thư mục chứa tệp khi tải xong", Location = new Point(18, 22), AutoSize = true };
            chkDoneCloseWindow = new CheckBox { Text = "Đóng cửa sổ tiến trình khi hoàn tất", Location = new Point(18, 52), AutoSize = true };
            chkDoneNotify = new CheckBox { Text = "Hiển thị thông báo hệ thống khi tải xong", Location = new Point(18, 82), AutoSize = true, Checked = true };

            tabDone.Controls.Add(chkDoneOpenFolder);
            tabDone.Controls.Add(chkDoneCloseWindow);
            tabDone.Controls.Add(chkDoneNotify);

            tabs.TabPages.Add(tabStatus);
            tabs.TabPages.Add(tabLimit);
            tabs.TabPages.Add(tabDone);

            // 64-segment visual bar
            segmentBar = new SegmentBarPanel();
            segmentBar.Location = new Point(10, 250);
            segmentBar.Size = new Size(565, 22);
            segmentBar.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;

            // Segments ListView
            listSegments = new DoubleBufferedListView();
            listSegments.Location = new Point(10, 279);
            listSegments.Size = new Size(565, 181);
            listSegments.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
            listSegments.View = View.Details;
            listSegments.FullRowSelect = true;
            listSegments.GridLines = true;
            listSegments.BackColor = Color.White;
            listSegments.Font = new Font("Segoe UI", 8.5f, FontStyle.Regular);

            listSegments.Columns.Add("Vị trí #", 68, HorizontalAlignment.Center);
            listSegments.Columns.Add("Đã tải", 165, HorizontalAlignment.Right);
            listSegments.Columns.Add("Trạng thái chi tiết", 308, HorizontalAlignment.Left);

            Controls.Add(tabs);
            Controls.Add(segmentBar);
            Controls.Add(listSegments);
        }

        private static Label MakeStaticLabel(string text, int x, int y)
        {
            return new Label
            {
                Text = text,
                Location = new Point(x, y),
                Size = new Size(125, 18),
                ForeColor = Color.FromArgb(71, 85, 105)
            };
        }

        private static Label MakeValueLabel(string text, int x, int y, Color color, bool bold)
        {
            return new Label
            {
                Text = text,
                Location = new Point(x, y),
                Size = new Size(215, 18),
                ForeColor = color,
                Font = new Font("Segoe UI", 9f, bold ? FontStyle.Bold : FontStyle.Regular)
            };
        }

        private static Button MakeActionBtn(string text, int x, int y, int w)
        {
            return new Button
            {
                Text = text,
                Location = new Point(x, y),
                Size = new Size(w, 26),
                UseVisualStyleBackColor = true
            };
        }

        private void PollJobOnce()
        {
            if (IsDisposed || agent.IsExiting) return;
            if (Interlocked.CompareExchange(ref pollBusyFlag, 1, 0) != 0) return;

            ThreadPool.QueueUserWorkItem(delegate
            {
                JobSnapshot found = null;
                try
                {
                    JobsSnapshotResponse snap = TrayAgentContext.FetchJobsSnapshot(1500);
                    for (int i = 0; i < snap.Jobs.Count; i++)
                    {
                        if (snap.Jobs[i].Id == jobId)
                        {
                            found = snap.Jobs[i];
                            break;
                        }
                    }
                }
                catch { }
                finally
                {
                    Interlocked.Exchange(ref pollBusyFlag, 0);
                }

                if (found != null && !IsDisposed && IsHandleCreated)
                {
                    try
                    {
                        BeginInvoke(new MethodInvoker(delegate
                        {
                            if (!IsDisposed) UpdateUi(found);
                        }));
                    }
                    catch { }
                }
            });
        }

        private void UpdateUi(JobSnapshot job)
        {
            currentStatus = (job.Status ?? "").ToLowerInvariant();
            currentFilePath = job.FilePath ?? "";
            currentSaveDir = job.SaveDir ?? "";

            string pctStr = IdmFormat.FormatPercent(job.Progress);
            if (currentStatus == "completed")
            {
                Text = string.Format("Hoàn thành 100% — {0}", job.FileName);
            }
            else
            {
                Text = string.Format("{0} của {1} — HyperIDM Ultra ({2} Luồng)", pctStr, job.FileName, job.MaxConnections);
            }

            lblUrlVal.Text = job.Url ?? "";

            if (currentStatus == "downloading")
            {
                lblStatusVal.Text = "Đang nhận dữ liệu...";
                lblStatusVal.ForeColor = Color.FromArgb(0, 102, 204);
            }
            else if (currentStatus == "completed")
            {
                lblStatusVal.Text = "Hoàn thành tải xuống!";
                lblStatusVal.ForeColor = Color.FromArgb(5, 150, 105);
            }
            else
            {
                lblStatusVal.Text = IdmFormat.TranslateStatus(job.Status, job.Progress, job.Error);
                lblStatusVal.ForeColor = currentStatus == "error" ? Color.FromArgb(220, 38, 38) : Color.FromArgb(217, 119, 6);
            }

            lblTotalSizeVal.Text = job.TotalBytes > 0 ? IdmFormat.FormatBytes(job.TotalBytes) : "Chưa rõ";
            lblDownloadedVal.Text = string.Format("{0} ({1})", IdmFormat.FormatBytes(job.DownloadedBytes), pctStr);
            lblSpeedVal.Text = IdmFormat.IsActiveStatus(currentStatus)
                ? (job.CurrentSpeedBps > 0 ? IdmFormat.FormatSpeed(job.CurrentSpeedBps, true) : "0 KB/sec")
                : "0 KB/sec";
            lblEtaVal.Text = IdmFormat.FormatEta(job.EtaSeconds, job.HasEta, currentStatus);
            lblResumeVal.Text = job.AcceptRanges ? "Có" : "Không";

            int barVal = (int)Math.Min(1000, Math.Max(0, Math.Round(job.Progress * 10)));
            if (progressBar.Value != barVal) progressBar.Value = barVal;

            if (currentStatus == "completed")
            {
                btnPauseResume.Text = "Mở tệp";
                btnCancelJob.Text = "Đóng";
            }
            else if (currentStatus == "paused" || currentStatus == "error" || currentStatus == "queued")
            {
                btnPauseResume.Text = "Tải tiếp";
                btnCancelJob.Text = "Hủy bỏ";
            }
            else
            {
                btnPauseResume.Text = "Tạm dừng";
                btnCancelJob.Text = "Hủy bỏ";
            }

            segmentBar.UpdateSegments(job.Segments, job.TotalBytes);
            UpdateSegmentList(job.Segments);

            if (currentStatus == "completed" && !completionHandled)
            {
                completionHandled = true;
                pollTimer.Stop();
                if (chkDoneNotify.Checked)
                {
                    agent.ShowBalloon("HyperIDM Ultra — Tải hoàn tất", job.FileName, ToolTipIcon.Info);
                }
                if (chkDoneOpenFolder.Checked)
                {
                    TrayAgentContext.OpenFolderSelectFile(currentFilePath, currentSaveDir);
                }
                if (chkDoneCloseWindow.Checked)
                {
                    Close();
                }
            }
        }

        private void UpdateSegmentList(List<SegmentSnapshot> segs)
        {
            if (segs == null) return;
            listSegments.BeginUpdate();
            try
            {
                while (listSegments.Items.Count > segs.Count)
                {
                    listSegments.Items.RemoveAt(listSegments.Items.Count - 1);
                }
                while (listSegments.Items.Count < segs.Count)
                {
                    ListViewItem lvi = new ListViewItem("");
                    lvi.SubItems.Add("");
                    lvi.SubItems.Add("");
                    listSegments.Items.Add(lvi);
                }

                for (int i = 0; i < segs.Count; i++)
                {
                    SegmentSnapshot s = segs[i];
                    ListViewItem item = listSegments.Items[i];

                    string col0 = (s.Id + 1).ToString();
                    long doneBytes = Math.Max(0, s.Current - s.Start);
                    long totalSegBytes = s.End >= s.Start ? (s.End - s.Start + 1) : 0;
                    string col1 = totalSegBytes > 0
                        ? (IdmFormat.FormatBytes(doneBytes) + " / " + IdmFormat.FormatBytes(totalSegBytes))
                        : IdmFormat.FormatBytes(doneBytes);

                    string col2;
                    if (s.Status == "completed")
                    {
                        col2 = "Hoàn thành";
                    }
                    else if (s.Status == "downloading")
                    {
                        string sp = s.SpeedBps > 0 ? (" (" + IdmFormat.FormatSpeed(s.SpeedBps, false) + ")") : "";
                        string ip = !string.IsNullOrEmpty(s.Ip) ? (" • " + s.Ip) : "";
                        col2 = "Đang nhận dữ liệu..." + sp + ip;
                    }
                    else
                    {
                        col2 = currentStatus == "paused" ? "Đã tạm dừng" : "Đang chờ kết nối...";
                    }

                    if (item.SubItems[0].Text != col0) item.SubItems[0].Text = col0;
                    if (item.SubItems[1].Text != col1) item.SubItems[1].Text = col1;
                    if (item.SubItems[2].Text != col2) item.SubItems[2].Text = col2;
                }
            }
            finally
            {
                listSegments.EndUpdate();
            }
        }

        private void TogglePauseResume()
        {
            if (currentStatus == "completed")
            {
                if (!string.IsNullOrEmpty(currentFilePath) && File.Exists(currentFilePath))
                {
                    try { Process.Start(new ProcessStartInfo { FileName = currentFilePath, UseShellExecute = true }); } catch { }
                }
                else
                {
                    TrayAgentContext.OpenFolderSelectFile(currentFilePath, currentSaveDir);
                }
                return;
            }

            string action = (currentStatus == "paused" || currentStatus == "error" || currentStatus == "queued") ? "resume" : "pause";
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    TrayAgentContext.HttpRequest("POST", Program.AppUrl + "/api/jobs/" + Uri.EscapeDataString(jobId) + "/" + action, "{}", 3000);
                }
                catch { }
                PollJobOnce();
                agent.RefreshMainFormNow();
            });
        }

        private void CancelOrClose()
        {
            if (currentStatus == "completed")
            {
                Close();
                return;
            }
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    TrayAgentContext.HttpRequest("POST", Program.AppUrl + "/api/jobs/" + Uri.EscapeDataString(jobId) + "/pause", "{}", 2500);
                }
                catch { }
            });
            Close();
        }

        private void ApplyJobLimit()
        {
            long bps = chkJobLimit.Checked ? ((long)numJobLimitKb.Value * 1024L) : 0L;
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    JavaScriptSerializer js = new JavaScriptSerializer();
                    Dictionary<string, object> p = new Dictionary<string, object>();
                    p["jobId"] = jobId;
                    p["bps"] = bps;
                    TrayAgentContext.HttpRequest("POST", Program.AppUrl + "/api/limit", js.Serialize(p), 2500);
                }
                catch { }
            });
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                try { if (pollTimer != null) { pollTimer.Stop(); pollTimer.Dispose(); } } catch { }
            }
            base.Dispose(disposing);
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
            Text = "Thông tin tệp tải xuống — HyperIDM Ultra 64-Bit";
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = true;
            TopMost = true;
            ShowInTaskbar = true;
            AutoScaleMode = AutoScaleMode.Font;
            ClientSize = new Size(640, 345);
            BackColor = Color.White;
            ForeColor = Color.FromArgb(15, 23, 42);
            Font = new Font("Segoe UI", 9.25f, FontStyle.Regular);
            try { Icon = agent.SharedIcon; } catch { }

            Panel header = new Panel();
            header.Dock = DockStyle.Top;
            header.Height = 52;
            header.BackColor = Color.FromArgb(245, 248, 252);
            header.Paint += delegate(object s, PaintEventArgs pe)
            {
                using (Pen p = new Pen(Color.FromArgb(226, 232, 240), 1))
                {
                    pe.Graphics.DrawLine(p, 0, header.Height - 1, header.Width, header.Height - 1);
                }
            };

            Label lblTitle = new Label();
            lblTitle.Text = "Thông tin tệp tải xuống — HyperIDM Ultra 64-Bit";
            lblTitle.Font = new Font("Segoe UI", 11f, FontStyle.Bold);
            lblTitle.ForeColor = Color.FromArgb(0, 120, 215);
            lblTitle.AutoSize = true;
            lblTitle.Location = new Point(18, 8);

            Label lblSub = new Label();
            lblSub.Text = string.IsNullOrEmpty(sourceLabel) ? "TitanFetch 64/128-Luồng Engine" : ("Nguồn: " + sourceLabel + " • TitanFetch Multi-Segment Engine");
            lblSub.Font = new Font("Segoe UI", 8.25f, FontStyle.Regular);
            lblSub.ForeColor = Color.FromArgb(100, 116, 139);
            lblSub.AutoSize = true;
            lblSub.Location = new Point(19, 30);

            header.Controls.Add(lblTitle);
            header.Controls.Add(lblSub);
            Controls.Add(header);

            int labelX = 20;
            int inputX = 148;
            int inputW = 470;
            int y = 70;

            Label lUrl = MakeLabel("URL tải xuống:", labelX, y + 4);
            txtUrl = MakeTextBox(inputX, y, inputW);
            txtUrl.TextChanged += delegate
            {
                if (!programmaticUpdate) RefreshMetadataFromUrl();
            };
            Controls.Add(lUrl);
            Controls.Add(txtUrl);

            y += 40;

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
            lCatTitle.ForeColor = Color.FromArgb(100, 116, 139);

            lblCategoryBadge = new Label();
            lblCategoryBadge.Location = new Point(512, y + 1);
            lblCategoryBadge.Size = new Size(106, 24);
            lblCategoryBadge.TextAlign = ContentAlignment.MiddleCenter;
            lblCategoryBadge.Font = new Font("Segoe UI", 8.5f, FontStyle.Bold);
            lblCategoryBadge.BackColor = Color.FromArgb(30, 64, 175);
            lblCategoryBadge.ForeColor = Color.White;
            lblCategoryBadge.Text = "Tệp tin khác";

            Controls.Add(lFile);
            Controls.Add(txtFileName);
            Controls.Add(lCatTitle);
            Controls.Add(lblCategoryBadge);

            y += 40;

            Label lDir = MakeLabel("Lưu tại thư mục:", labelX, y + 4);
            txtSaveDir = MakeTextBox(inputX, y, 378);
            txtSaveDir.TextChanged += delegate
            {
                if (!programmaticUpdate) userEditedSaveDir = true;
            };

            Button btnBrowse = new Button();
            btnBrowse.Text = "Chọn...";
            btnBrowse.Location = new Point(534, y - 1);
            btnBrowse.Size = new Size(84, 26);
            btnBrowse.UseVisualStyleBackColor = true;
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

            y += 40;

            Label lThreads = MakeLabel("Số luồng tải:", labelX, y + 4);
            cmbThreads = new ComboBox();
            cmbThreads.Location = new Point(inputX, y);
            cmbThreads.Size = new Size(245, 25);
            cmbThreads.DropDownStyle = ComboBoxStyle.DropDownList;
            cmbThreads.Items.Add("64 Luồng (Hyper-Turbo)");
            cmbThreads.Items.Add("128 Luồng (Max Speed)");
            cmbThreads.SelectedIndex = agent.DefaultThreads == 128 ? 1 : 0;

            Label lHint = new Label();
            lHint.Text = "Tự động kiểm tra SHA-1 / SHA-256 & nối mảnh 0-copy";
            lHint.ForeColor = Color.FromArgb(100, 116, 139);
            lHint.Font = new Font("Segoe UI", 8.25f, FontStyle.Italic);
            lHint.AutoSize = true;
            lHint.Location = new Point(402, y + 5);

            Controls.Add(lThreads);
            Controls.Add(cmbThreads);
            Controls.Add(lHint);

            y += 38;

            lblStatus = new Label();
            lblStatus.Location = new Point(labelX, y);
            lblStatus.Size = new Size(598, 22);
            lblStatus.ForeColor = Color.FromArgb(217, 119, 6);
            lblStatus.Font = new Font("Segoe UI", 8.75f, FontStyle.Regular);
            lblStatus.Text = "";
            Controls.Add(lblStatus);

            Panel footer = new Panel();
            footer.Dock = DockStyle.Bottom;
            footer.Height = 64;
            footer.BackColor = Color.FromArgb(245, 248, 252);
            footer.Paint += delegate(object s, PaintEventArgs pe)
            {
                using (Pen p = new Pen(Color.FromArgb(226, 232, 240), 1))
                {
                    pe.Graphics.DrawLine(p, 0, 0, footer.Width, 0);
                }
            };

            btnStart = new Button();
            btnStart.Text = "⚡ Bắt đầu tải ngay";
            btnStart.Location = new Point(20, 14);
            btnStart.Size = new Size(210, 36);
            btnStart.Font = new Font("Segoe UI", 9.75f, FontStyle.Bold);
            btnStart.FlatStyle = FlatStyle.Flat;
            btnStart.FlatAppearance.BorderSize = 0;
            btnStart.BackColor = Color.FromArgb(0, 120, 215);
            btnStart.ForeColor = Color.White;
            btnStart.Cursor = Cursors.Hand;
            btnStart.Click += delegate { SubmitJob(false); };

            btnLater = new Button();
            btnLater.Text = "🕒 Tải sau (Danh sách chờ)";
            btnLater.Location = new Point(242, 14);
            btnLater.Size = new Size(258, 36);
            btnLater.Font = new Font("Segoe UI", 9.25f, FontStyle.Regular);
            btnLater.UseVisualStyleBackColor = true;
            btnLater.Cursor = Cursors.Hand;
            btnLater.Click += delegate { SubmitJob(true); };

            btnCancel = new Button();
            btnCancel.Text = "Hủy bỏ";
            btnCancel.Location = new Point(512, 14);
            btnCancel.Size = new Size(106, 36);
            btnCancel.UseVisualStyleBackColor = true;
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
            lbl.ForeColor = Color.FromArgb(51, 65, 85);
            return lbl;
        }

        private static TextBox MakeTextBox(int x, int y, int w)
        {
            TextBox tb = new TextBox();
            tb.Location = new Point(x, y);
            tb.Size = new Size(w, 24);
            tb.BorderStyle = BorderStyle.FixedSingle;
            tb.BackColor = Color.White;
            tb.ForeColor = Color.FromArgb(15, 23, 42);
            return tb;
        }

        private void RefreshMetadataFromUrl()
        {
            string url = (txtUrl.Text ?? "").Trim();
            if (!userEditedFileName)
            {
                programmaticUpdate = true;
                txtFileName.Text = IdmFormat.GuessFileName(url);
                programmaticUpdate = false;
            }
            UpdateCategoryAndDir(url, txtFileName.Text);
        }

        private void UpdateCategoryAndDir(string url, string fileName)
        {
            CategoryInfo cat = IdmFormat.DetectCategory(url, fileName);
            lblCategoryBadge.Text = cat.DisplayName;
            lblCategoryBadge.BackColor = cat.BadgeColor;

            if (!userEditedSaveDir)
            {
                programmaticUpdate = true;
                txtSaveDir.Text = Path.Combine(TrayAgentContext.GetBaseDownloadDir(), cat.FolderName);
                programmaticUpdate = false;
            }
        }

        private void SubmitJob(bool queueForLater)
        {
            string url = (txtUrl.Text ?? "").Trim();
            if (!url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) &&
                !url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            {
                lblStatus.ForeColor = Color.FromArgb(220, 38, 38);
                lblStatus.Text = "Vui lòng nhập URL hợp lệ (bắt đầu bằng http:// hoặc https://).";
                txtUrl.Focus();
                return;
            }

            string fileName = IdmFormat.SanitizeFileName((txtFileName.Text ?? "").Trim());
            string saveDir = (txtSaveDir.Text ?? "").Trim();
            if (string.IsNullOrEmpty(saveDir)) saveDir = TrayAgentContext.GetBaseDownloadDir();

            int threads = cmbThreads.SelectedIndex == 1 ? 128 : 64;

            SetBusy(true, queueForLater ? "Đang thêm vào danh sách chờ..." : "Đang khởi tạo 64/128 luồng tải siêu tốc...");

            ThreadPool.QueueUserWorkItem(delegate
            {
                string errorMsg = null;
                string createdJobId = null;
                string createdFileName = fileName;
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

                    if (!string.IsNullOrEmpty(respJson))
                    {
                        Dictionary<string, object> respDict = js.DeserializeObject(respJson) as Dictionary<string, object>;
                        createdJobId = TrayAgentContext.GetDictString(respDict, "id");
                        string fn = TrayAgentContext.GetDictString(respDict, "fileName");
                        if (!string.IsNullOrEmpty(fn)) createdFileName = fn;

                        if (queueForLater && !string.IsNullOrEmpty(createdJobId))
                        {
                            string status = TrayAgentContext.GetDictString(respDict, "status") ?? "";
                            if (!string.Equals(status, "paused", StringComparison.OrdinalIgnoreCase))
                            {
                                try
                                {
                                    TrayAgentContext.HttpRequest(
                                        "POST",
                                        Program.AppUrl + "/api/jobs/" + Uri.EscapeDataString(createdJobId) + "/pause",
                                        "{}",
                                        3000);
                                }
                                catch { }
                            }
                        }
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
                            lblStatus.ForeColor = Color.FromArgb(220, 38, 38);
                            return;
                        }

                        agent.RefreshMainFormNow();
                        if (!queueForLater && !string.IsNullOrEmpty(createdJobId) && agent.AutoShowProgress)
                        {
                            agent.OpenProgressForm(createdJobId, createdFileName, url, threads);
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
            lblStatus.ForeColor = Color.FromArgb(217, 119, 6);
            lblStatus.Text = message ?? "";
        }
    }

    internal sealed class OptionsForm : Form
    {
        private readonly TrayAgentContext agent;
        private ComboBox cmbThreads;
        private CheckBox chkClipboard;
        private CheckBox chkBrowser;
        private CheckBox chkAutoProgress;
        private NumericUpDown numGlobalLimit;

        public OptionsForm(TrayAgentContext ownerAgent)
        {
            agent = ownerAgent;
            Text = "Tùy chọn — HyperIDM Ultra 64-Bit";
            ClientSize = new Size(460, 275);
            StartPosition = FormStartPosition.CenterParent;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            BackColor = Color.White;
            Font = new Font("Segoe UI", 9f, FontStyle.Regular);
            try { Icon = agent.SharedIcon; } catch { }

            Label l1 = new Label { Text = "Số luồng tải mặc định:", Location = new Point(20, 22), AutoSize = true };
            cmbThreads = new ComboBox { Location = new Point(190, 18), Size = new Size(240, 24), DropDownStyle = ComboBoxStyle.DropDownList };
            cmbThreads.Items.Add("64 Luồng (Hyper-Turbo)");
            cmbThreads.Items.Add("128 Luồng (Max Speed)");
            cmbThreads.SelectedIndex = agent.DefaultThreads == 128 ? 1 : 0;

            chkClipboard = new CheckBox
            {
                Text = "Tự động bắt link khi Copy (Clipboard)",
                Location = new Point(20, 60),
                AutoSize = true,
                Checked = agent.ClipboardEnabled
            };

            chkBrowser = new CheckBox
            {
                Text = "Tự động bắt link từ Trình duyệt (Chrome / Edge / Extension)",
                Location = new Point(20, 90),
                AutoSize = true,
                Checked = agent.BrowserInterceptEnabled
            };

            chkAutoProgress = new CheckBox
            {
                Text = "Tự động mở hộp thoại Tiến trình tải (IdmProgressForm)",
                Location = new Point(20, 120),
                AutoSize = true,
                Checked = agent.AutoShowProgress
            };

            Label lLimit = new Label { Text = "Giới hạn tốc độ toàn cục (KB/s, 0 = Không giới hạn):", Location = new Point(20, 158), AutoSize = true };
            numGlobalLimit = new NumericUpDown
            {
                Location = new Point(320, 155),
                Size = new Size(110, 24),
                Minimum = 0,
                Maximum = 1048576,
                Value = 0
            };

            Button btnOk = new Button { Text = "Lưu cấu hình", Location = new Point(242, 220), Size = new Size(100, 30), BackColor = Color.FromArgb(0, 120, 215), ForeColor = Color.White, FlatStyle = FlatStyle.Flat };
            btnOk.FlatAppearance.BorderSize = 0;
            btnOk.Click += delegate
            {
                agent.DefaultThreads = cmbThreads.SelectedIndex == 1 ? 128 : 64;
                agent.SetClipboardEnabled(chkClipboard.Checked);
                agent.SetBrowserInterceptEnabled(chkBrowser.Checked);
                agent.AutoShowProgress = chkAutoProgress.Checked;

                long bps = (long)numGlobalLimit.Value * 1024L;
                ThreadPool.QueueUserWorkItem(delegate
                {
                    try
                    {
                        JavaScriptSerializer js = new JavaScriptSerializer();
                        Dictionary<string, object> p = new Dictionary<string, object>();
                        p["bps"] = bps;
                        TrayAgentContext.HttpRequest("POST", Program.AppUrl + "/api/limit", js.Serialize(p), 2500);
                    }
                    catch { }
                });
                DialogResult = DialogResult.OK;
                Close();
            };

            Button btnCancel = new Button { Text = "Hủy", Location = new Point(352, 220), Size = new Size(80, 30), UseVisualStyleBackColor = true };
            btnCancel.Click += delegate { Close(); };

            Controls.AddRange(new Control[] { l1, cmbThreads, chkClipboard, chkBrowser, chkAutoProgress, lLimit, numGlobalLimit, btnOk, btnCancel });
            AcceptButton = btnOk;
            CancelButton = btnCancel;
        }
    }

    internal sealed class BatchSchedulerForm : Form
    {
        private readonly TrayAgentContext agent;
        private TextBox txtUrls;
        private ComboBox cmbThreads;

        public BatchSchedulerForm(TrayAgentContext ownerAgent)
        {
            agent = ownerAgent;
            Text = "Lập lịch & Tải hàng loạt — HyperIDM Ultra";
            ClientSize = new Size(560, 360);
            StartPosition = FormStartPosition.CenterParent;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            BackColor = Color.White;
            Font = new Font("Segoe UI", 9f, FontStyle.Regular);
            try { Icon = agent.SharedIcon; } catch { }

            Label lblHint = new Label
            {
                Text = "Nhập danh sách URL (mỗi dòng 1 link) hoặc mẫu hàng loạt (vd: https://host/file_[01-10].zip):",
                Location = new Point(16, 14),
                AutoSize = true
            };

            txtUrls = new TextBox
            {
                Location = new Point(16, 38),
                Size = new Size(528, 190),
                Multiline = true,
                ScrollBars = ScrollBars.Vertical,
                BorderStyle = BorderStyle.FixedSingle
            };

            Label lThreads = new Label { Text = "Số luồng mỗi tệp:", Location = new Point(16, 242), AutoSize = true };
            cmbThreads = new ComboBox { Location = new Point(135, 238), Size = new Size(190, 24), DropDownStyle = ComboBoxStyle.DropDownList };
            cmbThreads.Items.Add("64 Luồng (Hyper-Turbo)");
            cmbThreads.Items.Add("128 Luồng (Max Speed)");
            cmbThreads.SelectedIndex = agent.DefaultThreads == 128 ? 1 : 0;

            Button btnTestIpsw = new Button { Text = "+ Chèn Test IPSW.me", Location = new Point(16, 275), Size = new Size(160, 26), UseVisualStyleBackColor = true };
            btnTestIpsw.Click += delegate { AppendLine("https://ipsw.me/download/Mac15,12/23F79/"); };

            Button btnTestYt = new Button { Text = "+ Chèn Test YouTube", Location = new Point(184, 275), Size = new Size(160, 26), UseVisualStyleBackColor = true };
            btnTestYt.Click += delegate { AppendLine("https://www.youtube.com/watch?v=KxMqSz8qVSg"); };

            Button btnTestNode = new Button { Text = "+ Chèn Node.js ZIP", Location = new Point(352, 275), Size = new Size(160, 26), UseVisualStyleBackColor = true };
            btnTestNode.Click += delegate { AppendLine("https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip"); };

            Button btnGo = new Button
            {
                Text = "⚡ Thêm & Bắt đầu tải hàng loạt",
                Location = new Point(210, 315),
                Size = new Size(235, 32),
                BackColor = Color.FromArgb(0, 120, 215),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 9.25f, FontStyle.Bold)
            };
            btnGo.FlatAppearance.BorderSize = 0;
            btnGo.Click += delegate { SubmitBatch(); };

            Button btnClose = new Button { Text = "Đóng", Location = new Point(456, 315), Size = new Size(88, 32), UseVisualStyleBackColor = true };
            btnClose.Click += delegate { Close(); };

            Controls.AddRange(new Control[] { lblHint, txtUrls, lThreads, cmbThreads, btnTestIpsw, btnTestYt, btnTestNode, btnGo, btnClose });
        }

        private void AppendLine(string url)
        {
            if (string.IsNullOrEmpty(txtUrls.Text)) txtUrls.Text = url;
            else txtUrls.AppendText(Environment.NewLine + url);
        }

        private void SubmitBatch()
        {
            string raw = (txtUrls.Text ?? "").Trim();
            if (string.IsNullOrEmpty(raw)) return;
            int threads = cmbThreads.SelectedIndex == 1 ? 128 : 64;

            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    agent.EnsureServerRunningSync(4000);
                    JavaScriptSerializer js = new JavaScriptSerializer();
                    Dictionary<string, object> p = new Dictionary<string, object>();
                    p["text"] = raw;
                    p["maxConnections"] = threads;
                    TrayAgentContext.HttpRequest("POST", Program.AppUrl + "/api/batch", js.Serialize(p), 5000);
                }
                catch { }
                try
                {
                    BeginInvoke(new MethodInvoker(delegate
                    {
                        agent.RefreshMainFormNow();
                        Close();
                    }));
                }
                catch { }
            });
        }
    }
}
