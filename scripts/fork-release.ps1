# Builds the geocine fork for Windows and packs what
# distribution/install-geocine.ps1 downloads, into dist/fork:
#
#   herdr-app-windows-x86_64.tar.gz   herdr-app/ (exe, icon, notices)
#   herdr-core-windows-x86_64.zip     herdr-core.exe, conpty/, notices
#   SHA256SUMS
#
#   scripts/fork-release.ps1                 build and pack
#   scripts/fork-release.ps1 -Publish        then a GitHub release on geocine/herdr-app (needs gh)
#   scripts/fork-release.ps1 -Core <dir>     the herdr-core checkout (default: ..\herdr-core)
#   scripts/fork-release.ps1 -CoreExe <exe>  pack this herdr-core.exe instead of building one
#                                            (one antivirus already lets run: a fresh unsigned
#                                            build can be blocked until it has been scanned)
#
# The app is built without HERDR_APP_RELEASE, so it never updates itself or
# the core from upstream (src/update.rs). Building needs what the two repos
# need anyway: ZIG and LIBCLANG_PATH set, cargo, Git Bash (for the notices).
#
# Both builds read from git where they sit against upstream (their build.rs:
# the upstream commit, the fork's commits on top), shown in Settings > Updates.
# The release tag doesn't exist yet while they build, so -Publish hands it to
# them as HERDR_BUILD_TAG (a -CoreExe core keeps whatever it was built with).
param(
    [string]$Core = (Join-Path $PSScriptRoot "..\..\herdr-core"),
    [string]$CoreExe,
    [switch]$Publish,
    [string]$Repo = "geocine/herdr-app"
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$app = Resolve-Path (Join-Path $PSScriptRoot "..")
$Core = Resolve-Path $Core
$tar = Join-Path $env:SystemRoot "System32\tar.exe"
$out = Join-Path $app "dist\fork"
$stage = Join-Path ([IO.Path]::GetTempPath()) "herdr-fork-release-$PID"
$tag = if ($Publish) { "geocine-" + (Get-Date -Format "yyyyMMdd-HHmm") } else { $null }
# Put back after: the caller's later builds must not carry this release's tag.
$givenTag = $env:HERDR_BUILD_TAG

# Continue: Windows PowerShell turns a program's stderr (cargo's progress) into errors.
function Run($what) {
    $ErrorActionPreference = "Continue"
    & $what[0] $what[1..($what.Length - 1)]
    if ($LASTEXITCODE) { throw "failed: $what" }
}

# The upstream commit a checkout is based on (short), as build.rs finds it.
function UpstreamBase($repo) {
    foreach ($ref in "upstream/master", "origin/master", "master") {
        $found = git -C $repo rev-parse --verify -q "$ref^{commit}"
        if ($found) { return (git -C $repo rev-parse --short (git -C $repo merge-base HEAD $ref)).Trim() }
    }
    "unknown"
}

try {
    if ($tag) { $env:HERDR_BUILD_TAG = $tag } else { Remove-Item Env:HERDR_BUILD_TAG -ErrorAction SilentlyContinue }
    Remove-Item -Recurse -Force $out, $stage -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force $out, "$stage\core\THIRD-PARTY-NOTICES", "$stage\app\herdr-app" | Out-Null

    if ($CoreExe) {
        $coreExe = Resolve-Path $CoreExe
    } else {
        Write-Host "Building herdr-core ($Core)..."
        Push-Location $Core
        try { Run @("cargo", "build", "--release", "--locked", "-p", "herdr-core") } finally { Pop-Location }
        $coreExe = Join-Path $Core "target\release\herdr-core.exe"
    }
    Copy-Item $coreExe "$stage\core\"
    Copy-Item (Join-Path $Core "LICENSE") "$stage\core\"
    Copy-Item (Join-Path $Core "crates\herdr-core\THIRD-PARTY-NOTICES") "$stage\core\THIRD-PARTY-NOTICES\herdr-core.txt"
    Copy-Item (Join-Path $Core "distribution\windows\*") "$stage\core\THIRD-PARTY-NOTICES\"
    $conpty = Join-Path $Core "target\release\conpty"
    if (Test-Path "$conpty\conpty.dll") { Copy-Item -Recurse $conpty "$stage\core\" }
    else { & (Join-Path $Core "scripts\fetch-conpty.ps1") -Dest "$stage\core" }
    & $tar -a -cf "$out\herdr-core-windows-x86_64.zip" -C "$stage\core" herdr-core.exe conpty LICENSE THIRD-PARTY-NOTICES
    if ($LASTEXITCODE) { throw "zipping the core failed" }

    Write-Host "Building herdr-app ($app)..."
    Remove-Item Env:HERDR_APP_RELEASE -ErrorAction SilentlyContinue
    Push-Location $app
    try { Run @("cargo", "build", "--release", "--locked") } finally { Pop-Location }
    Copy-Item (Join-Path $app "target\release\herdr-app.exe") "$stage\app\herdr-app\"
    Copy-Item (Join-Path $app "assets\icons\herdr-ui-icon-clean.svg") "$stage\app\herdr-app\herdr-app.svg"
    Copy-Item (Join-Path $app "LICENSE"), (Join-Path $app "THIRD-PARTY-NOTICES") "$stage\app\herdr-app\"
    & $tar -czf "$out\herdr-app-windows-x86_64.tar.gz" -C "$stage\app" herdr-app
    if ($LASTEXITCODE) { throw "packing the app failed" }

    $sums = Get-ChildItem $out -File | ForEach-Object { "$((Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower())  $($_.Name)" }
    [IO.File]::WriteAllText("$out\SHA256SUMS", ($sums -join "`n") + "`n")

    $appVersion = (Select-String -Path (Join-Path $app "Cargo.toml") -Pattern '^version = "(.*)"' | Select-Object -First 1).Matches[0].Groups[1].Value
    $coreVersion = (Select-String -Path (Join-Path $Core "crates\herdr-core\Cargo.toml") -Pattern '^version = "(.*)"' | Select-Object -First 1).Matches[0].Groups[1].Value
    $appSha = (git -C $app rev-parse --short HEAD).Trim()
    $coreSha = (git -C $Core rev-parse --short HEAD).Trim()
    $appBase = UpstreamBase $app
    $coreBase = UpstreamBase $Core
    Write-Host "Packed into ${out}: app $appVersion ($appSha, upstream $appBase), core $coreVersion ($coreSha, upstream $coreBase)"

    if ($Publish) {
        if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw "-Publish needs the GitHub CLI (winget install GitHub.cli, then gh auth login)" }
        $notes = "herdr-app $appVersion ($appSha) and herdr-core $coreVersion ($coreSha), geocine fork, Windows x64. Based on upstream herdr-app $appBase and herdr-core $coreBase.`n`nInstall:`n``````powershell`npowershell -c `"irm https://raw.githubusercontent.com/$Repo/geocine/distribution/install-geocine.ps1 | iex`"`n``````"
        # A file: Windows PowerShell mangles quotes inside a program's arguments.
        $notesFile = Join-Path $stage "notes.md"
        [IO.File]::WriteAllText($notesFile, $notes)
        Run @("gh", "release", "create", $tag, "--repo", $Repo, "--target", "geocine", "--title", "Herdr geocine $tag", "--notes-file", $notesFile,
            "$out\herdr-app-windows-x86_64.tar.gz", "$out\herdr-core-windows-x86_64.zip", "$out\SHA256SUMS")
        Write-Host "Published $tag on $Repo."
    }
} finally {
    if ($null -ne $givenTag) { $env:HERDR_BUILD_TAG = $givenTag } else { Remove-Item Env:HERDR_BUILD_TAG -ErrorAction SilentlyContinue }
    Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
}
