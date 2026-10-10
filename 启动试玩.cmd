@echo off
setlocal
cd /d "%~dp0"
if not defined FOREST_GUNNER_ENV set "FOREST_GUNNER_ENV=test"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is required to run the local preview.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\build.ps1" -Platform web
if errorlevel 1 (
  echo Build failed. See the log path above.
  pause
  exit /b 1
)
rem Open the portrait /play wrapper; the game itself remains available at /.
node "%~dp0tools\serve.cjs" --open
if errorlevel 1 pause
endlocal
