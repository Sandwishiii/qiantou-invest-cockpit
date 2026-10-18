@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 钱途 · 装依赖

rem K线图用 ECharts 5.5.1，体积 1MB 所以不放进仓库，这里从 npmmirror 拉一次。
rem Windows 10 自带 curl 和 tar，无需装任何东西。

where curl >nul 2>nul
if errorlevel 1 (
  echo [错误] 系统里没找到 curl，请手动下载 echarts 5.5.1 放到 vendor\echarts.min.js
  pause
  exit /b 1
)

if exist "vendor\echarts.min.js" (
  echo vendor\echarts.min.js 已经在了，不用重复下载
  pause
  exit /b 0
)

echo 正在下载 ECharts 5.5.1 ...
curl -L --fail -o "%TEMP%\echarts.tgz" "https://registry.npmmirror.com/echarts/-/echarts-5.5.1.tgz"
if errorlevel 1 (
  echo [错误] 下载失败，换个网络再试，或者手动把 echarts.min.js 放进 vendor\
  pause
  exit /b 1
)

mkdir vendor 2>nul
tar -xzOf "%TEMP%\echarts.tgz" package/dist/echarts.min.js > "vendor\echarts.min.js"
del "%TEMP%\echarts.tgz" 2>nul

for %%F in ("vendor\echarts.min.js") do echo 已就绪：vendor\echarts.min.js（%%~zF 字节，正常约 1030855）
echo 没有 K 线也不影响其它页面，只是点行看不到图。
pause
