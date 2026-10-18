@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 钱途 · 个人投资管理舱

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没找到 Node.js，请先装 Node 18 以上并加入 PATH
  pause
  exit /b 1
)

netstat -ano | findstr "127.0.0.1:8618" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo 服务已经在运行，直接打开页面
  start "" "http://127.0.0.1:8618"
  exit /b 0
)

echo 正在启动本地服务...
start "钱途·本地服务（关掉这个小窗就停止）" /min cmd /c "node server.js"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:8618"
echo 已打开 http://127.0.0.1:8618  ——  那个最小化的黑窗口别关，它是取行情的服务。
