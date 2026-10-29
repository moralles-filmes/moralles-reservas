param(
  [string]$Container = 'margin-v2-service-sql-pg',
  [switch]$SkipBaseline
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$migrations = Join-Path $repo 'supabase\migrations'
$identity = docker inspect --format '{{.Config.Image}} {{.HostConfig.NetworkMode}} {{json .HostConfig.PortBindings}}' $Container
if ($LASTEXITCODE -ne 0 -or $identity -ne 'public.ecr.aws/supabase/postgres:17.11.0.004 none {}') {
  throw "The disposable Postgres container is not quarantined: $identity"
}
if (-not $SkipBaseline) {
  & (Join-Path $PSScriptRoot '73-template-auto-bootstrap.ps1') -Container $Container
  if ($LASTEXITCODE -ne 0) { throw 'Baseline 73 failed' }
}

function Apply-Sql([string]$Path) {
  Get-Content -LiteralPath $Path -Raw | docker exec -i $Container psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1
  if ($LASTEXITCODE -ne 0) { throw "SQL failed: $Path" }
  Write-Output ('PASS ' + [IO.Path]::GetFileName($Path))
}

# Fixture 73 deliberately omits this older production migration column.
# The new migration needs its historical prerequisite, not its provider APIs.
'alter table public.whatsapp_official_connection_grants add column if not exists replaces_channel_id uuid;' |
  docker exec -i $Container psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1
if ($LASTEXITCODE -ne 0) { throw 'Historical grant bridge failed' }

foreach ($prefix in @('20261017130000','20261017140000','20261017150000',
    '20261017170000','20261019133502','20261019183559','20261019193132','20261021190000')) {
  $file = Get-ChildItem -LiteralPath $migrations -Filter ($prefix + '*.sql') | Select-Object -First 1
  if (-not $file) { throw "Missing migration: $prefix" }
  Apply-Sql $file.FullName
}
# Run the exact raw migration a second time before exercising the fixture.
# This catches non-idempotent DDL/revoke/grant changes without masking errors.
Apply-Sql (Join-Path $migrations '20261021190000_whatsapp_v2_service_self_service.sql')
foreach ($name in @('74-template-v2-cohorts.sql','76-whatsapp-cutover-dedup.sql',
    '78-whatsapp-v2-service-self-service.sql')) {
  Apply-Sql (Join-Path $PSScriptRoot $name)
}
Write-Output 'GREEN78-LOCAL-PREFLIGHT'
