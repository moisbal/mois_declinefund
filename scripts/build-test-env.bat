@echo off
setlocal
for /f "usebackq tokens=1,* delims==" %%A in (".env.ledger-test.local") do set "%%A=%%B"
if not "%TARGET_ENV%"=="TEST" exit /b 1
if not "%TEST_PROJECT_REF%"=="reviewtestxxxxxxxxxx" exit /b 1
if not "%PROD_PROJECT_REF%"=="reviewprodxxxxxxxxxx" exit /b 1
set "SUPABASE_SERVICE_ROLE_KEY=%TEST_SUPABASE_SERVICE_ROLE_KEY%"
call npm run build
exit /b %errorlevel%
