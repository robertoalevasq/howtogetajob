@echo off
REM telegram-daemon-scheduler.bat — Configure Windows Task Scheduler for the
REM persistent Telegram long-poll daemon (2026-08-13, replaces the 5-minute
REM scheduled-poll model in telegram-setup-scheduler.bat for lower latency).
REM
REM IMPORTANT — pick ONE of the two Telegram polling modes, never both:
REM   - telegram-setup-scheduler.bat  (CareerOps-Telegram-Poll, every 5 min)
REM   - telegram-daemon-scheduler.bat (CareerOps-Telegram-Daemon, this script)
REM Running both against the same bot token causes Telegram to reject one
REM side's getUpdates calls with a 409 Conflict. This script disables the
REM old scheduled-poll task automatically if it exists.
REM
REM Run this as Administrator.

setlocal enabledelayedexpansion

set SCRIPT_DIR=%~dp0
set TASK_NAME=CareerOps-Telegram-Daemon
set OLD_TASK_NAME=CareerOps-Telegram-Poll

echo.
echo ========================================
echo Career-Ops Telegram Daemon Setup
echo ========================================
echo.
echo This creates a Windows Task Scheduler job that starts a persistent,
echo long-polling Telegram listener at logon. Messages are picked up within
echo seconds instead of waiting for the next scheduled interval.
echo.
echo Token cost is unchanged either way: polling itself spends zero Claude
echo tokens in both modes. This only reduces latency.
echo.

REM Check if running as Administrator
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo ERROR: This script must be run as Administrator.
    echo Please right-click cmd.exe and select "Run as Administrator", then try again.
    pause
    exit /b 1
)

REM Disable the old scheduled-poll task if present, so the two never run
REM concurrently against the same bot token.
schtasks /query /tn "%OLD_TASK_NAME%" >nul 2>&1
if %errorLevel% equ 0 (
    echo Disabling old task "%OLD_TASK_NAME%" ^(would conflict with the daemon^)...
    schtasks /change /tn "%OLD_TASK_NAME%" /disable >nul 2>&1
    echo.
)

REM Delete any existing daemon task with the same name (suppress error if absent)
schtasks /delete /tn "%TASK_NAME%" /f >nul 2>&1

echo Creating Task Scheduler job...
echo.

REM Triggers once at logon; telegram-daemon-wrapper.bat's own loop keeps the
REM daemon running (restarting it if it ever exits), so no /sc minute
REM interval and no XML-based restart-on-failure settings are needed here.
schtasks /create ^
  /tn "%TASK_NAME%" ^
  /tr "\"%SCRIPT_DIR%telegram-daemon-wrapper.bat\"" ^
  /sc onlogon ^
  /rl highest ^
  /f

if %errorLevel% equ 0 (
    echo.
    echo Task created successfully!
    echo.
    echo Task Name: %TASK_NAME%
    echo Action: %SCRIPT_DIR%telegram-daemon-wrapper.bat
    echo Trigger: At logon ^(the wrapper's own loop keeps it running^)
    echo.
    echo The task will:
    echo  1. Start a persistent long-poll loop against Telegram at logon
    echo  2. Route messages via Claude only when they arrive ^(zero tokens otherwise^)
    echo  3. Auto-restart itself if it ever exits or crashes
    echo.
    echo To start it right now without logging off/on:
    echo  - schtasks /run /tn "%TASK_NAME%"
    echo.
    echo To view or edit the task:
    echo  - Open Task Scheduler ^(taskschd.msc^)
    echo  - Navigate to: Task Scheduler Library
    echo  - Look for: %TASK_NAME%
    echo.
    echo To stop and disable the daemon:
    echo  - schtasks /end /tn "%TASK_NAME%"
    echo  - schtasks /change /tn "%TASK_NAME%" /disable
    echo.
    echo To delete the task entirely:
    echo  - schtasks /delete /tn "%TASK_NAME%" /f
    echo.
) else (
    echo.
    echo Failed to create task. Check that you're running as Administrator.
    echo.
)

pause
