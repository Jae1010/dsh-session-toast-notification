#Requires -Version 5.1
<#
.SYNOPSIS
  Protocol handler for a clicked session-toast notification.

.DESCRIPTION
  Windows launches this script with the toast URL, for example
  `dsh-session-toast:?session=session-123` for a click on the body, or
  `dsh-session-toast:?action=allow&call=call-7` for a button.

  The script records what the click meant as one JSON object where the DSH page
  can pick it up, then - only for a body click - brings the app forward. The
  page polls the plugin route `/dsh-session-toast-v2/pending`, consumes the
  object, and either opens that conversation or answers the held approval.
#>
param(
  [Parameter(Position = 0)][string] $Url
)

$ErrorActionPreference = 'SilentlyContinue'

$entry = @{}
if ($Url -match '[?&]session=([^&]+)') {
  $entry['sessionId'] = [System.Uri]::UnescapeDataString($Matches[1])
}
if ($Url -match '[?&]action=([^&]+)') {
  $entry['action'] = [System.Uri]::UnescapeDataString($Matches[1])
}
if ($Url -match '[?&]call=([^&]+)') {
  $entry['call'] = [System.Uri]::UnescapeDataString($Matches[1])
}
if ($Url -match '[?&]index=(\d+)') {
  $entry['index'] = [int]$Matches[1]
}
# Which question of a batch the clicked option belongs to.
if ($Url -match '[?&]step=(\d+)') {
  $entry['step'] = [int]$Matches[1]
}

if ($entry.Count -gt 0) {
  $pending = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-session-toast-pending.txt'
  Set-Content -LiteralPath $pending -Value ($entry | ConvertTo-Json -Compress) -Encoding ASCII -NoNewline
}

# Answering an approval from the toast should not yank the user's focus away
# from whatever they were doing.
if (-not $entry.ContainsKey('action')) {
  Start-Process 'dsh://open'
}
