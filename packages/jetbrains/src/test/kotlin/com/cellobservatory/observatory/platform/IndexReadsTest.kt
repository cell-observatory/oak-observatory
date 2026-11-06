package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.core.QueryServe
import com.cellobservatory.observatory.core.StoreReader
import com.cellobservatory.observatory.core.TranscriptWatcher
import com.cellobservatory.observatory.model.SessionsParser
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.cellobservatory.observatory.ui.ReviewOps
import com.intellij.notification.Notification
import com.intellij.notification.Notifications
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.TestDialog
import com.intellij.openapi.ui.TestDialogManager
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vfs.newvfs.impl.VfsRootAccess
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.util.ui.UIUtil
import java.io.File
import java.nio.file.Files
import java.util.concurrent.TimeUnit
import javax.swing.JList

/**
 * What the plugin reads from the local index (0.11.0), through this tree's real `oak`: every other machine's sessions in
 * the Switch Session chooser, each opened read-only with a fetch; and the pin check and the Codex change signal, answered
 * by `oak query --serve` where every rollout's head was read for the one, and any Codex session's write refreshed the
 * project for the other.
 */
class IndexReadsTest : ObservatoryPlatformTestCase() {

    private lateinit var cfg: File
    private lateinit var bin: File
    private var prevCfg: String? = null
    private var prevBin: String? = null
    /** build.gradle.kts points this at the tree's own `oak`. */
    private val treeOak: String get() = System.getenv("CLAUDE_OBSERVATORY_BIN") ?: error("no CLAUDE_OBSERVATORY_BIN: run through gradle's test task")

    override fun setUp() {
        super.setUp()
        cfg = Files.createTempDirectory("oak-index-cfg").toFile()
        bin = Files.createTempDirectory("oak-index-bin").toFile()
        VfsRootAccess.allowRootAccess(testRootDisposable, cfg.path, bin.path)
        // No saved machine, and an ssh that only says it ran: nothing here reaches a real machine.
        File(bin, "herdr").apply { writeText("#!/bin/sh\nif [ \"\$1 \$2\" = \"machine list\" ]; then printf '[]'; fi\nexit 0\n"); setExecutable(true) }
        File(bin, "ssh").apply { writeText("#!/bin/sh\necho \"\$*\" >> '${bin.path}/ssh.log'\nexit 255\n"); setExecutable(true) }
        File(bin, "oak").apply { writeText("#!/bin/sh\nPATH='${bin.path}':\"\$PATH\" exec '$treeOak' \"\$@\"\n"); setExecutable(true) }
        val st = ObservatorySettings.instance.state
        prevCfg = st.configDir
        prevBin = st.observatoryBin
        st.configDir = cfg.absolutePath
        st.observatoryBin = File(bin, "oak").path
        ClaudePaths.configDirOverride = cfg.toPath()
        project.basePath?.let { File(it).mkdirs() }
    }

    override fun tearDown() {
        try {
            val st = ObservatorySettings.instance.state
            st.configDir = prevCfg
            st.observatoryBin = prevBin
            ClaudePaths.configDirOverride = null
            cfg.deleteRecursively()
            bin.deleteRecursively()
        } finally {
            super.tearDown()
        }
    }

    /** build-box's record log as oak sync lands it here: one session, three hours old. */
    private fun buildBoxRecords() {
        val host = "b0b0b0b0b0b0"
        val at = System.currentTimeMillis() - 3 * 3_600_000L
        File(cfg, "claude-observatory/records/$host/$at-0badf00d.jsonl").apply {
            parentFile.mkdirs()
            writeText(listOf(
                """{"t":"batch","at":$at,"v":1,"label":"build-box","platform":"linux"}""",
                """{"t":"sessions","r":{"session_id":"remote-one","agent":"claude","origin":"local","review":0,"title":"Tune the remote parser","workspace":"~/remote","last_active_ms":$at,"tokens":120,"edits":2,"pending":1,"files":1,"model":"Opus 4.8"}}""",
            ).joinToString("\n") + "\n")
        }
    }

    fun testAnotherMachinesSessionsAreInTheChooserFromTheIndexAndOpenReadOnly() {
        buildBoxRecords()
        val machines = SessionsParser.machines(ObservatoryCli.syncedSessionsJson(project.basePath) ?: "")
        assertEquals(listOf("build-box"), machines.map { it.label })
        assertEquals(listOf("remote-one"), machines[0].sessions.map { it.id })
        assertNotNull("when its records landed here", machines[0].syncedAt)

        val popup = ReviewOps.chooseSessionPopup(project, emptyList(), machines)
        val items = try {
            val list = UIUtil.findComponentOfType(popup.content, JList::class.java)!!
            (0 until list.model.size).map { list.model.getElementAt(it).toString() }
        } finally {
            Disposer.dispose(popup)
        }
        val row = items.firstOrNull { it.startsWith("↗ Tune the remote parser  —  remote-o · on build-box") }
        assertNotNull("the chooser lists it under its machine: $items", row)
        assertTrue(row!!, row.contains(" · synced "))

        // A pick: what its records say of it, read-only; closed, nothing is fetched or pinned.
        val asked = mutableListOf<String>()
        val prev = TestDialogManager.setTestDialog(TestDialog { msg -> asked += msg; Messages.NO })
        try {
            ReviewOps.openSyncedSession(project, machines[0], machines[0].sessions[0])
        } finally {
            TestDialogManager.setTestDialog(prev)
        }
        assertEquals(1, asked.size)
        assertTrue(asked[0], asked[0].contains("“Tune the remote parser” is build-box’s session."))
        assertTrue(asked[0], asked[0].contains("2 edits (1 pending)"))
        assertTrue(asked[0], asked[0].contains("fetching brings a copy here (oak sync fetch remote-one)"))
        assertFalse(ObservatorySettings.instance.state.session == "remote-one")
        assertFalse("no ssh was run", File(bin, "ssh.log").exists())
    }

    /** Fetching runs `oak sync fetch`, which here reaches no machine: it says why in the CLI's words, and pins nothing. */
    fun testFetchingAnotherMachinesSessionThatNoMachineHoldsSaysWhyAndPinsNothing() {
        buildBoxRecords()
        val machines = SessionsParser.machines(ObservatoryCli.syncedSessionsJson(project.basePath) ?: "")
        assertEquals("control: build-box's session is listed", listOf("remote-one"), machines.flatMap { m -> m.sessions.map { it.id } })
        val seen = java.util.concurrent.CopyOnWriteArrayList<String>()
        project.messageBus.connect(testRootDisposable).subscribe(Notifications.TOPIC, object : Notifications {
            override fun notify(notification: Notification) { seen += notification.content }
        })
        val prev = TestDialogManager.setTestDialog(TestDialog { Messages.YES })
        try {
            ReviewOps.openSyncedSession(project, machines[0], machines[0].sessions[0])
        } finally {
            TestDialogManager.setTestDialog(prev)
        }
        val end = System.currentTimeMillis() + 60_000
        while (seen.isEmpty() && System.currentTimeMillis() < end) {
            PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            Thread.sleep(50)
        }
        assertTrue("$seen", seen.any { it.startsWith("Could not fetch “Tune the remote parser” — no machine's inventory lists session remote-one") })
        assertFalse(ObservatorySettings.instance.state.session == "remote-one")
        assertFalse("no ssh was run", File(bin, "ssh.log").exists())
    }

    /** An `oak` from before `query --serve` ends at once: started once, not again for a minute, and the reads go to the
     *  files; another CLI (the settings changed) is tried at once. */
    // The fakes below count only `query --serve` starts: the CLI setting is global, and the shared test project's panels
    // run it with other verbs (`multitask`, `sessions`) while a test waits.
    fun testAnOakWithoutTheServeIsStartedOnceAMinute() {
        val starts = File(bin, "starts.log")
        val old = File(bin, "old-oak").apply { writeText("#!/bin/sh\n[ \"\$1\" = query ] && echo started >> '${starts.path}'\nexit 1\n"); setExecutable(true) }
        val st = ObservatorySettings.instance.state
        val was = st.observatoryBin
        st.observatoryBin = old.path
        try {
            assertNull(offEdt { QueryServe.sessionKnown("00000000-0000-4000-8000-0000000000ee") })
            assertNull(offEdt { QueryServe.sessionKnown("00000000-0000-4000-8000-0000000000ee") })
            assertEquals("started once", listOf("started"), starts.readLines())
        } finally {
            st.observatoryBin = was
        }
        val before = QueryServe.answered
        offEdt { QueryServe.sessionKnown("00000000-0000-4000-8000-0000000000ee") }
        assertTrue("this tree's CLI, at once", QueryServe.answered > before)
    }

    /** A child that never answered is not started again at the next read, however long it took to end: under load an
     *  `oak` with no serve took more than a second to exit, and one still starting missed its read's deadline, and each
     *  was started again at every read (every two seconds from each project's Codex watcher). */
    fun testAServeThatNeverAnsweredIsNotStartedAgainAtTheNextRead() {
        val st = ObservatorySettings.instance.state
        val was = st.observatoryBin
        try {
            for ((name, body) in listOf(
                "slow-old-oak" to "sleep 1.5\nexit 1", // ends, but after more than a second
                "slow-start-oak" to "exec sleep 30", // still starting at the read's deadline
            )) {
                val starts = File(bin, "$name.log")
                val oak = File(bin, name).apply { writeText("#!/bin/sh\n[ \"\$1\" = query ] && echo started >> '${starts.path}'\n$body\n"); setExecutable(true) }
                st.observatoryBin = oak.path
                assertNull(offEdt { QueryServe.ask("sessions", mapOf("limit" to 1), 2_500) })
                assertNull(offEdt { QueryServe.ask("sessions", mapOf("limit" to 1), 2_500) })
                assertEquals("$name: started once", listOf("started"), starts.readLines())
            }
        } finally {
            st.observatoryBin = was
        }
    }

    /** A serve that answers it has no index here (an `oak` whose Node cannot run it) is of no use: stopped, and not
     *  started again for a minute. */
    fun testAServeWithNoIndexIsStoppedAndLeftAMinute() {
        val starts = File(bin, "noindex-starts.log")
        // Each start writes its process id (the serve keeps it: `exec`).
        val noIndex = File(bin, "noindex-oak").apply { writeText("#!/bin/sh\n[ \"\$1\" = query ] && echo $$ >> '${starts.path}'\nOAK_INDEX=off exec '$treeOak' \"$@\"\n"); setExecutable(true) }
        val st = ObservatorySettings.instance.state
        val was = st.observatoryBin
        st.observatoryBin = noIndex.path
        try {
            assertNull(offEdt { QueryServe.sessionKnown("00000000-0000-4000-8000-0000000000ee") })
            val pid = starts.readLines().single().trim().toLong()
            val end = System.currentTimeMillis() + 5_000
            while (ProcessHandle.of(pid).map { it.isAlive }.orElse(false) && System.currentTimeMillis() < end) Thread.sleep(50)
            assertFalse("stopped", ProcessHandle.of(pid).map { it.isAlive }.orElse(false))
            assertNull(offEdt { QueryServe.sessionKnown("00000000-0000-4000-8000-0000000000ee") })
            assertEquals("and not started again", 1, starts.readLines().size)
        } finally {
            st.observatoryBin = was
        }
    }

    /** The EDT never waits on the serve, not even for another thread's read in progress. */
    fun testTheEdtDoesNotWaitForAnotherThreadsRead() {
        val silent = File(bin, "silent-oak").apply { writeText("#!/bin/sh\nexec sleep 10\n"); setExecutable(true) }
        val st = ObservatorySettings.instance.state
        val was = st.observatoryBin
        st.observatoryBin = silent.path
        try {
            val reading = ApplicationManager.getApplication().executeOnPooledThread<Any?> { QueryServe.ask("sessions", mapOf("limit" to 1), 3_000) }
            Thread.sleep(500) // it holds the serve, waiting on an answer that never comes
            val t0 = System.currentTimeMillis()
            assertNull(QueryServe.sessionKnown("00000000-0000-4000-8000-0000000000ee"))
            assertTrue("answered at once (${System.currentTimeMillis() - t0} ms)", System.currentTimeMillis() - t0 < 1_000)
            reading.get(30, TimeUnit.SECONDS)
        } finally {
            st.observatoryBin = was
        }
    }

    /** Off the EDT, which never waits on the serve (QueryServe answers null there). */
    private fun <T> offEdt(what: () -> T): T = ApplicationManager.getApplication().executeOnPooledThread<T> { what() }.get(60, TimeUnit.SECONDS)

    /** The CLI reads Codex's rollouts where its own environment says, which the test cannot change: gradle's run gives it
     *  a home of its own (never the person's), and these tests write only their own rollouts there. */
    private val codexHome: File get() = File(System.getenv("CODEX_HOME") ?: error("no CODEX_HOME: run through gradle's test task"))

    private fun rollout(id: String, cwd: File): File =
        File(codexHome, "sessions/2026/10/31/rollout-2026-10-31T10-00-00-$id.jsonl").apply {
            parentFile.mkdirs()
            writeText(listOf(
                """{"timestamp":"2026-10-31T10:00:00Z","type":"session_meta","payload":{"id":"$id","cwd":"${cwd.path}"}}""",
                """{"timestamp":"2026-10-31T10:00:01Z","type":"event_msg","payload":{"type":"user_message","message":"Work here"}}""",
            ).joinToString("\n") + "\n")
        }

    fun testThePinCheckAndTheCodexSignalAreTheIndexsAnswers() {
        val work = File(project.basePath!!)
        val elsewhere = Files.createTempDirectory("oak-index-elsewhere").toFile()
        val ours = rollout("00000000-0000-4000-8000-00000000c0de", File(work, "pkg").apply { mkdirs() })
        var theirs: File? = null
        try {
            assertEquals("the index holds it", true, offEdt { QueryServe.sessionKnown("00000000-0000-4000-8000-00000000c0de") })
            val before = QueryServe.answered
            assertTrue("a Codex session with no store here still exists", offEdt { StoreReader.sessionExists("00000000-0000-4000-8000-00000000c0de") })
            assertTrue("…by the index's answer, not by reading every rollout", QueryServe.answered > before)
            // What the index has not read proves nothing: the caller looks on disk.
            assertNull(offEdt { QueryServe.sessionKnown("00000000-0000-4000-8000-0000000000ff") })
            assertFalse("and on disk it is not", offEdt { StoreReader.sessionExists("00000000-0000-4000-8000-0000000000ff") })
            // The EDT never waits on a process: there the index is not asked, and the caller reads as before.
            val onEdt = QueryServe.answered
            assertNull(QueryServe.sessionKnown("00000000-0000-4000-8000-00000000c0de"))
            assertEquals(onEdt, QueryServe.answered)
            // The project's folder as the platform gives it (`/`-separated on every OS); a session that ran below it is its.
            val stamp = offEdt { QueryServe.codexStamp(listOf(project.basePath!!), null) }
            assertTrue("$stamp", stamp!!.startsWith("00000000-0000-4000-8000-00000000c0de:"))
            // Another project's Codex session changes nothing here; a write to this one's does.
            theirs = rollout("00000000-0000-4000-8000-00000000c0df", elsewhere)
            theirs.setLastModified(System.currentTimeMillis() + 60_000)
            assertEquals(stamp, offEdt { QueryServe.codexStamp(listOf(project.basePath!!), null) })
            // …unless it is the session under review, wherever it ran.
            assertTrue(offEdt { QueryServe.codexStamp(listOf(project.basePath!!), "00000000-0000-4000-8000-00000000c0df") }!!.contains("00000000-0000-4000-8000-00000000c0df:"))
            ours.appendText("""{"timestamp":"2026-10-31T10:00:02Z","type":"event_msg","payload":{"type":"agent_message","message":"Done"}}""" + "\n")
            ours.setLastModified(System.currentTimeMillis() + 120_000)
            assertFalse(stamp == offEdt { QueryServe.codexStamp(listOf(project.basePath!!), null) })
        } finally {
            ours.delete()
            theirs?.delete()
            elsewhere.deleteRecursively()
        }
    }

    /** The project refreshed for every Codex session's write on the machine; now for its own, and not for another's. */
    fun testTheWatcherRefreshesForThisProjectsCodexSessionsAndNotAnothers() {
        val work = File(project.basePath!!)
        val elsewhere = Files.createTempDirectory("oak-index-elsewhere").toFile()
        val watcher = TranscriptWatcher(project)
        var refreshed = 0
        fun until(ms: Long, ok: () -> Boolean): Boolean {
            val end = System.currentTimeMillis() + ms
            while (System.currentTimeMillis() < end) {
                PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
                if (ok()) return true
                Thread.sleep(50)
            }
            PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            return ok()
        }
        val files = ArrayList<File>()
        try {
            watcher.addListener { refreshed++ }
            Thread.sleep(500) // its first sum is taken as it starts
            files += rollout("00000000-0000-4000-8000-0000000000a1", work)
            assertTrue("a Codex session of this project refreshes it", until(15_000) { refreshed > 0 })
            Thread.sleep(1_000) // past its debounce
            PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            val after = refreshed
            files += rollout("00000000-0000-4000-8000-0000000000a2", elsewhere)
            assertFalse("another project's does not", until(5_000) { refreshed > after })
            files[0].appendText("""{"timestamp":"2026-10-31T10:00:02Z","type":"event_msg","payload":{"type":"agent_message","message":"Done"}}""" + "\n")
            files[0].setLastModified(System.currentTimeMillis() + 60_000)
            assertTrue("positive control: a write to this project's again does", until(15_000) { refreshed > after })
            // The session under review refreshes it wherever it ran (a folder above the project's, say).
            Thread.sleep(1_000)
            PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            val pinned = refreshed
            ObservatorySettings.instance.state.session = "00000000-0000-4000-8000-0000000000a2"
            files[1].appendText("""{"timestamp":"2026-10-31T10:00:03Z","type":"event_msg","payload":{"type":"agent_message","message":"More"}}""" + "\n")
            files[1].setLastModified(System.currentTimeMillis() + 120_000)
            assertTrue("the session under review refreshes it", until(15_000) { refreshed > pinned })
        } finally {
            ObservatorySettings.instance.state.session = null
            watcher.dispose()
            files.forEach { it.delete() }
            elsewhere.deleteRecursively()
        }
    }
}
