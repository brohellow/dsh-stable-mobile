@echo off
rem ============================================================
rem dsh-stable-mobile 安装脚本（Windows）
rem
rem 把本插件链接进当前 DSH profile 的 node_modules，并在
rem profile 的 cordis.patch.yml 里登记 bundle。不需要 npm 联网安装。
rem
rem 用法：在本文件夹里双击运行即可。
rem ============================================================
setlocal EnableDelayedExpansion
chcp 65001 >nul

set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"

if "%DSH_HOME%"=="" (
  set "DSH_HOME=%USERPROFILE%\.dsh"
)

echo.
echo   dsh-stable-mobile 安装
echo   ----------------------
echo   DSH_HOME = %DSH_HOME%
echo.

rem ---- 找到 profile（默认 desktop）-------------------------------------
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
if "%PROFILE%"=="" goto noprofile

set "PROFILE_DIR=%DSH_HOME%\profiles\%PROFILE%"
if not exist "%PROFILE_DIR%" goto noprofile

echo   profile  = %PROFILE%
echo   目标目录 = %PROFILE_DIR%
echo.

rem ---- 1. 链接到 profile/node_modules ---------------------------------
set "NM=%PROFILE_DIR%\node_modules"
if not exist "%NM%" mkdir "%NM%"

set "LINK=%NM%\dsh-stable-mobile"
if exist "%LINK%" (
  echo [1/3] 移除已有的链接/目录...
  rmdir "%LINK%" 2>nul
  if exist "%LINK%" (
    echo       [错误] 无法删除 %LINK%
    goto fail
  )
)
echo [1/3] 链接插件到 profile...
mklink /J "%LINK%" "%HERE%" >nul
if errorlevel 1 (
  echo       [提示] 目录链接失败，尝试直接复制...
  xcopy "%HERE%" "%LINK%\" /E /I /Y /Q >nul
  if errorlevel 1 goto fail
)
echo       完成: %LINK%

rem ---- 2. 在 cordis.patch.yml 登记 bundle -----------------------------
set "PATCH=%PROFILE_DIR%\cordis.patch.yml"
echo [2/3] 登记到 cordis.patch.yml...
if not exist "%PATCH%" (
  echo # Your patch layer for this dsh profile.> "%PATCH%"
)
findstr /C:"dsh-stable-mobile" "%PATCH%" >nul 2>&1
if not errorlevel 1 (
  echo       已存在，跳过
) else (
  echo - id: stable-mobile>> "%PATCH%"
  echo   name: dsh-stable-mobile>> "%PATCH%"
  echo       已追加
)

rem ---- 3. 校验 package.json -------------------------------------------
echo [3/3] 校验插件文件...
if not exist "%HERE%\package.json" goto fail
if not exist "%HERE%\index.js" goto fail
if not exist "%HERE%\cordis.patch.yml" goto fail
if not exist "%HERE%\client.js" goto fail
echo       文件齐全

echo.
echo   安装完成！
echo.
echo   下一步：
echo     1. 重启 DeepSeek Harness
echo     2. 打开 设置 - 手机访问
echo     3. 展开「高级设置」，填入服务器地址、公网地址、SSH 私钥路径
echo     4. 点「开启」
echo.
echo   服务器一侧需要先配好 nginx TLS 反代，详见 README.md
echo.
pause
exit /b 0

:noprofile
echo [错误] 找不到 DSH profile 目录：%DSH_HOME%\profiles
echo        请确认 DeepSeek Harness 已经运行过至少一次。
echo.
pause
exit /b 1

:fail
echo.
echo [错误] 安装失败，请检查上面的提示。
echo.
pause
exit /b 1
