$ErrorActionPreference = 'SilentlyContinue'
$mins = [int]$env:VM_DURATION_MINUTES
if ($mins -lt 1) { $mins = 30 }
$deadline = (Get-Date).AddMinutes($mins)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 30
}
exit 0
