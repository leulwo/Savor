[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('Start', 'Stop', 'Status')]
  [string]$Action = 'Start',

  [ValidateSet('Zrok', 'Cloudflare')]
  [string]$TunnelProvider = 'Zrok',

  [string]$ProjectRoot = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
# A native tool can write routine diagnostics to stderr (for example when
# zrok's controller is temporarily unreachable). Keep those as captured output
# so the script can report/retry them instead of terminating before cleanup.
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$AppPort = 3000
$LocalOrigin = "http://127.0.0.1:$AppPort"
$EnvPath = Join-Path $ProjectRoot '.env'
$StatePath = Join-Path $ProjectRoot 'data\local-test-session.json'
$LogRoot = Join-Path $ProjectRoot 'data\local-test-logs'
$ManagedEnvKeys = @('APP_URL')

function Invoke-ZrokCommand {
  param(
    [Parameter(Mandatory)][string]$Executable,
    [Parameter(Mandatory)][string[]]$Arguments
  )
  $process = $null
  try {
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Executable
    $startInfo.Arguments = [string]::Join(' ', @($Arguments | ForEach-Object { '"' + ([string]$_).Replace('"', '\"') + '"' }))
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (!$process.Start()) { throw 'The zrok process could not be started.' }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $stdoutText = $stdoutTask.GetAwaiter().GetResult()
    $stderrText = $stderrTask.GetAwaiter().GetResult()
    $exitCode = $process.ExitCode
  } catch {
    $stdoutText = ''
    $stderrText = $_.Exception.Message
    $exitCode = 1
  } finally {
    if ($process) { $process.Dispose() }
  }
  $textParts = @()
  if ($stdoutText) { $textParts += $stdoutText.TrimEnd("`r", "`n") }
  if ($stderrText) { $textParts += $stderrText.TrimEnd("`r", "`n") }
  $text = ($textParts -join "`n").Trim()
  $output = @()
  if ($stdoutText) { $output += $stdoutText.TrimEnd("`r", "`n") -split "`r?`n" }
  if ($stderrText) { $output += $stderrText.TrimEnd("`r", "`n") -split "`r?`n" }
  if (!$text -and $exitCode -ne 0) { $text = "zrok exited with code $exitCode without diagnostic output." }
  return [pscustomobject]@{
    ExitCode = $exitCode
    Output = $output
    Text = $text
  }
}

function Read-EnvValue {
  param([string]$Content, [string]$Name)
  $pattern = "(?m)^\s*(?:export\s+)?$([regex]::Escape($Name))\s*=\s*(.*)\s*$"
  $matches = [regex]::Matches($Content, $pattern)
  if ($matches.Count -eq 0) { return @{ Exists = $false; Value = '' } }
  $value = $matches[$matches.Count - 1].Groups[1].Value.Trim()
  if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[$value.Length - 1] -eq '"') -or ($value[0] -eq "'" -and $value[$value.Length - 1] -eq "'"))) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  return @{ Exists = $true; Value = $value }
}

function Set-EnvValue {
  param([string]$Content, [string]$Name, [AllowEmptyString()][string]$Value)
  $pattern = "(?m)^\s*(?:export\s+)?$([regex]::Escape($Name))\s*=.*(?:\r?\n|$)"
  $replacement = "$Name=$Value`r`n"
  $updated = [regex]::Replace($Content, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $replacement })
  if ($updated -eq $Content -and $Content -notmatch "(?m)^\s*(?:export\s+)?$([regex]::Escape($Name))\s*=") {
    if ($updated.Length -gt 0 -and !$updated.EndsWith("`n")) { $updated += "`r`n" }
    $updated += $replacement
  }
  return $updated
}

function Remove-EnvValue {
  param([string]$Content, [string]$Name)
  $pattern = "(?m)^\s*(?:export\s+)?$([regex]::Escape($Name))\s*=.*(?:\r?\n|$)"
  return [regex]::Replace($Content, $pattern, '')
}

function Write-EnvFile {
  param([string]$Content)
  [System.IO.File]::WriteAllText($EnvPath, $Content, [System.Text.UTF8Encoding]::new($false))
}

function Get-ManagedProcess {
  param($Record)
  if (!$Record -or !$Record.Pid) { return $null }
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$($Record.Pid)" -ErrorAction SilentlyContinue
  if (!$processInfo) { return $null }
  $commandLine = [string]$processInfo.CommandLine
  if ($Record.Kind -eq 'site') {
    $expectedEntry = [regex]::Escape((Join-Path $ProjectRoot 'backend\dev.cjs'))
    $expectedRelativeEntry = 'backend[\\/]dev\.cjs'
    if ($processInfo.Name -notmatch '^node(\.exe)?$' -or ($commandLine -notmatch $expectedEntry -and $commandLine -notmatch $expectedRelativeEntry)) {
      throw "PID $($Record.Pid) no longer matches this Savory dev server; leaving it untouched."
    }
  } elseif ($Record.Kind -eq 'tunnel') {
    $provider = [string]$Record.Provider
    if (!$provider) { $provider = 'cloudflare' } # Support sessions created before provider metadata was added.
    if ($provider -eq 'zrok') {
      if ($processInfo.Name -notmatch '^zrok2(\.exe)?$' -or $commandLine -notmatch '(?i)share\s+public' -or $commandLine -notmatch '(localhost|127\.0\.0\.1):3000' -or $commandLine -notmatch '(?i)public:savory-test') {
        throw "PID $($Record.Pid) no longer matches this local zrok share; leaving it untouched."
      }
    } elseif ($provider -eq 'cloudflare') {
      if ($processInfo.Name -notmatch '^cloudflared(\.exe)?$' -or $commandLine -notmatch 'tunnel' -or $commandLine -notmatch '(localhost|127\.0\.0\.1):3000') {
        throw "PID $($Record.Pid) no longer matches this local Cloudflare tunnel; leaving it untouched."
      }
    } else {
      throw "Unknown tunnel provider in session state; leaving PID $($Record.Pid) untouched."
    }
  }
  return $processInfo
}

function Stop-ManagedRecord {
  param($Record)
  if (!$Record -or !$Record.Pid) { return }
  $processInfo = Get-ManagedProcess $Record
  if ($Record -and $Record.Kind -eq 'tunnel' -and $Record.Provider -eq 'zrok') {
    $zrokForCleanup = Join-Path $ProjectRoot 'data\tools\zrok2.exe'
    if (Test-Path -LiteralPath $zrokForCleanup) {
      $deleteResult = Invoke-ZrokCommand -Executable $zrokForCleanup -Arguments @('delete', 'share', 'public:savory-test')
      if ($deleteResult.ExitCode -ne 0 -and $deleteResult.Text -notmatch '(?i)(no live share|not found|does not exist)') {
        Write-Warning "Could not remove the zrok share record because the controller may be unavailable; continuing to stop the managed local process. Details: $($deleteResult.Text -replace '[\r\n]+', ' ')"
      }
    }
  }
  if ($processInfo) {
    Stop-Process -Id $processInfo.ProcessId -Force -ErrorAction Stop
    Write-Host "Stopped $($Record.Kind) (PID $($Record.Pid))."
  }
}

function Restore-PreviousAppUrl {
  param($State)
  if (!(Test-Path -LiteralPath $EnvPath)) { return }
  $content = [System.IO.File]::ReadAllText($EnvPath)
  if ($State.PreviousAppUrl.Exists) {
    $content = Set-EnvValue -Content $content -Name 'APP_URL' -Value $State.PreviousAppUrl.Value
  } else {
    $content = Remove-EnvValue -Content $content -Name 'APP_URL'
  }
  Write-EnvFile $content
}

function Read-State {
  if (!(Test-Path -LiteralPath $StatePath)) { return $null }
  try { return Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json }
  catch { throw "The local test state file is unreadable: $StatePath" }
}

if ($Action -eq 'Status') {
  $state = Read-State
  if (!$state) { Write-Host 'Savory local test session is not running.'; exit 0 }
  Write-Host "Site URL: $($state.LocalUrl)"
  Write-Host "$($state.Tunnel.Provider) URL: $($state.PublicUrl)"
  Write-Host "Site PID: $($state.Site.Pid) | Tunnel PID: $($state.Tunnel.Pid)"
  exit 0
}

if ($Action -eq 'Stop') {
  $state = Read-State
  if (!$state) { Write-Host 'No managed local test session was found; no processes were stopped.'; exit 0 }
  Stop-ManagedRecord $state.Tunnel
  Stop-ManagedRecord $state.Site
  $stateProvider = [string]$state.Tunnel.Provider
  if (!$stateProvider) { $stateProvider = 'cloudflare' }
  if ($stateProvider -eq 'cloudflare' -or !$state.PublicUrl) {
    Restore-PreviousAppUrl $state
    $appUrlMessage = 'restored the previous APP_URL'
  } else {
    $appUrlMessage = "kept APP_URL at the reserved URL $($state.PublicUrl)"
  }
  Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
  Write-Host "Stopped the managed site and tunnel, and $appUrlMessage."
  exit 0
}

if (!(Test-Path -LiteralPath (Join-Path $ProjectRoot 'backend\dev.cjs')) -or !(Test-Path -LiteralPath (Join-Path $ProjectRoot 'frontend')) -or !(Test-Path -LiteralPath $EnvPath)) {
  throw "Project files or .env were not found under $ProjectRoot. Set -ProjectRoot to the Savory project folder."
}
if (Read-State) { throw 'A managed session already exists. Run this script with -Action Stop first.' }

$node = Get-Command node -ErrorAction Stop
$cloudflared = $null
$zrokExecutable = $null
if ($TunnelProvider -eq 'Cloudflare') {
  $cloudflared = Get-Command cloudflared -ErrorAction Stop
} else {
  $bundledZrok = Join-Path $ProjectRoot 'data\tools\zrok2.exe'
  if (Test-Path -LiteralPath $bundledZrok) { $zrokExecutable = $bundledZrok }
  else {
    $zrokCommand = Get-Command zrok2 -ErrorAction SilentlyContinue
    if ($zrokCommand) { $zrokExecutable = $zrokCommand.Source }
  }
  if (!$zrokExecutable) { throw "zrok2 was not found. Install it from the official guide: https://netfoundry.io/docs/zrok/how-tos/install/windows/" }
}
$listener = Get-NetTCPConnection -LocalPort $AppPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) { throw "Port $AppPort is already used by PID $($listener.OwningProcess). Stop that app yourself first; this script will not kill an unrelated process." }

New-Item -ItemType Directory -Path (Split-Path $StatePath) -Force | Out-Null
New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$siteOut = Join-Path $LogRoot "site-$stamp.out.log"
$siteErr = Join-Path $LogRoot "site-$stamp.err.log"
$tunnelOut = Join-Path $LogRoot "$($TunnelProvider.ToLowerInvariant())-$stamp.out.log"
$tunnelErr = Join-Path $LogRoot "$($TunnelProvider.ToLowerInvariant())-$stamp.err.log"
$envContent = [System.IO.File]::ReadAllText($EnvPath)
$previousAppUrl = Read-EnvValue -Content $envContent -Name 'APP_URL'
$state = [ordered]@{
  StartedAt = (Get-Date).ToString('o')
  LocalUrl = $LocalOrigin
  PublicUrl = ''
  PreviousAppUrl = $previousAppUrl
  Site = $null
  Tunnel = $null
  Logs = @{ Site = $siteOut; SiteError = $siteErr; Tunnel = $tunnelOut; TunnelError = $tunnelErr }
}

try {
  $publicUrl = $null
  $tunnel = $null
  $state.Tunnel = @{ Kind = 'tunnel'; Provider = $TunnelProvider.ToLowerInvariant(); Pid = 0 }

  if ($TunnelProvider -eq 'Zrok') {
    $zrokStatusResult = $null
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      $zrokStatusResult = Invoke-ZrokCommand -Executable $zrokExecutable -Arguments @('status')
      if ($zrokStatusResult.ExitCode -eq 0) { break }
      $isTransientControllerError = $zrokStatusResult.Text -match '(?i)(TLS handshake timeout|context deadline exceeded|Client\.Timeout|connection reset|connection refused|i/o timeout|temporarily unavailable|network is unreachable|no such host|temporary failure in name resolution|unexpected EOF)'
      if (!$isTransientControllerError -or $attempt -eq 3) { break }
      Write-Warning "Could not reach the zrok controller; retrying status check ($attempt of 3)."
      Start-Sleep -Seconds 3
    }
    if ($zrokStatusResult.ExitCode -ne 0) {
      throw "Could not verify zrok right now because its controller did not respond after 3 checks. Check this PC's internet connection, then retry. Details: $($zrokStatusResult.Text -replace '[\r\n]+', ' ')"
    }
    if ($zrokStatusResult.Text -notmatch '(?is)EnvZId.{0,80}<<SET>>') {
      throw "zrok is not enabled on this PC yet. In the zrok dashboard open the zrok API console, get your account token, then run: `"$zrokExecutable`" enable <your-account-token>. Keep that token private."
    }

    $nameList = @()
    $nameListExit = 1
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      $nameListResult = Invoke-ZrokCommand -Executable $zrokExecutable -Arguments @('list', 'names')
      $nameList = $nameListResult.Output
      $nameListExit = $nameListResult.ExitCode
      if ($nameListExit -eq 0) { break }
      $nameListError = $nameListResult.Text
      $isTransientNameError = $nameListError -match '(?i)(TLS handshake timeout|context deadline exceeded|Client\.Timeout|connection reset|connection refused|i/o timeout|temporarily unavailable|network is unreachable|no such host|temporary failure in name resolution|unexpected EOF)'
      if (!$isTransientNameError -or $attempt -eq 3) { throw "Could not check zrok reserved names. Run `"$zrokExecutable`" status and confirm this PC is enabled. Details: $nameListError" }
      Write-Warning "zrok name lookup timed out; retrying ($attempt of 3)."
      Start-Sleep -Seconds 2
    }
    $hasReservedName = @($nameList | Where-Object { $_ -match '(?i)\bsavory-test\b' -and $_ -match '(?i)\bpublic\b' }).Count -gt 0
    if (!$hasReservedName) {
      $createNameResult = Invoke-ZrokCommand -Executable $zrokExecutable -Arguments @('create', 'name', '-n', 'public', 'savory-test')
      $createNameResult.Output | ForEach-Object { Write-Host $_ }
      if ($createNameResult.ExitCode -ne 0) { throw "Could not reserve public name savory-test. Check whether it is already in use in the zrok dashboard. Details: $($createNameResult.Text -replace '[\r\n]+', ' ')" }
    }

    $publicUrl = $null
    $shareReady = $false
    $lastZrokError = ''
    for ($attempt = 1; $attempt -le 3 -and !$shareReady; $attempt++) {
      $attemptSuffix = if ($attempt -eq 1) { '' } else { "-attempt-$attempt" }
      $currentTunnelOut = Join-Path $LogRoot "zrok-$stamp$attemptSuffix.out.log"
      $currentTunnelErr = Join-Path $LogRoot "zrok-$stamp$attemptSuffix.err.log"
      $state.Logs.Tunnel = $currentTunnelOut
      $state.Logs.TunnelError = $currentTunnelErr

      $tunnel = Start-Process -FilePath $zrokExecutable -ArgumentList @('share', 'public', '--headless', $LocalOrigin, '-n', 'public:savory-test') -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $currentTunnelOut -RedirectStandardError $currentTunnelErr
      $state.Tunnel = @{ Kind = 'tunnel'; Provider = 'zrok'; Pid = $tunnel.Id }
      $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $StatePath -Encoding utf8

      for ($i = 0; $i -lt 90; $i++) {
        $combinedTunnelLog = @()
        foreach ($log in @($currentTunnelOut, $currentTunnelErr)) { if (Test-Path $log) { $combinedTunnelLog += Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue } }
        $urlMatch = [regex]::Match(($combinedTunnelLog -join "`n"), '(?i)(?:https?://)?savory-test\.(?:shares|share)\.zrok\.io')
        if ($urlMatch.Success) {
          $publicUrl = $urlMatch.Value
          if ($publicUrl -notmatch '(?i)^https://') { $publicUrl = "https://$publicUrl" }
          $shareReady = $true
          break
        }
        if ($tunnel.HasExited) { $lastZrokError = $combinedTunnelLog -join "`n"; break }
        Start-Sleep -Seconds 1
      }
      if ($shareReady) { break }
      if (!$tunnel.HasExited) { throw "zrok did not report the reserved URL within 90 seconds. See $currentTunnelOut and $currentTunnelErr" }

      $shareConflict = [regex]::Match($lastZrokError, "(?is)name\s+'savory-test'\s+in\s+namespace\s+'public'\s+is\s+in\s+use\s+by\s+share\s+'([^']+)'" )
      if ($shareConflict.Success) {
        $conflictingShareToken = $shareConflict.Groups[1].Value
        $deleteConflict = Invoke-ZrokCommand -Executable $zrokExecutable -Arguments @('delete', 'share', $conflictingShareToken)
        $shareWasReleased = $deleteConflict.ExitCode -eq 0 -or $deleteConflict.Text -match '(?i)(no live share|not found|does not exist|no such share)'
        if (!$shareWasReleased) {
          throw "The reserved zrok name is held by share $conflictingShareToken, and zrok could not release it. Details: $($deleteConflict.Text -replace '[\r\n]+', ' ')"
        }
        $state.Tunnel = $null
        $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $StatePath -Encoding utf8
        if ($attempt -eq 3) { throw "Released stale zrok share $conflictingShareToken, but the reserved name remained busy. Run the script again after a few seconds." }
        Write-Warning "Released the stale zrok share holding savory-test; retrying the reserved URL ($attempt of 3)."
        Start-Sleep -Seconds 2
        continue
      }

      $isTransientFailure = $lastZrokError -match '(?i)(context deadline exceeded|Client\.Timeout|connection reset|i/o timeout|temporarily unavailable|network is unreachable|no such host|temporary failure in name resolution)'
      if (!$isTransientFailure -or $attempt -eq 3) { throw "zrok share exited before publishing $publicUrl. See $currentTunnelOut and $currentTunnelErr`n$lastZrokError" }

      $state.Tunnel = $null
      $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $StatePath -Encoding utf8
      Write-Warning "zrok's edge connection timed out; retrying ($attempt of 3)."
      Start-Sleep -Seconds 3
    }
    if (!$shareReady) { throw "zrok could not establish the reserved share after 3 attempts. Last logs: $($state.Logs.Tunnel) and $($state.Logs.TunnelError)" }
  } else {
    $lastTunnelError = ''
    for ($attempt = 1; $attempt -le 3 -and !$publicUrl; $attempt++) {
      $attemptSuffix = if ($attempt -eq 1) { '' } else { "-attempt-$attempt" }
      $currentTunnelOut = Join-Path $LogRoot "cloudflared-$stamp$attemptSuffix.out.log"
      $currentTunnelErr = Join-Path $LogRoot "cloudflared-$stamp$attemptSuffix.err.log"
      $state.Logs.Tunnel = $currentTunnelOut
      $state.Logs.TunnelError = $currentTunnelErr

      $tunnel = Start-Process -FilePath $cloudflared.Source -ArgumentList @('tunnel', '--no-autoupdate', '--url', $LocalOrigin) -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $currentTunnelOut -RedirectStandardError $currentTunnelErr
      $state.Tunnel = @{ Kind = 'tunnel'; Provider = 'cloudflare'; Pid = $tunnel.Id }
      $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $StatePath -Encoding utf8

      for ($i = 0; $i -lt 90; $i++) {
        $combinedLogs = @()
        foreach ($log in @($currentTunnelOut, $currentTunnelErr)) { if (Test-Path $log) { $combinedLogs += Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue } }
        $combinedTunnelLog = $combinedLogs -join "`n"
        $match = [regex]::Match($combinedTunnelLog, 'https://[a-z0-9-]+\.trycloudflare\.com', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        if ($match.Success) { $publicUrl = $match.Value.TrimEnd('.') ; break }
        if ($tunnel.HasExited) { $lastTunnelError = $combinedTunnelLog; break }
        Start-Sleep -Seconds 1
      }
      if ($publicUrl) { break }
      if (!$tunnel.HasExited) { throw "cloudflared did not report a Quick Tunnel URL within 90 seconds. See $currentTunnelOut and $currentTunnelErr" }

      $isDnsFailure = $lastTunnelError -match '(?i)(lookup\s+api\.trycloudflare\.com|no such host|temporary failure in name resolution|could not resolve|name resolution)'
      if (!$isDnsFailure) { throw "cloudflared exited before creating a Quick Tunnel. See $currentTunnelOut and $currentTunnelErr`n$lastTunnelError" }

      $state.Tunnel = $null
      $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $StatePath -Encoding utf8
      if ($attempt -lt 3) {
        Write-Warning "DNS could not resolve Cloudflare's Quick Tunnel API; retrying ($attempt of 3)."
        Start-Sleep -Seconds 2
      }
    }
    if (!$publicUrl) {
      throw "DNS could not resolve Cloudflare's Quick Tunnel API (api.trycloudflare.com) after 3 attempts. Check that this PC has internet and DNS access, then retry. You can diagnose with: nslookup api.trycloudflare.com. Last logs: $($state.Logs.Tunnel) and $($state.Logs.TunnelError)"
    }
  }

  $state.PublicUrl = $publicUrl
  $firebaseHost = ([uri]$publicUrl).Host
  $envContent = [System.IO.File]::ReadAllText($EnvPath)
  Write-EnvFile (Set-EnvValue -Content $envContent -Name 'APP_URL' -Value $publicUrl)
  $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $StatePath -Encoding utf8

  $siteEntry = Join-Path $ProjectRoot 'backend\dev.cjs'
  $site = Start-Process -FilePath $node.Source -ArgumentList @($siteEntry) -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $siteOut -RedirectStandardError $siteErr
  $state.Site = @{ Kind = 'site'; Pid = $site.Id }
  $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $StatePath -Encoding utf8

  $ready = $false
  $lastHealthError = 'No successful response was received.'
  for ($i = 0; $i -lt 90; $i++) {
    if ($site.HasExited) { throw "Savory exited during startup. See $siteErr" }
    try {
      $response = Invoke-WebRequest -Uri "$LocalOrigin/health" -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -eq 200) { $ready = $true; break }
      $lastHealthError = "HTTP status $($response.StatusCode)."
    } catch {
      $lastHealthError = $_.Exception.Message
    }
    Start-Sleep -Seconds 1
  }
  if (!$ready) { throw "Savory did not become ready at $LocalOrigin/health. Last probe: $lastHealthError See $siteOut and $siteErr" }

  Write-Host ''
  Write-Host 'Savory test site is running.' -ForegroundColor Green
  Write-Host "Local:  $LocalOrigin"
  Write-Host "Public: $publicUrl"
  Write-Host "APP_URL in .env was updated to $publicUrl"
  Write-Host "Chapa webhook URL for this run: $publicUrl/api/chapa/webhook"
  Write-Host "If Google sign-in requires it, add $firebaseHost to Firebase Authentication > Settings > Authorized domains."
  if ($TunnelProvider -eq 'Cloudflare') { Write-Host "The Quick Tunnel URL changes on the next start, so update Chapa's webhook URL for each run." }
  else { Write-Host 'This zrok URL is reserved and stays the same between runs. Set the Firebase authorized domain and Chapa webhook URL once.' }
  Write-Host "Logs: $LogRoot"
  Write-Host 'Stop both with: .\run-local-test.ps1 -Action Stop'
} catch {
  $cleanupFailed = $false
  if ($state.Tunnel) { try { Stop-ManagedRecord $state.Tunnel } catch { $cleanupFailed = $true; Write-Warning $_ } }
  if ($state.Site) { try { Stop-ManagedRecord $state.Site } catch { $cleanupFailed = $true; Write-Warning $_ } }
  $failedProvider = [string]$state.Tunnel.Provider
  if (!$failedProvider) { $failedProvider = 'cloudflare' }
  if ($failedProvider -eq 'cloudflare' -or !$state.PublicUrl) {
    try { Restore-PreviousAppUrl $state } catch { Write-Warning "Could not restore APP_URL: $_" }
  } else {
    Write-Host "Kept APP_URL at the reserved zrok URL $($state.PublicUrl)."
  }
  if ($cleanupFailed) {
    $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $StatePath -Encoding utf8
    Write-Warning "Cleanup was incomplete. Run this script with -Action Stop to retry; session state was kept at $StatePath"
  } else {
    Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
  }
  throw
}


