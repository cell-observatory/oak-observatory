<#
.SYNOPSIS
  OAK - one-command install / update for Windows. No bash, no Git Bash, no WSL.

.DESCRIPTION
  The PowerShell peer of scripts/bootstrap.sh: downloads a GitHub Release and installs the CLI, then
  the editor extensions for whatever editors are on this machine, then optionally the capture hooks.

  Everything after the CLI is one call to `oak install-extensions`, so editor detection,
  asset download, sha256 verification and the Windows `.cmd` shim rules all live in the CLI rather than
  being reimplemented here. That is the whole reason this file can be short.

  There was no native Windows install path before this. The documented one-liner was
  `curl ... | bash`, which on Windows either fails ("bash is not recognized") or - worse, if WSL is
  installed - silently installs everything INSIDE WSL, where Claude Code on the Windows side can never
  see it.

.PARAMETER Channel
  stable (default) = tagged releases. dev = the rolling pre-release built from the dev branch: newest
  features, less soak. The choice is PERSISTED, so later `oak update` follows it.

.PARAMETER Yes
  Install the capture hooks without asking. Piped invocations (`irm ... | iex`) cannot prompt reliably,
  because the pipeline owns stdin - so without this the script prints the command instead of hanging.

.EXAMPLE
  irm https://raw.githubusercontent.com/cell-observatory/oak-observatory/main/install.ps1 | iex

.EXAMPLE
  # With options, the pipe form needs a scriptblock:
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/cell-observatory/oak-observatory/main/install.ps1))) -Channel dev
#>
[CmdletBinding()]
param(
    [ValidateSet('stable', 'dev', 'pre', 'prerelease', 'main', 'release')]
    [string]$Channel = 'stable',
    [switch]$Yes
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest's progress bar is very slow in a pipe
$Repo = 'cell-observatory/oak-observatory'

function Say  { param($m) Write-Host "$([char]0x25B8) $m" -ForegroundColor Cyan }
function Warn { param($m) Write-Host "! $m" -ForegroundColor Yellow }
function Ok   { param($m) Write-Host "$([char]0x2713) $m" -ForegroundColor Green }
function Dim  { param($m) Write-Host "  $m" -ForegroundColor DarkGray }

# Git Bash, found in the order Claude Code and `oak statusline` use: CLAUDE_CODE_GIT_BASH_PATH, Git in
# Program Files, then the bin\bash.exe beside the git on PATH. Never System32\bash.exe: that is the WSL
# launcher, which runs Linux and cannot read the status line's Windows paths.
function Find-GitBash {
    $wsl = if ($env:SystemRoot) { [IO.Path]::GetFullPath([IO.Path]::Combine($env:SystemRoot, 'System32', 'bash.exe')) }
    $cands = @()
    $set = $env:CLAUDE_CODE_GIT_BASH_PATH
    if ($set -and ((Split-Path -Leaf $set) -in 'bash.exe', 'sh.exe', 'bash', 'sh')) { $cands += $set }
    if ($env:ProgramFiles) { $cands += [IO.Path]::Combine($env:ProgramFiles, 'Git', 'bin', 'bash.exe') }
    if (${env:ProgramFiles(x86)}) { $cands += [IO.Path]::Combine(${env:ProgramFiles(x86)}, 'Git', 'bin', 'bash.exe') }
    $git = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($git) { $cands += [IO.Path]::Combine((Split-Path $git.Source), '..', 'bin', 'bash.exe') }
    foreach ($c in $cands) {
        $full = [IO.Path]::GetFullPath($c)
        if ((Test-Path -LiteralPath $full -PathType Leaf) -and $full -ne $wsl) { return $full }
    }
    return $null
}

switch ($Channel) {
    'main'       { $Channel = 'stable' }
    'release'    { $Channel = 'stable' }
    'pre'        { $Channel = 'dev' }
    'prerelease' { $Channel = 'dev' }
}

# --- prerequisites -------------------------------------------------------------------------------
# Get-Command resolves npm.cmd through PATHEXT natively - the very thing Node's spawn cannot do, and
# the reason the CLI has to route its own npm calls through cmd.exe.
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) {
    Warn 'npm not found - install Node.js 24 or newer first: https://nodejs.org/en/download'
    Dim  'or: winget install OpenJS.NodeJS.LTS'
    exit 1
}
$nodeVersion = (& node --version) -replace '^v', ''
# Parenthesised deliberately: `[int](expr)[0]` relies on cast-vs-index precedence, which is a coin flip
# to read and a real PowerShell gotcha.
# Node.js 24 or newer (core runtime.ts INDEX_NODES): OAK's local index uses the SQLite built into Node, with full-text
# search.
$nodeParts = $nodeVersion -split '\.'
if ([int]($nodeParts[0]) -lt 24) {
    Warn "OAK needs Node.js 24 or newer, and this is Node.js $nodeVersion."
    exit 1
}

# --- not inside the Claude desktop app -----------------------------------------------------------
# The Claude desktop app is an MSIX package, and what it starts runs in the package's file system virtualization: a
# new file under %APPDATA% lands in %LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming instead, where no terminal and
# no editor sees it, so `npm i -g` from there installs an oak only the app's own sessions run. A probe file written
# to %APPDATA% and found in that copy tells; any error lets the install go on (core diagnose.ts claudeDesktopPackage
# makes the same check for `oak update` and `oak install-extensions`).
$probeName = 'oak-container-probe-' + [System.IO.Path]::GetRandomFileName()
$probe = $null
$container = $null
try {
    $probe = Join-Path $env:APPDATA $probeName
    New-Item -ItemType File -Path $probe -Force | Out-Null
    $container = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Packages') -Directory -Filter 'Claude_*' -ErrorAction SilentlyContinue |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "LocalCache\Roaming\$probeName") } | Select-Object -First 1
} catch { } finally {
    if ($probe) { Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue }
}
if ($container) {
    Warn "This runs inside the Claude desktop app ($($container.Name)), where Windows keeps what an install writes under %APPDATA% in a copy only the app's own sessions see."
    Dim  'Run this installer from a normal terminal: Windows Terminal, or PowerShell from the Start menu.'
    exit 1
}

$tmp = Join-Path $env:TEMP ("oak-observatory-" + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
    # --- resolve the release ---------------------------------------------------------------------
    # The rolling pre-release keeps a FIXED `dev-latest` tag so its URLs never move; stable is whatever
    # `releases/latest` serves. The dev channel then takes the newer of the two, below.
    if ($Channel -eq 'dev') {
        Say 'Finding the newest pre-release...'
        $relUrl = "https://api.github.com/repos/$Repo/releases/tags/dev-latest"
    } else {
        Say 'Finding the latest release...'
        $relUrl = "https://api.github.com/repos/$Repo/releases/latest"
    }
    try {
        $rel = Invoke-RestMethod -Uri $relUrl -Headers @{ Accept = 'application/vnd.github+json' } -UseBasicParsing
    } catch {
        Warn "Could not reach the release API for $Repo (channel: $Channel): $($_.Exception.Message)"
        exit 1
    }
    # The dev channel serves the newest build, which right after a release is the release itself: 0.12.0 outranks
    # 0.12.0-dev.N until the next push to dev. `oak install-extensions` and `oak update` choose by that rule, as
    # bootstrap.sh does. A release outranks its own pre-releases, so it wins when its x.y.z is at least the
    # pre-release's. The release is optional here: without it the pre-release installs.
    if ($Channel -eq 'dev') {
        $xyz = {
            param($r)
            $t = "$($r.tag_name)" -replace '^[vV]', ''
            if ($t -notmatch '^\d{1,9}\.\d{1,9}\.\d{1,9}') { $t = "$($r.name)" }
            if ($t -match '(\d{1,9})\.(\d{1,9})\.(\d{1,9})') { [version]::new([int]$Matches[1], [int]$Matches[2], [int]$Matches[3]) } else { $null }
        }
        try {
            $stable = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ Accept = 'application/vnd.github+json' } -UseBasicParsing
            $pv = & $xyz $rel
            $sv = & $xyz $stable
            if ($pv -and $sv -and $sv -ge $pv) {
                $rel = $stable
                Say 'The latest release is newer than the pre-release, so the dev channel installs it.'
            }
        } catch { }
    }
    $tgz = $rel.assets | Where-Object { $_.name -like '*.tgz' } | Select-Object -First 1
    if (-not $tgz) { Warn "Release $($rel.tag_name) has no CLI tarball."; exit 1 }
    Say "Release: $($rel.tag_name)  (channel: $Channel)"

    # --- CLI ------------------------------------------------------------------------------------
    $dest = Join-Path $tmp $tgz.name
    Say 'Downloading the oak CLI...'
    Invoke-WebRequest -Uri $tgz.browser_download_url -OutFile $dest -UseBasicParsing

    # Verify the tarball before npm runs its install scripts as this user - parity with the CLI's own
    # assertDigest and bootstrap.sh. GitHub publishes `sha256:<hex>` in the asset metadata.
    if ($tgz.digest -and $tgz.digest.StartsWith('sha256:')) {
        $expected = $tgz.digest.Substring(7)
        $actual = (Get-FileHash -Path $dest -Algorithm SHA256).Hash.ToLower()
        if ($actual -ne $expected.ToLower()) {
            Warn "Integrity check FAILED for $($tgz.name)"
            Dim  "sha256 $actual != $expected - refusing to install."
            exit 1
        }
        Dim "sha256 verified ($($tgz.name))"
    } else {
        Warn "No published checksum for $($tgz.name) - skipping the integrity check."
    }

    # A pre-rename install (`claude-observatory`) owns the `claude-observatory` bin, which this package
    # also ships, and npm >=7 refuses to hand a bin to a different package (EEXIST) - remove the old
    # global first, never --force (it leaves the old package behind claiming the shared bin, and a later
    # `npm uninstall -g claude-observatory` would delete a shim belonging to the NEW install).
    # Route through cmd.exe: under $ErrorActionPreference='Stop', a redirected NATIVE stderr line
    # (e.g. an npm warn from a deprecated .npmrc key) becomes a terminating error in Windows
    # PowerShell 5.1 - the default host for the `irm | iex` one-liner - which would abort the whole
    # install on the probe. cmd swallows the streams so only the exit code reaches PowerShell.
    & cmd /c "npm ls -g claude-observatory >nul 2>nul"
    if ($LASTEXITCODE -eq 0) {
        Say 'Removing the old claude-observatory global package (renamed to oak-observatory)...'
        & npm uninstall -g claude-observatory --silent
        if ($LASTEXITCODE -ne 0) {
            Warn 'Could not remove it - if the install below fails with EEXIST, run: npm uninstall -g claude-observatory, then re-run this script.'
        }
    }

    Say 'Installing it globally (npm i -g)...'
    # Not --silent: npm's own EEXIST or permission error is the one line that says what went wrong.
    # --allow-scripts: npm 12 blocks dependency install scripts by default, node-pty's included
    # (npm 10 and 11 accept the flag and change nothing).
    & npm i -g $dest --allow-scripts=node-pty
    if ($LASTEXITCODE -ne 0) {
        Warn "Global install failed. If npm said EEXIST, another global package already owns one of OAK's commands (oak, oak-observatory, claude-observatory): uninstall it or remove the file npm named, then re-run this script. Otherwise try an elevated prompt."
        exit 1
    }
    # Release bundles carry the plugin (staged from packages/herdr-plugin/) and notices.
    # Not `npm root -g`: npm 11 and later print a UUID-shaped path segment as ***. A script npm runs is
    # handed the real global prefix, whose node_modules holds the package on Windows.
    $npmPrefix = (& npm exec --silent -c "node -p process.env.npm_config_global_prefix").Trim()
    $npmRoot = Join-Path $npmPrefix 'node_modules'
    foreach ($artifact in @('herdr-plugin/herdr-plugin.toml', 'THIRD_PARTY_NOTICES.md')) {
        $installedArtifact = Join-Path $npmRoot ("oak-observatory/dist/" + $artifact)
        if (-not (Test-Path $installedArtifact)) {
            Warn "Missing release artifact: $installedArtifact. Reinstall a complete OAK release."
            exit 1
        }
    }
    # node-pty is an OPTIONAL dependency: npm exits 0 even when it fails to install, and says nothing.
    # Only OAK's herdr tab needs it. The script catches its own failure, so nothing reaches stderr.
    & node -e "try { require(require.resolve('node-pty', { paths: [process.argv[1]] })) } catch (e) { process.exit(1) }" (Join-Path $npmRoot 'oak-observatory')
    if ($LASTEXITCODE -ne 0) {
        Warn "node-pty did not install, so OAK's herdr tab has no terminal on this machine. Everything else works, and 'oak attach' opens herdr without it."
        Dim  'Reinstall to fix it: re-run this script.'
    }
    $cli = Get-Command oak -ErrorAction SilentlyContinue
    if ($cli) { Ok "CLI ready: $($cli.Source)" }
    else {
        Warn 'oak is not on PATH yet.'
        Dim  'Open a NEW terminal (PATH is read at start-up), or check: npm prefix -g'
        exit 1
    }

    # --- editor extensions ----------------------------------------------------------------------
    # One call for the VS Code family AND JetBrains: detection, download, sha256, and the cmd.exe rules
    # that a .cmd shim needs. Nothing about editors is implemented in this script.
    Say 'Installing the editor extensions...'
    & oak install-extensions --channel $Channel
    if ($LASTEXITCODE -ne 0) { Warn 'Some editor surfaces could not be installed - see the notes above.' }

    # --- status line ----------------------------------------------------------------------------
    # Say the true thing rather than skipping quietly. The bundled status line IS a bash script that
    # parses its input with jq (and uses python3 for the token estimates), so it needs both on PATH.
    # There is no PowerShell port; porting it is a separate piece of work. The bash is Git Bash: a bare
    # `bash` here can be the WSL launcher (see Find-GitBash).
    $bash = Find-GitBash
    $jq   = Get-Command jq -ErrorAction SilentlyContinue
    if ($bash -and $jq) {
        Say 'Installing the bundled status line...'
        & oak statusline | Out-Null
        if ($LASTEXITCODE -eq 0) { Ok 'Status line installed - it appears next session.' }
        else { Warn 'The status line did not install. Everything else still works.' }
    } else {
        $missing = @()
        if (-not $bash) { $missing += 'Git Bash' }
        if (-not $jq)   { $missing += 'jq' }
        Warn "Skipped the bundled status line: $($missing -join ' and ') not found."
        Dim  'Consequence: the sidebar Usage bars and the terminal status line stay empty. Everything else works.'
        if (-not $jq)   { Dim 'winget install jqlang.jq' }
        if (-not $bash) { Dim 'winget install Git.Git' }
        Dim  'Then: oak statusline'
    }

    # --- capture hooks --------------------------------------------------------------------------
    Write-Host ''
    Warn 'Install the capture hooks with Claude Code CLOSED - a running session reverts mid-session hook edits.'
    if ($Yes) {
        & oak init
    } else {
        # `irm ... | iex` gives the pipeline stdin, so Read-Host here is unreliable. Print, do not prompt.
        Dim 'Then run:  oak init      (or re-run this installer with -Yes)'
    }

    Write-Host ''
    Say 'Health check, and herdr:'
    # --fix IS ensureHerdr(): the herdr pinned in herdr.lock (downloaded and checksum-verified only
    # when this machine has none or an older one), its claude + codex integrations, OAK's herdr
    # plugin, and its server. On Windows the release is a zip, so it expands into
    # %USERPROFILE%\.local\bin\herdr - the report says to put that directory on PATH.
    & oak doctor --fix
    Write-Host ''
    Ok "Done. Update anytime with: oak update"
}
finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
