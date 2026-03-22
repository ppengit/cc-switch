@echo off
setlocal

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
  echo [run-with-msvc] vswhere.exe not found: "%VSWHERE%"
  exit /b 1
)

set "VSINSTALL="
for /f "usebackq delims=" %%I in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do (
  set "VSINSTALL=%%I"
)

if not defined VSINSTALL (
  echo [run-with-msvc] Visual Studio Build Tools with C++ workload not found.
  exit /b 1
)

set "VCVARS=%VSINSTALL%\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%VCVARS%" (
  echo [run-with-msvc] vcvars64.bat not found: "%VCVARS%"
  exit /b 1
)

call "%VCVARS%" >nul
if errorlevel 1 (
  echo [run-with-msvc] Failed to initialize MSVC environment.
  exit /b %errorlevel%
)

rem Prevent GNU toolchain overrides from hijacking MSVC builds.
set "CC="
set "CXX="
set "CFLAGS="
set "CXXFLAGS="

if "%~1"=="" (
  echo [run-with-msvc] No command specified.
  exit /b 1
)

call %*
exit /b %errorlevel%
