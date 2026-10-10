[CmdletBinding()]
param(
    [ValidateSet('all', 'web', 'wechat')]
    [string]$Platform = 'all',
    [string]$Environment,
    [string]$EnginePath = 'E:\CocosEditors\Creator\3.8.8\CocosCreator.exe'
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot '..'))
$logDirectory = Join-Path $workspaceRoot 'AI-Workspace\Work\v1\logs'
$lockStream = $null

try {
    $resolvedEnvironment = if ($PSBoundParameters.ContainsKey('Environment')) {
        $Environment
    } elseif ($null -ne $env:FOREST_GUNNER_ENV) {
        $env:FOREST_GUNNER_ENV
    } else {
        'production'
    }
    if ($resolvedEnvironment -cnotin @('test', 'production')) {
        throw 'FOREST_GUNNER_ENV / -Environment must be exactly test or production.'
    }
    Write-Host "Build environment: $resolvedEnvironment"
    $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $nodeCommand) { throw 'Node.js is required to inject and verify the build environment.' }
    if (-not (Test-Path -LiteralPath $EnginePath -PathType Leaf)) {
        throw "Cocos Creator 3.8.8 was not found: $EnginePath"
    }
    $engineVersion = (Get-Item -LiteralPath $EnginePath).VersionInfo.ProductVersion
    if ($engineVersion -notlike '3.8.8*') {
        throw "This project requires Creator 3.8.8; selected executable reports $engineVersion."
    }
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    try {
        $lockStream = [IO.File]::Open((Join-Path $logDirectory 'project-build.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    } catch {
        throw 'Another build started by this script is running. Wait for it to finish.'
    }
    $targets = if ($Platform -eq 'all') { @('web', 'wechat') } else { @($Platform) }
    foreach ($target in $targets) {
        $configPath = Join-Path $projectRoot ("build-{0}.json" -f $target)
        if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
            throw "Build configuration is missing: $configPath"
        }
        $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
        $stdoutLog = Join-Path $logDirectory "$target-$stamp.stdout.log"
        $stderrLog = Join-Path $logDirectory "$target-$stamp.stderr.log"
        $detailLog = Join-Path $logDirectory "$target-$stamp.build.log"
        if ($configPath.Contains(';') -or $detailLog.Contains(';')) {
            throw 'Cocos CLI does not support semicolons in these file paths.'
        }
        $buildOptions = "configPath=$configPath;logDest=$detailLog"
        $engineArguments = '--project "{0}" --build "{1}"' -f $projectRoot, $buildOptions
        Write-Host "Building $target with Creator $engineVersion..."
        Write-Host "Log: $stdoutLog"
        $buildProcess = Start-Process -FilePath $EnginePath -ArgumentList $engineArguments `
            -WorkingDirectory $projectRoot -WindowStyle Hidden -Wait -PassThru `
            -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
        $code = $buildProcess.ExitCode
        if ($code -notin @(0, 36)) {
            if (Test-Path -LiteralPath $stderrLog) { Get-Content -LiteralPath $stderrLog -Tail 25 }
            if (Test-Path -LiteralPath $stdoutLog) { Get-Content -LiteralPath $stdoutLog -Tail 25 }
            throw "Creator build failed (exit $code). Inspect $logDirectory"
        }
        $buildBase = if ($config.buildPath) { [string]$config.buildPath } else { 'project://build' }
        if ($buildBase.StartsWith('project://')) {
            $buildBase = Join-Path $projectRoot $buildBase.Substring(10)
        } elseif (-not [IO.Path]::IsPathRooted($buildBase)) {
            $buildBase = Join-Path $projectRoot $buildBase
        }
        $outputName = if ($config.outputName) { [string]$config.outputName } else { [string]$config.platform }
        $outputDirectory = Join-Path $buildBase $outputName
        $entryName = if ($target -eq 'wechat') { 'game.js' } else { 'index.html' }
        if (-not (Test-Path -LiteralPath (Join-Path $outputDirectory $entryName) -PathType Leaf)) {
            throw "Creator exited with $code, but expected output is missing: $outputDirectory\$entryName"
        }
        & $nodeCommand.Source (Join-Path $PSScriptRoot 'inject-environment.cjs') $target $outputDirectory $resolvedEnvironment
        if ($LASTEXITCODE -ne 0) {
            throw "Environment injection failed for $target; this output must not be distributed."
        }
        Write-Host "Built $target successfully (exit $code): $outputDirectory"
    }
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
} finally {
    if ($lockStream) { $lockStream.Dispose() }
}
exit 0
