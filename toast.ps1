#Requires -Version 5.1
<#
.SYNOPSIS
  Shows one Windows toast notification from a base64-encoded JSON payload.

.DESCRIPTION
  Called by the session-toast DSH plugin with Windows PowerShell 5.1, because
  the WinRT notification types it needs are unavailable in PowerShell 7.

  Payload fields: appId, tag, group, sound, volume, lines[], actions[], activationType, launch,
  flash, windowPid.
  Exit codes: 0 shown, 1 failed (the reason goes to stderr).
#>
param(
  [Parameter(Mandatory = $true)][string] $Payload
)

$ErrorActionPreference = 'Stop'

# Windows notification events cannot carry a volume, so a level below 100 is
# played from the matching Media file instead, through MCI.
$SYSTEM_SOUND_FILES = @{
  'ms-winsoundevent:Notification.Default'  = 'Windows Notify System Generic.wav'
  'ms-winsoundevent:Notification.Reminder' = 'Windows Notify Calendar.wav'
  'ms-winsoundevent:Notification.Mail'     = 'Windows Notify Email.wav'
}

# Taskbar flashing is the only way a background app can ask for attention in
# the taskbar; it keeps blinking until the window is brought forward.
Add-Type -Namespace DshWin -Name Flash -MemberDefinition @'
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct FLASHWINFO { public uint cbSize; public System.IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; }
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool FlashWindowEx(ref FLASHWINFO pwfi);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr GetForegroundWindow();
'@

Add-Type -Namespace DshSnd -Name Mci -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("winmm.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern int mciSendStringW(string command, System.Text.StringBuilder ret, int retLen, System.IntPtr hwnd);
'@

# MCI plays both wav and mp3, and `play ... wait` keeps this helper alive exactly
# as long as the sound lasts, so a short notification never gets cut off.
function Play-SoundFile([string] $File, [int] $Volume = 100) {
  $alias = 'dshsnd' + [guid]::NewGuid().ToString('N').Substring(0, 6)
  $opened = $false
  foreach ($type in @('mpegvideo', 'waveaudio', '')) {
    if ($type) {
      $command = 'open "' + $File + '" type ' + $type + ' alias ' + $alias
    } else {
      $command = 'open "' + $File + '" alias ' + $alias
    }
    if ([DshSnd.Mci]::mciSendStringW($command, $null, 0, [IntPtr]::Zero) -eq 0) {
      $opened = $true
      break
    }
  }
  if (-not $opened) { return }

  # MCI volume is 0..1000, Windows shows it as a percentage.
  if ($Volume -lt 100) {
    $level = [Math]::Max(0, [Math]::Min(100, $Volume)) * 10
    [DshSnd.Mci]::mciSendStringW(('setaudio ' + $alias + ' volume to ' + $level), $null, 0, [IntPtr]::Zero) | Out-Null
  }

  $duration = 6000
  try {
    [DshSnd.Mci]::mciSendStringW(('set ' + $alias + ' time format milliseconds'), $null, 0, [IntPtr]::Zero) | Out-Null
    $buffer = New-Object System.Text.StringBuilder 32
    [DshSnd.Mci]::mciSendStringW(('status ' + $alias + ' length'), $buffer, 32, [IntPtr]::Zero) | Out-Null
    $length = 0
    if ([int]::TryParse($buffer.ToString().Trim(), [ref] $length) -and $length -gt 0) {
      $duration = [Math]::Min($length, 6000)
    }
  }
  catch {
    $duration = 6000
  }

  try {
    [DshSnd.Mci]::mciSendStringW(('play ' + $alias + ' from 0 to ' + $duration + ' wait'), $null, 0, [IntPtr]::Zero) | Out-Null
  }
  finally {
    [DshSnd.Mci]::mciSendStringW(('close ' + $alias), $null, 0, [IntPtr]::Zero) | Out-Null
  }
}

# Flash the window that belongs to the given process. FLASHW_ALL keeps the
# taskbar button blinking (and the caption flashing) until the window is
# activated, which is what a background app is allowed to do. Skipped when the
# window is already in front, so a notification never flashes in your face.
function Invoke-Flash([int] $OwnerPid) {
  try {
    $handle = [IntPtr]::Zero
    $owner = Get-Process -Id $OwnerPid -ErrorAction SilentlyContinue
    if ($owner -and $owner.MainWindowHandle -ne 0) {
      $handle = $owner.MainWindowHandle
    } else {
      $fallback = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } |
        Select-Object -First 1)
      if ($fallback.Count -gt 0) { $handle = $fallback[0].MainWindowHandle }
    }
    if ($handle -eq [IntPtr]::Zero) { Write-Output 'flash skipped: no window'; return }

    if ([DshWin.Flash]::GetForegroundWindow() -eq $handle) {
      Write-Output 'flash skipped: already in front'
      return
    }

    $info = New-Object DshWin.Flash+FLASHWINFO
    $info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][DshWin.Flash+FLASHWINFO])
    $info.hwnd = $handle
    # FLASHW_ALL (3) | FLASHW_TIMERNOFG (12)
    $info.dwFlags = 15
    $info.uCount = 0
    $info.dwTimeout = 0
    [DshWin.Flash]::FlashWindowEx([ref] $info) | Out-Null
    Write-Output 'flash ok'
  }
  catch {
    Write-Output ('flash failed: ' + $_.Exception.Message)
  }
}

try {
  $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Payload))
  $data = $json | ConvertFrom-Json

  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $toast = $xml.CreateElement('toast')
  # A plain toast is dismissed after a few seconds; "long" keeps the body and
  # the buttons on screen long enough to read and act on them.
  $toast.SetAttribute('duration', 'long')

  # Clicking the body activates `launch` through the given activation type;
  # the plugin registers a `dsh-session-toast:` protocol for that.
  $activationType = [string]$data.activationType
  $launch = [string]$data.launch
  if (-not [string]::IsNullOrWhiteSpace($activationType)) { $toast.SetAttribute('activationType', $activationType) }
  if (-not [string]::IsNullOrWhiteSpace($launch)) { $toast.SetAttribute('launch', $launch) }

  $xml.AppendChild($toast) | Out-Null

  $visual = $xml.CreateElement('visual')
  $toast.AppendChild($visual) | Out-Null

  $binding = $xml.CreateElement('binding')
  $binding.SetAttribute('template', 'ToastGeneric')
  $visual.AppendChild($binding) | Out-Null

  foreach ($line in @($data.lines)) {
    $text = [string]$line
    if ([string]::IsNullOrWhiteSpace($text)) { continue }
    $node = $xml.CreateElement('text')
    $node.InnerText = $text
    $binding.AppendChild($node) | Out-Null
  }

  if ($binding.ChildNodes.Count -eq 0) {
    throw 'notification payload contains no text line'
  }

  # Actions come after <audio>; the schema drops an out-of-order element.
  $audio = $xml.CreateElement('audio')
  $sound = [string]$data.sound
  # `file:<path>` means "play this file instead of a system sound": the toast
  # itself stays silent and the file is played after it is shown. MCI handles
  # both wav and mp3, which SoundPlayer cannot do.
  $soundFile = ''
  if ($sound -like 'file:*') {
    $soundFile = $sound.Substring(5)
  }
  elseif (-not [string]::IsNullOrWhiteSpace($sound) -and $sound -ne 'silent' -and $volume -lt 100) {
    $mapped = $SYSTEM_SOUND_FILES[$sound]
    if ($mapped) {
      $candidate = Join-Path (Join-Path $env:WINDIR 'Media') $mapped
      if (Test-Path -LiteralPath $candidate) { $soundFile = $candidate }
    }
  }

  if ($soundFile) {
    $audio.SetAttribute('silent', 'true')
  } elseif ([string]::IsNullOrWhiteSpace($sound)) {
    $audio.SetAttribute('src', 'ms-winsoundevent:Notification.Default')
  } elseif ($sound -eq 'silent') {
    $audio.SetAttribute('silent', 'true')
  } else {
    $audio.SetAttribute('src', $sound)
  }
  $toast.AppendChild($audio) | Out-Null
$actions = @($data.actions)
  if ($actions.Count -gt 0) {
    $actionsNode = $xml.CreateElement('actions')
    $toast.AppendChild($actionsNode) | Out-Null
    foreach ($entry in $actions) {
      $label = [string]$entry.label
      $arguments = [string]$entry.arguments
      if ([string]::IsNullOrWhiteSpace($label) -or [string]::IsNullOrWhiteSpace($arguments)) { continue }
      $action = $xml.CreateElement('action')
      $action.SetAttribute('content', $label)
      $action.SetAttribute('arguments', $arguments)
      # A protocol button runs our handler exactly like a click on the body.
      $action.SetAttribute('activationType', 'protocol')
      $actionsNode.AppendChild($action) | Out-Null
    }
  }

  $volume = 100
  try {
    if ($null -ne $data.volume) { $volume = [Math]::Max(0, [Math]::Min(100, [int]$data.volume)) }
  }
  catch {
    $volume = 100
  }


  $notification = New-Object Windows.UI.Notifications.ToastNotification $xml
  $tag = [string]$data.tag
  if (-not [string]::IsNullOrWhiteSpace($tag)) { $notification.Tag = $tag }
  $group = [string]$data.group
  if (-not [string]::IsNullOrWhiteSpace($group)) { $notification.Group = $group }

  $appId = [string]$data.appId
  if ([string]::IsNullOrWhiteSpace($appId)) { $appId = 'com.deepseek.dsh' }

  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
  $notifier.Show($notification)

  # Blink the taskbar button next to the notification; the sound follows so the
  # blink starts without waiting for a long audio clip to finish.
  $ownerPid = 0
  if ($data.flash -eq $true -and [int]::TryParse([string]$data.windowPid, [ref] $ownerPid) -and $ownerPid -gt 0) {
    Invoke-Flash $ownerPid
  }

  if ($soundFile -and (Test-Path -LiteralPath $soundFile)) {
    Play-SoundFile $soundFile $volume
  }

  Write-Output 'ok'
  exit 0
}
catch {
  $message = $_.Exception.GetType().FullName + ': ' + $_.Exception.Message
  [Console]::Error.WriteLine($message)
  exit 1
}
