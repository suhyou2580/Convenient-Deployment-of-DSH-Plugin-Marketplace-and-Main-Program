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
echo   正在自检环境…
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
echo   DSH 插件一键部署器
echo   服务地址：%URL%
echo   关闭此窗口即可停止服务。
echo.

rem 等 2 秒让服务起来后自动打开浏览器（独立最小化窗口，不影响主窗口）
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start %URL%"

node server.js

echo.
echo   服务已停止。
pause
