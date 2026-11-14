@echo off
setlocal
title MARS MAYHEM
cd /d "%~dp0"

if not exist "index.html" (
  echo index.html not found in %CD%
  echo Put start.bat in the game folder, next to index.html.
  goto :fail
)

REM Python first when it exists: that host has been tested end to end.
where py >nul 2>nul
if not errorlevel 1 (
  py host.py %*
  goto :done
)
where python >nul 2>nul
if not errorlevel 1 (
  python host.py %*
  goto :done
)

REM No Python: use PowerShell, which every Windows machine already has.
where powershell >nul 2>nul
if errorlevel 1 goto :noshell

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0host.ps1" %*
if errorlevel 1 goto :fail
goto :done

:noshell
echo.
echo Neither Python nor PowerShell was found on this machine.
echo Install Python 3 from python.org, or serve this folder with any
echo static web server that sends Cache-Control: no-store.
goto :fail

:fail
echo.
echo ------------------------------------------------------------
echo  Exit code %ERRORLEVEL% - copy the text above if you need help.
echo  The window stays open so you can read it.
echo ------------------------------------------------------------
pause

:done
endlocal
