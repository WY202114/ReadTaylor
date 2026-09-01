param(
    [string]$Version = "9.13.0"
)

$ErrorActionPreference = "Stop"
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$destination = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "vendor\calibre"))
$expectedVendorRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "vendor"))

if (-not $destination.StartsWith($expectedVendorRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to prepare Calibre outside the ReadTaylor vendor directory."
}

$existing = Get-ChildItem -LiteralPath $destination -Recurse -Filter "ebook-convert.exe" -File -ErrorAction SilentlyContinue |
    Select-Object -First 1
if ($existing) {
    Write-Host "Calibre is already prepared at $($existing.FullName)"
    exit 0
}

$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("readtaylor-calibre-" + [guid]::NewGuid().ToString("N"))
$temporaryRoot = [System.IO.Path]::GetFullPath($temporaryRoot)
$systemTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
if (-not $temporaryRoot.StartsWith($systemTemp, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use a temporary directory outside the system temp folder."
}

$installer = Join-Path $temporaryRoot "calibre-portable-installer.exe"
$downloadURL = "https://download.calibre-ebook.com/$Version/calibre-portable-installer-$Version.exe"

try {
    New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Write-Host "Downloading official Calibre Portable $Version..."
    Invoke-WebRequest -Uri $downloadURL -OutFile $installer -UseBasicParsing

    Write-Host "Extracting Calibre into ReadTaylor/vendor/calibre..."
    $process = Start-Process -FilePath $installer -ArgumentList @($destination) -Wait -PassThru -WindowStyle Hidden
    if ($process.ExitCode -ne 0) {
        throw "Calibre Portable installer exited with code $($process.ExitCode)."
    }

    $ebookConvert = Get-ChildItem -LiteralPath $destination -Recurse -Filter "ebook-convert.exe" -File |
        Select-Object -First 1
    if (-not $ebookConvert) {
        throw "ebook-convert.exe was not found after extracting Calibre."
    }

    $sourceNotice = @"
Bundled dependency: Calibre $Version
License: GNU GPL v3
Homepage: https://calibre-ebook.com/
Corresponding source: https://download.calibre-ebook.com/$Version/calibre-$Version.tar.xz
Prepared from: $downloadURL
"@
    Set-Content -LiteralPath (Join-Path $destination "calibre-source.txt") -Value $sourceNotice -Encoding UTF8
    Write-Host "Calibre is ready: $($ebookConvert.FullName)"
}
finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}
