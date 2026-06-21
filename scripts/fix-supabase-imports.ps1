# fix-supabase-imports.ps1
# Substitui criacao local do client Supabase pelo client central de lib/jarvis.ts

$files = @(
  "app\api\calendar\upcoming\route.ts",
  "app\api\cron\memory-index\route.ts",
  "app\api\cron\notifications\route.ts",
  "app\api\finances\accounts\[id]\invoices\route.ts",
  "app\api\finances\accounts\[id]\route.ts",
  "app\api\finances\accounts\route.ts",
  "app\api\finances\budgets\route.ts",
  "app\api\finances\categories\route.ts",
  "app\api\finances\dashboard\route.ts",
  "app\api\finances\investments\accounts\[id]\positions\route.ts",
  "app\api\finances\investments\accounts\route.ts",
  "app\api\finances\investments\dashboard\route.ts",
  "app\api\finances\investments\events\route.ts",
  "app\api\finances\parse-notification\route.ts",
  "app\api\finances\summary\route.ts",
  "app\api\finances\transactions\[id]\route.ts",
  "app\api\finances\transactions\route.ts",
  "lib\chat\pipeline\style-learner.ts",
  "lib\chat\tools-executor-agenda-patch.ts",
  "lib\finances\db.ts"
)

$repoRoot = Split-Path (Get-Location) -Parent
$backupDir = Join-Path (Get-Location) "backup-supabase-fix"
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

foreach ($relPath in $files) {
    $path = Join-Path $repoRoot $relPath

    if (-not (Test-Path $path)) {
        Write-Host "NAO ENCONTRADO: $relPath" -ForegroundColor Yellow
        continue
    }

    $backupPath = Join-Path $backupDir $relPath
    New-Item -ItemType Directory -Force -Path (Split-Path $backupPath) | Out-Null
    Copy-Item $path $backupPath -Force

    $lines = Get-Content $path

    $newLines = New-Object System.Collections.Generic.List[string]
    $skipping = $false
    $insertedImport = $false

    foreach ($line in $lines) {

        # Remove a linha de import direto do createClient
        if ($line -match "import\s*\{\s*createClient\s*\}\s*from\s*'@supabase/supabase-js';") {
            continue
        }

        # Detecta inicio do bloco "const supabase = createClient("
        if ($line -match "^const\s+supabase\s*=\s*createClient\(") {
            $skipping = $true
            continue
        }

        # Enquanto estiver dentro do bloco, pula linhas ate encontrar ");"
        if ($skipping) {
            if ($line -match "\);\s*$") {
                $skipping = $false
            }
            continue
        }

        $newLines.Add($line)

        # Insere o novo import logo apos a ultima linha de import
        if (-not $insertedImport -and $line -match "^import ") {
            $nextIsImport = $false
        }
    }

    # Insere o import do client central apos o ultimo "import" encontrado no topo
    $finalLines = New-Object System.Collections.Generic.List[string]
    $lastImportIndex = -1
    for ($i = 0; $i -lt $newLines.Count; $i++) {
        if ($newLines[$i] -match "^import ") {
            $lastImportIndex = $i
        }
    }

    for ($i = 0; $i -lt $newLines.Count; $i++) {
        $finalLines.Add($newLines[$i])
        if ($i -eq $lastImportIndex) {
            $finalLines.Add("import { supabase } from '@/lib/jarvis';")
        }
    }

    Set-Content -Path $path -Value $finalLines

    Write-Host "OK: $relPath" -ForegroundColor Green
}

Write-Host ""
Write-Host "Backup salvo em: $backupDir" -ForegroundColor Cyan
Write-Host "Revise os diffs antes de commitar: git diff" -ForegroundColor Cyan