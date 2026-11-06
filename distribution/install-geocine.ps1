# Installs the geocine fork of Herdr on Windows: the app and herdr-core,
# both from the fork's latest GitHub release (scripts/fork-release.ps1 makes
# one):
#
#   powershell -c "irm https://raw.githubusercontent.com/geocine/herdr-app/geocine/distribution/install-geocine.ps1 | iex"
#
# Unlike the upstream installer, the core is always installed or replaced
# (the fork's app wants the fork's core: Git Bash folders, reboot restore,
# agents resumed). An hc already there is swapped the planned way (hc update
# --from), so running terminals keep running. The fork's app never updates
# itself or the core from upstream.
#
# With Git Bash installed (and HERDR_NO_GIT_BASH unset), it also makes Git
# Bash the core's shell when the core has no `shell` yet, and adds the
# folder report (OSC 9;9) to ~/.bashrc when it isn't there.
#
# HERDR_FORK_URL downloads from elsewhere (a folder, for tests: file:///C:/...);
# HERDR_INSTALL_ROOT installs into another folder than %LOCALAPPDATA%\Programs
# and then leaves PATH, the Start menu and Git Bash alone (tests).

# Its own scope: under `irm | iex` it would otherwise set the caller's variables.
& {
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# throw, not exit: under `irm | iex`, exit would close the person's window.
function Fail($why) { throw "herdr: $why" }

$repo = "geocine/herdr-app"
$from = if ($env:HERDR_FORK_URL) { $env:HERDR_FORK_URL.TrimEnd("/") } else {
    # One release for all files: GitHub caches each file's `latest` redirect
    # on its own, so right after a release they can point at different ones.
    $tag = (Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers @{ "User-Agent" = "herdr-fork-installer" }).tag_name
    if (-not $tag) { Fail "no release of $repo found" }
    Write-Host "Release $tag"
    "https://github.com/$repo/releases/download/$tag"
}
$test = [bool]$env:HERDR_INSTALL_ROOT
$root = if ($test) { $env:HERDR_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA "Programs" }
$appDir = Join-Path $root "herdr-app"
$coreDir = Join-Path $root "herdr-core"
$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($arch -ne "AMD64") { Fail "no build for $arch Windows (x64 only)" }
$appFile = "herdr-app-windows-x86_64.tar.gz"
$coreFile = "herdr-core-windows-x86_64.zip"
# Windows' own tar: Git Bash's, often first on PATH, takes C:\ for a remote host and can't open zips.
$tar = Join-Path $env:SystemRoot "System32\tar.exe"
if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue) -or -not (Test-Path $tar)) {
    Fail "needs curl.exe and tar.exe (Windows 10 1803 or newer)"
}

function Sha256($file) {
    # .NET, not Get-FileHash: that one fails when PowerShell 7 starts 5.1.
    $stream = [IO.File]::OpenRead($file)
    try { -join ([Security.Cryptography.SHA256]::Create().ComputeHash($stream) | ForEach-Object { $_.ToString("x2") }) } finally { $stream.Close() }
}

# Adds a folder to the user PATH, keeping %VARIABLES% unexpanded and the value's type.
function Add-ToPath($dir) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
    $raw = [string]$key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $listed = $raw -split ";" | Where-Object { $_.Trim().TrimEnd("\") -ieq $dir.TrimEnd("\") }
    if (-not $listed) {
        $kind = if ($key.GetValueNames() -contains "Path") { $key.GetValueKind("Path") } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
        $key.SetValue("Path", $(if ($raw) { "$($raw.TrimEnd(';'));$dir" } else { $dir }), $kind)
        # Setting any user variable tells running programs the environment changed.
        [Environment]::SetEnvironmentVariable("HERDR_INSTALLING", "1", "User")
        [Environment]::SetEnvironmentVariable("HERDR_INSTALLING", $null, "User")
    }
    $key.Close()
    if (($env:Path -split ";") -notcontains $dir) { $env:Path += ";$dir" }
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) "herdr-fork-install-$PID"
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
    Write-Host "Downloading Herdr (geocine fork)..."
    foreach ($f in "SHA256SUMS", $appFile, $coreFile) {
        curl.exe -fsSL "$from/$f" -o "$tmp\$f"
        if ($LASTEXITCODE) { Fail "cannot download $from/$f" }
    }
    $sums = @{}
    foreach ($line in Get-Content "$tmp\SHA256SUMS") {
        $hash, $name = $line -split "\s+\*?", 2
        if ($name) { $sums[$name.Trim()] = $hash.ToLower() }
    }
    foreach ($f in $appFile, $coreFile) {
        if (-not $sums[$f]) { Fail "SHA256SUMS has no line for $f" }
        if ((Sha256 "$tmp\$f") -ne $sums[$f]) { Fail "$f is damaged (checksum mismatch); try again" }
    }

    # The core first: the app finds it when it opens.
    New-Item -ItemType Directory -Force "$tmp\core" | Out-Null
    & $tar -xf "$tmp\$coreFile" -C "$tmp\core"
    $new = "$tmp\core\herdr-core.exe"
    if ($LASTEXITCODE -or -not (Test-Path "$tmp\core\conpty\conpty.dll")) { Fail "the download holds no complete herdr-core" }
    try { $version = (& $new --version) -replace "^hc ", "" }
    catch { Fail "Windows would not run the downloaded herdr-core.exe ($($_.Exception.Message.Trim())). Antivirus often holds back a new unsigned program until it has scanned it: try again in a few minutes, or ask whoever manages this PC to allow it." }
    if ($LASTEXITCODE) { Fail "the downloaded herdr-core does not run on this machine" }
    New-Item -ItemType Directory -Force $coreDir | Out-Null
    $core = Join-Path $coreDir "herdr-core.exe"
    if (Test-Path $core) {
        # Swapped the planned way, so its terminals keep running.
        # Refused when the core there is newer than the fork's: the fork needs rebuilding on it.
        $said = & $core update --from $new 2>&1 | Out-String
        if ($LASTEXITCODE) { Fail "replacing $core with the fork's $version failed: $($said.Trim())" }
        Write-Host "herdr-core updated to $version (fork)."
    } else {
        Copy-Item -Recurse -Force "$tmp\core\herdr-core.exe", "$tmp\core\conpty" $coreDir
        Write-Host "herdr-core $version (fork) installed."
    }
    # Its contents: copying the folder onto an existing one would nest it.
    New-Item -ItemType Directory -Force "$coreDir\THIRD-PARTY-NOTICES" | Out-Null
    Copy-Item -Recurse -Force "$tmp\core\THIRD-PARTY-NOTICES\*" "$coreDir\THIRD-PARTY-NOTICES" -ErrorAction SilentlyContinue
    $hc = Join-Path $coreDir "hc.exe"
    if (-not (Test-Path $hc) -and ($test -or -not (Get-Command hc -ErrorAction SilentlyContinue))) {
        New-Item -ItemType HardLink -Path $hc -Target $core | Out-Null
    }

    # The app. A running app's folder can be renamed, not deleted: the old
    # one goes now if it can, else on the next install.
    & $tar -xzf "$tmp\$appFile" -C $tmp
    if ($LASTEXITCODE -or -not (Test-Path "$tmp\herdr-app\herdr-app.exe")) { Fail "the download holds no complete app" }
    New-Item -ItemType Directory -Force $root | Out-Null
    Remove-Item -Recurse -Force "$appDir.old" -ErrorAction SilentlyContinue
    if (Test-Path $appDir) { Rename-Item $appDir "$appDir.old" }
    Move-Item "$tmp\herdr-app" $appDir
    Remove-Item -Recurse -Force "$appDir.old" -ErrorAction SilentlyContinue
    Write-Host "Herdr app (fork) installed."

    if (-not $test) {
        $menu = Join-Path ([Environment]::GetFolderPath("Programs")) "Herdr.lnk"
        $link = (New-Object -ComObject WScript.Shell).CreateShortcut($menu)
        $link.TargetPath = Join-Path $appDir "herdr-app.exe"
        $link.WorkingDirectory = $env:USERPROFILE
        $link.Description = "Terminals and coding agents that keep running"
        $link.Save()
        Add-ToPath $coreDir
        Add-ToPath $appDir
    }

    # Git Bash: the core's shell when it has none, and the folder report.
    $bash = Join-Path $env:ProgramFiles "Git\bin\bash.exe"
    if (-not (Test-Path $bash) -and (Get-Command git.exe -ErrorAction SilentlyContinue)) {
        $bash = Join-Path (Split-Path (Split-Path (Get-Command git.exe).Source)) "bin\bash.exe"
    }
    if (-not $test -and -not $env:HERDR_NO_GIT_BASH -and (Test-Path $bash)) {
        $configDir = if ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME } else { $env:APPDATA }
        $config = Join-Path $configDir "herdr-core\config.toml"
        $text = if (Test-Path $config) { [IO.File]::ReadAllText($config) } else { "" }
        if ($text -notmatch "(?m)^\s*shell\s*=") {
            New-Item -ItemType Directory -Force (Split-Path $config) | Out-Null
            # A top-level key goes before any [table].
            [IO.File]::WriteAllText($config, "shell = ['$bash', '--login', '-i']`n$text")
            Write-Host "Git Bash is now herdr-core's shell ($config)."
        }
        $bashrc = Join-Path $env:USERPROFILE ".bashrc"
        $rc = if (Test-Path $bashrc) { [IO.File]::ReadAllText($bashrc) } else { "" }
        if ($rc -notmatch "__herdr_report_cwd") {
            $hook = @'

# Report the shell's folder to herdr-core (OSC 9;9) on every prompt.
__herdr_report_cwd() {
    if [[ -n "${HC_TERMINAL_ID:-}" ]] && command -v cygpath >/dev/null 2>&1; then
        printf '\033]9;9;%s\033\\' "$(cygpath -w "$(pwd -P)")"
    fi
}
PROMPT_COMMAND="__herdr_report_cwd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
'@
            # LF only and no BOM: bash chokes on CR.
            [IO.File]::AppendAllText($bashrc, ($hook -replace "`r", "") + "`n", (New-Object Text.UTF8Encoding $false))
            Write-Host "Added the folder report to $bashrc."
        }
    }

    Write-Host "Herdr (geocine fork) is installed. Open it from the Start menu, or run: herdr-app"
    Write-Host "Optional: start herdr-core at login with `"start_core_at_login`": true in ~/.config/herdr-app/settings.json."
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
}
