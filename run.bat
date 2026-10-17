@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo [1/2] 正在创建虚拟环境...
  python -m venv .venv
  if errorlevel 1 (
    echo 创建虚拟环境失败，请确认已安装 Python 3.10+
    pause
    exit /b 1
  )
  echo [2/2] 正在安装依赖...
  ".venv\Scripts\python.exe" -m pip install -q --disable-pip-version-check -r requirements.txt
)

".venv\Scripts\python.exe" run.py %*
if errorlevel 1 pause
