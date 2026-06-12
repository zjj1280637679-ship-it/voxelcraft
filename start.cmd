@echo off
title VoxelCraft Server
cd /d "%~dp0"
rem Open the game in the default browser once the server has had 2s to start.
rem If the port is already in use, an instance is running - the page still works.
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:8080"
node server\index.js
echo.
echo Server stopped. Press any key to close this window...
pause >nul
