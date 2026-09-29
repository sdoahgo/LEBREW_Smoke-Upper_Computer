@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

node tests\smoke_protocol.test.mjs
if errorlevel 1 goto fail
node tests\comm_link.test.mjs
if errorlevel 1 goto fail
node tests\frontend_checks.test.mjs
if errorlevel 1 goto fail

echo.
echo [全部测试通过]
exit /b 0

:fail
echo.
echo [存在失败用例]
exit /b 1
