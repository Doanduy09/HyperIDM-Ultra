@echo off
title Duytai 64-Bit Installer
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-HyperIDM.ps1"
echo.
echo [DONE] Duytai 64-Bit has been installed and signed!
start "" "%LOCALAPPDATA%\Programs\Duytai\Duytai.exe"
