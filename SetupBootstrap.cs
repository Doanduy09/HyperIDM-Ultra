using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;

[assembly: AssemblyTitle("Duytai 64-Bit Universal Setup")]
[assembly: AssemblyDescription("Duytai 64-Bit Official Installer & Browser Integration")]
[assembly: AssemblyCompany("DOANDUY Software")]
[assembly: AssemblyProduct("Duytai 64-Bit")]
[assembly: AssemblyCopyright("Copyright © 2026 DOANDUY. All rights reserved.")]
[assembly: AssemblyVersion("7.5.0.0")]
[assembly: AssemblyFileVersion("7.5.0.0")]
[assembly: AssemblyInformationalVersion("7.5.0")]
[assembly: ComVisible(false)]

namespace HyperIDMSetup
{
    internal static class SetupProgram
    {
        [STAThread]
        private static void Main()
        {
            string installDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                @"Programs\Duytai"
            );
            Directory.CreateDirectory(installDir);

            // 0. Stop running Duytai.exe before extracting so binaries are never locked
            try
            {
                Process[] running = Process.GetProcessesByName("Duytai");
                for (int i = 0; i < running.Length; i++)
                {
                    try
                    {
                        if (running[i].Id != Process.GetCurrentProcess().Id)
                        {
                            running[i].Kill();
                            running[i].WaitForExit(2000);
                        }
                    }
                    catch { }
                    finally { try { running[i].Dispose(); } catch { } }
                }
            }
            catch { }

            // 1. Extract embedded payload.zip resource into %LOCALAPPDATA%\Programs\Duytai with Zip-Slip protection
            try
            {
                string canonicalRoot = Path.GetFullPath(installDir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar);
                Assembly asm = Assembly.GetExecutingAssembly();
                using (Stream resStream = asm.GetManifestResourceStream("payload.zip"))
                {
                    if (resStream != null)
                    {
                        using (ZipArchive archive = new ZipArchive(resStream, ZipArchiveMode.Read))
                        {
                            foreach (ZipArchiveEntry entry in archive.Entries)
                            {
                                string combined = Path.Combine(installDir, entry.FullName.Replace('/', '\\'));
                                string fullPath = Path.GetFullPath(combined);
                                if (!fullPath.StartsWith(canonicalRoot, StringComparison.OrdinalIgnoreCase))
                                {
                                    continue;
                                }
                                string dirName = Path.GetDirectoryName(fullPath);
                                if (!string.IsNullOrEmpty(dirName))
                                {
                                    Directory.CreateDirectory(dirName);
                                }
                                if (!string.IsNullOrEmpty(entry.Name))
                                {
                                    using (Stream entryStream = entry.Open())
                                    using (FileStream fs = new FileStream(fullPath, FileMode.Create, FileAccess.Write))
                                    {
                                        entryStream.CopyTo(fs);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("Không thể giải nén gói cài đặt Duytai: " + ex.Message, "Duytai Setup", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }

            // 2. Run Install-HyperIDM.ps1 (from baseDir if present, otherwise from extracted installDir)
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string ps1 = Path.Combine(baseDir, "Install-HyperIDM.ps1");
            if (!File.Exists(ps1))
            {
                ps1 = Path.Combine(installDir, "Install-HyperIDM.ps1");
            }

            if (File.Exists(ps1))
            {
                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = "powershell.exe",
                    Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + ps1 + "\"",
                    WorkingDirectory = Path.GetDirectoryName(ps1),
                    UseShellExecute = false
                };
                using (Process p = Process.Start(psi))
                {
                    if (p != null)
                    {
                        p.WaitForExit();
                        if (p.ExitCode != 0)
                        {
                            MessageBox.Show("Trình cài đặt trả về mã trạng thái: " + p.ExitCode, "Duytai Setup", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                        }
                    }
                }
            }

            // 3. Launch installed Duytai.exe via Windows Explorer Shell so GUI and System Tray always appear in interactive desktop
            string installedExe = Path.Combine(installDir, "Duytai.exe");
            if (!File.Exists(installedExe))
            {
                installedExe = Path.Combine(installDir, "HyperIDM.exe");
            }
            if (File.Exists(installedExe))
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = "explorer.exe",
                    Arguments = "\"" + installedExe + "\"",
                    UseShellExecute = true
                });
            }
        }
    }
}
