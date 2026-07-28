param([ValidateSet('up','down','logs','status')][string]$Action = 'up')
$envFile = Join-Path $PSScriptRoot '..\.env'
if (!(Test-Path $envFile)) {
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  $rootBytes = New-Object byte[] 32; $rng.GetBytes($rootBytes)
  $appBytes = New-Object byte[] 32; $rng.GetBytes($appBytes); $rng.Dispose()
  $rootPassword = [Convert]::ToBase64String($rootBytes).TrimEnd('=').Replace('+','-').Replace('/','_')
  $appPassword = [Convert]::ToBase64String($appBytes).TrimEnd('=').Replace('+','-').Replace('/','_')
  @("WEB_PORT=8085", "DB_NAME=emu", "ASSET_VERSION=v26", "MONGO_ROOT_USERNAME=wildones_root", "MONGO_ROOT_PASSWORD=$rootPassword", "MONGO_APP_USERNAME=wildones_app", "MONGO_APP_PASSWORD=$appPassword") | Set-Content -LiteralPath $envFile -Encoding utf8
}
switch ($Action) {
  'up' { docker compose up -d --build --wait }
  'down' { docker compose down }
  'logs' { docker compose logs -f }
  'status' { docker compose ps }
}
