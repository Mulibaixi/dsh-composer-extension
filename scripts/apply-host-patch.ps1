[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$JobPath,
  [switch]$Recover
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$job = $null
$mutex = $null
$ownsMutex = $false
$exitCode = 0

function Read-Json([string]$Path) {
  return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
}

function Full-Path([string]$Path) {
  if (-not [System.IO.Path]::IsPathRooted($Path)) { throw '任务包含非绝对路径。' }
  return [System.IO.Path]::GetFullPath($Path)
}

function Hash-File([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try { return [System.BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $algorithm.Dispose() }
}

function Read-Job {
  $value = Read-Json (Full-Path $JobPath)
  $fields = @('id', 'dshVersion', 'archivePath', 'executablePath', 'hostPid', 'desktopPid', 'helperPid', 'baseSha256',
    'candidatePath', 'candidateSha256', 'backupPath', 'permitPath', 'resultPath', 'operation')
  foreach ($property in $value.PSObject.Properties) {
    if ($fields -notcontains $property.Name) { throw ('任务包含未知字段：' + $property.Name) }
  }
  foreach ($field in @('id', 'baseSha256', 'candidateSha256')) {
    if ($value.$field -isnot [string]) { throw ('任务字段无效：' + $field) }
  }
  if ($value.id -notmatch '^[a-zA-Z0-9-]{1,80}$') { throw '任务编号无效。' }
  if ($value.dshVersion -isnot [string] -or $value.dshVersion -cnotmatch '^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$') {
    throw '任务宿主版本无效。'
  }
  foreach ($field in @('baseSha256', 'candidateSha256')) {
    if ($value.$field -cnotmatch '^[a-f0-9]{64}$') { throw ('任务校验值无效：' + $field) }
  }
  foreach ($field in @('hostPid', 'desktopPid')) {
    if ($value.$field -isnot [int] -and $value.$field -isnot [long]) { throw '宿主进程编号无效。' }
    if ($value.$field -lt 1 -or $value.$field -gt [int]::MaxValue) { throw '宿主进程编号无效。' }
  }
  if ($null -ne $value.PSObject.Properties['helperPid']) {
    if (($value.helperPid -isnot [int] -and $value.helperPid -isnot [long]) -or
      $value.helperPid -lt 1 -or $value.helperPid -gt [int]::MaxValue) { throw '安装助手进程编号无效。' }
  }
  $operationProperty = $value.PSObject.Properties['operation']
  if ($null -eq $operationProperty) { $value | Add-Member -NotePropertyName operation -NotePropertyValue 'install' }
  if ($value.operation -notin @('install', 'restore')) { throw '任务操作无效。' }
  $paths = @()
  foreach ($field in @('archivePath', 'executablePath', 'candidatePath', 'backupPath', 'permitPath', 'resultPath')) {
    if ($value.$field -isnot [string] -or [string]::IsNullOrWhiteSpace($value.$field)) {
      throw ('任务路径无效：' + $field)
    }
    $value.$field = Full-Path $value.$field
    if ($paths -contains $value.$field) { throw '任务中的文件路径不能重合。' }
    $paths += $value.$field
  }
  $installDirectory = [System.IO.Path]::GetDirectoryName($value.executablePath).TrimEnd('\', '/') + '\'
  foreach ($field in @('candidatePath', 'backupPath', 'permitPath', 'resultPath')) {
    if ($value.$field.StartsWith($installDirectory, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw '候选、备份和任务结果必须保存在 DSH 安装目录之外。'
    }
  }
  return $value
}

function Write-Result([string]$State, [string]$Message) {
  $record = [ordered]@{
    id = $job.id
    state = $State
    message = $Message
    baseSha256 = $job.baseSha256
    candidateSha256 = $job.candidateSha256
    backupPath = $job.backupPath
  }
  $directory = [System.IO.Path]::GetDirectoryName($job.resultPath)
  [void][System.IO.Directory]::CreateDirectory($directory)
  $temporary = $job.resultPath + '.' + $job.id + '.tmp'
  [System.IO.File]::WriteAllText($temporary, ($record | ConvertTo-Json -Depth 4), $utf8)
  if ([System.IO.File]::Exists($job.resultPath)) {
    [System.IO.File]::Replace($temporary, $job.resultPath, [NullString]::Value)
  } else {
    [System.IO.File]::Move($temporary, $job.resultPath)
  }
  Write-Output $Message
}

function Read-Permit {
  if (-not [System.IO.File]::Exists($job.permitPath)) { return $null }
  $value = Read-Json $job.permitPath
  if ($value.id -ne $job.id -or $value.allowed -isnot [bool]) { throw '退出许可与当前任务不匹配。' }
  return $value
}

function Matching-DshProcesses {
  # CIM failures must stop installation: an unavailable process list is not an empty list.
  $name = [System.IO.Path]::GetFileName($job.executablePath)
  $matches = @()
  foreach ($process in @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)) {
    if (-not [string]::Equals([string]$process.Name, $name, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
    if ([string]::IsNullOrWhiteSpace([string]$process.ExecutablePath)) {
      throw '无法核验同名 DSH 进程的安装路径，未替换安装文件。'
    }
    if ([string]::Equals((Full-Path $process.ExecutablePath), $job.executablePath,
      [System.StringComparison]::OrdinalIgnoreCase)) { $matches += $process }
  }
  return $matches
}

function Original-ProcessesRunning {
  foreach ($processId in @($job.hostPid, $job.desktopPid)) {
    if ($null -ne (Get-Process -Id $processId -ErrorAction SilentlyContinue)) { return $true }
  }
  return $false
}

function Remove-Temporary([string]$Path) {
  if ([System.IO.File]::Exists($Path)) { Remove-Item -LiteralPath $Path -Force }
}

function Replace-Archive([string]$Source, [string]$SourceHash, [string]$ExpectedHash, [string]$Backup) {
  $pending = $job.archivePath + '.composer-' + $job.id + '.pending'
  $rollback = $job.archivePath + '.composer-' + $job.id + '.rollback'
  try {
    if ((Hash-File $job.archivePath) -ne $ExpectedHash) {
      return @{ state = 'cancelled'; message = 'DSH 安装文件已变化，本次补丁任务已取消。' }
    }
    if ((Hash-File $Source) -ne $SourceHash) { throw '候选安装文件校验失败，未替换原包。' }
    [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($Backup))
    if ([System.IO.File]::Exists($Backup)) {
      if ((Hash-File $Backup) -ne $ExpectedHash) { throw '已有备份与本次原包不一致，未覆盖备份。' }
    } else {
      Copy-Item -LiteralPath $job.archivePath -Destination $Backup
    }
    if ((Hash-File $Backup) -ne $ExpectedHash) { throw '原包备份校验失败，未替换安装文件。' }
    Copy-Item -LiteralPath $Source -Destination $pending -Force
    if ((Hash-File $pending) -ne $SourceHash) { throw '候选复制校验失败，未替换安装文件。' }
    if ((Hash-File $job.archivePath) -ne $ExpectedHash) {
      return @{ state = 'cancelled'; message = 'DSH 安装文件在准备期间变化，本次任务已取消。' }
    }
    if (@(Matching-DshProcesses).Count -ne 0) {
      return @{ state = 'cancelled'; message = 'DSH 已重新启动，本次补丁任务已取消。' }
    }
    [System.IO.File]::Replace($pending, $job.archivePath, [NullString]::Value)
    $installedHash = Hash-File $job.archivePath
    if ($installedHash -ne $SourceHash) {
      if (@(Matching-DshProcesses).Count -eq 0 -and (Hash-File $job.archivePath) -eq $installedHash) {
        Copy-Item -LiteralPath $Backup -Destination $rollback -Force
        if ((Hash-File $rollback) -ne $ExpectedHash) { throw '安装校验失败，恢复备份校验也未通过。' }
        [System.IO.File]::Replace($rollback, $job.archivePath, [NullString]::Value)
        if ((Hash-File $job.archivePath) -ne $ExpectedHash) { throw '安装校验失败，原包恢复后校验未通过。' }
        throw '安装后校验失败，已恢复本次补丁前的安装文件。'
      }
      throw '安装后校验失败；安装文件或进程状态已变化，请使用备份恢复。'
    }
    return @{ state = 'applied'; message = '联动组件已更新，重新打开 DSH 后生效。' }
  } finally {
    Remove-Temporary $pending
    Remove-Temporary $rollback
  }
}

function Invoke-Job {
  if ($Recover) {
    if ($job.operation -ne 'install') { throw '请使用原安装任务恢复补丁前版本。' }
    if (@(Matching-DshProcesses).Count -ne 0) { throw '请先完全退出 DSH，再恢复补丁前版本。' }
    if (-not [System.IO.File]::Exists($job.resultPath)) { throw '找不到本次安装结果，未执行恢复。' }
    $previous = Read-Json $job.resultPath
    if ($previous.id -ne $job.id -or $previous.baseSha256 -ne $job.baseSha256 -or
      $previous.candidateSha256 -ne $job.candidateSha256) { throw '安装结果与当前恢复任务不匹配。' }
    if ((Hash-File $job.archivePath) -eq $job.baseSha256 -and (Hash-File $job.backupPath) -eq $job.baseSha256) {
      return @{ state = 'restored'; message = '当前安装已是本次补丁前版本。' }
    }
    if ((Hash-File $job.archivePath) -ne $job.candidateSha256) {
      return @{ state = 'cancelled'; message = '当前 DSH 已变化，不能恢复旧版本安装包。' }
    }
    $recoveryBackup = $job.backupPath + '.before-recovery'
    $outcome = Replace-Archive $job.backupPath $job.baseSha256 $job.candidateSha256 $recoveryBackup
    if ($outcome.state -eq 'applied') {
      Remove-Temporary $recoveryBackup
      return @{ state = 'restored'; message = '已恢复本次补丁前版本，可以重新打开 DSH。' }
    }
    return $outcome
  }

  while ((Original-ProcessesRunning) -or ($job.operation -eq 'restore' -and @(Matching-DshProcesses).Count -ne 0)) {
    # An explicit cancellation may release a superseded worker while Host is still running.
    $permit = Read-Permit
    if ($null -ne $permit -and -not $permit.allowed) {
      return @{ state = 'cancelled'; message = '联动组件任务已撤销，未修改安装文件。' }
    }
    Start-Sleep -Milliseconds 250
  }
  $permit = Read-Permit
  if ($null -eq $permit -or -not $permit.allowed) {
    return @{ state = 'cancelled'; message = '未取得正常退出许可，未修改安装文件。' }
  }
  if (@(Matching-DshProcesses).Count -ne 0) {
    return @{ state = 'cancelled'; message = '该安装仍有 DSH 进程或已重新启动，本次任务已取消。' }
  }
  $outcome = Replace-Archive $job.candidatePath $job.candidateSha256 $job.baseSha256 $job.backupPath
  if ($outcome.state -eq 'applied' -and $job.operation -eq 'restore') {
    return @{ state = 'restored'; message = '已恢复本次补丁前版本，重新打开 DSH 后生效。' }
  }
  return $outcome
}

try {
  $job = Read-Job
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try { $key = [System.BitConverter]::ToString($algorithm.ComputeHash($utf8.GetBytes($job.archivePath.ToLowerInvariant()))).Replace('-', '') }
  finally { $algorithm.Dispose() }
  $mutex = New-Object System.Threading.Mutex($false, ('Local\dsh-composer-host-patch-' + $key))
  try { $ownsMutex = $mutex.WaitOne(5000) }
  catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
  # A second helper must not overwrite the result belonging to the active worker.
  if (-not $ownsMutex) { return }
  $outcome = Invoke-Job
  Write-Result $outcome.state $outcome.message
} catch {
  $exitCode = 1
  $message = '联动组件操作未完成：' + $_.Exception.Message
  if ($null -ne $job -and $ownsMutex) { Write-Result 'failed' $message }
  else { [Console]::Error.WriteLine($message) }
} finally {
  if ($ownsMutex) { $mutex.ReleaseMutex() }
  if ($null -ne $mutex) { $mutex.Dispose() }
}
exit $exitCode
