@echo off
title Coder - AI Coding Agent
cd /d "%~dp0"

if not exist ".venv" (
    echo Creating virtual environment...
    python -m venv .venv
    if errorlevel 1 (
        echo Error: Python 3.10+ is required. Please install Python first.
        pause
        exit /b 1
    )
)

call .venv\Scripts\activate.bat

echo Installing dependencies...
pip install -r requirements.txt -q 2>nul

echo.
echo ============================================
echo   Coder - AI Coding Agent
echo   Powered by Gemma 4
echo   Running at http://localhost:5001
echo   Press Ctrl+C to stop
echo ============================================
echo.

start "" http://localhost:5001
python app.py
pause
