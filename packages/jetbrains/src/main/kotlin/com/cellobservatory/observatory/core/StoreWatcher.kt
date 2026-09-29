package com.cellobservatory.observatory.core

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.util.SystemInfo
import java.nio.file.FileSystems
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardWatchEventKinds.ENTRY_CREATE
import java.nio.file.StandardWatchEventKinds.ENTRY_DELETE
import java.nio.file.StandardWatchEventKinds.ENTRY_MODIFY
import java.nio.file.WatchService
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import kotlin.io.path.exists
import kotlin.io.path.isDirectory
import kotlin.io.path.name
import kotlin.io.path.listDirectoryEntries

/**
 * Watches <configDir>/claude-observatory/<any session>/log.jsonl with a plain nio WatchService —
 * the store lives OUTSIDE any project, so VFS watch roots are the wrong tool. Captures land in
 * PreToolUse+PostToolUse bursts, so events are debounced 150ms (same as the VS Code extension).
 * App-level service; project services register listeners and are notified on the EDT.
 */
@Service
class StoreWatcher : Disposable {
    private val log = logger<StoreWatcher>()
    private val listeners = CopyOnWriteArrayList<Runnable>()
    private val debouncer = ScheduledThreadPoolExecutor(1) { r -> Thread(r, "claude-observatory-debounce").apply { isDaemon = true } }
    private var pending: ScheduledFuture<*>? = null

    @Volatile
    private var watcher: WatchService? = null
    private var started = false
    /** The poll task, so a restart can cancel it instead of leaving a second one running. */
    private var pollTask: ScheduledFuture<*>? = null

    fun addListener(l: Runnable) {
        listeners.add(l)
        ensureStarted()
    }

    fun removeListener(l: Runnable) = listeners.remove(l)

    /**
     * Re-point at the store root and start again — called when a move lands.
     *
     * Without this the watcher kept its ORIGINAL root for the life of the IDE: `ensureStarted` reads
     * `ClaudePaths.rootDir()` once, and it had already re-created the abandoned directory, so it
     * polled a folder nothing would ever write to and live refresh never fired again.
     */
    @Synchronized
    fun restart() {
        pollTask?.cancel(false)
        pollTask = null
        // Closing the service ends `loop`, which exits on the ClosedWatchServiceException.
        runCatching { watcher?.close() }
        watcher = null
        started = false
        if (listeners.isNotEmpty()) ensureStarted()
    }

    @Synchronized
    private fun ensureStarted() {
        if (started) return
        started = true
        val root = ClaudePaths.rootDir()
        try {
            Files.createDirectories(root) // watch works even before the first capture
            // macOS's default WatchService is a ~10s POLLING watcher (the JDK exposes no HIGH-sensitivity
            // knob) — slower than our own 2s mtime poll, so a fresh capture would sit invisible for
            // seconds. Use the 2s poll directly on macOS; native inotify/ReadDirectoryChanges elsewhere.
            if (SystemInfo.isMac) {
                startPollFallback(root)
                return
            }
            val ws = FileSystems.getDefault().newWatchService()
            watcher = ws
            register(ws, root)
            root.listDirectoryEntries().filter { it.isDirectory() }.forEach { register(ws, it) }
            Thread({ loop(ws, root) }, "claude-observatory-watch").apply { isDaemon = true }.start()
        } catch (e: Exception) {
            log.warn("store watch unavailable (${e.message}) — falling back to 2s mtime polling")
            startPollFallback(root)
        }
    }

    /** Network/overlay mounts (NFS, some devcontainer volumes) don't deliver inotify events —
     *  poll session-log mtimes instead so remote-dev setups still refresh live. */
    private fun startPollFallback(root: Path) {
        var last = pollStamp(root)
        pollTask = debouncer.scheduleWithFixedDelay({
            val now = pollStamp(root)
            if (now != last) {
                last = now
                debounceNotify()
            }
        }, 2, 2, TimeUnit.SECONDS)
    }

    private fun pollStamp(root: Path): Long = try {
        if (!root.exists()) 0L
        else root.listDirectoryEntries().filter { it.isDirectory() }.sumOf { dir ->
            dir.listDirectoryEntries().filter { p -> p.name == "log.jsonl" || p.name == "capture-events.jsonl" || p.name in listOf("attention.json", "agent.json") }
                .sumOf { p -> runCatching { Files.getLastModifiedTime(p).toMillis() + Files.size(p) }.getOrDefault(0L) }
        }
    } catch (_: Exception) {
        0L
    }

    private fun register(ws: WatchService, dir: Path) {
        try {
            dir.register(ws, ENTRY_CREATE, ENTRY_MODIFY, ENTRY_DELETE)
        } catch (_: Exception) {
            /* dir vanished between listing and registration */
        }
    }

    private fun loop(ws: WatchService, root: Path) {
        while (true) {
            val key = try {
                ws.take()
            } catch (_: Exception) {
                return // watcher closed on dispose
            }
            var relevant = false
            for (ev in key.pollEvents()) {
                val name = (ev.context() as? Path)?.toString() ?: continue
                val parent = key.watchable() as? Path ?: continue
                // New session dir under the root → start watching it for its log.jsonl.
                if (parent == root) {
                    val child = root.resolve(name)
                    if (child.isDirectory()) register(ws, child)
                    relevant = true // a new session's first capture must refresh too
                } else if (name == "log.jsonl" || name == "capture-events.jsonl" || name in listOf("attention.json", "agent.json")) {
                    relevant = true
                }
            }
            key.reset()
            if (relevant) debounceNotify()
        }
    }

    private fun debounceNotify() {
        pending?.cancel(false)
        pending = debouncer.schedule({
            ApplicationManager.getApplication().invokeLater {
                listeners.forEach { it.run() }
            }
        }, 150, TimeUnit.MILLISECONDS)
    }

    override fun dispose() {
        try {
            watcher?.close()
        } catch (_: Exception) {
        }
        debouncer.shutdownNow()
    }

    companion object {
        val instance: StoreWatcher
            get() = ApplicationManager.getApplication().getService(StoreWatcher::class.java)
    }
}
