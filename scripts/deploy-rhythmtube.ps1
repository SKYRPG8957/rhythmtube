param(
    [string]$GitHubOwner = "SKYRPG8957",
    [string]$RepoName = "rhythmtube",
    [string]$RenderServiceName = "rhythmtube",
    [string]$RenderOwnerId = "tea-d1rlrladbo4c738aei9g",
    [string]$RenderRegion = "singapore"
)

$ErrorActionPreference = "Stop"

if (-not $env:GITHUB_PAT) {
    throw "GITHUB_PAT environment variable is required."
}
if (-not $env:RENDER_API_KEY) {
    throw "RENDER_API_KEY environment variable is required."
}

$repoApi = "https://api.github.com/repos/$GitHubOwner/$RepoName"
$repoCreateApi = "https://api.github.com/user/repos"
$repoUrl = "https://github.com/$GitHubOwner/$RepoName"

Write-Host "[1/5] Checking/creating GitHub repository: $repoUrl"
try {
    Invoke-RestMethod -Method Get -Uri $repoApi -Headers @{ Authorization = "Bearer $($env:GITHUB_PAT)"; Accept = "application/vnd.github+json" } | Out-Null
    Write-Host "Repo exists"
}
catch {
    $body = @{ name = $RepoName; private = $true } | ConvertTo-Json
    Invoke-RestMethod -Method Post -Uri $repoCreateApi -Headers @{ Authorization = "Bearer $($env:GITHUB_PAT)"; Accept = "application/vnd.github+json" } -Body $body -ContentType "application/json" | Out-Null
    Write-Host "Repo created"
}

Write-Host "[2/5] Initializing git repository and pushing code"
if (-not (Test-Path ".git")) {
    git init | Out-Null
}
git add .
git commit -m "chore: rename project to rhythmtube and add deployment config" 2>$null
git branch -M main
git remote remove origin 2>$null
git remote add origin "https://$($env:GITHUB_PAT)@github.com/$GitHubOwner/$RepoName.git"
git push -u origin main

Write-Host "[3/5] Creating/validating Render service"
$renderHeaders = @{ Authorization = "Bearer $($env:RENDER_API_KEY)"; Accept = "application/json" }
$existing = Invoke-RestMethod -Method Get -Uri "https://api.render.com/v1/services" -Headers $renderHeaders
$found = $existing | Where-Object { $_.service.name -eq $RenderServiceName }

if (-not $found) {
    $payload = @{
        type = "web_service"
        name = $RenderServiceName
        ownerId = $RenderOwnerId
        repo = $repoUrl
        branch = "main"
        autoDeploy = "yes"
        serviceDetails = @{
            env = "node"
            runtime = "node"
            region = $RenderRegion
            plan = "free"
            healthCheckPath = "/healthz"
            envSpecificDetails = @{
                buildCommand = "npm ci && npm run build"
                startCommand = "npm run start"
            }
        }
    } | ConvertTo-Json -Depth 8

    $service = Invoke-RestMethod -Method Post -Uri "https://api.render.com/v1/services" -Headers ($renderHeaders + @{ "Content-Type" = "application/json" }) -Body $payload
    $serviceId = $service.id
    Write-Host "Render service created: $serviceId"
}
else {
    $serviceId = $found.service.id
    Write-Host "Render service already exists: $serviceId"
}

Write-Host "[4/5] Triggering deploy"
Invoke-RestMethod -Method Post -Uri "https://api.render.com/v1/services/$serviceId/deploys" -Headers ($renderHeaders + @{ "Content-Type" = "application/json" }) | Out-Null

Write-Host "[5/5] Done"
Write-Host "Dashboard: https://dashboard.render.com/web/$serviceId"
