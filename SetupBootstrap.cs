using System;
using System.Diagnostics;
using System.IO;

namespace HyperIDMSetup
{
    internal static class SetupProgram
    {
        [STAThread]
        private static void Main()
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string ps1 = Path.Combine(baseDir, "Install-HyperIDM.ps1");
            if (File.Exists(ps1))
            {
                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = "powershell.exe",
                    Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + ps1 + "\"",
                    WorkingDirectory = baseDir,
                    UseShellExecute = false
                };
                Process p = Process.Start(psi);
                if (p != null) p.WaitForExit();
            }

            string installedExe = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                @"Programs\HyperIDM\HyperIDM.exe"
            );
            if (File.Exists(installedExe))
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = installedExe,
                    UseShellExecute = true
                });
            }
        }
    }
}
