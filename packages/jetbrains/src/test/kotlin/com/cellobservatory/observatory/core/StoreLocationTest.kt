package com.cellobservatory.observatory.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Paths

/**
 * The Kotlin path layer must follow `prefs.storeDir`.
 *
 * It did not: `rootDir()` was `configDir()/claude-observatory` unconditionally, so after a move —
 * made from this plugin's own popup, or from the terminal app, or from VS Code — every DIRECT read
 * here still resolved the abandoned location. Pending badges fell to zero, "Undo all" reported
 * nothing to revert while edits were pending, and a double-clicked edit opened a diff of
 * empty-against-empty, because `readBlob` swallows a missing file. Meanwhile the CLI-backed panels
 * followed the move, so one tool window showed two different truths.
 */
class StoreLocationTest {

    private fun writePrefs(cfg: java.nio.file.Path, json: String) {
        val dir = cfg.resolve("claude-observatory")
        Files.createDirectories(dir)
        Files.writeString(dir.resolve("prefs.json"), json)
    }

    @Test
    fun `with no setting the root is the default beside the config`() {
        val cfg = Files.createTempDirectory("cp-default")
        ClaudePaths.configDirOverride = cfg
        ClaudePaths.forgetRoot()
        assertEquals(cfg.resolve("claude-observatory"), ClaudePaths.rootDir())
    }

    @Test
    fun `a moved store is followed, and the session paths move with it`() {
        val cfg = Files.createTempDirectory("cp-moved")
        val dest = Files.createTempDirectory("cp-dest").resolve("obs")
        ClaudePaths.configDirOverride = cfg
        writePrefs(cfg, """{"storeDir": "${dest.toString().replace("\\", "\\\\")}"}""")
        ClaudePaths.forgetRoot()

        assertEquals(dest, ClaudePaths.rootDir())
        assertEquals(dest.resolve("sess1"), ClaudePaths.storeDir("sess1"))
        assertEquals(dest.resolve("sess1").resolve("log.jsonl"), ClaudePaths.logPath("sess1"))
        // Transcripts are NOT store data — they stay beside the config wherever the store goes.
        assertTrue(ClaudePaths.projectDir("/tmp/x").startsWith(cfg))
    }

    @Test
    fun `a malformed or absent prefs file falls back rather than breaking every read`() {
        val cfg = Files.createTempDirectory("cp-bad")
        ClaudePaths.configDirOverride = cfg
        writePrefs(cfg, "{ not json")
        ClaudePaths.forgetRoot()
        assertEquals(cfg.resolve("claude-observatory"), ClaudePaths.rootDir())

        writePrefs(cfg, """{"storeDir": "   "}""")
        ClaudePaths.forgetRoot()
        assertEquals(cfg.resolve("claude-observatory"), ClaudePaths.rootDir())

        // A relative location, `~name/…` among them, is not one, as core reads it: it would resolve against the IDE's own
        // working folder, where no other surface looks.
        for (relative in listOf("obs/store", "~x/obs")) {
            writePrefs(cfg, """{"storeDir": "$relative"}""")
            ClaudePaths.forgetRoot()
            assertEquals(relative, cfg.resolve("claude-observatory"), ClaudePaths.rootDir())
        }
    }

    /**
     * Redirecting the seam drops the cached root on its own — the caller must not have to know to say so.
     *
     * Every test above says `forgetRoot()` by hand. The ones that do not — the headless-IDE tests that
     * seed a store and then write into it — were left with a one-second window in which
     * `createDirectories(storeDir(s))` landed under the PREVIOUS test's root while
     * `writeString(logPath(s))` landed under their own, one cache expiry apart. That surfaced as a
     * `NoSuchFileException` in whichever test happened to run second, and passed when run alone, which
     * is the worst shape a failure can take: it reads as flakiness in the test rather than a seam that
     * does not do what its name says.
     */
    @Test
    fun `redirecting the seam drops the cached root, with no forgetRoot by hand`() {
        val a = Files.createTempDirectory("cp-seam-a")
        val b = Files.createTempDirectory("cp-seam-b")
        ClaudePaths.configDirOverride = a
        assertEquals(a.resolve("claude-observatory"), ClaudePaths.rootDir()) // populates the cache
        ClaudePaths.configDirOverride = b // deliberately NO forgetRoot() here
        assertEquals(
            "the seam answered with the previous root, so the cache outlived the redirect",
            b.resolve("claude-observatory"),
            ClaudePaths.rootDir(),
        )
    }

    /**
     * The store watcher follows a move made elsewhere. Only this plugin's own move restarted it, so after the terminal
     * app's, VS Code's or `oak store --move`, it went on watching the old root and live refresh stopped.
     */
    @Test
    fun `the store watcher follows a store moved by another surface`() {
        val cfg = Files.createTempDirectory("cp-watch")
        val dest = Files.createTempDirectory("cp-watch-dest").resolve("obs")
        ClaudePaths.configDirOverride = cfg
        val watcher = StoreWatcher()
        try {
            watcher.addListener {}
            assertEquals("control: it watches the default", cfg.resolve("claude-observatory"), watcher.watching)
            writePrefs(cfg, """{"storeDir": "${dest.toString().replace("\\", "\\\\")}"}""")
            val end = System.currentTimeMillis() + 10_000
            while (watcher.watching != dest && System.currentTimeMillis() < end) Thread.sleep(50)
            assertEquals("it follows the store where it went", dest, watcher.watching)
        } finally {
            watcher.dispose()
            ClaudePaths.configDirOverride = null
            cfg.toFile().deleteRecursively()
            dest.parent.toFile().deleteRecursively()
        }
    }

    /**
     * A store root deleted (by hand, say) and made again by the next capture is watched again. Its key no longer reported,
     * so no new session was watched and live refresh stopped until the IDE restarted. Linux: the macOS watcher polls, and
     * Windows reports a watched folder's deletion its own way.
     */
    @Test
    fun `the store watcher watches a root deleted and made again, and never makes it itself`() {
        org.junit.Assume.assumeTrue(System.getProperty("os.name").startsWith("Linux"))
        val cfg = Files.createTempDirectory("cp-rewatch")
        ClaudePaths.configDirOverride = cfg
        val root = cfg.resolve("claude-observatory")
        val watcher = StoreWatcher()
        fun until(what: String, ok: () -> Boolean) {
            val end = System.currentTimeMillis() + 10_000
            while (!ok() && System.currentTimeMillis() < end) Thread.sleep(50)
            assertTrue(what, ok())
        }
        try {
            watcher.addListener {}
            val first = watcher.rootKey
            assertTrue("control: the root is watched", first?.isValid == true)
            root.toFile().deleteRecursively()
            until("control: its key is dead once the root is gone") { first?.isValid == false }
            Thread.sleep(2_500) // past a follow check
            assertTrue("the watcher does not make the root again", !Files.exists(root))
            Files.createDirectories(root)
            until("the root made again is watched again") { watcher.rootKey !== first && watcher.rootKey?.isValid == true }
        } finally {
            watcher.dispose()
            ClaudePaths.configDirOverride = null
            cfg.toFile().deleteRecursively()
        }
    }

    /** An OAK older than 0.11.0 rewrites prefs.json with only the keys it knows, dropping `sync` and the `prefsFormat`
     *  mark: the delete dialog's words read the backup as oak sync's copy of the settings holds it, as the CLI puts it
     *  back (core keptPrefs). A prefs.json with the mark is as the person left it. */
    @Test
    fun `a backup folder dropped from prefs json by an older OAK is read from oak sync's copy`() {
        val cfg = Files.createTempDirectory("cp-kept")
        try {
            ClaudePaths.configDirOverride = cfg
            val copy = cfg.resolve("claude-observatory").resolve("sync")
            Files.createDirectories(copy)
            Files.writeString(copy.resolve("settings.json"), """{"sync":{"backup":{"kind":"folder","path":"/mnt/b"}}}""")
            writePrefs(cfg, """{"prefsFormat":2,"sync":{"backup":{"kind":"folder","path":"/mnt/b"}}}""")
            assertTrue("control: as prefs.json holds it", ClaudePaths.folderBackup())
            writePrefs(cfg, """{"sort":"name"}""")
            assertTrue("dropped by an older OAK, with the mark: as the copy holds it", ClaudePaths.folderBackup())
            writePrefs(cfg, """{"sort":"name","machineUsage":false}""")
            assertTrue("one of them put back by hand since: the rest as the copy holds them", ClaudePaths.folderBackup())
            writePrefs(cfg, """{"sort":"name","sync":{"auto":false}}""")
            assertTrue("sync put back since stands as written: no backup", !ClaudePaths.folderBackup())
            writePrefs(cfg, """{"prefsFormat":2,"sort":"name"}""")
            assertTrue("removed by hand, the mark left: no backup", !ClaudePaths.folderBackup())
            Files.delete(cfg.resolve("claude-observatory").resolve("prefs.json"))
            assertTrue("nor with no prefs.json at all", !ClaudePaths.folderBackup())
            writePrefs(cfg, """{"sync":{"backup":{"kind":"machine","label":"nas"}}}""")
            assertTrue("one set since is the one read", !ClaudePaths.folderBackup())
        } finally {
            ClaudePaths.configDirOverride = null
            cfg.toFile().deleteRecursively()
        }
    }

    @Test
    fun `a tilde in the setting is expanded, because that is what a reader types`() {
        val cfg = Files.createTempDirectory("cp-tilde")
        ClaudePaths.configDirOverride = cfg
        writePrefs(cfg, """{"storeDir": "~/obs-store"}""")
        ClaudePaths.forgetRoot()
        assertEquals(Paths.get(System.getProperty("user.home"), "obs-store"), ClaudePaths.rootDir())
    }
}
