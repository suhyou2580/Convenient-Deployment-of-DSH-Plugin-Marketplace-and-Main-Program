@echo off
chcp 65001 >nul
title DSH 插件一键部署器
cd /d "%~dp0"

if not defined PORT set PORT=3210
set "URL=http://127.0.0.1:%PORT%"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [错误] 未检测到 Node.js，请先安装：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo.
echo   正在自检环境...
echo.
node check.js
if errorlevel 1 (
  echo.
  echo   自检发现严重问题，请按上面提示修复后重试。
  echo.
  pause
  exit /b 1
)

echo.
echo   正在后台启动服务...
echo   服务地址：%URL%
echo   停止服务：运行「停止.bat」
echo.

rem 后台隐藏启动服务（不占用终端），等端口就绪后自动打开浏览器，然后本窗口自动关闭
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; $out=Join-Path $env:TEMP 'dsh-deployer.out.log'; $err=Join-Path $env:TEMP 'dsh-deployer.err.log'; Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err; $ok=$false; for($i=0;$i -lt 40;$i++){ Start-Sleep -Milliseconds 250; try { Invoke-WebRequest -UseBasicParsing -ErrorAction Stop -TimeoutSec 1 '%URL%/' | Out-Null; $ok=$true; break } catch {} }; if($ok){ Start-Process '%URL%'; exit 0 } else { exit 1 }"

if errorlevel 1 (
  echo   [错误] 服务未能在 10 秒内启动。
  echo   请在本目录运行 node server.js 查看具体报错。
  echo.
  pause
  exit /b 1
)

exit
