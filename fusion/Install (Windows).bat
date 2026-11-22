@echo off
rem Copies the PelicanExport script into Fusion 360's AddIns folder.
set "DEST=%APPDATA%\Autodesk\Autodesk Fusion 360\API\AddIns"
if not exist "%APPDATA%\Autodesk\Autodesk Fusion 360" (
  echo Fusion 360 does not appear to be installed for this user.
  pause
  exit /b 1
)
if not exist "%DEST%" mkdir "%DEST%"
if exist "%DEST%\PelicanExport" rmdir /s /q "%DEST%\PelicanExport"
xcopy "%~dp0PelicanExport" "%DEST%\PelicanExport\" /e /i /q /y >nul
if errorlevel 1 (
  echo Copy failed.
  pause
  exit /b 1
)
echo Installed to: %DEST%\PelicanExport
echo Restart Fusion, then click Utilities ^> Pelican Export.
pause
