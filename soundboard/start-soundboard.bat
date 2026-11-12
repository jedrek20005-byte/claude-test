@echo off
cd /d "%~dp0"
where npm >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js / npm was not found.
  echo If you just installed Node.js, restart your PC ^(or sign out and in^) and try again.
  echo Otherwise install it from https://nodejs.org
  echo.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies, first run only... this can take a few minutes.
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed. Copy the text above and send it to Claude.
    pause
    exit /b 1
  )
)
call npm start
if errorlevel 1 (
  echo.
  echo [ERROR] The app failed to start. Copy the text above and send it to Claude.
  pause
)
