@echo off
title HyperIDM Ultra 64-Bit Installer
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-HyperIDM.ps1"
echo.
echo [DONE] HyperIDM Ultra 64-Bit has been installed!
start "" "%LOCALAPPDATA%\Programs\HyperIDM\HyperIDM.exe"
