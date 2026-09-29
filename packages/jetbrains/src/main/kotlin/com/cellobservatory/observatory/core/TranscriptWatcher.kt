package com.cellobservatory.observatory.core

import com.cellobservatory.observatory.model.MultitaskParser
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.SystemInfo
import java.io.IOException
import java.nio.file.FileSystems
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardWatchEventKinds.ENTRY_CREATE
import java.nio.file.StandardWatchEventKinds.ENTRY_DELETE
import java.nio.file.StandardWatchEventKinds.ENTRY_MODIFY
import java.nio.file.WatchService
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import kotlin.io.path.exists
import kotlin.io.path.isDirectory
import kotlin.io.path.listDirectoryEntries
import kotlin.io.path.name

/**
 * Watches Claude Code's TRANSCRIPTS (not the edit store) so panels rebuild on transcript growth —
 * reads, bash, subagent spawns, to-dos — and not only on edits. `StoreWatcher` covers the store log;
 * without this a "live" Multitasking / Actions / Timeline window would silently update only when
 * Claude writes a file (a no-silent-fail violation).
 *
 * Bounded to the worktree-sibling project dirs (`multitask --json`'s `worktrees[]`), NOT all of
 * `~/.claude/projects`. `java.nio.WatchService` is NOT recursive, so we register a `WatchKey` PER
 * directory — each project dir + its `<session>/` dirs + their `subagents/` subdirs — and register
 * newly-created worktree/session/subagent dirs dynamically on `ENTRY_CREATE`. On macOS the JDK's
 * default WatchService is a slow (~10s) poller, so — exactly like `StoreWatcher` — we use a 2s mtime
 * poll over the same bounded set instead. On Linux/Windows we use native inotify/RDC and fall back to
 * the 2s poll on `ENOSPC`/too-many-watches, so watch exhaustion degrades loudly-but-functionally.
 */
@Service(Service.Level.PROJECT)
class TranscriptWatcher(private val project: Project) : Disposable {
    private val log = logger<TranscriptWatcher>()
    private val listeners = CopyOnWriteArrayList<Runnable>()
    private val exec = ScheduledThreadPoolExecutor(1) { r -> Thread(r, "claude-observatory-transcript").apply { isDaemon = true } }
    private var pending: ScheduledFuture<*>? = null

    @Volatile private var watcher: WatchService? = null
    @Volatile private var started = false
    @Volatile private var polling = false
    private val registered = ConcurrentHashMap.newKeySet<Path>()

    @Volatile private var projectDirs: List<Path> = emptyList()
    @Volatile private var lastStamp: Long = 0L

    fun addListener(l: Runnable) {
        listeners.add(l)
        ensureStarted()
    }

    fun removeListener(l: Runnable) = listeners.remove(l)

    @Synchronized
    private fun ensureStarted() {
        if (started) return
        started = true
        // Arm on the project's OWN dir immediately (no CLI) so the current worktree is live at once;
        // sibling discovery (which spawns the CLI) runs async and only ADDS dirs.
        exec.schedule({ start() }, 0, TimeUnit.MILLISECONDS)
        // Worktree siblings appear/disappear mid-run — re-discover on a slow cadence. kickDiscovery
        // submits to the pooled thread, so this never blocks the 2s poll (single-thread `exec`).
        exec.scheduleWithFixedDelay({ kickDiscovery() }, DISCOVER_MS, DISCOVER_MS, TimeUnit.MILLISECONDS)
    }

    private fun start() {
        projectDirs = projectDirsFor(listOfNotNull(project.basePath)) // base only — instant, no CLI
        lastStamp = transcriptStamp(projectDirs)
        // macOS's default WatchService is a slow (~10s) poller — use the 2s mtime poll directly, same as
        // StoreWatcher. inotify/RDC elsewhere, falling back to the poll on ENOSPC.
        if (SystemInfo.isMac) {
            startPollFallback()
        } else {
            try {
                val ws = FileSystems.getDefault().newWatchService()
                watcher = ws
                watchDirsFor(projectDirs).forEach { registerDir(ws, it) }
                Thread({ loop(ws) }, "claude-observatory-transcript-watch").apply { isDaemon = true }.start()
            } catch (e: Exception) {
                log.warn("transcript watch unavailable (${e.message}) — falling back to 2s mtime polling")
                closeWatcher()
                startPollFallback()
            }
        }
        // Codex shards by date. Poll metadata without registering an unbounded watcher tree.
        val codexHome = Path.of(System.getenv("CODEX_HOME")?.takeIf { it.isNotBlank() } ?: System.getProperty("user.home") + "/.codex")
        var codexStamp = codexTranscriptStamp(codexHome)
        exec.scheduleWithFixedDelay({
            val next = codexTranscriptStamp(codexHome)
            if (next != codexStamp) { codexStamp = next; debounceNotify() }
        }, POLL_MS, POLL_MS, TimeUnit.MILLISECONDS)
        kickDiscovery() // async: fold in the worktree siblings
    }

    @Volatile private var lastProjectsSig: String? = null

    /** Discover the repo's worktree-sibling dirs on the POOLED thread (the CLI spawn is heavy and must
     *  never stall the poll), then UNION them in and (nio) register the new ones. Union-not-replace so a
     *  transient CLI failure never drops a sibling we were watching.
     *
     *  The `multitask` spawn costs ~10s of CPU, and this runs every DISCOVER_MS forever — so gate it:
     *  a new worktree sibling ALWAYS surfaces as a new dir under <config>/projects, so until that
     *  listing changes there is nothing new to discover and the spawn is pure waste. */
    private fun kickDiscovery() {
        ApplicationManager.getApplication().executeOnPooledThread {
            if (project.isDisposed) return@executeOnPooledThread
            val sig = projectsDirSignature(ClaudePaths.configDir().resolve("projects"))
            if (sig == lastProjectsSig) return@executeOnPooledThread
            val merged = (projectDirs + discoverSiblingDirs()).distinct()
            lastProjectsSig = sig
            if (merged.toSet() == projectDirs.toSet()) return@executeOnPooledThread
            projectDirs = merged
            watcher?.let { ws -> watchDirsFor(merged).forEach { registerDir(ws, it) } }
        }
    }

    /** Bounded to this repo's worktree siblings: the project cwd + `multitask`'s `worktrees[]`, each
     *  mangled to its `<config>/projects/<mangled>` dir. Falls back to just the project cwd on failure. */
    private fun discoverSiblingDirs(): List<Path> {
        val base = project.basePath ?: return emptyList()
        val cwds = LinkedHashSet<String>().apply { add(base) }
        // No --session: only `worktrees[]` is read here, which is keyed by --root (the repo), not by
        // whichever sibling the payload calls its own.
        runCatching { ObservatoryCli.multitaskJson(null, base)?.let { MultitaskParser.parse(it)?.worktrees } }
            .getOrNull()?.let { cwds.addAll(it) }
        return projectDirsFor(cwds)
    }

    private fun registerDir(ws: WatchService, dir: Path) {
        if (!registered.add(dir)) return // already watching
        try {
            dir.register(ws, ENTRY_CREATE, ENTRY_MODIFY, ENTRY_DELETE)
        } catch (e: IOException) {
            // ENOSPC / "user limit of inotify watches reached" — degrade to the 2s poll, loudly.
            registered.remove(dir)
            log.warn("transcript watch registration failed (${e.message}) — falling back to 2s mtime polling")
            closeWatcher()
            startPollFallback()
        } catch (_: Exception) {
            registered.remove(dir) // dir vanished between listing and registration
        }
    }

    private fun loop(ws: WatchService) {
        while (true) {
            val key = try {
                ws.take()
            } catch (_: Exception) {
                return // watcher closed on dispose / fallback
            }
            var relevant = false
            val dir = key.watchable() as? Path
            for (ev in key.pollEvents()) {
                val name = (ev.context() as? Path)?.toString() ?: continue
                if (dir == null) continue
                val child = dir.resolve(name)
                if (ev.kind() == ENTRY_CREATE && child.isDirectory()) {
                    // A new session dir (or subagents/ subdir) appeared — start watching it (and its
                    // subagents subdir) so the very first transcript line under it refreshes too.
                    registerDir(ws, child)
                    child.resolve("subagents").takeIf { it.exists() && it.isDirectory() }?.let { registerDir(ws, it) }
                    relevant = true
                } else if (name.endsWith(".jsonl")) {
                    relevant = true // transcript growth (reads/bash/spawns/todos) or a new session/agent file
                }
            }
            key.reset()
            if (relevant) debounceNotify()
        }
    }

    @Synchronized
    private fun startPollFallback() {
        if (polling) return
        polling = true
        exec.scheduleWithFixedDelay({
            val now = transcriptStamp(projectDirs)
            if (now != lastStamp) {
                lastStamp = now
                debounceNotify()
            }
        }, POLL_MS, POLL_MS, TimeUnit.MILLISECONDS)
    }

    private fun debounceNotify() {
        pending?.cancel(false)
        pending = exec.schedule({
            ApplicationManager.getApplication().invokeLater {
                if (!project.isDisposed) listeners.forEach { it.run() }
            }
        }, DEBOUNCE_MS, TimeUnit.MILLISECONDS)
    }

    private fun closeWatcher() {
        try {
            watcher?.close()
        } catch (_: Exception) {
        }
        watcher = null
    }

    override fun dispose() {
        closeWatcher()
        exec.shutdownNow()
    }

    companion object {
        private const val POLL_MS = 2000L
        private const val DISCOVER_MS = 15_000L
        private const val DEBOUNCE_MS = 300L

        fun getInstance(project: Project): TranscriptWatcher = project.getService(TranscriptWatcher::class.java)

        /** cwds → their `<config>/projects/<mangled>` dirs, existing + deduped. Pure (testable). */
        fun projectDirsFor(cwds: Collection<String>): List<Path> =
            cwds.map { ClaudePaths.projectDir(it) }.filter { it.exists() && it.isDirectory() }.distinct()

        /** Every directory to register a nio WatchKey on: each project dir (new session transcripts +
         *  new session dirs) + each `<session>/` dir (a new subagents/ subdir) + each `subagents/`
         *  subdir (agent-*.jsonl growth). Pure (testable). */
        fun watchDirsFor(projectDirs: Collection<Path>): Set<Path> {
            val dirs = LinkedHashSet<Path>()
            for (dir in projectDirs) {
                if (!dir.exists() || !dir.isDirectory()) continue
                dirs.add(dir)
                try {
                    dir.listDirectoryEntries().filter { it.isDirectory() }.forEach { sess ->
                        dirs.add(sess)
                        val sub = sess.resolve("subagents")
                        if (sub.exists() && sub.isDirectory()) dirs.add(sub)
                    }
                } catch (_: Exception) {
                }
            }
            return dirs
        }

        /** Mtime+size fold over every ".jsonl" transcript in the bounded set (top-level session files
         *  + each session's "subagents" agent transcripts). Changes on both append (mtime/size) and a
         *  new file appearing. Pure (testable) — the poll-fallback's change signal. */
        fun transcriptStamp(projectDirs: Collection<Path>): Long {
            var stamp = 0L
            for (dir in projectDirs) {
                if (!dir.exists()) continue
                try {
                    dir.listDirectoryEntries().forEach { entry ->
                        if (entry.isDirectory()) {
                            val sub = entry.resolve("subagents")
                            if (sub.exists() && sub.isDirectory()) {
                                sub.listDirectoryEntries("*.jsonl").forEach { stamp += fileStamp(it) }
                            }
                        } else if (entry.name.endsWith(".jsonl")) {
                            stamp += fileStamp(entry)
                        }
                    }
                } catch (_: Exception) {
                }
            }
            return stamp
        }

        fun codexTranscriptStamp(home: Path): Long {
            var stamp = 0L
            for (root in listOf(home.resolve("sessions"), home.resolve("archived_sessions"))) {
                if (!Files.isDirectory(root)) continue
                runCatching { Files.walk(root, 6).use { paths ->
                    paths.filter { it.name.endsWith(".jsonl") && Files.isRegularFile(it) }.forEach { stamp += fileStamp(it) }
                } }
            }
            return stamp
        }

        private fun fileStamp(p: Path): Long = try {
            Files.getLastModifiedTime(p).toMillis() + Files.size(p)
        } catch (_: Exception) {
            0L
        }
    }
}

/** Order-independent fingerprint of the project-dir listing — the cheap gate for sibling discovery.
 *  Internal (not private) so the gate is unit-testable without mocking the CLI. */
internal fun projectsDirSignature(projectsDir: Path): String = runCatching {
    projectsDir.listDirectoryEntries().map { it.name }.sorted().joinToString("\n")
}.getOrDefault("")
