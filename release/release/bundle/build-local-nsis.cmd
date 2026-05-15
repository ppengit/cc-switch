@echo off
rem Manual usage:
rem 1. Double click this file in Explorer, or run it in cmd:
rem    .\release\release\bundle\build-local-nsis.cmd
rem 2. From repo root, you can also run:
rem    powershell -ExecutionPolicy Bypass -NoProfile -File .\scripts\build-local-nsis.ps1
rem 3. Or use:
rem    pnpm build:local:nsis

setlocal
set "SCRIPT_DIR=%~dp0"
powershell -ExecutionPolicy Bypass -NoProfile -File "%SCRIPT_DIR%..\..\..\scripts\build-local-nsis.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo NSIS 本地打包失败，退出码: %EXIT_CODE%
)
exit /b %EXIT_CODE%
