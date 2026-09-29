package com.cellobservatory.observatory.core

import com.cellobservatory.observatory.model.DemoStep
import com.cellobservatory.observatory.model.LocateParser
import com.cellobservatory.observatory.model.Placement
import com.cellobservatory.observatory.model.TourParser
import com.cellobservatory.observatory.model.UndoResult
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.google.gson.JsonParser
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.process.OSProcessHandler
import com.intellij.execution.process.ProcessAdapter
import com.intellij.execution.process.ProcessEvent
import com.intellij.execution.process.ProcessOutputTypes
import com.intellij.execution.util.ExecUtil
import com.intellij.openapi.util.Key
import com.intellij.openapi.util.SystemInfo
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Drives the `oak` CLI — the backend for every store MUTATION (keep/undo/redo) and
 * for diff-dependent reads (locate). The undo engine's correctness lives in the CLI's TS core;
 * this plugin never reimplements it. All calls are blocking — run them on a background thread.
 */
object ObservatoryCli {

    data class CliResult(val exitCode: Int, val stdout: String, val stderr: String) {
        val ok get() = exitCode == 0
    }

    /** GUI-launched IDEs and SSH-launched remote-dev backends have a stripped, non-login-shell
     *  PATH — probe the standard install dirs first (same candidate list as the VS Code extension
     *  and core's resolveClaudeBin). */
    fun resolveBin(): String {
        val home = System.getProperty("user.home")
        // Prefer the current `oak` bin; fall back to the pre-rename `claude-observatory` (still shipped
        // as a deprecated alias) so a plugin that finds only an older CLI on disk still drives it.
        val names = listOf("oak", "claude-observatory")
        val candidates = buildList {
            ObservatorySettings.instance.state.observatoryBin?.let { add(it) }
            System.getenv("CLAUDE_OBSERVATORY_BIN")?.let { add(it) }
            for (n in names) addAll(binCandidates(n, home) { System.getenv(it) })
        }
        for (c in candidates) if (c.isNotBlank() && File(c).exists()) return c
        return "oak" // PATH fallback
    }

    /** Where a global install puts [name]: core's `resolveBin` list (analyze.ts), in its order, so this
     *  plugin finds the CLI wherever VS Code does. nvm and fnm keep one bin dir per node version. */
    internal fun binCandidates(name: String, home: String, env: (String) -> String?): List<String> = buildList {
        fun versions(root: String): List<File> = File(root).listFiles()?.sortedByDescending { it.name } ?: emptyList()
        add("$home/.local/bin/$name")
        add("/opt/homebrew/bin/$name")
        add("/usr/local/bin/$name")
        add("/usr/bin/$name")
        add("$home/.npm-global/bin/$name")
        add("$home/.volta/bin/$name")
        add("$home/.bun/bin/$name")
        env("PNPM_HOME")?.let { add("$it/$name") }
        add("$home/Library/pnpm/$name")
        add("$home/.local/share/pnpm/$name")
        add("$home/.asdf/shims/$name")
        versions("$home/.nvm/versions/node").forEach { add(File(it, "bin/$name").path) }
        // fnm: FNM_DIR when set, else its default root on Linux, then on macOS — the first that has versions.
        listOfNotNull(env("FNM_DIR"), "$home/.local/share/fnm", "$home/Library/Application Support/fnm")
            .firstOrNull { File(it, "node-versions").isDirectory }
            ?.let { root -> versions("$root/node-versions").forEach { add(File(it, "installation/bin/$name").path) } }
        env("APPDATA")?.let { add("$it\\npm\\$name.cmd") }
        env("LOCALAPPDATA")?.let { add("$it\\Volta\\bin\\$name.exe"); add("$it\\pnpm\\$name.cmd") }
    }

    private fun commandLine(args: List<String>, workDir: String?): GeneralCommandLine {
        // Windows: npm installs the CLI as a .cmd shim, which ProcessBuilder can't exec directly —
        // route through cmd.exe (which also does PATH+PATHEXT resolution for the bare fallback).
        val bin = resolveBin()
        val exec = if (SystemInfo.isWindows) listOf("cmd", "/c", bin) + args else listOf(bin) + args
        val cmd = GeneralCommandLine(exec)
            .withCharset(Charsets.UTF_8)
            .withRedirectErrorStream(false)
        workDir?.let { cmd.withWorkingDirectory(java.nio.file.Path.of(it)) }
        // Keep the CLI pointed at the same config dir the plugin reads.
        ObservatorySettings.instance.state.configDir?.takeIf { it.isNotBlank() }?.let {
            cmd.withEnvironment("CLAUDE_CONFIG_DIR", it)
        }
        return cmd
    }

    /**
     * How long a heavy read may take before we give up on it.
     *
     * The change map and the multitask view rebuild every SIBLING session in the repo — 36 of them here —
     * and a first, uncached build was measured at 33 s. The old 30 s budget killed it just before it
     * finished, so the on-disk cache it would have written never got written, and the next tick started
     * the same 33 s of work again: two node processes at a full core each, forever, and a panel that
     * never rendered. Letting the cold build finish once is what makes every later one ~0.1 s.
     */
    const val HEAVY_TIMEOUT_MS = 180_000

    /**
     * One spawn for the whole refresh tick.
     *
     * The panels ask for eight views — changemap, multitask, prompts, processes, sessions, observations,
     * risk, egress — and each used to be its own CLI process. Two costs came with that, and only the
     * first is obvious: ~70 ms of node start-up per spawn before any work at all, paid eight times; and
     * every process re-deriving the SAME transcript and log parses from cold, because core's memo dies
     * with the process that held it. Measured warm on a real store: 2.66 s across eight spawns against
     * 1.38 s for one batched call.
     *
     * The batch is a cache, not a schedule: whichever view asks first pays for it and the other seven
     * read the same result. The window is just under the panels' own 3 s throttle, so a tick shares one
     * spawn and the next tick gets fresh data. An older CLI on PATH has no `views` command; that is
     * detected once and every view falls back to spawning for itself, exactly as before.
     */
    /** Drop the batched view cache — call after a mutation, before a forced refresh. */
    fun invalidateViewBatch() = ViewBatch.invalidate()

    /** What the last batched fetch could NOT build, in the reader's terms. Empty is the normal case;
     *  a panel that finds entries here must say so instead of drawing an empty view. */
    @Volatile
    var lastProblems: List<String> = emptyList()
        private set

    private object ViewBatch {
        private const val WINDOW_MS = 2_500L
        private val lock = Any()
        // One entry PER (session, workspace). This object is a singleton shared by every open project, so
        // a single slot would let two projects evict each other on every call — each view then missing,
        // spawning for itself AND re-spawning the batch: strictly worse than not batching at all.
        private val entries = LinkedHashMap<String, Pair<Long, Map<String, String?>>>()
        private const val MAX_ENTRIES = 8
        /** Per-(session, workspace) spawn locks, so one project's slow batch cannot block another's. */
        private val keyLocks = java.util.concurrent.ConcurrentHashMap<String, Any>()
        /** Set once if this CLI predates `views`; from then on every caller spawns for itself. */
        @Volatile private var unsupported = false

        /** Drop every cached batch. Called when a MUTATION lands: `ThrottledFetch.forced` exists so a
         *  refresh after Accept All / Reject All / Clear Resolved is never served stale, and a batch up to
         *  2.5 s old would have defeated exactly that — the Edits tree reads the store directly and would
         *  have disagreed with the Overview on screen for the rest of the window. */
        fun invalidate() {
            synchronized(lock) { entries.clear() }
        }

        /** ONE definition of the cache key — [peek] and [view] must agree, or a peek silently never
         *  hits and the picker pays a full spawn every time it opens. */
        private fun cacheKey(session: String?, workDir: String?) = "${session.orEmpty()}\u0000${workDir.orEmpty()}"

        /** The cached batch for [k] if it is still inside the window, else null. */
        private fun fresh(k: String): Map<String, String?>? = synchronized(lock) {
            entries[k]?.takeIf { System.currentTimeMillis() - it.first <= WINDOW_MS }?.second
        }

        /** Cache-only read: answers if the window is warm, never spawns. */
        fun peek(name: String, session: String?, workDir: String?): String? {
            if (unsupported) return null
            return fresh(cacheKey(session, workDir))?.get(name)
        }

        fun view(name: String, session: String?, workDir: String?): String? {
            if (unsupported) return null
            val k = cacheKey(session, workDir)
            fresh(k)?.let { return it[name] }

            // The spawn runs OUTSIDE the shared lock, under one private to this (session, workDir).
            // Holding the global lock across `fetch` serialized every open project behind whichever one
            // was building: at HEAVY_TIMEOUT_MS that is a 180 s stall on a second project whose own batch
            // was already cached. Per-key still coalesces the case that matters — several views of the
            // SAME session asking at once collapse to one spawn, which is the point of batching.
            val keyLock = keyLocks.computeIfAbsent(k) { Any() }
            synchronized(keyLock) {
                fresh(k)?.let { return it[name] } // another thread filled it while we waited
                val fresh = fetch(session, workDir)
                synchronized(lock) {
                    entries[k] = System.currentTimeMillis() to fresh
                    if (entries.size > MAX_ENTRIES) entries.remove(entries.keys.first())
                }
                // Distinct sessions accumulate over a long-lived IDE. Dropping the map while a lock is
                // held risks at worst a duplicate spawn for one key, never a wrong answer.
                if (keyLocks.size > 64) keyLocks.clear()
                return fresh[name]
            }
        }

        private fun fetch(session: String?, workDir: String?): Map<String, String?> {
            val args = buildList {
                add("views"); add("--json")
                session?.takeIf { it.isNotBlank() }?.let { add("--session"); add(it) }
                workDir?.let { add("--root"); add(it) }
            }
            val r = run(args, workDir, timeoutMs = HEAVY_TIMEOUT_MS)
            if (r.exitCode != 0 || r.stdout.isBlank()) {
                // Latch ONLY on the one failure that can never succeed later: a CLI too old to know the
                // command, which says so verbatim on stderr ("unknown command \"views\""). Everything
                // else here is transient — a timeout on a huge first build, a spawn that lost a race
                // with an upgrade, an OOM — and latching on those cost far more than it saved: one slow
                // tick permanently disabled batching for the rest of the IDE session, putting every
                // later tick back on eight spawns, which is the regression this batch exists to prevent.
                // Returning an empty map already makes THIS tick fall back per-view; the next tick retries.
                if (r.stderr.contains("unknown command")) unsupported = true
                return emptyMap()
            }
            return try {
                val obj = com.google.gson.JsonParser.parseString(r.stdout).asJsonObject
                // A view the CLI could not build arrives as `null`, which every panel renders as an
                // empty one — the same frame a session that did nothing produces. `views` names the
                // ones that failed, and an unreadable .observatoryignore rides along; both are kept
                // here so a panel can SAY so rather than showing a convincing zero.
                lastProblems = buildList {
                    obj.getAsJsonObject("__problems")?.entrySet()?.forEach { (k, v) ->
                        add("the $k view could not be read — ${v.asString}")
                    }
                    obj.getAsJsonArray("__ignoreProblems")?.forEach { add(it.asString) }
                }
                obj.entrySet().associate { (k, v) -> k to if (v.isJsonNull) null else v.toString() }
            } catch (_: Exception) {
                // Unparseable stdout from a CLI that DID accept the command — a truncated pipe, or a
                // stray line from a wrapper script. Transient by the same argument; do not latch.
                emptyMap()
            }
        }
    }

    fun run(args: List<String>, workDir: String? = null, stdin: String? = null, timeoutMs: Int = 30_000): CliResult {
        val cmd = commandLine(args, workDir)
        return try {
            val out = if (stdin != null) {
                val proc = cmd.createProcess()
                proc.outputStream.use { it.write(stdin.toByteArray(Charsets.UTF_8)) }
                // Drain stdout AND stderr on separate threads with a bounded wait: reading stdout to
                // completion first can deadlock if the child fills the stderr pipe buffer, and the
                // old bare waitFor() had NO timeout — a wedged `locate` (run on every inline render)
                // would hang the pooled worker forever and silently strand inline/navigate/keep.
                val outBuf = StringBuilder()
                val errBuf = StringBuilder()
                val tOut = Thread { proc.inputStream.bufferedReader(Charsets.UTF_8).use { outBuf.append(it.readText()) } }
                val tErr = Thread { proc.errorStream.bufferedReader(Charsets.UTF_8).use { errBuf.append(it.readText()) } }
                tOut.start(); tErr.start()
                if (proc.waitFor(timeoutMs.toLong(), TimeUnit.MILLISECONDS)) {
                    tOut.join(1000); tErr.join(1000)
                    CliResult(proc.exitValue(), outBuf.toString(), errBuf.toString())
                } else {
                    proc.destroyForcibly()
                    tOut.join(500); tErr.join(500)
                    CliResult(-1, outBuf.toString(), "oak timed out after ${timeoutMs}ms")
                }
            } else {
                val o = ExecUtil.execAndGetOutput(cmd, timeoutMs)
                // ExecUtil signals a timeout via isTimeout, not a non-zero exit — treat it as a failure
                // so callers don't mistake a killed run's partial output for a result.
                if (o.isTimeout) CliResult(-1, o.stdout, "oak timed out after ${timeoutMs}ms")
                else CliResult(o.exitCode, o.stdout, o.stderr)
            }
            out
        } catch (e: Exception) {
            CliResult(-1, "", e.message ?: "failed to launch $cmd")
        }
    }

    // --- typed wrappers over the CLI's --json surface ---

    /** Install the PreToolUse/PostToolUse capture hooks (non-interactive `oak init`). */
    fun init(workDir: String?): CliResult = run(listOf("init"), workDir)

    /** Garbage-collect orphaned blobs in a session (`clean --session <id>`). */
    fun gc(session: String, workDir: String?): CliResult = run(listOf("clean", "--session", session), workDir)

    /** Drop a whole session from the store (`clean --drop <id>`). */
    fun dropSession(session: String, workDir: String?): CliResult = run(listOf("clean", "--drop", session), workDir)

    /** Remove a session from every picker and purge its captured edits for good (`sessions --delete <id>`),
     *  backed by core.deleteSession. The agent's OWN transcript/rollout is left untouched — the durable
     *  hidden-list is what keeps it gone — and `sessions --undelete <id>` lists the session again, never its
     *  edits. [confirmedPending] is how many edits still pending review the caller's dialog named, and
     *  [seenThrough] the newest edit id of the listing it counted from (its row's `lastEdit`): the CLI refuses
     *  a session with more pending than that count, or with a pending edit newer than that id, so no edit
     *  captured after the listing is purged unseen, even one that joined a change the count included. */
    fun deleteSession(session: String, workDir: String?, confirmedPending: Int, seenThrough: Long?): CliResult =
        run(listOf("sessions", "--delete", session) + (if (confirmedPending > 0) listOf("--force-pending", confirmedPending.toString()) else emptyList()) +
            (if (seenThrough != null) listOf("--seen-through", seenThrough.toString()) else emptyList()) + "--json", workDir)

    /** True only when [r] is the CLI saying it deleted [session] (`{"deleted": "<id>"}`). A CLI from before
     *  `sessions --delete` (0.9.5, which the plugin still drives through its `claude-observatory` fallback)
     *  ignores the flag and exits 0 with a listing: a success that deleted nothing. */
    fun deletedSession(r: CliResult, session: String): Boolean = r.ok && runCatching {
        JsonParser.parseString(r.stdout).asJsonObject.get("deleted")?.asString == session
    }.getOrDefault(false)

    /** Announce a raised hand on the desktop IF DUE (`notify --session …`, 2026-09-15): core's once-per-
     *  machine claim and cooldown decide — the plugin cannot call core, so the row's facts go over as
     *  flags and the SAME rule every surface uses answers. Fire-and-forget; never on the EDT. */
    fun notifyHand(session: String, kind: String, ts: Long, title: String?, message: String, agent: String, workDir: String?): CliResult =
        run(
            listOf("notify", "--session", session, "--kind", kind, "--ts", ts.toString(), "--title", title ?: "", "--message", message, "--agent", agent, "--json"),
            workDir,
            timeoutMs = 10_000,
        )

    /** Every conversation's asks and answers, ranked (`search --json --query <text>`).
     *  The first search builds core's per-session index, so its timeout is generous. The whole result,
     *  so a failed run is never read as "no hits". */
    fun search(query: String, workDir: String?): CliResult =
        run(listOf("search", "--json", "--query", query, "--limit", "30"), workDir, timeoutMs = 120_000)

    /** The next session waiting on the reader (`inbox --next [--after <id>] --json` → `{next, hand}`),
     *  by core's ranking. The whole result, so a failed read is never read as "nobody waiting". */
    fun inboxNext(after: String?, workDir: String?): CliResult =
        run(listOf("inbox", "--next", "--json") + (after?.let { listOf("--after", it) } ?: emptyList()), workDir, timeoutMs = 15_000)

    /** Accept every pending edit in a session, then clear its records (`resolve --session <id>`).
     *  Files on disk are never touched, and the session itself is kept. */
    fun resolveSession(session: String, workDir: String?): CliResult =
        run(listOf("resolve", "--session", session, "--json"), workDir)

    /**
     * Pre-build the change maps of sessions active in the last day, DETACHED (`warm`).
     *
     * Switching to a session nothing had built measured 6.2 s against 1.5 s once its caches existed, and
     * nothing built one until you switched to it. This spends idle time instead. Fire-and-forget on
     * purpose: it must never delay the refresh that triggered it, and its failure costs a slow switch
     * rather than a broken panel — so the process is started and abandoned, never awaited.
     */
    /** Re-gather the other machines' usage figures (fire-and-forget, warmRecent's shape) — the
     *  status-bar refresh button's other half. */
    /** Detached `oak usage --pull-account`: fetch the account's own usage into the statusline
     *  cache — the numbers refresh with no claude session open. Fire-and-forget, like the gather. */
    fun pullAccountUsage(workDir: String?) {
        try {
            val resolved = resolveBin()
            val exec = if (SystemInfo.isWindows) listOf("cmd", "/c", resolved) else listOf(resolved)
            ProcessBuilder(exec + listOf("usage", "--pull-account", "--json"))
                .directory(workDir?.let { java.io.File(it) })
                .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                .redirectError(ProcessBuilder.Redirect.DISCARD)
                .start()
        } catch (_: Exception) {
            /* no CLI on PATH — the auto-pull from the next poll still runs */
        }
    }



    fun warmRecent(workDir: String?) {
        try {
            val resolved = resolveBin()
            val exec = if (SystemInfo.isWindows) listOf("cmd", "/c", resolved) else listOf(resolved)
            ProcessBuilder(exec + listOf("warm", "--root", workDir ?: ".", "--since", "24h"))
                .directory(workDir?.let { java.io.File(it) })
                .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                .redirectError(ProcessBuilder.Redirect.DISCARD)
                .start()
        } catch (_: Exception) {
            /* no CLI on PATH — switching stays as slow as it was before 0.9.0, which is not a failure */
        }
    }

    /**
     * Drop every FINISHED session — nothing pending, conversation over (`clean --completed`).
     *
     * The predicate lives in core, not here: which sessions are safe to delete is exactly the kind of
     * rule that must not exist twice. The CLI refuses the current session, anything with pending edits,
     * anything that only just went quiet, and anything with a capture in flight.
     */
    fun cleanCompleted(workDir: String?): CliResult = run(listOf("clean", "--completed", "--json"), workDir)

    /** What `cleanCompleted` WOULD drop, without dropping it — so the confirm dialog can state real
     *  numbers instead of generic prose. The eligibility rules stay in core; this only asks. */
    fun cleanCompletedPreview(workDir: String?): CliResult =
        run(listOf("clean", "--completed", "--dry-run", "--json"), workDir)

    /** Single-id keep (group-aware in the CLI). Returns the number of records actually flipped —
     *  0 is a REAL answer (the edit is already kept, or reverted), null a failed spawn. The CLI
     *  exits 0 with `kept: 0` on a no-op, so `.ok` alone painted a green "kept" over nothing —
     *  which the snapshot-style stacked review tab turned from a milliseconds-wide race into a
     *  standing lie. */
    fun keep(session: String, id: Int, workDir: String?): Int? {
        val r = run(listOf("keep", id.toString(), "--session", session, "--json"), workDir)
        if (!r.ok) return null
        return try {
            JsonParser.parseString(r.stdout).asJsonObject.get("kept")?.takeIf { !it.isJsonNull }?.asInt ?: 0
        } catch (_: Exception) {
            null
        }
    }

    /** `keep --ids <a,b,c>` — accept an explicit set in ONE process. A scoped accept used to spawn the
     *  CLI once per edit, which on a long session is thousands of processes; this is one. Returns the
     *  kept count, or null if the call failed. */
    fun keepIds(session: String, ids: List<Int>, workDir: String?): Int? {
        if (ids.isEmpty()) return 0
        val r = run(listOf("keep", "--ids", ids.joinToString(","), "--session", session, "--json"), workDir)
        return if (r.ok) parseInt(r.stdout, "kept") else null
    }

    /** Kept count, or null if the CLI call failed (distinct from a genuine 0-pending result). */
    fun keepAll(session: String, workDir: String?): Int? {
        val r = run(listOf("keep", "--all", "--session", session, "--json"), workDir)
        return if (r.ok) parseInt(r.stdout, "kept") else null
    }

    fun undo(session: String, id: Int, force: Boolean, workDir: String?): UndoResult =
        parseUndo(run(buildList {
            add("undo"); add(id.toString()); if (force) add("--force")
            add("--session"); add(session); add("--json")
        }, workDir))

    fun redo(session: String, id: Int, force: Boolean, workDir: String?): UndoResult =
        parseUndo(run(buildList {
            add("redo"); add(id.toString()); if (force) add("--force")
            add("--session"); add(session); add("--json")
        }, workDir))

    data class UndoScopeResult(
        val undone: Int,
        val conflicts: Int,
        val total: Int,
        /** Edits the CLI REFUSED outright (e.g. the #43 phantom guard) — 0 from older CLIs. */
        val errors: Int = 0,
        /** The first refusal's message — it names the remediation (`clean --phantoms`). */
        val firstError: String? = null,
        /** WHICH edits actually reverted — empty from a pre-0.10 CLI, which reported only counts. */
        val ids: List<Int> = emptyList(),
        /** Review units the reverted set collapses to; null unless this was a `--from-prompt` rewind,
         *  whose two counts differ (raw records vs the units the Prompts rows print). */
        val units: Int? = null,
        /** The FIRST conflict's message — a named-dependent refusal must reach bulk readers too. */
        val firstConflict: String? = null,
        /** Files rewritten whose status the store could not record: the CLI's sentence naming them and
         *  the command that records them. Never shown as a plain success. */
        val unrecorded: String? = null,
    )

    /** The `unrecorded` report's message from a scope verb's JSON, or null (absent from older CLIs). */
    internal fun unrecordedOf(o: com.google.gson.JsonObject): String? =
        o.get("unrecorded")?.takeIf { it.isJsonObject }?.asJsonObject?.get("message")
            ?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString

    private fun parseUndoScope(stdout: String): UndoScopeResult? = try {
        val o = JsonParser.parseString(stdout).asJsonObject
        UndoScopeResult(
            o.get("undone").asInt, o.get("conflicts").asInt, o.get("total").asInt,
            o.get("errors")?.takeIf { it.isJsonPrimitive }?.asInt ?: 0,
            o.get("firstError")?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString,
            intList(o, "ids"),
            o.get("units")?.takeIf { it.isJsonPrimitive }?.asInt,
            firstConflict = o.get("firstConflict")?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString,
            unrecorded = unrecordedOf(o),
        )
    } catch (_: Exception) {
        null
    }

    /** An optional int array — absent (older CLI) reads as empty, never as null. */
    private fun intList(o: com.google.gson.JsonObject, key: String): List<Int> =
        o.get(key)?.takeIf { it.isJsonArray }?.asJsonArray?.mapNotNull { it.takeIf { e -> e.isJsonPrimitive }?.asInt }
            ?: emptyList()

    /** Revert every PENDING edit in a scope in ONE call (the CLI's `undo --all` / `undo --under`, backed
     *  by core.undoScope — the single scoped-revert implementation both editors share). `under` = null
     *  reverts the whole session; a path reverts a file (exact) or folder (everything beneath). Accepted
     *  edits are left on disk. Returns null if the CLI call failed. */
    fun undoScope(session: String, under: String?, workDir: String?): UndoScopeResult? {
        val args = buildList {
            add("undo")
            if (under == null) add("--all") else { add("--under"); add(under) }
            add("--session"); add(session); add("--json")
        }
        val r = run(args, workDir)
        if (!r.ok) return null
        return parseUndoScope(r.stdout)
    }

    data class RedoScopeResult(
        val redone: Int,
        val conflicts: Int,
        val total: Int,
        /** WHICH edits re-applied — empty from a pre-0.10 CLI. */
        val ids: List<Int> = emptyList(),
        /** Review units, only on a `--from-prompt` restore (see [UndoScopeResult.units]). */
        val units: Int? = null,
        /** See [UndoScopeResult.unrecorded]. */
        val unrecorded: String? = null,
    )

    private fun parseRedoScope(stdout: String): RedoScopeResult? = try {
        val o = JsonParser.parseString(stdout).asJsonObject
        RedoScopeResult(
            o.get("redone").asInt, o.get("conflicts").asInt, o.get("total").asInt,
            intList(o, "ids"),
            o.get("units")?.takeIf { it.isJsonPrimitive }?.asInt,
            unrecorded = unrecordedOf(o),
        )
    } catch (_: Exception) {
        null
    }

    /** Re-apply every UNDONE edit in a scope in ONE call (the CLI's `redo --all` / `redo --under`, backed
     *  by core.redoScope — the forward mirror of undoScope). `under` = null re-applies the whole session;
     *  a path targets a file (exact) or folder (everything beneath). Returns null if the CLI call failed. */
    fun redoScope(session: String, under: String?, workDir: String?): RedoScopeResult? {
        val args = buildList {
            add("redo")
            if (under == null) add("--all") else { add("--under"); add(under) }
            add("--session"); add(session); add("--json")
        }
        val r = run(args, workDir)
        if (!r.ok) return null
        return parseRedoScope(r.stdout)
    }

    /** Revert an EXPLICIT pending-edit id set in ONE call (`undo --ids <a,b,c>`, backed by
     *  core.undoScope({ ids }) — the same set VS Code's Folder-axis Reject uses). Unlike `undoScope(under)`
     *  this targets a module bucket's EXACT edits, never the recursive subtree a path scope would catch.
     *  Accepted edits are left on disk. Returns null if the CLI call failed. */
    fun undoScopeIds(session: String, ids: List<Int>, workDir: String?): UndoScopeResult? {
        if (ids.isEmpty()) return UndoScopeResult(0, 0, 0)
        val r = run(listOf("undo", "--ids", ids.joinToString(","), "--session", session, "--json"), workDir)
        if (!r.ok) return null
        return parseUndoScope(r.stdout)
    }

    /**
     * A scoped op's outcome when the CLI's own REASON matters.
     *
     * [undoScope] and friends collapse a failure to null, and for them that is the whole truth: their
     * callers say "the CLI failed or isn't installed", which is what a missing binary means. A REWIND can
     * fail for reasons only the CLI knows — an unknown prompt id, a session whose transcript is gone — and
     * a destructive button that reports none of them is the silent-fail this project forbids.
     */
    data class ScopedOutcome<T : Any>(val result: T?, val error: String?)

    /**
     * Rewind to before one ask: revert every PENDING edit that ask and everything after it produced
     * (`undo --from-prompt <id>`), in ONE call. The boundary and the group expansion are core's — see
     * `checkpointScope` — so the two editors revert exactly the same set.
     *
     * [promptId] must be the stable 12-hex prompt id, NEVER the display index: the CLI accepts either, but
     * an index is a position in a list that grows with every ask, so a stale panel would rewind the wrong
     * one. The result's `units` is the review-unit count the Prompts rows show, which differs from `undone`
     * whenever a same-code group straddles the boundary.
     */
    fun undoFromPrompt(session: String, promptId: String, workDir: String?): ScopedOutcome<UndoScopeResult> {
        val r = run(listOf("undo", "--from-prompt", promptId, "--session", session, "--json"), workDir)
        if (!r.ok) return ScopedOutcome(null, failureMessage(r.stdout, r.stderr, "the CLI exited ${r.exitCode} without saying why"))
        return parseUndoScope(r.stdout)?.let { ScopedOutcome(it, null) }
            ?: ScopedOutcome(null, "the CLI answered `undo --from-prompt` with output this build cannot read")
    }

    /**
     * What a rewind WOULD revert, counted without touching disk — `undo --from-prompt <id> --dry-run`.
     *
     * The three numbers a destructive confirmation has to state, and the only way this plugin can get them:
     * the boundary and the group expansion live in core, and every other exposure of that scope performs
     * the revert. [pending] is raw store records, [units] the review units they collapse to (what the
     * Prompts rows count) — the two differ exactly when a same-code group straddles the boundary — and
     * [files] how many files they touch.
     */
    data class RewindPreview(
        val pending: Int,
        val units: Int,
        /** 0 also means "this build did not report the file list", so a caller states no file count rather
         *  than printing a zero it cannot stand behind. */
        val files: Int,
        /**
         * True when the CLI IGNORED `--dry-run` and performed the revert anyway.
         *
         * The CLI on PATH is version-skewed from this plugin in BOTH directions — it is installed and
         * updated separately — so any build that honours `--from-prompt` without honouring `--dry-run`
         * lands here: an intermediate rolling pre-release, a hand-built checkout, or a future one that
         * drops the flag again. An unrecognized boolean flag is silently dropped by an argument scan, so
         * the alternative to detecting this is reverting someone's work without ever asking and reporting
         * nothing. Cheap to keep, and it guards the most destructive verb in the product.
         */
        val performed: Boolean = false,
        /** How many of [pending] were made BEFORE the ask this rewind points at. One review unit can
         *  span two asks when the file was absent in between, and a unit is the smallest revertible
         *  thing — so the rewind reaches back, and the dialog says so. 0 from an older CLI. */
        val fromEarlier: Int = 0,
    )

    /** Parse the preflight payload. `internal` so the shape is unit-testable without a subprocess. */
    internal fun parseRewindPreview(stdout: String): RewindPreview? = try {
        val o = JsonParser.parseString(stdout).asJsonObject
        fun int(k: String): Int? = o.get(k)?.takeIf { it.isJsonPrimitive }?.asInt
        val dry = o.get("dryRun")?.takeIf { it.isJsonPrimitive }?.asBoolean ?: false
        when {
            // A preview, as asked for.
            dry -> {
                val pending = int("pending") ?: return null
                val units = int("units") ?: return null
                RewindPreview(
                    pending,
                    units,
                    o.get("files")?.takeIf { it.isJsonArray }?.asJsonArray?.size() ?: 0,
                    fromEarlier = int("fromEarlier") ?: 0,
                )
            }
            // NOT a preview but a completed revert: this build dropped the flag and did the work.
            o.has("undone") -> RewindPreview(int("undone") ?: 0, int("units") ?: 0, 0, performed = true)
            else -> null // some other shape entirely — the caller falls back to a count-free confirmation
        }
    } catch (_: Exception) {
        null
    }

    /**
     * Count a rewind's scope without performing it. Null when the CLI could not answer, and the caller then
     * confirms count-free rather than blocking the rewind — a preflight that fails is a missing number, not
     * a reason to withhold the feature. [supportsFromPrompt] gates the path, so a pre-0.10 CLI reaches this
     * only when its `--version` was unreadable (that gate answers TRUE there by design) — and then this run
     * fails on the unknown flag and returns null, which is exactly the fallback. Not memoized: the answer
     * changes with every keep and undo.
     */
    fun previewRewind(session: String, promptId: String, workDir: String?): RewindPreview? {
        val r = run(listOf("undo", "--from-prompt", promptId, "--dry-run", "--session", session, "--json"), workDir)
        if (!r.ok) return null
        return parseRewindPreview(r.stdout)
    }

    /**
     * Re-apply an EXPLICIT id set (`redo --ids <a,b,c>`) — how a rewind's Redo undoes itself.
     *
     * It must be the ids the rewind actually reverted, never the rewind's scope re-resolved. The scope is
     * every record in the window whatever its status, so re-resolving it would also re-apply an edit the
     * reader had deliberately REJECTED before the rewind ran — resurrecting rejected code on disk, and
     * counting it in the toast without ever naming it. `undo --from-prompt --json` hands back exactly what
     * moved; that is the set to send here.
     *
     * Returns a [ScopedOutcome] rather than a bare nullable so the CLI's own reason reaches the toast: a
     * null-collapsing helper would turn a refusal back into silence.
     */
    fun redoScopeIds(session: String, ids: List<Int>, workDir: String?): ScopedOutcome<RedoScopeResult> {
        if (ids.isEmpty()) return ScopedOutcome(null, "no edits to restore")
        val r = run(listOf("redo", "--ids", ids.joinToString(","), "--session", session, "--json"), workDir)
        if (!r.ok) return ScopedOutcome(null, failureMessage(r.stdout, r.stderr, "the CLI exited ${r.exitCode} without saying why"))
        return parseRedoScope(r.stdout)?.let { ScopedOutcome(it, null) }
            ?: ScopedOutcome(null, "the CLI answered `redo --ids` with output this build cannot read")
    }

    /** Memo for [supportsFromPrompt], keyed on the work dir — the CLI resolved there is what answers. */
    private val fromPromptSupport = java.util.concurrent.ConcurrentHashMap<String, Boolean>()

    /**
     * Whether the CLI on PATH understands `--from-prompt` (0.10+).
     *
     * A pre-0.10 CLI does not have the flag, and its `undo` would fall through to `requireId`, whose scan
     * skips only `--session` and then takes the first all-digit token — so a prompt id made entirely of
     * decimal digits could be read as an edit id. Unlikely (12 hex chars, P ≈ 0.36 % all-decimal, and it
     * must also be small enough to name a real edit) but not impossible, and the failure would be a
     * SILENT revert of the wrong edit.
     *
     * Memoized because it spawns, and resolved lazily from `actionPerformed` — never from an action
     * `update()`, which the platform runs per toolbar tick. A version string this cannot parse returns
     * TRUE and lets the CLI's own error surface: refusing on an unreadable version would disable the
     * feature for anyone whose wrapper prints a banner first.
     */
    fun supportsFromPrompt(workDir: String?): Boolean = fromPromptSupport.getOrPut(workDir ?: "") {
        val r = run(listOf("--version"), workDir, timeoutMs = 15_000)
        if (!r.ok) return@getOrPut true
        val m = Regex("""(\d+)\.(\d+)""").find(r.stdout) ?: return@getOrPut true
        val major = m.groupValues[1].toIntOrNull() ?: return@getOrPut true
        val minor = m.groupValues[2].toIntOrNull() ?: return@getOrPut true
        major > 0 || minor >= 10
    }

    /** `clean --resolved --json` — returns the CLI's own `cleared` count, or null on failure. The count
     *  comes from the verb, never a UI-side guess, so the toast can not disagree with what happened. */
    fun clearResolvedJson(session: String, workDir: String?): Int? {
        val r = run(listOf("clean", "--resolved", "--session", session, "--json"), workDir)
        if (!r.ok) return null
        return try {
            com.google.gson.JsonParser.parseString(r.stdout).asJsonObject.get("cleared").asInt
        } catch (_: Exception) {
            null
        }
    }

    fun clearResolved(session: String, workDir: String?, under: String? = null): Boolean =
        run(
            listOf("clean", "--resolved", "--session", session) + (under?.let { listOf("--under", it) } ?: emptyList()),
            workDir,
        ).ok

    /** `clean --resolved --ids <a,b,c>` — clear the resolved (kept/undone) edits of an EXPLICIT id set:
     *  the scope one prompt names, which no path can express (a single ask edits many folders). Returns
     *  the cleared count, or null if the CLI call failed. */
    fun clearResolvedIds(session: String, ids: List<Int>, workDir: String?): Int? {
        if (ids.isEmpty()) return 0
        val r = run(
            listOf("clean", "--resolved", "--ids", ids.joinToString(","), "--session", session, "--json"),
            workDir,
        )
        return if (r.ok) parseInt(r.stdout, "cleared") else null
    }

    /** Per-pending-edit geometry in the LIVE buffer text (may be unsaved): added lines, deleted hunks and
     *  churn. Parsing lives in [LocateParser] so the payload contract is testable without a subprocess. */
    fun locate(session: String, file: String, currentText: String, workDir: String?): List<Placement> {
        val r = run(listOf("locate", "--file", file, "--session", session), workDir, stdin = currentText)
        if (!r.ok) return emptyList()
        return LocateParser.parse(r.stdout)
    }

    /** Where the store lives, and whether that is the default. */
    data class StoreInfo(val dir: String, val moved: Boolean)

    /** `store --json` — the resolved store root. Null when the CLI is too old to know the verb, which
     *  the caller shows as "unavailable" rather than inventing a path. */
    fun store(workDir: String?): StoreInfo? {
        val res = run(listOf("store", "--json"), workDir)
        if (!res.ok) return null
        return try {
            val o = JsonParser.parseString(res.stdout).asJsonObject
            StoreInfo(o.get("dir")?.asString ?: return null, o.get("moved")?.asBoolean ?: false)
        } catch (_: Exception) {
            null
        }
    }

    /** `ignore --session <id>` — runs the sweep (core.dropIgnored) that drops records a newly-added
     *  `.observatoryignore` now covers. A USER Refresh calls this before re-reading: adding the file fires
     *  no capture hook, so the capture-time sweep never runs and a plain refresh (a read) leaves the
     *  now-ignored records. Self-gating (a no-op when nothing matches). Best-effort. */
    fun ignoreSweep(workDir: String?, session: String): Boolean {
        if (session.isBlank()) return false
        return run(listOf("ignore", "--session", session, "--json"), workDir).ok
    }

    /** `store --move <dir>` (or `--default`). The move is the CLI's, shared with every other front end. */
    fun storeMove(workDir: String?, dir: String?): ChangeResult {
        val res = run(if (dir == null) listOf("store", "--default") else listOf("store", "--move", dir), workDir)
        return ChangeResult(if (res.ok) null else res.stderr.trim().ifBlank { "could not move the store" })
    }

    data class ChangeResult(val error: String?)

    /** `sessions --json` — every store session incl. its human-readable title (0.8.6), for the chooser.
     *
     *  [buildBatch] separates the two callers, which want opposite things from the batch. The POLLING
     *  path (ObservatoryService) is the batch's owner: it may build one. The Switch-Session picker must
     *  not — it names the current session too, so it would otherwise hit the same cache key and, on a
     *  cold or expired window, block the popup behind a full eight-view build INCLUDING the change map.
     *  That is precisely the multi-second stall the 0.8.8 stat-only listing removed. It peeks instead:
     *  free when the poller has already filled the window, a plain `sessions` spawn when it has not. */
    fun sessionsJson(workDir: String?, reviewing: String? = null, buildBatch: Boolean = false): String? {
        if (reviewing != null) {
            val batched = if (buildBatch) ViewBatch.view("sessions", reviewing, workDir)
            else ViewBatch.peek("sessions", reviewing, workDir)
            batched?.let { return it }
        }
        // --session names the session being reviewed, so a pinned conversation that has made no edits
        // yet is still listed rather than looking like another workspace's.
        val args = buildList {
            add("sessions"); add("--json")
            reviewing?.takeIf { it.isNotBlank() }?.let { add("--session"); add(it) }
        }
        val r = run(args, workDir)
        return if (r.ok) r.stdout else null
    }

    fun statsJson(session: String?, workDir: String?): String? {
        val args = buildList {
            add("stats"); add("--json")
            session?.let { add("--session"); add(it) }
        }
        val r = run(args, workDir)
        return if (r.ok) r.stdout else null
    }

    fun usageJson(session: String?, workDir: String?): String? {
        // --session pins the sessionTokens breakdown to the session the panel is showing, instead of
        // whatever the CLI would resolve as newest for the cwd.
        val args = buildList {
            add("usage")
            session?.let { add("--session"); add(it) }
        }
        return run(args, workDir).stdout.takeIf { it.isNotBlank() }
    }

    fun observeJson(session: String, workDir: String?): String? {
        val r = run(listOf("observe", "--session", session), workDir)
        return if (r.ok) r.stdout else null
    }

    /** The Observations view-model (0.8.0, Timeline folded in): recap + coalesced same-file ×N runs with
     *  per-edit reasoning + next-steps. Always JSON; both editors render this payload thin. */
    fun observationsJson(session: String, workDir: String?): String? {
        ViewBatch.view("observations", session, workDir)?.let { return it }
        val args = buildList {
            add("observations"); add("--session"); add(session)
            workDir?.let { add("--root"); add(it) }
        }
        val r = run(args, workDir)
        return if (r.ok) r.stdout else null
    }

    /** `task-keep <taskId>` — keep every PENDING edit in a task's STRICT in_progress span. Returns
     *  the kept count, or null if the CLI call failed (distinct from a genuine 0-pending task). */
    fun taskKeep(session: String, taskId: String, workDir: String?): Int? {
        val r = run(listOf("task-keep", taskId, "--session", session, "--json"), workDir)
        return if (r.ok) parseInt(r.stdout, "kept") else null
    }

    /** `keep --under <path>` — accept every PENDING edit at or beneath one file or folder.
     *  Records a verdict; changes no file on disk. Returns the count, or null if the call failed. */
    fun keepUnder(session: String, under: String, workDir: String?): Int? {
        val r = run(listOf("keep", "--under", under, "--session", session, "--json"), workDir)
        return if (r.ok) parseInt(r.stdout, "kept") else null
    }

    /** [errors] and [firstError] are NOT decoration: `undoScope` returns refusals separately from
     *  conflicts, and dropping them turned "every edit here refused, and here is why" into
     *  "No pending edits to reject" — a statement that is flatly false. */
    data class TaskUndoResult(
        val undone: Int,
        val conflicts: Int,
        val total: Int,
        val errors: Int = 0,
        val firstError: String? = null,
        /** The FIRST conflict's message — a named-dependent refusal must reach task-scoped readers too. */
        val firstConflict: String? = null,
        /** See [UndoScopeResult.unrecorded]. */
        val unrecorded: String? = null,
    )

    /** `task-undo <taskId>` — revert every PENDING edit in a task's STRICT span, newest-first.
     *  Writes to disk. Returns {undone, conflicts, total}, or null if the CLI call failed. */
    fun taskUndo(session: String, taskId: String, workDir: String?): TaskUndoResult? {
        val r = run(listOf("task-undo", taskId, "--session", session, "--json"), workDir)
        if (!r.ok) return null
        return try {
            val o = JsonParser.parseString(r.stdout).asJsonObject
            TaskUndoResult(
                o.get("undone").asInt, o.get("conflicts").asInt, o.get("total").asInt,
                o.get("errors")?.takeIf { !it.isJsonNull }?.asInt ?: 0,
                o.get("firstError")?.takeIf { !it.isJsonNull }?.asString,
                firstConflict = o.get("firstConflict")?.takeIf { !it.isJsonNull }?.asString,
                unrecorded = unrecordedOf(o),
            )
        } catch (_: Exception) {
            null
        }
    }

    /** `undo --under <path>` — revert every PENDING edit at or beneath one file or folder, newest
     *  first. WRITES TO DISK. Returns {undone, conflicts, total}, or null if the CLI call failed.
     *  The same scope the terminal's change map and VS Code's ledger use, so one rule serves all three
     *  instead of each deriving an id set the others could disagree with. */
    fun undoUnder(session: String, under: String, workDir: String?): TaskUndoResult? {
        val r = run(listOf("undo", "--under", under, "--session", session, "--json"), workDir)
        if (!r.ok) return null
        return try {
            val o = JsonParser.parseString(r.stdout).asJsonObject
            TaskUndoResult(
                o.get("undone")?.asInt ?: 0,
                o.get("conflicts")?.asInt ?: 0,
                o.get("total")?.asInt ?: 0,
                o.get("errors")?.takeIf { !it.isJsonNull }?.asInt ?: 0,
                o.get("firstError")?.takeIf { !it.isJsonNull }?.asString,
                firstConflict = o.get("firstConflict")?.takeIf { !it.isJsonNull }?.asString,
                unrecorded = unrecordedOf(o),
            )
        } catch (_: Exception) {
            null
        }
    }

    /** `task-clear <taskId>` — drop the RESOLVED (kept/undone) edits of a task's STRICT span;
     *  pending edits are preserved. Returns the cleared count, or null if the CLI call failed. */
    fun taskClear(session: String, taskId: String, workDir: String?): Int? {
        val r = run(listOf("task-clear", taskId, "--session", session, "--json"), workDir)
        return if (r.ok) parseInt(r.stdout, "cleared") else null
    }

    data class TaskClearCompletedResult(val cleared: Int, val tasks: Int)

    /** `task-clear --completed` — clear the resolved edits of EVERY settled task (all kept).
     *  Returns {cleared, tasks}, or null if the CLI call failed. */
    fun taskClearCompleted(session: String, workDir: String?): TaskClearCompletedResult? {
        val r = run(listOf("task-clear", "--completed", "--session", session, "--json"), workDir)
        if (!r.ok) return null
        return try {
            val o = JsonParser.parseString(r.stdout).asJsonObject
            TaskClearCompletedResult(o.get("cleared").asInt, o.getAsJsonArray("tasks")?.size() ?: 0)
        } catch (_: Exception) {
            null
        }
    }

    /** The folder→file→class→edit view-model (with exact deltas) — the single source both editors render. */
    fun treeJson(session: String, workDir: String?, filter: String?): String? {
        val args = buildList {
            add("tree"); add("--session"); add(session)
            workDir?.let { add("--root"); add(it) }
            if (!filter.isNullOrBlank()) { add("--filter"); add(filter) }
        }
        val r = run(args, workDir)
        return if (r.ok) r.stdout else null
    }

    /** The session change-map: per-file / per-module rollups of everything Claude
     *  touched. Every number (churn, status precedence, module labels) is computed by core — this
     *  plugin only renders the result, exactly like the VS Code webview. */
    fun changemapJson(session: String, workDir: String?): String? {
        ViewBatch.view("changemap", session, workDir)?.let { return it }
        val args = buildList {
            add("changemap"); add("--session"); add(session)
            workDir?.let { add("--root"); add(it) }
            add("--json")
        }
        val r = run(args, workDir, timeoutMs = HEAVY_TIMEOUT_MS)
        return if (r.ok) r.stdout else null
    }

    /** The multi-agent view: one row per running agent across every worktree (live phase, sparkline,
     *  ±diff, risk), nested subagents, and cross-agent file collisions. `--root` keys the repo-scoped
     *  fleet. Everything is aggregated in core — the panel only paints.
     *
     *  `--session` pins WHICH sibling is the payload's own: it decides the fleet's `self` row and the
     *  session-scoped sections (actions, tasks). Without it the CLI re-resolves the newest session for
     *  the cwd, so after Switch Session every one of those still described the session you left. */
    fun multitaskJson(session: String?, workDir: String?): String? {
        ViewBatch.view("multitask", session, workDir)?.let { return it }
        val args = buildList {
            add("multitask"); add("--json")
            session?.takeIf { it.isNotBlank() }?.let { add("--session"); add(it) }
            workDir?.let { add("--root"); add(it) }
        }
        val r = run(args, workDir, timeoutMs = HEAVY_TIMEOUT_MS)
        return if (r.ok) r.stdout else null
    }

    /** `risk --json` — the flagged shell commands AND (0.8.7) the edits that landed OUTSIDE the
     *  workspace. `--root` is the boundary "outside" is measured against; without it the CLI falls back
     *  to its own cwd, which is not the project root whenever the IDE was launched from elsewhere. */
    fun riskJson(session: String, workDir: String?): String? {
        ViewBatch.view("risk", session, workDir)?.let { return it }
        val args = buildList {
            add("risk"); add("--session"); add(session)
            workDir?.let { add("--root"); add(it) }
            add("--json")
        }
        val r = run(args, workDir)
        return if (r.ok) r.stdout else null
    }

    /** `egress --json` — every destination this session reached: web hosts, MCP servers, network shell,
     *  and (0.8.7) the files it READ from outside the workspace. Only this verb carries those `file`
     *  channels; the `multitask --json` egress sub-report predates the fold and would omit them. */
    fun egressJson(session: String, workDir: String?): String? {
        ViewBatch.view("egress", session, workDir)?.let { return it }
        val args = buildList {
            add("egress"); add("--session"); add(session)
            workDir?.let { add("--root"); add(it) }
            add("--json")
        }
        val r = run(args, workDir)
        return if (r.ok) r.stdout else null
    }

    /** The background shells this session launched with `run_in_background` and left running — runtime,
     *  exit code, output volume. No OS pid is reported because none exists to report: the transcript
     *  never records one, and guessing it from local processes breaks the moment the agent runs over
     *  SSH or in a container. */
    fun processesJson(session: String, workDir: String?): String? {
        ViewBatch.view("processes", session, workDir)?.let { return it }
        val r = run(listOf("processes", "--session", session, "--json"), workDir)
        return if (r.ok) r.stdout else null
    }

    /** The session as the list of things the USER asked for — each ask with the edits, tool calls,
     *  subagents, workflow runs and background shells it produced. Work is attributed to the prompt that
     *  STARTED it (core's rule), so nothing here re-attributes by completion. */
    fun promptsJson(session: String, workDir: String?): String? {
        ViewBatch.view("prompts", session, workDir)?.let { return it }
        val r = run(listOf("prompts", "--session", session, "--json"), workDir)
        return if (r.ok) r.stdout else null
    }

    /** the agent's prose reply to one ask (its tool calls stripped) — the log a reviewer expands to read.
     *  Fetched on demand because it can be large. */
    fun promptResponseJson(session: String, promptId: String, workDir: String?): String? {
        val r = run(listOf("prompts", "--id", promptId, "--response", "--session", session, "--json"), workDir)
        return if (r.ok) r.stdout else null
    }

    /** The session's work as review units — the Review tab's whole payload; a null promptId answers
     *  the WHOLE session (the tab's default view), a prompt id scopes to one ask. This is also where
     *  this plugin finally gets core's same-code collapse: it reads raw records off disk everywhere
     *  else, and units exist only in core, served over this seam. `--no-patch` because the panel is a
     *  LIST — every diff renders in the editor, so shipping patch text here would be pure weight.
     *  Fetched on demand, like promptResponseJson — deliberately not batched: `views` hands one
     *  argument list to every view it runs, and this one's scope changes with the pick. */


    fun reviewJson(session: String, promptId: String?, workDir: String?): String? {
        val args = buildList {
            add("review")
            if (promptId != null) { add("--prompt"); add(promptId) }
            // Everything, not just pending: Review is the ONLY review surface (the Edits/Diffs trees
            // are gone) — resolved records render greyed with redo/undo, pending units first-class.
            add("--session"); add(session); add("--json"); add("--no-patch")
        }
        val r = run(args, workDir)
        return if (r.ok) r.stdout else null
    }

    /** A bounded tail of what ONE thing is doing: an agent, a workflow run, a task, a background shell,
     *  or the session itself. core decides whether the source is still writing ('live') or has finished
     *  ('audit'), so both editors follow — and stop following — the same things. */
    fun feedJson(session: String, kind: String, id: String, limit: Int, workDir: String?): String? {
        val args = buildList {
            add("feed"); add("--kind"); add(kind)
            if (id.isNotBlank()) { add("--id"); add(id) }
            // --feed-limit is the feed's OWN depth channel (it outranks --limit); --limit rides along
            // so an older CLI on PATH still honours the depth. --root scopes the read to the session's
            // workspace — a sibling worktree's feed is unreadable without it.
            add("--feed-limit"); add(limit.toString())
            add("--limit"); add(limit.toString())
            workDir?.let { add("--root"); add(it) }
            add("--session"); add(session)
            add("--json")
        }
        val r = run(args, workDir)
        return if (r.ok) r.stdout else null
    }

    /** Zero-token chat handoff: core assembles a ready-to-paste review prompt for an edit / subagent /
     *  task / action (or the whole session), which the caller copies to the clipboard. NEVER calls a
     *  model — this only reads the store + transcripts. Returns the prompt, or null if the CLI failed. */
    fun chatContextJson(session: String, workDir: String?, ref: ChatRef): String? {
        val args = buildList {
            add("chat-context"); add("--json")
            when (ref) {
                is ChatRef.Edit -> { add("--edit"); add(ref.id.toString()) }
                is ChatRef.Agent -> { add("--agent"); add(ref.agentId) }
                is ChatRef.Task -> { add("--task"); add(ref.taskId) }
                is ChatRef.ToolUse -> { add("--tool-use-id"); add(ref.toolUseId) }
                ChatRef.Session -> {} // no ref flag → session-level framing
            }
            add("--session"); add(session)
            workDir?.let { add("--root"); add(it) }
        }
        val r = run(args, workDir)
        if (!r.ok) return null
        return try {
            JsonParser.parseString(r.stdout).asJsonObject.get("prompt")?.takeIf { !it.isJsonNull }?.asString
        } catch (_: Exception) {
            null
        }
    }

    /** #5 review comments: add a line comment on a pending edit through the CLI (the JVM stays out of
     *  core). `line` 0 is a whole-edit note. Null on success, else the CLI's reason. The text rides as
     *  ONE `--text=<text>` argument: a separate value starting with `--` (a markdown rule, "--force is
     *  wrong here") is read by the CLI as a missing value. */
    fun commentAdd(session: String, workDir: String?, unit: Int, line: Int, text: String): String? {
        val args = buildList {
            add("comment"); add("add"); add("--session"); add(session)
            add("--edit"); add(unit.toString())
            if (line > 0) { add("--line"); add(line.toString()) }
            add("--text=$text")
            workDir?.let { add("--root"); add(it) }
        }
        val r = run(args, workDir)
        return if (r.ok) null else failureMessage(r.stdout, r.stderr, "`oak comment add` did not answer").removePrefix("oak: ")
    }

    data class CommentDraft(val text: String, val ids: List<String>)

    /** Compose without consuming the ledger. Only an acknowledged prompt spends these exact ids. */
    fun commentCompose(session: String, workDir: String?): CommentDraft? {
        val r = run(listOf("comment", "compose", "--session", session, "--json"), workDir)
        if (!r.ok) return null
        return runCatching {
            val o = JsonParser.parseString(r.stdout).asJsonObject
            val text = o.get("text")?.asString.orEmpty()
            if (text.isBlank()) null else CommentDraft(text, o.getAsJsonArray("ids")?.map { it.asString } ?: emptyList())
        }.getOrNull()
    }

    /**
     * Submit a draft to the session's agent through herdr (`oak prompt`). Null when it was sent, else the
     * reason, as the CLI gave it. The draft rides as ONE `--text=<draft>` argument, since a separate value
     * starting with `--` is read by the CLI as a missing one. The budget is the heavy one: a prompt to a
     * saved machine makes several forwarded round trips, and a run killed mid-send may still deliver.
     */
    fun prompt(session: String, text: String, workDir: String?, commentIds: List<String> = emptyList()): String? {
        val args = mutableListOf("prompt", "--session", session, "--text=$text", "--json")
        if (commentIds.isNotEmpty()) { args.add("--comment-ids"); args.add(commentIds.joinToString(",")) }
        val r = run(args, workDir, timeoutMs = HEAVY_TIMEOUT_MS)
        val o = runCatching { JsonParser.parseString(r.stdout).asJsonObject }.getOrNull()
        if (r.ok && o?.get("sent")?.takeIf { it.isJsonPrimitive }?.asBoolean == true) return null
        if (r.stderr.startsWith("oak timed out")) return "`oak prompt` did not answer within ${HEAVY_TIMEOUT_MS / 60_000} minutes — the prompt may still have been delivered; check the session's pane before sending it again"
        return o?.get("reason")?.takeIf { it.isJsonPrimitive }?.asString?.takeIf { it.isNotBlank() }
            ?: failureMessage(r.stdout, r.stderr, "`oak prompt` did not answer").removePrefix("oak: ")
    }

    fun startAgent(kind: String, workDir: String?): ChangeResult {
        val r = run(listOf("agent", "start", "--kind", kind, "--json"), workDir)
        return ChangeResult(if (r.ok) null else r.stderr.trim().ifBlank { "could not start the agent in herdr" })
    }

    /** #6/#7: the agent's last reply as a `> ` block, for quoting/annotating in the next prompt. */
    fun quoteLastReply(session: String, workDir: String?): String? {
        val args = buildList {
            add("quote"); add("--session"); add(session)
            workDir?.let { add("--root"); add(it) }
        }
        val r = run(args, workDir)
        return if (r.ok && r.stdout.isNotBlank()) r.stdout else null
    }

    /** Portable markdown review summary (kept/reverted per file) for export. */
    fun summaryMarkdown(session: String, workDir: String?): String? {
        val r = run(listOf("summary", "--markdown", "--session", session), workDir)
        return if (r.ok) r.stdout else null
    }

    /** The FULL session trace — everything the observatory recorded — as JSON (`export`). Core
     *  composes it, so this plugin, VS Code, and the CLI export the identical document. */
    fun traceJson(session: String, workDir: String?): String? {
        val r = run(listOf("export", "--session", session), workDir)
        return if (r.ok) r.stdout else null
    }

    data class VersionCheck(
        val current: String,
        val channel: String, // "stable" | "dev"
        val latest: String?,
        val updateAvailable: Boolean,
        /** The installed build sorts ABOVE the channel's newest — a local build, or a channel just
         *  switched downward. It is still actionable (following a channel means matching it), but it
         *  is not an "update", and calling it one confused everyone who hit it. */
        val stranded: Boolean,
        val stableLatest: String?,
        val devLatest: String?,
    )

    /** One row of `update --json`: what a surface has installed, and what the channel says it should
     *  have. `reason` is core's UpdateReason — current / behind / ahead / switching / missing / forced. */
    data class UpdateSurface(val surface: String, val label: String, val from: String?, val to: String, val reason: String)

    /**
     * `update --json` — the whole plan, as DATA, installing nothing.
     *
     * This exists so the plugin can stop deciding what happened by grepping the CLI's prose
     * (`out.contains("everything is up to date")`), which broke the moment the wording moved and gave
     * people "no restart needed" after a real install. Ask before, act, ask again.
     */
    fun updatePlan(channel: String?, workDir: String?): List<UpdateSurface>? {
        val args = buildList {
            add("update"); add("--json")
            if (channel != null) { add("--channel"); add(channel) }
        }
        val r = run(args, workDir, timeoutMs = 60_000)
        if (!r.ok) return null
        return try {
            val arr = JsonParser.parseString(r.stdout).asJsonObject.getAsJsonArray("surfaces")
            arr.map { el ->
                val o = el.asJsonObject
                fun s(k: String) = o.get(k)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString
                UpdateSurface(
                    surface = s("surface") ?: "",
                    label = s("label") ?: "",
                    from = s("from"),
                    to = s("to") ?: "",
                    reason = s("reason") ?: "",
                )
            }
        } catch (_: Exception) {
            null
        }
    }

    /** `version --check --json` — the version dropdown's payload: the installed CLI version, the
     *  followed channel, and both channels' newest releases (one GitHub fetch, CLI-side). Null when
     *  the CLI is missing, offline, or predates the channels. */
    fun versionCheck(workDir: String?): VersionCheck? {
        val r = run(listOf("version", "--check", "--json"), workDir)
        if (!r.ok) return null
        return try {
            val o = JsonParser.parseString(r.stdout).asJsonObject
            fun s(k: String) = o.get(k)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString
            VersionCheck(
                current = s("current") ?: "",
                channel = s("channel") ?: "stable",
                latest = s("latest"),
                updateAvailable = o.get("updateAvailable")?.takeIf { it.isJsonPrimitive }?.asBoolean ?: false,
                stranded = o.get("stranded")?.takeIf { it.isJsonPrimitive }?.asBoolean ?: false,
                stableLatest = s("stableLatest"),
                devLatest = s("devLatest"),
            )
        } catch (_: Exception) {
            null
        }
    }

    /** `update [--channel X]` — the ONE updater for every surface: refreshes the CLI, both editor
     *  plugins, and the status line; `--channel` also switches release channels. LONG (downloads) —
     *  callers run it on a pooled thread and tell the user to restart the IDE afterwards. */
    fun update(channel: String?, workDir: String?): Pair<Boolean, String> {
        val args = buildList {
            add("update")
            if (channel != null) {
                add("--channel"); add(channel)
            }
        }
        val r = run(args, workDir, timeoutMs = 300_000)
        return r.ok to (if (r.ok) r.stdout else failureMessage(r.stdout, r.stderr, "the CLI exited ${r.exitCode} without saying why"))
    }

    /** Node's own chatter on stderr — `(node:123) [DEP0190] …` and the `(Use `node --trace…`)` hint
     *  that follows it. Never a failure reason. */
    private val NODE_NOISE = Regex("""^\s*(?:\(node:\d+\)|\(Use `node )""")

    /** Lines that read as a problem rather than as progress — used only when falling back to stdout. */
    private val LOOKS_LIKE_TROUBLE = Regex(
        """(?:^\s*[⚠✗✘✖!]|\b(?:fail(?:ed|ure)?|could not|couldn't|cannot|can't|unable|denied|refused|missing|not found|no such)\b)""",
        RegexOption.IGNORE_CASE,
    )

    /**
     * MIRROR of core/failure.ts `cliFailureMessage` — keep the two in step. A source assertion in
     * packages/core/test/core.test.js fails if this function goes missing, because a silent
     * divergence between the two editors is the very class of bug this fixes.
     *
     * The rule used to be `stderr.ifBlank { stdout }`, with a comment asserting the error is always on
     * stderr. It is not: the CLI's "could not update the VS Code extension" path exits 1 while writing
     * to stdout, and on Windows stderr held nothing but a Node DEP0190 deprecation warning — so the
     * toast showed the warning and hid the reason (#45). Prefer stderr MINUS the noise; then the lines
     * of stdout that read as trouble; then its tail, where a summary lives.
     */
    fun failureMessage(stdout: String, stderr: String, fallback: String, maxLen: Int = 300): String {
        fun cap(s: String) = if (s.length > maxLen) s.take(maxLen - 1).trimEnd() + "…" else s
        // trimEnd on every line, matching the TS: otherwise the two editors show the same failure with
        // different trailing whitespace, and the parity this function exists for is only approximate.
        val realStderr =
            stderr.lines().map { it.trimEnd() }.filter { it.isNotBlank() && !NODE_NOISE.containsMatchIn(it) }
                .joinToString("\n").trim()
        if (realStderr.isNotEmpty()) return cap(realStderr)
        val out = stdout.lines().map { it.trimEnd() }.filter { it.isNotBlank() }
        val flagged = out.filter { LOOKS_LIKE_TROUBLE.containsMatchIn(it) }
        if (flagged.isNotEmpty()) return cap(flagged.joinToString("\n").trim())
        if (out.isNotEmpty()) return cap(out.takeLast(3).joinToString("\n").trim())
        return fallback
    }

    /** Setup diagnostics as markdown. `doctor` exits 1 when there are failures but still prints, so the
     *  caller takes stdout regardless of the exit code. It times forwarding to every saved herdr machine
     *  (up to 30 s each, in turn), so it gets the heavy budget, the deadline VS Code gives it too. */
    fun doctor(workDir: String?): CliResult = run(listOf("doctor", "--markdown"), workDir, timeoutMs = HEAVY_TIMEOUT_MS)

    /** `--claude-bin <path>` when the user set an explicit claude CLI path (Settings → Tools → Claude
     *  Observatory). Without this the setting is dead: a GUI-launched IDE with a stripped PATH can't
     *  find `claude`, and Analyze/Recap fail even though the user pointed us at the binary. */
    private fun claudeBinArgs(): List<String> =
        ObservatorySettings.instance.state.claudeBin?.takeIf { it.isNotBlank() }
            ?.let { listOf("--claude-bin", it) } ?: emptyList()

    /** Opt-in `claude -p` layer: cached unless fresh; can run for minutes. Returns text or null. */
    fun analyze(session: String, id: Int, workDir: String?): String? {
        val args = listOf("analyze", id.toString(), "--session", session, "--json") + claudeBinArgs()
        val r = run(args, workDir, timeoutMs = 150_000)
        return analysisText(r)
    }

    fun recap(session: String, fresh: Boolean, workDir: String?): String? {
        val args = buildList {
            add("recap"); add("--session"); add(session); add("--json"); if (fresh) add("--fresh")
            addAll(claudeBinArgs())
        }
        return analysisText(run(args, workDir, timeoutMs = 150_000))
    }

    private fun analysisText(r: CliResult): String? = try {
        if (r.ok) JsonParser.parseString(r.stdout).asJsonObject.get("text").asString else null
    } catch (_: Exception) {
        null
    }

    // --- demo mode + the guided tour (0.8.9) ---------------------------------------------------------

    /**
     * Replay the demo session, STREAMING its per-beat narration instead of waiting for the process.
     *
     * `run` is spawn-and-wait with a 30s cap, and a paced replay is ~20s — already inside the noise
     * margin, and `--speed 0.5` would blow straight past it. Streaming buys three things a longer
     * timeout does not: the progress bar narrates each beat as it lands, the panels can be refreshed
     * per beat rather than once at the end, and Cancel can actually stop it.
     *
     * A cancelled run leaves a partial demo, which `demoClean` removes exactly like a complete one.
     * Returns the exit code with the narration joined, for the caller's error path.
     */
    fun demoStreaming(args: List<String>, workDir: String?, isCancelled: () -> Boolean, onLine: (String) -> Unit): CliResult {
        return try {
            val handler = OSProcessHandler(commandLine(listOf("demo") + args, workDir))
            // StringBuffer, not StringBuilder: these are appended from the process reader thread and
            // read from this one after an ASYNCHRONOUS destroyProcess(), so there is no happens-before
            // edge to rely on — a torn read used to surface a plain cancel as "could not start".
            val out = StringBuffer()
            val err = StringBuffer()
            handler.addProcessListener(object : ProcessAdapter() {
                override fun onTextAvailable(event: ProcessEvent, outputType: Key<*>) {
                    // stderr is the only place a failing run says WHY; dropping it left every failure
                    // reported as "is the CLI installed?", the one cause already ruled out.
                    if (outputType == ProcessOutputTypes.STDERR) { err.append(event.text); return }
                    if (outputType != ProcessOutputTypes.STDOUT) return
                    out.append(event.text)
                    event.text.lineSequence().map { it.trim() }.filter { it.isNotEmpty() }.forEach(onLine)
                }
            })
            handler.startNotify()
            var cancelled = false
            while (!handler.waitFor(200)) {
                if (isCancelled()) { handler.destroyProcess(); cancelled = true; break }
            }
            CliResult(
                if (cancelled) -1 else (handler.exitCode ?: -1),
                out.toString(),
                if (cancelled) "cancelled" else err.toString(),
            )
        } catch (e: Exception) {
            CliResult(-1, "", e.message ?: "failed to launch the demo")
        }
    }

    /**
     * The guided tour's script. Core owns it, so this and the VS Code panel render the same tour.
     *
     * Capability-probed first, and that is not defensive habit: a pre-0.8.9 CLI does not reject
     * `demo --tour --json` — it ignores the unknown flag, honours `--json`, and REPLAYS AN ENTIRE DEMO
     * as the side effect of being asked for a script. Asking `help` what it supports costs one cheap
     * process and cannot mutate anything.
     */
    fun demoTour(workDir: String?, essentials: Boolean = false): List<DemoStep> {
        if (!run(listOf("help"), workDir).stdout.contains("demo --tour")) return emptyList()
        val args = buildList { add("demo"); add("--tour"); if (essentials) add("--essentials"); add("--json") }
        val r = run(args, workDir)
        return if (r.ok) TourParser.parse(r.stdout) else emptyList()
    }

    /** Keep a running demo inside the fleet's 60s active window — mtime only, nothing is written.
     *  Called on tour step advance ONLY: this touches watched files, so calling it from a refresh
     *  would wake the watcher that triggered it, forever. */
    fun demoTouch(workDir: String?): CliResult = run(listOf("demo", "--touch", "--json"), workDir)

    /** Remove every trace: both sessions, their stores, the demo folder, and the scratch dir. */
    fun demoClean(workDir: String?): CliResult = run(listOf("demo", "--clean", "--json"), workDir)

    /** The primary session id a streamed replay reported. Its final narration line names it, and the
     *  sibling agent's id is never printed — so this is exact, where picking one out of the store would
     *  have to assume an ordering. Null when the run printed nothing (a failed spawn, or a cancel
     *  before the first beat), and the caller falls back to [demoSession]. */
    fun demoSessionFrom(stdout: String): String? =
        DEMO_ID_IN_TEXT.findAll(stdout).lastOrNull()?.value

    private val DEMO_ID_IN_TEXT = Regex("demo-[0-9a-f]{8}")

    /** The demo session id for this project, or null — how the plugin finds a demo it did not itself
     *  just start (one a crashed IDE left behind, since demo mode persists no state of its own). */
    fun demoSession(workDir: String?): String? = try {
        val r = run(listOf("sessions", "--json"), workDir)
        if (!r.ok) null
        else JsonParser.parseString(r.stdout).asJsonObject.getAsJsonArray("sessions")
            .mapNotNull { it.takeIf { e -> e.isJsonObject }?.asJsonObject?.get("id")?.asString }
            .firstOrNull { DEMO_ID.matches(it) }
    } catch (_: Exception) {
        null
    }

    /** The same gate core applies — `demo-<8hex>` and nothing else may drive demo-only behaviour. */
    private val DEMO_ID = Regex("^demo-[0-9a-f]{8}$")

    fun isDemoSession(id: String?): Boolean = id != null && DEMO_ID.matches(id)

    // internal, not private: the port-fidelity test constructs CliResults and pins every field read.
    internal fun parseUndo(r: CliResult): UndoResult = try {
        val o = JsonParser.parseString(r.stdout).asJsonObject
        UndoResult(
            o.get("ok").asBoolean, o.get("status").asString, o.get("message").asString,
            intList(o, "dependents"), intList(o, "closure"),
        )
    } catch (_: Exception) {
        UndoResult(false, "error", r.stderr.ifBlank { "oak CLI not found — install it and set its path in Settings → Tools → OAK" })
    }

    private fun parseInt(json: String, key: String): Int = try {
        JsonParser.parseString(json).asJsonObject.get(key).asInt
    } catch (_: Exception) {
        0
    }
}

/** What a zero-token chat handoff is about — maps 1:1 to `chat-context`'s ref flags (§7). */
sealed class ChatRef {
    /** No ref flag → a whole-session framing prompt. */
    object Session : ChatRef()
    data class Edit(val id: Int) : ChatRef()          // --edit <n>
    data class Agent(val agentId: String) : ChatRef() // --agent <id> (a subagent)
    data class Task(val taskId: String) : ChatRef()   // --task <id>
    data class ToolUse(val toolUseId: String) : ChatRef() // --tool-use-id <id>
}
