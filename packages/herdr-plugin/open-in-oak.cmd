@echo off
rem PowerShell need not be on the herdr server's PATH.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0open-in-oak.ps1"
exit /b %errorlevel%
