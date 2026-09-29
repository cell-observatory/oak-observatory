package com.cellobservatory.observatory.core

import com.cellobservatory.observatory.settings.ObservatorySettings
import java.nio.file.Path
import java.nio.file.Paths

/**
 * Single source of truth for Claude paths — mirrors core's paths.ts/session.ts exactly.
 * Everything lives under CLAUDE_CONFIG_DIR (settings override first, then the env var Claude Code
 * itself honors), defaulting to ~/.claude — devcontainers relocate it onto a persistent volume.
 */
object ClaudePaths {
    /**
     * Test seam: unit tests point the whole path layer at a temp dir without an IDE application.
     *
     * Assigning it drops [rootCache], because the store root is derived from this and cached for a
     * second: without that, a test that redirected the seam and then wrote its fixture could create
     * the session directory under the PREVIOUS test's root and write `log.jsonl` under its own, one
     * cache expiry apart. That failed as `NoSuchFileException` in whichever test happened to run
     * second — a cross-test order dependency, invisible when the test was run alone.
     */
    @Volatile
    var configDirOverride: Path? = null
        set(value) {
            field = value
            forgetRoot()
        }

    fun configDir(): Path {
        configDirOverride?.let { return it }
        // runCatching: the settings service needs a running Application — absent in unit tests
        // and during very early startup; fall back to the env var Claude Code itself honors.
        val fromSettings = runCatching { ObservatorySettings.instance.state.configDir }.getOrNull()
        if (!fromSettings.isNullOrBlank()) return Paths.get(fromSettings)
        System.getenv("CLAUDE_CONFIG_DIR")?.takeIf { it.isNotBlank() }?.let { return Paths.get(it) }
        return Paths.get(System.getProperty("user.home"), ".claude")
    }

    /**
     * The edit store root — `prefs.storeDir` when the reader has moved it, else
     * `<config>/claude-observatory`.
     *
     * This used to be the second half unconditionally, which was correct only while the store could
     * not move. It can now, from this plugin's own "Store location…" popup as well as from the
     * terminal app and VS Code — and every DIRECT read on the Kotlin side goes through here:
     * StoreReader's log/blob/session readers and StoreWatcher's polling root. Ignoring the setting
     * left them all pointed at an abandoned directory: pending badges fell to zero, "Undo all"
     * reported nothing to revert while edits were pending, a double-clicked edit opened a diff of
     * empty-against-empty (readBlob swallows the miss), and the watcher polled a directory it had
     * just re-created, so live refresh never fired again. The CLI-backed panels followed the move,
     * so the tool window showed edits in one pane and nothing in the others.
     *
     * Read straight from prefs.json rather than through the CLI: this is on the read path, and it
     * must answer the same way core does even when the CLI is missing from PATH. Cached for a second
     * so a poll does not re-read it per call; [forgetRoot] drops the cache the moment a move lands.
     */
    @Volatile private var rootCache: Pair<Long, Path>? = null

    fun rootDir(): Path {
        val now = System.currentTimeMillis()
        rootCache?.let { (at, dir) -> if (now - at < 1_000) return dir }
        val fallback = configDir().resolve("claude-observatory")
        val dir = runCatching {
            val text = java.nio.file.Files.readString(fallback.resolve("prefs.json"))
            val o = com.google.gson.JsonParser.parseString(text).asJsonObject
            val raw = o.get("storeDir")?.takeIf { it.isJsonPrimitive }?.asString?.trim().orEmpty()
            if (raw.isEmpty()) fallback else Paths.get(expandHome(raw))
        }.getOrDefault(fallback)
        rootCache = now to dir
        return dir
    }

    /** Drop the cached root. Called when a move lands, so the next read follows it immediately. */
    fun forgetRoot() {
        rootCache = null
    }

    /** `~` is the reader's own shorthand in that setting; every path below wants a real one. */
    private fun expandHome(p: String): String = when {
        p == "~" -> System.getProperty("user.home")
        p.startsWith("~/") || p.startsWith("~\\") ->
            Paths.get(System.getProperty("user.home"), p.substring(2)).toString()
        else -> p
    }

    fun storeDir(sessionId: String): Path = rootDir().resolve(sessionId)

    fun logPath(sessionId: String): Path = storeDir(sessionId).resolve("log.jsonl")

    fun blobPath(sessionId: String, sha: String): Path = storeDir(sessionId).resolve("blobs").resolve(sha)

    /**
     * Claude Code's project-dir mangling, as core's mangleCwd: every non-alphanumeric char becomes '-',
     * and a name over 200 chars keeps its first 200 plus '-' and the path's base-36 hash (Claude Code
     * 2.1.x). Kotlin's String.hashCode is the same 31-multiplier hash; abs is taken on a Long so
     * Int.MIN_VALUE stays positive, as JavaScript's Math.abs keeps it.
     */
    fun mangleCwd(cwd: String): String {
        val slug = cwd.replace(Regex("[^a-zA-Z0-9]"), "-")
        if (slug.length <= 200) return slug
        return slug.substring(0, 200) + "-" + kotlin.math.abs(cwd.hashCode().toLong()).toString(36)
    }

    fun projectDir(cwd: String): Path = configDir().resolve("projects").resolve(mangleCwd(cwd))

    fun statuslineCache(): Path = configDir().resolve("statusline-last.json")

    /** True if the capture hooks are wired into settings.json — the marker install.ts writes. Both the
     *  current `oak-observatory-hook` and the pre-rename `claude-observatory-hook` count, so an existing
     *  install still reads as hooked until `oak init` migrates it in place. */
    fun hooksInstalled(): Boolean = runCatching {
        val s = java.nio.file.Files.readString(configDir().resolve("settings.json"))
        s.contains("oak-observatory-hook") || s.contains("claude-observatory-hook")
    }.getOrDefault(false)

    /**
     * Canonicalize a path's DRIVE-LETTER case — the Kotlin mirror of core's canonPath (issue #43).
     * Same total, platform-independent string transform; see paths.ts for the full rationale.
     */
    fun canonPath(p: String): String {
        if (p.length >= 2 && p[1] == ':' && (p.length == 2 || p[2] == '\\' || p[2] == '/')) {
            val d = p[0]
            if (d in 'a'..'z') return d.uppercaseChar() + p.substring(1)
        }
        return p
    }

    /**
     * Editor→store path bridge (#43): IntelliJ VirtualFile paths are system-independent
     * (`C:/repo/x.ts`) while store records are OS-native (`C:\repo\x.ts` on Windows) — so a raw
     * `record.file == vf.path` join can never match on Windows. Flips separators only for
     * drive-letter-shaped paths (a backslash is a legal filename character on POSIX, and the drive
     * shape is what makes it unambiguously a Windows path), then canonicalizes the drive case.
     * UNC paths (`//server/share`) are left as-is — out of #43's scope.
     */
    fun storeKey(editorPath: String): String {
        val driveShaped = editorPath.length >= 2 && editorPath[1] == ':' &&
            (editorPath.length == 2 || editorPath[2] == '/' || editorPath[2] == '\\')
        val native = if (driveShaped) editorPath.replace('/', '\\') else editorPath
        return canonPath(native)
    }
}
