@echo off
REM telegram-daemon-wrapper.bat — keeps telegram-monitor.mjs --daemon running.
REM Task Scheduler triggers this once (at logon); this loop handles restarting
REM the daemon if it ever exits or crashes, so Task Scheduler's own simpler
REM "run once at logon" trigger is enough — no XML task definition or
REM restart-on-failure settings needed.

setlocal enabledelayedexpansion
set SCRIPT_DIR=%~dp0

:loop
echo [%date% %time%] Starting telegram-monitor.mjs --daemon...
node "%SCRIPT_DIR%core\telegram-monitor.mjs" --daemon
echo [%date% %time%] telegram-monitor.mjs --daemon exited (this is not expected during normal operation) — restarting in 5s...
timeout /t 5 /nobreak >nul
goto loop
