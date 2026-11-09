@echo off
rem ============================================================
rem dsh-stable-mobile 安装器（Windows，适用于桌面版 DeepSeek Harness）
rem
rem 为什么不能只跑 `dsh plugin add`：
rem  1) 桌面版（Electron）的 desktop profile 被应用独占管理，
rem     命令行 `dsh --profile desktop ...` 会直接报错：
rem       "profile desktop is managed exclusively by the Electron application"
rem  2) `dsh plugin add` 只装依赖，不会把包名写入 dsh.profile.bundles，
rem     而只有 bundles 里的包才会被加载 —— 表现为「装了但设置里没有」。
rem  3) 用 PowerShell 写 package.json 容易带入 UTF-8 BOM，
rem     DSH 解析会报 "Unexpected token ''"，插件完全加载不了。
rem
rem 本脚本用 Node 直接改文件，保证：无 BOM、只追加 bundles、不动其他配置。
rem
rem 用法：双击运行。
rem ============================================================
setlocal EnableDelayedExpansion
chcp 65001 >nul

set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"

if "%DSH_HOME%"=="" set "DSH_HOME=%USERPROFILE%\.dsh"

echo.
echo   dsh-stable-mobile 安装器
echo   ========================
echo   源目录   = %HERE%
echo   DSH_HOME = %DSH_HOME%

rem ---------- 找 node ------------------------------------------------
set "NODE="
for /f "delims=" %%P in ('where node 2^>nul') do (
  if "!NODE!"=="" set "NODE=%%P"
)
if "%NODE%"=="" (
  for %%R in (
    "%ProgramFiles%\nodejs\node.exe"
    "%LOCALAPPDATA%\Programs\nodejs\node.exe"
    "%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
  ) do (
    if "!NODE!"=="" if exist "%%~R" set "NODE=%%~R"
  )
)
if "%NODE%"=="" (
  echo.
  echo [错误] 找不到 Node.js。
  echo        请安装 Node.js ^(^>=20^)，或把它加进 PATH 后重跑。
  pause
  exit /b 1
)
echo   node     = %NODE%

rem ---------- 选 profile ---------------------------------------------
set "PROFILE=%DSH_PROFILE%"
if "%PROFILE%"=="" (
  if exist "%DSH_HOME%\profiles\desktop" (
    set "PROFILE=desktop"
  ) else (
    for /d %%D in ("%DSH_HOME%\profiles\*") do (
      if "!PROFILE!"=="" set "PROFILE=%%~nxD"
    )
  )
)
if "%PROFILE%"=="" (
  echo [错误] 找不到 profile，请先运行过一次 DeepSeek Harness。
  pause
  exit /b 1
)
set "PROFILE_DIR=%DSH_HOME%\profiles\%PROFILE%"
if not exist "%PROFILE_DIR%" (
  echo [错误] profile 目录不存在: %PROFILE_DIR%
  pause
  exit /b 1
)
echo   profile  = %PROFILE%
echo.

rem ---------- 调用 Node 安装器 ----------------------------------------
"%NODE%" "%HERE%\scripts\install.mjs" --here "%HERE%" --profile-dir "%PROFILE_DIR%"
if errorlevel 1 (
  echo.
  echo [失败] 安装未完成，请查看上面的错误。
  pause
  exit /b 1
)

echo.
echo   下一步：
echo     1. 完全退出 DeepSeek Harness 再重新打开
echo     2. 打开 设置 - 手机访问
echo.
pause
exit /b 0
