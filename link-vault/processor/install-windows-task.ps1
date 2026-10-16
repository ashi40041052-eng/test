# Registers a Windows scheduled task that runs the Link Vault processor 5 times a day.
# Missed runs (PC was off/asleep) run as soon as the PC is available again.
#
#   powershell -ExecutionPolicy Bypass -File .\install-windows-task.ps1
#   powershell -ExecutionPolicy Bypass -File .\install-windows-task.ps1 -Times "07:30","12:00","20:00"

param(
  [string[]]$Times = @("08:00", "11:00", "14:00", "18:00", "22:00"),
  [string]$TaskName = "LinkVaultProcessor"
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node -ErrorAction Stop).Source

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$here\process.mjs`"" -WorkingDirectory $here
$triggers = $Times | ForEach-Object { New-ScheduledTaskTrigger -Daily -At $_ }
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RunOnlyIfNetworkAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings `
  -Description "Link Vault: analyze and categorize saved links" -Force | Out-Null

# archive-only task: every 20 minutes, no AI (saves post text and images)
$aAction = New-ScheduledTaskAction -Execute $node -Argument "`"$here\process.mjs`" --archive-only" -WorkingDirectory $here
$aTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 20) -RepetitionDuration (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName "${TaskName}Archive" -Action $aAction -Trigger $aTrigger -Settings $settings `
  -Description "Link Vault: archive saved links (every 20 min)" -Force | Out-Null

Write-Host "Registered '$TaskName' at: $($Times -join ', ')"
Write-Host "Run now:   Start-ScheduledTask -TaskName $TaskName"
Write-Host "Logs:      $here\logs\"
Write-Host "Remove:    Unregister-ScheduledTask -TaskName $TaskName, ${TaskName}Archive -Confirm:`$false"
