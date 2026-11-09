$ErrorActionPreference = 'Stop'
$desktopRoot = Split-Path $PSScriptRoot -Parent
$tool = Get-Command ffmpeg -ErrorAction Stop
$source = $tool.Source
$binaryDir = Join-Path $desktopRoot 'bin'
New-Item -ItemType Directory -Path $binaryDir -Force | Out-Null
Copy-Item -LiteralPath $source -Destination (Join-Path $binaryDir 'ffmpeg.exe')
$probe = Get-Command ffprobe -ErrorAction Stop
Copy-Item -LiteralPath $probe.Source -Destination (Join-Path $binaryDir 'ffprobe.exe')
$distribution = Split-Path (Split-Path $source -Parent) -Parent
$licenses = Join-Path $desktopRoot 'licenses'
New-Item -ItemType Directory -Path $licenses -Force | Out-Null
foreach ($name in @('LICENSE', 'README.txt')) {
    $notice = Join-Path $distribution $name
    if (Test-Path -LiteralPath $notice) {
        $noticeName = if ($name -eq 'LICENSE') { 'FFmpeg-LICENSE.txt' } else { 'FFmpeg-README.txt' }
        Copy-Item -LiteralPath $notice -Destination (Join-Path $licenses $noticeName)
    }
}
Write-Output 'FFmpeg y FFprobe locales preparados. Conserva las licencias del distribuidor al redistribuir.'

$previousBrowserPath = $env:PLAYWRIGHT_BROWSERS_PATH
try {
    $env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $binaryDir 'playwright'
    & node (Join-Path $desktopRoot 'node_modules/playwright/cli.js') install ffmpeg
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo preparar el codificador de demos web.' }
} finally { $env:PLAYWRIGHT_BROWSERS_PATH = $previousBrowserPath }
