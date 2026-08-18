@echo off
REM telegram-setup-scheduler.bat — Configure Windows Task Scheduler for Telegram polling
REM Run this as Administrator to set up automatic polling every 5 minutes

setlocal enabledelayedexpansion

REM Get the directory where this batch file is located
set SCRIPT_DIR=%~dp0
set TASK_NAME=CareerOps-Telegram-Poll
set POLL_INTERVAL_MINUTES=5

echo.
echo ========================================
echo Career-Ops Telegram Polling Setup
echo ========================================
echo.
echo This will create a Windows Task Scheduler job to poll Telegram every %POLL_INTERVAL_MINUTES% minutes.
echo Polling runs headlessly (no Claude tokens spent on empty results).
echo Messages trigger Claude routing only when they arrive.
echo.

REM Check if running as Administrator
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo ERROR: This script must be run as Administrator.
    echo Please right-click cmd.exe and select "Run as Administrator", then try again.
    pause
    exit /b 1
)

echo Creating Task Scheduler job...
echo.

REM Delete any existing task with the same name (suppress error if it doesn't exist)
schtasks /delete /tn "%TASK_NAME%" /f >nul 2>&1

REM Create the new task
REM Runs every 5 minutes, indefinitely
REM Execution happens in the career-ops directory
REM Output is logged (optional; remove if you prefer silent operation)

schtasks /create ^
  /tn "%TASK_NAME%" ^
  /tr "node \"%SCRIPT_DIR%core\telegram-monitor.mjs\"" ^
  /sc minute ^
  /mo %POLL_INTERVAL_MINUTES% ^
  /rl highest ^
  /f

if %errorLevel% equ 0 (
    echo.
    echo ✅ Task created successfully!
    echo.
    echo Task Name: %TASK_NAME%
    echo Action: node %SCRIPT_DIR%core\telegram-monitor.mjs
    echo Schedule: Every %POLL_INTERVAL_MINUTES% minutes (recurring)
    echo.
    echo The task will:
    echo  1. Poll Telegram headlessly (zero tokens if no messages)
    echo  2. Route messages via Claude only when they arrive
    echo  3. Run silently in the background
    echo.
    echo To view or edit the task:
    echo  - Open Task Scheduler (taskschd.msc)
    echo  - Navigate to: Task Scheduler Library
    echo  - Look for: %TASK_NAME%
    echo.
    echo To disable the task:
    echo  - schtasks /change /tn "%TASK_NAME%" /disable
    echo.
    echo To delete the task:
    echo  - schtasks /delete /tn "%TASK_NAME%" /f
    echo.
) else (
    echo.
    echo ❌ Failed to create task. Check that you're running as Administrator.
    echo.
)

pause
