using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

namespace HyperIDM
{
    internal static class Program
    {
        private const int Port = 17890;
        private static readonly string AppUrl = "http://127.0.0.1:17890";

        [STAThread]
        private static void Main(string[] args)
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string serverJs = Path.Combine(baseDir, "server.js");

            if (!IsServerRunning())
            {
                StartEngineDaemon(baseDir, serverJs);
                for (int i = 0; i < 30; i++)
                {
                    if (IsServerRunning()) break;
                    Thread.Sleep(150);
                }
            }

            if (args != null && args.Length > 0 && args[0].StartsWith("http", StringComparison.OrdinalIgnoreCase))
            {
                EnqueueUrl(args[0]);
            }

            OpenDesktopWindow();
        }

        private static bool IsServerRunning()
        {
            try
            {
                using (TcpClient client = new TcpClient())
                {
                    var result = client.BeginConnect("127.0.0.1", Port, null, null);
                    bool success = result.AsyncWaitHandle.WaitOne(TimeSpan.FromMilliseconds(200));
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

        private static void StartEngineDaemon(string workingDir, string serverJs)
        {
            string nodePath = @"C:\Program Files\nodejs\node.exe";
            if (!File.Exists(nodePath)) nodePath = "node.exe";

            ProcessStartInfo psi = new ProcessStartInfo
            {
                FileName = nodePath,
                Arguments = "\"" + serverJs + "\"",
                WorkingDirectory = workingDir,
                CreateNoWindow = true,
                UseShellExecute = false,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            Process.Start(psi);
        }

        private static void EnqueueUrl(string url)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(AppUrl + "/api/jobs");
                req.Method = "POST";
                req.ContentType = "application/json; charset=utf-8";
                string json = "{\"url\":\"" + url.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\",\"maxConnections\":64}";
                byte[] bytes = Encoding.UTF8.GetBytes(json);
                req.ContentLength = bytes.Length;
                using (Stream s = req.GetRequestStream())
                {
                    s.Write(bytes, 0, bytes.Length);
                }
                using (WebResponse resp = req.GetResponse()) { }
            }
            catch { }
        }

        private static void OpenDesktopWindow()
        {
            string chromePath = @"C:\Program Files\Google\Chrome\Application\chrome.exe";
            if (File.Exists(chromePath))
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = chromePath,
                    Arguments = "--app=" + AppUrl + " --window-size=1380,860",
                    UseShellExecute = true
                });
                return;
            }

            Process.Start(new ProcessStartInfo
            {
                FileName = AppUrl,
                UseShellExecute = true
            });
        }
    }
}
