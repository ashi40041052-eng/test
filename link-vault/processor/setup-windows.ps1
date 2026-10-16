# Link Vault PC setup for Windows. Open PowerShell and paste:
#
#   irm https://raw.githubusercontent.com/ashi40041052-eng/test/main/link-vault/processor/setup-windows.ps1 | iex
#
# It is safe to run again: finished steps are skipped.
# Works in Windows PowerShell 5.1 and PowerShell 7. Overrides (env vars): LV_OWNER, LV_APP_REPO,
# LV_DATA_REPO, LV_APP_DIR, LV_DATA_DIR, LV_MODEL, LV_TIMES (e.g. "08:00,12:00,20:00")

function Install-LinkVault {
  $ErrorActionPreference = 'Stop'

  function Get-Setting($name, $default) {
    $v = [Environment]::GetEnvironmentVariable($name)
    if ($v) { return $v } else { return $default }
  }
  function Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Green }
  function Info($msg) { Write-Host "    $msg" }
  function Fail($msg) { Write-Host ""; Write-Host "x $msg" -ForegroundColor Red; throw 'LINKVAULT_SETUP_FAILED' }
  function Has($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
  function Refresh-Path {
    # Pick up tools installed during this session (winget / Claude Code installer).
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $local = Join-Path (Join-Path $HOME '.local') 'bin'
    $env:Path = (@($local, $machine, $user, $env:Path) | Where-Object { $_ }) -join [IO.Path]::PathSeparator
  }

  $owner = Get-Setting 'LV_OWNER' 'ashi40041052-eng'
  $appRepo = Get-Setting 'LV_APP_REPO' 'test'
  $dataRepo = Get-Setting 'LV_DATA_REPO' 'link-vault-data'
  $appDir = Get-Setting 'LV_APP_DIR' (Join-Path $HOME 'link-vault-app')
  $dataDir = Get-Setting 'LV_DATA_DIR' (Join-Path $HOME 'link-vault-data')
  $model = Get-Setting 'LV_MODEL' 'opus'
  $times = (Get-Setting 'LV_TIMES' '08:00,11:00,14:00,18:00,22:00').Split(',') | ForEach-Object { $_.Trim() }
  $procDir = Join-Path (Join-Path $appDir 'link-vault') 'processor'
  $taskName = 'LinkVaultProcessor'
  Refresh-Path

  # ---------- 1. tools ----------
  Step '1/7 必要なツールを確認（git / Node.js / Claude Code）'
  foreach ($tool in @(@{ cmd = 'git'; id = 'Git.Git' }, @{ cmd = 'node'; id = 'OpenJS.NodeJS.LTS' })) {
    if (-not (Has $tool.cmd)) {
      if (-not (Has 'winget')) { Fail "$($tool.cmd) が見つかりません。インストールしてから、もう一度実行してください" }
      Info "$($tool.cmd) をインストールします（winget）"
      winget install --id $tool.id -e --source winget --accept-package-agreements --accept-source-agreements
      Refresh-Path
      if (-not (Has $tool.cmd)) { Fail "$($tool.cmd) のインストール後、PowerShell を開き直してもう一度実行してください" }
    }
  }
  $nodeVer = (& node -p "process.versions.node").Trim()
  $parts = $nodeVer.Split('.')
  if ([int]$parts[0] -lt 20 -or ([int]$parts[0] -eq 20 -and [int]$parts[1] -lt 12)) {
    Fail "Node.js $nodeVer は古いです。20.12 以上に更新してください（winget upgrade OpenJS.NodeJS.LTS）"
  }
  Info "node $nodeVer / $((& git --version).Trim())"

  if (-not (Has 'claude')) {
    Info 'Claude Code をインストールします'
    Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
    Refresh-Path
    if (-not (Has 'claude')) { Fail 'Claude Code のインストールに失敗しました。https://code.claude.com/ の手順で入れてから再実行してください' }
  }
  $claude = (Get-Command claude).Source
  Info "claude: $claude"

  # ---------- 2. Claude login (subscription) ----------
  Step '2/7 Claude Code のログインを確認'
  function Test-ClaudeLogin {
    # Windows PowerShell 5.1 turns redirected stderr into terminating errors under 'Stop'.
    $ErrorActionPreference = 'Continue'
    $saved = $env:ANTHROPIC_API_KEY; $savedTok = $env:ANTHROPIC_AUTH_TOKEN
    $env:ANTHROPIC_API_KEY = $null; $env:ANTHROPIC_AUTH_TOKEN = $null
    Push-Location $env:TEMP
    try {
      $out = & $claude -p 'Reply with OK' --output-format json --no-session-persistence --model haiku 2>$null | Out-String
      $j = $out | ConvertFrom-Json
      return (-not $j.is_error)
    } catch { return $false }
    finally {
      Pop-Location
      $env:ANTHROPIC_API_KEY = $saved; $env:ANTHROPIC_AUTH_TOKEN = $savedTok
    }
  }
  if (Test-ClaudeLogin) {
    Info 'ログイン済みです'
  } else {
    Info 'Claude Code にログインが必要です。これから Claude Code が開きます。'
    Info '  1) ログイン方法を聞かれたら「Claude アカウント（Pro/Max）」を選ぶ（聞かれなければ /login と入力）'
    Info '  2) ブラウザでログインが終わったら、/exit と入力して Enter'
    Read-Host '    準備ができたら Enter' | Out-Null
    & $claude
    if (-not (Test-ClaudeLogin)) { Fail 'まだログインできていないようです。もう一度このコマンドを実行してください' }
    Info 'ログインできました'
  }

  # ---------- 3. app code ----------
  Step '3/7 Link Vault のプログラムを用意'
  if (Test-Path (Join-Path $appDir '.git')) {
    & git -C $appDir pull --ff-only -q
    if ($LASTEXITCODE -ne 0) { Info '（更新に失敗しましたが、手元の版で続けます）' }
  } else {
    & git clone -q "https://github.com/$owner/$appRepo.git" $appDir
    if ($LASTEXITCODE -ne 0) { Fail 'プログラムのダウンロードに失敗しました' }
  }
  Info $appDir
  Push-Location $procDir
  try {
    & npm ci --silent --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { Fail 'npm ci に失敗しました' }
  } finally { Pop-Location }

  # ---------- 4. data repo ----------
  Step "4/7 データ用リポジトリ（$dataRepo）を用意"
  if (-not (Test-Path (Join-Path $dataDir '.git'))) {
    Info '非公開リポジトリなので、GitHub のログイン画面が開くことがあります。案内に沿ってログインしてください。'
    & git clone "https://github.com/$owner/$dataRepo.git" $dataDir
    if ($LASTEXITCODE -ne 0) { Fail 'クローンに失敗しました。リポジトリ名と GitHub のログインを確認してください' }
  }
  Info $dataDir

  # ---------- 5. settings ----------
  Step '5/7 設定ファイル（.env）を作成'
  $envFile = Join-Path $procDir '.env'
  if (Test-Path $envFile) {
    Info "既にあるのでそのまま使います: $envFile"
  } else {
    $lines = @(
      "LV_DATA_DIR=$dataDir",
      'LV_BACKEND=claude-code',
      "LV_MODEL=$model",
      "LV_CLAUDE_BIN=$claude",
      'LV_MAX_PER_RUN=60'
    )
    # UTF-8 without BOM (a BOM would break the first variable name)
    [IO.File]::WriteAllText($envFile, ($lines -join "`r`n") + "`r`n", (New-Object Text.UTF8Encoding($false)))
    Info $envFile
  }

  # ---------- 6. first run ----------
  Step '6/7 試しに1回実行'
  Push-Location $procDir
  try {
    & node process.mjs
    if ($LASTEXITCODE -ne 0) { Fail "実行に失敗しました。上のエラーと $procDir\logs\ を確認してください" }
  } finally { Pop-Location }

  # ---------- 7. schedule ----------
  Step "7/7 1日の自動実行を設定（$($times -join ' / ')）"
  $node = (Get-Command node).Source
  $action = New-ScheduledTaskAction -Execute $node -Argument "`"$procDir\process.mjs`"" -WorkingDirectory $procDir
  $triggers = $times | ForEach-Object { New-ScheduledTaskTrigger -Daily -At $_ }
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RunOnlyIfNetworkAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Settings $settings `
    -Description 'Link Vault: analyze and categorize saved links' -Force | Out-Null
  # archive-only task: every 20 minutes, no AI
  $aAction = New-ScheduledTaskAction -Execute $node -Argument "`"$procDir\process.mjs`" --archive-only" -WorkingDirectory $procDir
  $aTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 20) -RepetitionDuration (New-TimeSpan -Days 3650)
  Register-ScheduledTask -TaskName "$($taskName)Archive" -Action $aAction -Trigger $aTrigger -Settings $settings `
    -Description 'Link Vault: archive saved links (every 20 min)' -Force | Out-Null
  Info 'タスクスケジューラに登録しました（PCが切れていた分は、次に起動したときに実行されます。保存は20分ごと）'

  Write-Host ''
  Write-Host 'v セットアップ完了！' -ForegroundColor Green
  Info "スマホで保存したリンクは $($times -join ' / ') に自動で分析されます。"
  Info "今すぐ分析したいとき: Start-ScheduledTask -TaskName $taskName"
  Info "ログ: $procDir\logs\"
  Info "止めたいとき: Unregister-ScheduledTask -TaskName $taskName -Confirm:`$false"
}

try { Install-LinkVault } catch {
  if ("$_" -ne 'LINKVAULT_SETUP_FAILED') { Write-Host "エラー: $_" -ForegroundColor Red }
}
