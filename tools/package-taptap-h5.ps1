[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Build,
    [Parameter(Mandatory=$true)][string]$Destination
)
$ErrorActionPreference = 'Stop'
$buildRoot = (Resolve-Path -LiteralPath $Build).Path
$releaseRoot = [IO.Path]::GetFullPath($Destination)
if ($releaseRoot -eq $buildRoot -or $releaseRoot.StartsWith($buildRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Package output must be outside the build directory.'
}
if (Test-Path -LiteralPath $releaseRoot) { throw 'Refusing to overwrite an existing release directory.' }
New-Item -ItemType Directory -Path $releaseRoot | Out-Null
$manifest = Join-Path $releaseRoot 'h5-manifest.json'
& node (Join-Path $PSScriptRoot 'audit-taptap-h5.cjs') $buildRoot $manifest
if ($LASTEXITCODE -ne 0) { throw 'Build audit failed; package was not created.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = Join-Path $releaseRoot 'forest-gunner-taptap-h5.zip'
$rootFolder = 'taptap-h5'
$files = (Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).files
# The developer console requires exactly one enclosing folder, with index.html inside it.
$archive = [IO.Compression.ZipFile]::Open($zip, [IO.Compression.ZipArchiveMode]::Create)
try {
    $null = $archive.CreateEntry($rootFolder + '/')
    foreach ($file in $files) {
        $null = [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,
            (Join-Path $buildRoot $file.path), ($rootFolder + '/' + $file.path), [IO.Compression.CompressionLevel]::Optimal)
    }
} finally { $archive.Dispose() }
if ((Get-Item -LiteralPath $zip).Length -gt 300000000) { throw 'H5 ZIP exceeds the console 300 MB upload limit.' }
$archive = [IO.Compression.ZipFile]::OpenRead($zip)
try {
    if ($archive.Entries.Count -ne $files.Count + 1) { throw 'Unexpected H5 ZIP entry count.' }
    foreach ($entry in $archive.Entries) {
        if (!$entry.FullName.StartsWith($rootFolder + '/', [StringComparison]::Ordinal) -or
            $entry.FullName.Contains('\') -or $entry.FullName -match '(^|/)\.\.(/|$)') {
            throw 'H5 ZIP must contain exactly one relative root folder.'
        }
    }
    if ($null -eq $archive.GetEntry($rootFolder + '/index.html')) { throw 'H5 ZIP entry is missing inside its root folder.' }
} finally { $archive.Dispose() }
$verification = Join-Path $releaseRoot 'verified-h5'
[IO.Compression.ZipFile]::ExtractToDirectory($zip, $verification)
$verifiedManifest = Join-Path $releaseRoot 'h5-extracted-manifest.json'
$verifiedGame = Join-Path $verification $rootFolder
& node (Join-Path $PSScriptRoot 'audit-taptap-h5.cjs') $verifiedGame $verifiedManifest
if ($LASTEXITCODE -ne 0) { throw 'Extracted ZIP audit failed.' }
if ((Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $verifiedManifest -Algorithm SHA256).Hash) {
    throw 'ZIP round-trip changed the release files.'
}
# Keep this exact extracted artifact for local HTTP/browser acceptance.
$checksum = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath (Join-Path $releaseRoot 'h5-zip.sha256') -Value "$checksum  forest-gunner-taptap-h5.zip" -Encoding ascii
[ordered]@{ archiveRoot = $rootFolder; entry = "$rootFolder/index.html"; files = $files.Count;
    zipBytes = (Get-Item -LiteralPath $zip).Length; maxZipBytes = 300000000; contentsVerified = $true } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $releaseRoot 'upload-layout.json') -Encoding utf8
Write-Host "Verified H5 ZIP: $zip"
