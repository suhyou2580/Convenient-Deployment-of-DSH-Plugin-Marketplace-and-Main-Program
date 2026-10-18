@echo off
chcp 65001 >nul
title 停止 DSH 插件一键部署器
cd /d "%~dp0"

if not defined PORT set PORT=3210

echo 正在停止 127.0.0.1:%PORT% 上的部署器服务...
powershell -NoProfile -Command "$p = Get-NetTCPConnection -LocalPort $env:PORT -State Listen -ErrorAction SilentlyContinue; if (-not $p) { Write-Host '未发现运行中的部署器服务。' } else { $p | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; Write-Host '已停止。' }"
echo.
pause
