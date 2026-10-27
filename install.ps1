$ErrorActionPreference = 'Stop'
$src = 'C:\Users\HP\Desktop\work\soul-build'
$dst = 'C:\Users\HP\dsh-plugins\dsh-soul'
$backupRoot = 'C:\Users\HP\Desktop\work\old-plugins-backup'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

if (-not (Test-Path (Join-Path $src 'lib\index.js'))) { throw "source missing: $src" }
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null

# 1) backup current soul source
if (Test-Path $dst) {
  Copy-Item -LiteralPath $dst -Destination (Join-Path $backupRoot ("dsh-soul-" + $stamp)) -Recurse -Force
  Write-Output "backed up old soul source"
}

# 2) replace plugin source
Get-ChildItem -LiteralPath $dst -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force
Remove-Item -Path (Join-Path $dst '*.mjs') -Force -ErrorAction SilentlyContinue
if (Test-Path (Join-Path $dst 'node_modules')) { Remove-Item (Join-Path $dst 'node_modules') -Recurse -Force }
if (Test-Path (Join-Path $dst '.chk')) { Remove-Item (Join-Path $dst '.chk') -Recurse -Force }
Write-Output "plugin source replaced"

# 3) sync into profile node_modules
foreach ($p in @('desktop', 'dsh-tui', 'headless', 'web')) {
  $nm = "C:\Users\HP\.dsh\profiles\$p\node_modules\dsh-soul"
  if (Test-Path $nm) {
    $item = Get-Item $nm -Force
    if ($item.LinkType) { $item.Delete() } else { Remove-Item $nm -Recurse -Force }
  }
  Copy-Item -LiteralPath $dst -Destination $nm -Recurse -Force
  Write-Output "synced $p\node_modules\dsh-soul"
}

# 4) desktop cordis.patch.yml: drop dsh-companion insert block + its history comments
$patch = 'C:\Users\HP\.dsh\profiles\desktop\cordis.patch.yml'
if (Test-Path $patch) {
  Copy-Item -LiteralPath $patch -Destination (Join-Path $backupRoot ("cordis.patch.yml-" + $stamp)) -Force
  $lines = Get-Content -LiteralPath $patch -Encoding UTF8
  $out = New-Object System.Collections.Generic.List[string]
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]
    if ($line -match '^\s*#\s*dsh-companion') { continue }
    if ($line -match '^- insert:' -and ($i + 1) -lt $lines.Count -and $lines[$i + 1] -match 'dsh-companion') {
      $j = $i + 1
      while ($j -lt $lines.Count -and $lines[$j] -match '^(\s|-)') { $j++ }
      $i = $j - 1
      continue
    }
    $out.Add($line)
  }
  Set-Content -LiteralPath $patch -Value $out -Encoding UTF8
  Write-Output "desktop cordis.patch.yml cleaned"
}

# 5) remove old dsh-companion from desktop node_modules
$comp = 'C:\Users\HP\.dsh\profiles\desktop\node_modules\dsh-companion'
if (Test-Path $comp) { Remove-Item $comp -Recurse -Force; Write-Output "removed desktop dsh-companion" }

# 6) try to delete old companion db (may be locked by the running host)
$compDb = 'C:\Users\HP\.dsh\dsh-companion'
if (Test-Path $compDb) {
  try { Remove-Item $compDb -Recurse -Force; Write-Output "removed dsh-companion data dir" }
  catch { Write-Output "SKIP dsh-companion data dir (locked by running host): $($_.Exception.Message)" }
}

Write-Output "INSTALL DONE"
