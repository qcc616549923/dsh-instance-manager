@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "NODE_EXE="

:: 1) Node.js on PATH
for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"

:: 2) The DSH installation that launched this shell, if any
if not defined NODE_EXE if defined DSH_INSTALL_DIR (
  for %%I in ("%DSH_INSTALL_DIR%\..\..\..\..\..") do (
    if exist "%%~fI\runtime\primary-runtime\dependencies\node\bin\node.exe" (
      set "NODE_EXE=%%~fI\runtime\primary-runtime\dependencies\node\bin\node.exe"
    )
  )
)

:: 3) Registry install location (per-user and machine-wide installs)
for /f "tokens=2,*" %%A in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall" /s /f "DeepSeek Harness" /d 2^>nul ^| findstr /i "InstallLocation"') do (
  call :probe "%%B\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
)
for /f "tokens=2,*" %%A in ('reg query "HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall" /s /f "DeepSeek Harness" /d 2^>nul ^| findstr /i "InstallLocation"') do (
  call :probe "%%B\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
)

:: 4) Any DSH-looking app folder under %LOCALAPPDATA%\Programs
for /d %%D in ("%LOCALAPPDATA%\Programs\*") do call :probe "%%~fD\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"

:: 5) Common installation folders
call :probe "%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
call :probe "%LOCALAPPDATA%\Programs\DSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
call :probe "%ProgramFiles%\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
call :probe "%ProgramFiles%\DSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
call :probe "%ProgramFiles(x86)%\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
call :probe "C:\Soft\DSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
call :probe "D:\Soft\DSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"

if not defined NODE_EXE (
  echo [DSH Instance Manager] Node.js not found.
  echo Install DSH Desktop, or install Node.js 20.11+ and retry.
  pause
  exit /b 1
)

"%NODE_EXE%" server.js %*
if errorlevel 1 pause
exit /b 0

:probe
if not defined NODE_EXE if exist "%~1" set "NODE_EXE=%~1"
exit /b 0
