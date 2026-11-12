$ErrorActionPreference = 'SilentlyContinue'

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   ⚡ DUYTAI 64-BIT — UNIVERSAL WINDOWS INSTALLER" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$sourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$installDir = Join-Path $env:LOCALAPPDATA "Programs\Duytai"
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

Write-Host "[2/6] Copying Duytai 64-bit engine & Browser Extension..." -ForegroundColor Yellow
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

$ffmpegLocal = Get-ChildItem "$env:LOCALAPPDATA\hermes\tools" -Recurse -Filter "ffmpeg.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($ffmpegLocal -and -not (Test-Path "$binDir\ffmpeg.exe")) {
    Copy-Item -Path $ffmpegLocal.FullName -Destination "$binDir\ffmpeg.exe" -Force
}

Write-Host "[3/6] Compiling Native 64-Bit Windows System Tray Executable (Duytai.exe)..." -ForegroundColor Yellow
Stop-Process -Name "Duytai", "HyperIDM", "IDMan" -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 300
$csc = "$env:SystemRoot\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (Test-Path $csc) {
    & $csc /nologo /target:winexe /platform:x64 /optimize+ /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Core.dll /r:System.Web.Extensions.dll "/out:$installDir\Duytai.exe" "$installDir\HyperIDM.cs"
    Copy-Item -Path "$installDir\Duytai.exe" -Destination "$installDir\HyperIDM.exe" -Force
} elseif (Test-Path "$sourceDir\Duytai.exe") {
    Copy-Item -Path "$sourceDir\Duytai.exe" -Destination "$installDir\Duytai.exe" -Force
    Copy-Item -Path "$sourceDir\Duytai.exe" -Destination "$installDir\HyperIDM.exe" -Force
}

$cmdContent = "@echo off`r`nnode `"%~dp0cli.js`" %*`r`n"
Set-Content -Path "$installDir\duytai.cmd" -Value $cmdContent -Encoding ASCII

Write-Host "[4/6] Creating Desktop & Start Menu Shortcuts (Duytai)..." -ForegroundColor Yellow
$wsh = New-Object -ComObject WScript.Shell
$desktopPath = [Environment]::GetFolderPath("Desktop")
$startMenuPath = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"

foreach ($folder in @($desktopPath, $startMenuPath)) {
    $oldLnk = Join-Path $folder "HyperIDM Ultra.lnk"
    if (Test-Path $oldLnk) { Remove-Item $oldLnk -Force -ErrorAction SilentlyContinue }
    $lnk = $wsh.CreateShortcut((Join-Path $folder "Duytai.lnk"))
    $lnk.TargetPath = "$installDir\Duytai.exe"
    $lnk.WorkingDirectory = $installDir
    $lnk.Description = "Duytai 64-Bit Download Accelerator"
    $lnk.Save()
}

Write-Host "[5/6] Registering duytai:// URL Protocol & User PATH..." -ForegroundColor Yellow
foreach ($proto in @("duytai", "hyperidm")) {
    New-Item -Path "HKCU:\Software\Classes\$proto" -Force | Out-Null
    Set-ItemProperty -Path "HKCU:\Software\Classes\$proto" -Name "(Default)" -Value "URL:Duytai Protocol" -Force
    Set-ItemProperty -Path "HKCU:\Software\Classes\$proto" -Name "URL Protocol" -Value "" -Force
    New-Item -Path "HKCU:\Software\Classes\$proto\shell\open\command" -Force | Out-Null
    Set-ItemProperty -Path "HKCU:\Software\Classes\$proto\shell\open\command" -Name "(Default)" -Value "`"$installDir\Duytai.exe`" `"%1`"" -Force
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$installDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$installDir", "User")
}

New-Item -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Force | Out-Null
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "HyperIDMUltra" -ErrorAction SilentlyContinue
Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "Duytai" -Value "`"$installDir\Duytai.exe`" --tray" -Force

$uninstKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Duytai"
New-Item -Path $uninstKey -Force | Out-Null
Set-ItemProperty -Path $uninstKey -Name "DisplayName" -Value "Duytai 64-Bit — Trình Tăng Tốc Tải Xuống" -Force
Set-ItemProperty -Path $uninstKey -Name "DisplayVersion" -Value "7.0.0" -Force
Set-ItemProperty -Path $uninstKey -Name "Publisher" -Value "DOANDUY" -Force
Set-ItemProperty -Path $uninstKey -Name "InstallLocation" -Value $installDir -Force
Set-ItemProperty -Path $uninstKey -Name "DisplayIcon" -Value "$installDir\Duytai.exe" -Force
Set-ItemProperty -Path $uninstKey -Name "UninstallString" -Value "cmd.exe /c rd /s /q `"$installDir`"" -Force

Write-Host "[6/6] Installation Complete! Installed at: $installDir\Duytai.exe" -ForegroundColor Green
