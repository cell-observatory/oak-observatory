# Windows peer of open-in-oak.sh; JSON parsing is built into PowerShell.
$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
    [Console]::Error.WriteLine('OAK: ' + ($Message -replace '\s+', ' '))
    exit 1
}

function Session-From($Context) {
    foreach ($pane in @($Context, $Context.focused_pane, $Context.pane)) {
        if ($null -eq $pane) { continue }
        $ref = $pane.agent_session
        $candidates = @($pane.agent_session_id, $pane.session_id)
        if ($ref -and (-not $ref.kind -or $ref.kind -eq 'id')) {
            $candidates = @($ref.value) + $candidates
        }
        foreach ($value in $candidates) {
            if ($value -is [string] -and $value -cmatch '\A[A-Za-z0-9._-]{1,128}\z' -and $value -notin @('.', '..')) {
                return $value
            }
        }
    }
    return $null
}

function Resolve-Tool([string]$Name) {
    $tool = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($tool) { return $tool.Source }
    return $null
}

try {
    $userDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $env:HOME }
    $voltaDir = if ($env:VOLTA_HOME) { $env:VOLTA_HOME } else { "$userDir\.volta" }
    $fnmDir = if ($env:FNM_DIR) { $env:FNM_DIR } else { "$env:APPDATA\fnm" }
    $extra = @(
        "$userDir\.local\bin", "$userDir\.local\bin\herdr", "$userDir\.local\node\bin", "$env:APPDATA\npm",
        "$env:ProgramFiles\nodejs", "$voltaDir\bin", "$env:LOCALAPPDATA\Volta\bin",
        $env:NVM_HOME, $env:NVM_SYMLINK, "$fnmDir\aliases\default",
        "$env:LOCALAPPDATA\fnm\aliases\default"
    )
    if ($env:FNM_MULTISHELL_PATH) { $extra += $env:FNM_MULTISHELL_PATH }
    foreach ($pattern in @(
        "$env:NVM_HOME\v*", "$env:APPDATA\nvm\v*",
        "$fnmDir\node-versions\*\installation", "$env:LOCALAPPDATA\fnm\node-versions\*\installation"
    )) {
        $extra += @(Get-Item $pattern -ErrorAction SilentlyContinue | Where-Object { $_.PSIsContainer } | ForEach-Object { $_.FullName })
    }
    $env:PATH = (@($env:PATH) + @($extra | Where-Object { $_ })) -join ';'

    if ($env:OAK_BIN) {
        $oak = Resolve-Tool $env:OAK_BIN
        if (-not $oak) { Fail 'OAK_BIN does not name an executable' }
    } else {
        $oak = Resolve-Tool 'oak'
        if (-not $oak) { $oak = Resolve-Tool 'claude-observatory' }
        if (-not $oak) { Fail 'neither oak nor claude-observatory was found on the augmented PATH' }
    }

    $context = $null
    if ($env:HERDR_PLUGIN_CONTEXT_JSON) {
        try { $context = ConvertFrom-Json $env:HERDR_PLUGIN_CONTEXT_JSON } catch { $context = $null }
    }
    $session = Session-From $context
    if (-not $session) {
        $pane = $env:HERDR_PANE_ID
        if (-not $pane) { $pane = $context.focused_pane_id }
        if (-not $pane) { $pane = $context.pane_id }
        if ($pane -isnot [string] -or -not $pane) { Fail 'no focused pane or agent session in the plugin context' }
        $herdr = if ($env:HERDR_BIN_PATH) { Resolve-Tool $env:HERDR_BIN_PATH } else { Resolve-Tool 'herdr' }
        if (-not $herdr) { Fail 'herdr was not found on the augmented PATH; cannot resolve the focused pane session' }
        # HERDR_SOCKET_PATH is inherited; herdr handles the Windows named pipe.
        $raw = & $herdr pane get $pane 2>$null
        if ($LASTEXITCODE -ne 0) { Fail 'herdr pane get failed for the focused pane; check HERDR_SOCKET_PATH' }
        try { $response = ConvertFrom-Json ($raw -join "`n") } catch { Fail 'herdr pane get returned invalid JSON' }
        if ($response.result) { $response = $response.result }
        $session = Session-From $response
        if (-not $session) { Fail 'the focused pane has no valid agent session id' }
    }
    & $oak focus --session $session --tab observatory
    exit $LASTEXITCODE
} catch {
    Fail $_.Exception.Message
}
