$ErrorActionPreference = 'SilentlyContinue'

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   ⚡ HYPERIDM ULTRA 64-BIT — UNIVERSAL WINDOWS INSTALLER" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$sourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$installDir = Join-Path $env:LOCALAPPDATA "Programs\HyperIDM"
$binDir = Join-Path $installDir "bin"
$publicDir = Join-Path $installDir "public"
$extDir = Join-Path $installDir "extension"

Write-Host "[1/6] Creating installation directory: $installDir" -ForegroundColor Yellow
New-Item -Path $installDir -ItemType Directory -Force | Out-Null
New-Item -Path $binDir -ItemType Directory -Force | Out-Null
New-Item -Path $publicDir -ItemType Directory -Force | Out-Null
New-Item -Path $extDir -ItemType Directory -Force | Out-Null

# Ensure Node.js is available on target Windows PC
if (-not (Get-Command node -ErrorAction SilentlyContinue) -and -not (Test-Path "C:\Program Files\nodejs\node.exe")) {
    Write-Host "[*] Installing Node.js 64-bit runtime via WinGet..." -ForegroundColor Yellow
    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent
}

Write-Host "[2/6] Copying core 64-bit engine, IDM-killer modules & Browser Extension..." -ForegroundColor Yellow
if ($sourceDir.TrimEnd('\') -ne $installDir.TrimEnd('\')) {
    foreach ($f in @("engine.js", "server.js", "idm-features.js", "clipboard-batch.js", "cli.js", "HyperIDM.cs", "Install-HyperIDM.ps1")) {
        if (Test-Path "$sourceDir\$f") {
            Copy-Item -Path "$sourceDir\$f" -Destination "$installDir\$f" -Force
        }
    }
    if (Test-Path "$sourceDir\public\*") {
        Copy-Item -Path "$sourceDir\public\*" -Destination $publicDir -Recurse -Force
    }
    if (Test-Path "$sourceDir\extension\*") {
        Copy-Item -Path "$sourceDir\extension\*" -Destination $extDir -Recurse -Force
    }
}

# Bundle or download yt-dlp.exe for YouTube/Streaming Engine
if (($sourceDir.TrimEnd('\') -ne $installDir.TrimEnd('\')) -and (Test-Path "$sourceDir\bin\yt-dlp.exe")) {
    Copy-Item -Path "$sourceDir\bin\yt-dlp.exe" -Destination "$binDir\yt-dlp.exe" -Force
} elseif (-not (Test-Path "$binDir\yt-dlp.exe")) {
    Write-Host "[*] Downloading standalone 64-bit yt-dlp.exe..." -ForegroundColor Yellow
    & "$env:SystemRoot\System32\curl.exe" -L -s -o "$binDir\yt-dlp.exe" "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
}

# Copy ffmpeg.exe if present locally so video muxing works everywhere
$ffmpegLocal = Get-ChildItem "$env:LOCALAPPDATA\hermes\tools" -Recurse -Filter "ffmpeg.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($ffmpegLocal -and -not (Test-Path "$binDir\ffmpeg.exe")) {
    Copy-Item -Path $ffmpegLocal.FullName -Destination "$binDir\ffmpeg.exe" -Force
}

Write-Host "[3/6] Compiling Native 64-Bit Windows Executable (HyperIDM.exe)..." -ForegroundColor Yellow
$csc = "$env:SystemRoot\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (Test-Path $csc) {
    & $csc /nologo /target:winexe /platform:x64 /optimize+ "/out:$installDir\HyperIDM.exe" "$installDir\HyperIDM.cs"
} elseif (Test-Path "$sourceDir\HyperIDM.exe") {
    Copy-Item -Path "$sourceDir\HyperIDM.exe" -Destination "$installDir\HyperIDM.exe" -Force
}

# Create CLI wrapper hyperidm.cmd
$cmdContent = "@echo off`r`nnode `"%~dp0cli.js`" %*`r`n"
Set-Content -Path "$installDir\hyperidm.cmd" -Value $cmdContent -Encoding ASCII

Write-Host "[4/6] Creating Desktop & Start Menu Shortcuts..." -ForegroundColor Yellow
$wsh = New-Object -ComObject WScript.Shell
$desktopPath = [Environment]::GetFolderPath("Desktop")
$startMenuPath = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"

foreach ($folder in @($desktopPath, $startMenuPath)) {
    $lnk = $wsh.CreateShortcut((Join-Path $folder "HyperIDM Ultra.lnk"))
    $lnk.TargetPath = "$installDir\HyperIDM.exe"
    $lnk.WorkingDirectory = $installDir
    $lnk.Description = "HyperIDM Ultra 64-Bit Download Accelerator"
    $lnk.Save()
}

Write-Host "[5/6] Registering hyperidm:// URL Protocol & User PATH..." -ForegroundColor Yellow
New-Item -Path "HKCU:\Software\Classes\hyperidm" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\Software\Classes\hyperidm" -Name "(Default)" -Value "URL:HyperIDM Protocol" -Force
Set-ItemProperty -Path "HKCU:\Software\Classes\hyperidm" -Name "URL Protocol" -Value "" -Force
New-Item -Path "HKCU:\Software\Classes\hyperidm\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\Software\Classes\hyperidm\shell\open\command" -Name "(Default)" -Value "`"$installDir\HyperIDM.exe`" `"%1`"" -Force

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$installDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$installDir", "User")
}

# Register Uninstall entry in Windows Settings (Installed Apps)
$uninstKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\HyperIDMUltra"
New-Item -Path $uninstKey -Force | Out-Null
Set-ItemProperty -Path $uninstKey -Name "DisplayName" -Value "HyperIDM Ultra 64-Bit v3.0 (TitanFetch Engine)" -Force
Set-ItemProperty -Path $uninstKey -Name "DisplayVersion" -Value "3.0.0" -Force
Set-ItemProperty -Path $uninstKey -Name "Publisher" -Value "DOANDUY / Antigravity" -Force
Set-ItemProperty -Path $uninstKey -Name "InstallLocation" -Value $installDir -Force
Set-ItemProperty -Path $uninstKey -Name "DisplayIcon" -Value "$installDir\HyperIDM.exe" -Force
Set-ItemProperty -Path $uninstKey -Name "UninstallString" -Value "cmd.exe /c rd /s /q `"$installDir`"" -Force

Write-Host "[6/6] Installation Complete! Installed at: $installDir\HyperIDM.exe" -ForegroundColor Green
