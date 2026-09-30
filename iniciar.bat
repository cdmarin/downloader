@echo off
title ClipSaver - Descargador Local
color 0B

echo ========================================================
echo                 Iniciando ClipSaver...
echo ========================================================
echo.

:: Comprobar si Node.js está instalado
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] No se ha encontrado Node.js. Por favor instalalo.
    pause
    exit /b
)

:: Comprobar e instalar dependencias si es necesario
if not exist "node_modules\" (
    echo [INFO] Primera ejecucion detectada. Instalando dependencias...
    echo [INFO] Esto puede tardar uno o dos minutos, por favor espera.
    set NODE_TLS_REJECT_UNAUTHORIZED=0
    call npm install
    echo.
)

:: Liberar puerto 3000 si estaba en uso por una ejecucion previa
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000" ^| findstr "LISTENING"') do taskkill /f /pid %%a >nul 2>&1

:: Abrir el navegador despues de 1 segundo
start "" "http://localhost:3000"

:: Iniciar el servidor (imprimirá las URLs para PC y Móvil)
node server.js

pause
