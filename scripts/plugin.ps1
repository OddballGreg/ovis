# Herdr may have started before Bun was installed: read the current user PATH at invocation time.
param([string]$Command = 'status')
$ErrorActionPreference = 'Stop'
if (-not $env:HOME) { $env:HOME = $env:USERPROFILE }
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$env:PATH = "$env:USERPROFILE\.bun\bin;$userPath;$env:PATH"
$bun = Get-Command bun -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $bun) { throw 'Could not find a runnable Bun application (bun.exe or bun.cmd). Install Bun and try again.' }
if ($Command -eq 'start') {
    # A fresh hidden console keeps PowerShell's output pipes out of the detached server.
    $executable = $bun.Source
    $arguments = '"{0}" start' -f (Join-Path $PSScriptRoot 'plugin.ts')
    if ([IO.Path]::GetExtension($executable) -in '.cmd', '.bat') {
        # Batch shims need a command interpreter, not ShellExecute's document association.
        $arguments = '/d /s /c ""{0}" {1}"' -f $executable, $arguments
        $executable = $env:ComSpec
    }
    $child = Start-Process -FilePath $executable -ArgumentList $arguments -WindowStyle Hidden -PassThru
    $null = $child.Handle # Keep the exit code available even when start exits quickly.
    $child.WaitForExit() # -Wait would also wait for the server's descendants.
    if ($child.ExitCode -ne 0) {
        # The hidden console took the start's own words; server.log holds them and the server's.
        $log = Join-Path $env:HERDR_PLUGIN_STATE_DIR 'server.log'
        $tail = if (Test-Path -LiteralPath $log) { (Get-Content -LiteralPath $log -Tail 15) -join "`n" } else { '(no log)' }
        throw "Could not start Ovis. $log ends with:`n$tail"
    }
    Write-Output 'Ovis started'
    exit 0
}
& $bun.Source (Join-Path $PSScriptRoot 'plugin.ts') $Command
exit $LASTEXITCODE
