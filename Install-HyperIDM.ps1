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

Write-Host "[2/6] Copying Duytai 64-bit engine, Native Host & Browser Extension..." -ForegroundColor Yellow
if ($sourceDir.TrimEnd('\') -ne $installDir.TrimEnd('\')) {
    foreach ($f in @("package.json", "engine.js", "server.js", "idm-features.js", "clipboard-batch.js", "cli.js", "duytai-native-host.js", "HyperIDM.cs", "app.manifest", "Sign-Duytai.ps1", "Duytai-CodeSigning.cer", "Install-HyperIDM.ps1")) {
        if (Test-Path "$sourceDir\$f") {
            Copy-Item -Path "$sourceDir\$f" -Destination "$installDir\$f" -Force
        }
    }
    if (Test-Path "$sourceDir\assets\*") {
        New-Item -Path "$installDir\assets" -ItemType Directory -Force | Out-Null
        Copy-Item -Path "$sourceDir\assets\*" -Destination "$installDir\assets" -Recurse -Force
    }
    if (Test-Path "$sourceDir\public\*") {
        Copy-Item -Path "$sourceDir\public\*" -Destination $publicDir -Recurse -Force
    }
    if (Test-Path "$sourceDir\extension\*") {
        Copy-Item -Path "$sourceDir\extension\*" -Destination $extDir -Recurse -Force
    }
}

# Register Native Messaging Host for ALL major browsers (Chrome, Edge, CocCoc, Brave, Firefox)
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe -and (Test-Path "C:\Program Files\nodejs\node.exe")) { $nodeExe = "C:\Program Files\nodejs\node.exe" }
if (-not $nodeExe) { $nodeExe = "node.exe" }

$nativeCmdPath = Join-Path $installDir "duytai-native-host.cmd"
Set-Content -Path $nativeCmdPath -Value "@echo off`r`n`"$nodeExe`" `"%~dp0duytai-native-host.js`" %*`r`n" -Encoding ASCII

$chromeNmJson = @{
    name = "com.duytai.idm"
    description = "Duytai 64-Bit Browser Native Messaging Host"
    path = $nativeCmdPath
    type = "stdio"
    allowed_origins = @(
        "chrome-extension://knpgakkbngbpcijjehpjflnflccdlaon/"
    )
} | ConvertTo-Json -Depth 3
$nmJsonPath = Join-Path $installDir "com.duytai.idm.json"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($nmJsonPath, $chromeNmJson, $utf8NoBom)

$ffNmJson = @{
    name = "com.duytai.idm"
    description = "Duytai 64-Bit Firefox Native Messaging Host"
    path = $nativeCmdPath
    type = "stdio"
    allowed_extensions = @("duytai-idm@doanduy.dev")
} | ConvertTo-Json -Depth 3
$ffNmJsonPath = Join-Path $installDir "com.duytai.idm.firefox.json"
[System.IO.File]::WriteAllText($ffNmJsonPath, $ffNmJson, $utf8NoBom)

foreach ($regRoot in @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.duytai.idm",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.duytai.idm",
    "HKCU:\Software\CocCoc\Browser\NativeMessagingHosts\com.duytai.idm",
    "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.duytai.idm"
)) {
    New-Item -Path $regRoot -Force | Out-Null
    Set-ItemProperty -Path $regRoot -Name "(Default)" -Value $nmJsonPath -Force
}
New-Item -Path "HKCU:\Software\Mozilla\NativeMessagingHosts\com.duytai.idm" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\Software\Mozilla\NativeMessagingHosts\com.duytai.idm" -Name "(Default)" -Value $ffNmJsonPath -Force

# Bundle or download yt-dlp.exe for YouTube/Streaming Engine
if (($sourceDir.TrimEnd('\') -ne $installDir.TrimEnd('\')) -and (Test-Path "$sourceDir\bin\yt-dlp.exe")) {
    Copy-Item -Path "$sourceDir\bin\yt-dlp.exe" -Destination "$binDir\yt-dlp.exe" -Force
} elseif (-not (Test-Path "$binDir\yt-dlp.exe")) {
    Write-Host "[*] Downloading standalone 64-bit yt-dlp.exe..." -ForegroundColor Yellow
    & "$env:SystemRoot\System32\curl.exe" -L -s -o "$binDir\yt-dlp.exe" "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
}

if (($sourceDir.TrimEnd('\') -ne $installDir.TrimEnd('\')) -and (Test-Path "$sourceDir\bin\ffmpeg.exe")) {
    Copy-Item -Path "$sourceDir\bin\ffmpeg.exe" -Destination "$binDir\ffmpeg.exe" -Force
}
$ffmpegLocal = Get-ChildItem "$env:LOCALAPPDATA\hermes\tools" -Recurse -Filter "ffmpeg.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $ffmpegLocal) {
    $ffmpegCmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if ($ffmpegCmd -and (Test-Path $ffmpegCmd.Source)) { $ffmpegLocal = Get-Item $ffmpegCmd.Source }
}
if ($ffmpegLocal -and -not (Test-Path "$binDir\ffmpeg.exe")) {
    Copy-Item -Path $ffmpegLocal.FullName -Destination "$binDir\ffmpeg.exe" -Force
}

Write-Host "[3/6] Compiling & Signing Native 64-Bit Windows Executable (Duytai.exe)..." -ForegroundColor Yellow
Stop-Process -Name "Duytai", "HyperIDM" -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 300
$csc = "$env:SystemRoot\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$icoFlag = if (Test-Path "$installDir\assets\Duytai.ico") { "/win32icon:$installDir\assets\Duytai.ico" } elseif (Test-Path "$sourceDir\assets\Duytai.ico") { "/win32icon:$sourceDir\assets\Duytai.ico" } else { $null }
$manifestFlag = if (Test-Path "$installDir\app.manifest") { "/win32manifest:$installDir\app.manifest" } elseif (Test-Path "$sourceDir\app.manifest") { "/win32manifest:$sourceDir\app.manifest" } else { $null }
if (Test-Path $csc) {
    $cscArgs = @("/nologo", "/target:winexe", "/platform:x64", "/optimize+", "/r:System.Windows.Forms.dll", "/r:System.Drawing.dll", "/r:System.Core.dll", "/r:System.Web.Extensions.dll")
    if ($icoFlag) { $cscArgs += $icoFlag }
    if ($manifestFlag) { $cscArgs += $manifestFlag }
    $cscArgs += @("/out:$installDir\Duytai.exe", "$installDir\HyperIDM.cs")
    & $csc @cscArgs
    Copy-Item -Path "$installDir\Duytai.exe" -Destination "$installDir\HyperIDM.exe" -Force
} elseif (Test-Path "$sourceDir\Duytai.exe") {
    Copy-Item -Path "$sourceDir\Duytai.exe" -Destination "$installDir\Duytai.exe" -Force
    Copy-Item -Path "$sourceDir\Duytai.exe" -Destination "$installDir\HyperIDM.exe" -Force
}

if (Test-Path "$installDir\Sign-Duytai.ps1") {
    & "$installDir\Sign-Duytai.ps1" -TargetPaths @("$installDir\Duytai.exe", "$installDir\HyperIDM.exe")
} elseif (Test-Path "$sourceDir\Sign-Duytai.ps1") {
    & "$sourceDir\Sign-Duytai.ps1" -TargetPaths @("$installDir\Duytai.exe", "$installDir\HyperIDM.exe")
}

$cmdContent = "@echo off`r`n`"$nodeExe`" `"%~dp0cli.js`" %*`r`n"
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

$uninstScriptPath = Join-Path $installDir "Uninstall-Duytai.ps1"
$uninstScript = @'
$ErrorActionPreference = 'SilentlyContinue'
Stop-Process -Name "Duytai", "HyperIDM" -Force
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "Duytai"
foreach ($proto in @("duytai", "hyperidm")) {
    Remove-Item -Path "HKCU:\Software\Classes\$proto" -Recurse -Force
}
foreach ($regRoot in @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.duytai.idm",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.duytai.idm",
    "HKCU:\Software\CocCoc\Browser\NativeMessagingHosts\com.duytai.idm",
    "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.duytai.idm",
    "HKCU:\Software\Mozilla\NativeMessagingHosts\com.duytai.idm"
)) {
    Remove-Item -Path $regRoot -Recurse -Force
}
$desktopLnk = Join-Path ([Environment]::GetFolderPath("Desktop")) "Duytai.lnk"
$startLnk = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Duytai.lnk"
Remove-Item -Path $desktopLnk, $startLnk -Force
Remove-Item -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Duytai" -Recurse -Force
$installDir = Join-Path $env:LOCALAPPDATA "Programs\Duytai"
Start-Process -FilePath "cmd.exe" -ArgumentList "/c ping 127.0.0.1 -n 2 > nul & rd /s /q `"$installDir`"" -WindowStyle Hidden
'@
Set-Content -Path $uninstScriptPath -Value $uninstScript -Encoding UTF8

$uninstKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Duytai"
New-Item -Path $uninstKey -Force | Out-Null
Set-ItemProperty -Path $uninstKey -Name "DisplayName" -Value "Duytai 64-Bit — Trình Tăng Tốc Tải Xuống" -Force
Set-ItemProperty -Path $uninstKey -Name "DisplayVersion" -Value "7.5.0" -Force
Set-ItemProperty -Path $uninstKey -Name "Publisher" -Value "DOANDUY Software" -Force
Set-ItemProperty -Path $uninstKey -Name "InstallLocation" -Value $installDir -Force
Set-ItemProperty -Path $uninstKey -Name "DisplayIcon" -Value "$installDir\Duytai.exe" -Force
Set-ItemProperty -Path $uninstKey -Name "UninstallString" -Value "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$uninstScriptPath`"" -Force

Write-Host "[6/6] Installation Complete! Installed & Signed at: $installDir\Duytai.exe" -ForegroundColor Green
