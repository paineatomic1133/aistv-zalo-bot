$ErrorActionPreference = 'Continue'
$tsExe = "$env:ProgramFiles\Tailscale\tailscale.exe"
function Install-NetworkPkg {
  if (Test-Path -LiteralPath $tsExe) { Write-Host "Network: da cai san"; return $true }
  $exe = Join-Path $env:RUNNER_TEMP "tailscale-setup.exe"
  try {
    Invoke-WebRequest -Uri "https://pkgs.tailscale.com/stable/tailscale-setup-full-1.98.4.exe" -OutFile $exe -UseBasicParsing -TimeoutSec 120
    if (Test-Path -LiteralPath $exe) {
      $p = Start-Process -FilePath $exe -ArgumentList @("/quiet") -Wait -PassThru -NoNewWindow
      for ($w = 0; $w -lt 20; $w++) { if (Test-Path -LiteralPath $tsExe) { break }; Start-Sleep -Seconds 2 }
    }
  } catch { Write-Host "Network EXE loi: $($_.Exception.Message)" }
  if (Test-Path -LiteralPath $tsExe) { return $true }
  return $false
}
Install-NetworkPkg | Out-Null
$null = New-Item -Path 'C:\AISTV' -ItemType Directory -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $tsExe) {
  $ip = 'pending'
  for ($t = 0; $t -lt 18; $t++) {
    try {
      $j = & $tsExe status --json 2>$null | ConvertFrom-Json
      if ($j.Self.Online -eq $true -and $j.Self.TailscaleIPs) {
        foreach ($a in $j.Self.TailscaleIPs) { $s = "$a".Trim(); if ($s -match '^\d{1,3}(\.\d{1,3}){3}$') { $ip = $s; break } }
      }
    } catch {}
    if ($ip -ne 'pending') { break }
    Start-Sleep -Seconds 5
  }
} else {
  $ip = (Invoke-RestMethod -Uri 'https://api.ipify.org?format=json' -TimeoutSec 30).ip
}
$password = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 52 | ForEach-Object { [char]$_ })
$vmUser = 'AISTV'
$sec = ConvertTo-SecureString $password -AsPlainText -Force
if (Get-LocalUser -Name $vmUser -ErrorAction SilentlyContinue) {
  Set-LocalUser -Name $vmUser -Password $sec -PasswordNeverExpires $true -ErrorAction SilentlyContinue
} else {
  New-LocalUser -Name $vmUser -Password $sec -FullName 'AI STV User' -PasswordNeverExpires -ErrorAction SilentlyContinue
}
$lu = Get-LocalUser -Name $vmUser -ErrorAction SilentlyContinue
if ($lu) { $lu | Enable-LocalUser -ErrorAction SilentlyContinue }
Add-LocalGroupMember -Group 'Administrators' -Member $vmUser -ErrorAction SilentlyContinue
Add-LocalGroupMember -Group 'Remote Desktop Users' -Member $vmUser -ErrorAction SilentlyContinue
Set-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -Name 'fDenyTSConnections' -Value 0
Enable-NetFirewallRule -DisplayGroup 'Remote Desktop' | Out-Null
# Set up wallpaper & account picture
$ws2 = if ($env:GITHUB_WORKSPACE) { $env:GITHUB_WORKSPACE } else { (Get-Location).Path }
$wpSrc = Join-Path $ws2 "img19.png"
$avSrc = Join-Path $ws2 "user.png"
$lsSrc = Join-Path $ws2 "img0.png"
$wpDst = "C:\AISTV\wallpaper.png"
$avDst = "C:\AISTV\user.png"
$lsDst = "C:\AISTV\lockscreen.png"
if (Test-Path -LiteralPath $wpSrc) { Copy-Item -LiteralPath $wpSrc -Destination $wpDst -Force; Write-Host "Wallpaper image copied" }
if (Test-Path -LiteralPath $avSrc) { Copy-Item -LiteralPath $avSrc -Destination $avDst -Force; Write-Host "Avatar image copied" }
if (Test-Path -LiteralPath $lsSrc) { Copy-Item -LiteralPath $lsSrc -Destination $lsDst -Force; Write-Host "Lockscreen image copied" }
if (Test-Path -LiteralPath $wpDst) {
  try {
    & reg.exe load "HKU\_AISTV_DEF" "C:\Users\Default\NTUSER.DAT" 2>$null
    $null = New-Item -Path "HKU:\_AISTV_DEF\Control Panel\Desktop" -Force -ErrorAction SilentlyContinue
    Set-ItemProperty -Path "HKU:\_AISTV_DEF\Control Panel\Desktop" -Name 'Wallpaper' -Value $wpDst -Force -ErrorAction SilentlyContinue
    Set-ItemProperty -Path "HKU:\_AISTV_DEF\Control Panel\Desktop" -Name 'WallpaperStyle' -Value '10' -Force -ErrorAction SilentlyContinue
    Set-ItemProperty -Path "HKU:\_AISTV_DEF\Control Panel\Desktop" -Name 'TileWallpaper' -Value '0' -Force -ErrorAction SilentlyContinue
    & reg.exe unload "HKU\_AISTV_DEF" 2>$null
  } catch { Write-Host "Wallpaper reg error: $($_.Exception.Message)" }
  try {
    $null = New-Item -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization" -Force -ErrorAction SilentlyContinue
    Set-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization" -Name 'DesktopWallpaper' -Value $wpDst -Force -ErrorAction SilentlyContinue
    Set-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization" -Name 'DesktopWallpaperStyle' -Value '10' -Force -ErrorAction SilentlyContinue
  } catch { Write-Host "Wallpaper policy error: $($_.Exception.Message)" }
}
if (Test-Path -LiteralPath $avDst) {
  try {
    $sid = (Get-LocalUser -Name $vmUser -ErrorAction SilentlyContinue).SID.Value
    if ($sid) {
      $null = New-Item -Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AccountPicture\Users\$sid" -Force -ErrorAction SilentlyContinue
      Set-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AccountPicture\Users\$sid" -Name 'Image128' -Value $avDst -Force -ErrorAction SilentlyContinue
      Set-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AccountPicture\Users\$sid" -Name 'Image240' -Value $avDst -Force -ErrorAction SilentlyContinue
      Set-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AccountPicture\Users\$sid" -Name 'Image48' -Value $avDst -Force -ErrorAction SilentlyContinue
      Write-Host "Account picture set for SID $sid"
    }
  } catch { Write-Host "Avatar reg error: $($_.Exception.Message)" }
}

$runId = if ($env:GITHUB_RUN_ID) { $env:GITHUB_RUN_ID } else { '0' }
$tsHostname = "STV-VM-$runId"
Write-Host "Hostname: $tsHostname"
Write-Host "IP: $ip"
Write-Host "Username: $vmUser"
Write-Host "Password: $password"
$ws = if ($env:GITHUB_WORKSPACE) { $env:GITHUB_WORKSPACE } else { (Get-Location).Path }
$credsPath = Join-Path $ws 'vm-creds.json'
@{ hostname = $tsHostname; ip = $ip; username = $vmUser; password = $password; login = $vmUser; instance_id = $env:INSTANCE_ID; discord_id = $env:DISCORD_ID; kind = 'windows'; run_id = $runId } | ConvertTo-Json | Set-Content -LiteralPath $credsPath -Encoding utf8
if (-not (Test-Path -LiteralPath $credsPath)) { Write-Error "vm-creds.json not created"; exit 1 }
exit 0
