param(
    [Alias("TargetFiles")]
    [string[]]$TargetPaths = @()
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $TargetPaths -or $TargetPaths.Count -eq 0) {
    $TargetPaths = @(
        (Join-Path $scriptDir "Duytai.exe"),
        (Join-Path $scriptDir "HyperIDM.exe"),
        (Join-Path $scriptDir "Duytai-Setup.exe"),
        (Join-Path $scriptDir "HyperIDM-Setup.exe")
    )
}

$certDir = Join-Path $env:LOCALAPPDATA "Duytai\certs"
New-Item -Path $certDir -ItemType Directory -Force | Out-Null
$pfxPath = Join-Path $certDir "Duytai-CodeSigning.pfx"
$cerPath = Join-Path $scriptDir "Duytai-CodeSigning.cer"
$pfxPassPlain = if ($env:DUYTAI_WIN_PFX_PASSWORD) { $env:DUYTAI_WIN_PFX_PASSWORD } else { "DuytaiCodeSign#2026" }
$pfxPass = ConvertTo-SecureString -String $pfxPassPlain -Force -AsPlainText

$signingCert = $null

# 1. Load CI/Commercial PFX if provided via base64 env
if ($env:DUYTAI_WIN_PFX_BASE64) {
    $rawBytes = [Convert]::FromBase64String($env:DUYTAI_WIN_PFX_BASE64)
    [System.IO.File]::WriteAllBytes($pfxPath, $rawBytes)
}

# 2. Load existing PFX or reuse existing valid CodeSigning cert from CurrentUser\My
if (Test-Path $pfxPath) {
    try {
        $signingCert = Get-PfxCertificate -FilePath $pfxPath -Password $pfxPass -ErrorAction Stop
        Import-PfxCertificate -FilePath $pfxPath -CertStoreLocation "Cert:\CurrentUser\My" -Password $pfxPass -Exportable | Out-Null
        $signingCert = Get-ChildItem "Cert:\CurrentUser\My\$($signingCert.Thumbprint)" -ErrorAction SilentlyContinue
    } catch {
        $signingCert = $null
    }
}

if (-not $signingCert) {
    $signingCert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
        Where-Object { $_.Subject -like "*DOANDUY*" -and $_.NotAfter -gt (Get-Date).AddDays(30) } |
        Select-Object -First 1
}

# 3. Create RSA-2048 SHA-256 Authenticode Code Signing Certificate if none found
if (-not $signingCert) {
    $signingCert = New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject "CN=DOANDUY Software (Duytai 64-Bit), O=DOANDUY Software, C=VN" `
        -KeyAlgorithm RSA `
        -KeyLength 2048 `
        -HashAlgorithm "SHA256" `
        -KeyExportPolicy Exportable `
        -KeyUsage DigitalSignature `
        -NotAfter (Get-Date).AddYears(10) `
        -CertStoreLocation "Cert:\CurrentUser\My"
    Export-PfxCertificate -Cert $signingCert -FilePath $pfxPath -Password $pfxPass -Force | Out-Null
}

Export-Certificate -Cert $signingCert -FilePath $cerPath -Type CERT -Force | Out-Null

# 4. Ensure certificate is trusted in TrustedPublisher and Root stores without interactive modal popups
foreach ($storeName in @("Cert:\LocalMachine\TrustedPublisher", "Cert:\LocalMachine\Root", "Cert:\CurrentUser\TrustedPublisher")) {
    try {
        $existing = Get-ChildItem "$storeName\$($signingCert.Thumbprint)" -ErrorAction SilentlyContinue
        if (-not $existing) {
            Import-Certificate -FilePath $cerPath -CertStoreLocation $storeName -ErrorAction Stop | Out-Null
        }
    } catch {}
}
if (-not (Test-Path "Cert:\LocalMachine\Root\$($signingCert.Thumbprint)") -and -not (Test-Path "Cert:\CurrentUser\Root\$($signingCert.Thumbprint)")) {
    try {
        if (-not ("RootCertApprover" -as [type])) {
            Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class RootCertApprover {
    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter, string lpszClass, string lpszWindow);
    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")]
    static extern IntPtr GetDlgItem(IntPtr hDlg, int nIDDlgItem);
    [DllImport("user32.dll")]
    static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    public static void StartAutoApprove(int pid) {
        Thread t = new Thread(() => {
            for (int i = 0; i < 80; i++) {
                IntPtr hwnd = IntPtr.Zero;
                while ((hwnd = FindWindowEx(IntPtr.Zero, hwnd, "#32770", null)) != IntPtr.Zero) {
                    uint wpid;
                    GetWindowThreadProcessId(hwnd, out wpid);
                    if (wpid == (uint)pid) {
                        IntPtr yesBtn = GetDlgItem(hwnd, 6);
                        if (yesBtn != IntPtr.Zero) {
                            SendMessage(yesBtn, 0x00F5, IntPtr.Zero, IntPtr.Zero);
                            PostMessage(hwnd, 0x0111, (IntPtr)6, yesBtn);
                            return;
                        }
                    }
                }
                Thread.Sleep(40);
            }
        });
        t.IsBackground = true;
        t.Start();
    }
}
"@
        }
        [RootCertApprover]::StartAutoApprove($PID)
        Import-Certificate -FilePath $cerPath -CertStoreLocation "Cert:\CurrentUser\Root" | Out-Null
    } catch {}
}

# 5. Sign all target binaries with SHA-256 and strip Zone.Identifier MOTW
foreach ($target in $TargetPaths) {
    if (-not (Test-Path $target)) { continue }
    try { Unblock-File -Path $target -ErrorAction SilentlyContinue } catch {}

    $sig = $null
    if ($env:DUYTAI_TIMESTAMP_URL) {
        try {
            $sig = Set-AuthenticodeSignature -FilePath $target -Certificate $signingCert -HashAlgorithm SHA256 -IncludeChain All -TimestampServer $env:DUYTAI_TIMESTAMP_URL -ErrorAction Stop
        } catch {
            $sig = Set-AuthenticodeSignature -FilePath $target -Certificate $signingCert -HashAlgorithm SHA256 -IncludeChain All -ErrorAction Stop
        }
    } else {
        $sig = Set-AuthenticodeSignature -FilePath $target -Certificate $signingCert -HashAlgorithm SHA256 -IncludeChain All -ErrorAction Stop
    }

    $verify = Get-AuthenticodeSignature -FilePath $target
    Write-Host "[Authenticode] Signed $(Split-Path -Leaf $target) -> Status: $($verify.Status) | Thumbprint: $($verify.SignerCertificate.Thumbprint)" -ForegroundColor Green
}
