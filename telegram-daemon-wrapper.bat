@echo off
REM telegram-daemon-wrapper.bat — keeps telegram-monitor.mjs --daemon running.
REM Task Scheduler triggers this once (at logon); this loop handles restarting
REM the daemon if it ever exits or crashes, so Task Scheduler's own simpler
REM "run once at logon" trigger is enough — no XML task definition or
REM restart-on-failure settings needed.
REM
REM All output is appended to data/logs/telegram-daemon.log. The daemon spawns
REM `claude -p` dispatches with stdio:'inherit', so a dispatch's own output and
REM crash reason surface here and nowhere else — without this redirect they go
REM to a console nobody is attached to and are lost. Added 2026-08-27 after a
REM /run cycle died mid-sweep and left no recoverable trace of why.

setlocal enabledelayedexpansion
set SCRIPT_DIR=%~dp0
set LOG_DIR=%SCRIPT_DIR%data\logs
set LOG_FILE=%LOG_DIR%\telegram-daemon.log
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

:loop
echo [%date% %time%] Starting telegram-monitor.mjs --daemon... >> "%LOG_FILE%" 2>&1
node "%SCRIPT_DIR%core\telegram-monitor.mjs" --daemon >> "%LOG_FILE%" 2>&1
echo [%date% %time%] telegram-monitor.mjs --daemon exited with code !errorlevel! (not expected during normal operation) — restarting in 5s... >> "%LOG_FILE%" 2>&1
timeout /t 5 /nobreak >nul
goto loop
