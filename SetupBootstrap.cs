using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;

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

            // 1. Extract embedded payload.zip resource into %LOCALAPPDATA%\Programs\HyperIDM
            try
            {
                Assembly asm = Assembly.GetExecutingAssembly();
                using (Stream resStream = asm.GetManifestResourceStream("payload.zip"))
                {
                    if (resStream != null)
                    {
                        using (ZipArchive archive = new ZipArchive(resStream, ZipArchiveMode.Read))
                        {
                            foreach (ZipArchiveEntry entry in archive.Entries)
                            {
                                string fullPath = Path.Combine(installDir, entry.FullName.Replace('/', '\\'));
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
            catch
            {
                // Ignore if files are locked by running instance
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
                Process p = Process.Start(psi);
                if (p != null) p.WaitForExit();
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
