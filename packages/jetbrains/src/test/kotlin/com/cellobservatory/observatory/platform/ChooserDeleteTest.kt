package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.model.SessionRow
import com.cellobservatory.observatory.model.SessionsParser
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.cellobservatory.observatory.ui.ReviewOps
import com.intellij.notification.Notification
import com.intellij.notification.Notifications
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.TestDialog
import com.intellij.openapi.ui.TestDialogManager
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.SystemInfo
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.util.ui.UIUtil
import java.io.File
import java.nio.file.Files
import java.util.concurrent.TimeUnit
import javax.swing.JList

/**
 * Deleting a session from JetBrains' session choosers, as VS Code's quick picks and both Sessions tabs
 * allow. The chooser carries a delete row; the delete it leads to is the Sessions tab's own, confirmed,
 * and it removes the session through this tree's CLI, in a throwaway config dir.
 */
class ChooserDeleteTest : BasePlatformTestCase() {

    private lateinit var cfg: File
    private lateinit var work: File
    private var prevCfg: String? = null
    private val seen = mutableListOf<Notification>()

    override fun setUp() {
        super.setUp()
        cfg = Files.createTempDirectory("oak-chooser-cfg").toFile()
        work = Files.createTempDirectory("oak-chooser-ws").toFile()
        val st = ObservatorySettings.instance.state
        prevCfg = st.configDir
        st.configDir = cfg.absolutePath
        ClaudePaths.configDirOverride = cfg.toPath()
        project.messageBus.connect(testRootDisposable).subscribe(Notifications.TOPIC, object : Notifications {
            override fun notify(notification: Notification) { seen += notification }
        })
    }

    override fun tearDown() {
        try {
            ObservatorySettings.instance.state.configDir = prevCfg
            ClaudePaths.configDirOverride = null
            cfg.deleteRecursively()
            work.deleteRecursively()
        } finally {
            super.tearDown()
        }
    }

    private fun listing() = SessionsParser.parse(ObservatoryCli.run(listOf("sessions", "--json"), work.absolutePath).stdout)!!.sessions

    /** Confirm the delete of [row], recording what the confirm said, and wait for the delete's own
     *  notification: (what the confirm said, what the delete then said). */
    private fun deleteConfirmed(row: SessionRow): Pair<List<String>, String> {
        val asked = mutableListOf<String>()
        project.basePath?.let { File(it).mkdirs() } // the delete runs the CLI in the project's folder, which the light test project names but never creates
        val before = seen.size
        val said = { seen.drop(before).map { it.content }.firstOrNull { it.startsWith("Deleted") || it.startsWith("Could not delete") } }
        val prev = TestDialogManager.setTestDialog(TestDialog { message -> asked += message; Messages.YES })
        try {
            ReviewOps.confirmAndDeleteSession(project, row)
            val deadline = System.currentTimeMillis() + 30_000
            while (said() == null && System.currentTimeMillis() < deadline) {
                PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()
                Thread.sleep(20)
            }
        } finally {
            TestDialogManager.setTestDialog(prev)
        }
        return asked to (said() ?: "no delete notification: ${seen.map { it.content }}")
    }

    fun testTheChooserOffersDeleteAndTheDeleteRemovesTheSession() {
        assertTrue("control: the demo replay seeded a session", ObservatoryCli.run(listOf("demo", "--fast"), work.absolutePath, timeoutMs = 120_000).ok)
        val row = listing().first { it.id.startsWith("demo-") }

        val popup = ReviewOps.chooseSessionPopup(project, listOf(row))
        try {
            val list = UIUtil.findComponentOfType(popup.content, JList::class.java)!!
            val items = (0 until list.model.size).map { list.model.getElementAt(it).toString() }
            assertTrue("the Switch Session chooser offers delete: $items", items.contains(ReviewOps.DELETE_SESSION))
        } finally {
            Disposer.dispose(popup)
        }

        // The confirm names the edits still pending review, whose before-snapshots the purge takes, and says
        // undelete lists the session again without its edits (it promised a restore).
        assertTrue("control: the demo leaves edits pending review", row.pending > 1)
        val (asked, said) = deleteConfirmed(row)
        assertEquals(1, asked.size)
        assertTrue(asked[0], asked[0].contains("${row.pending} of those edits are still pending review: the purge drops their before-snapshots, so OAK can no longer undo those changes."))
        assertTrue(asked[0], asked[0].contains("`oak sessions --undelete ${row.id}` lists the session again, without its edits."))
        assertFalse(asked[0], asked[0].contains("restores"))
        assertEquals("Deleted “${row.displayName}” from Observatory and purged its edits — `oak sessions --undelete ${row.id}` lists it again, without them.", said)
        assertFalse("…and the session is gone from the listing", listing().any { it.id == row.id })
    }

    /** A row read before the agent wrote more: it shows nothing pending, so the confirm names none, the delete
     *  is not forced, and the CLI refuses rather than purge edits nobody was told about. */
    fun testEditsTheConfirmDidNotNameAreRefusedNotPurged() {
        assertTrue("control: the demo replay seeded a session", ObservatoryCli.run(listOf("demo", "--fast"), work.absolutePath, timeoutMs = 120_000).ok)
        val live = listing().first { it.id.startsWith("demo-") }
        assertTrue("control: it has edits pending review", live.pending > 0)
        val (asked, said) = deleteConfirmed(live.copy(pending = 0))
        assertFalse(asked[0], asked[0].contains("pending review"))
        assertTrue(said, said.startsWith("Could not delete ${live.displayName} — ${live.id} has ${live.pending} edits pending review"))
        assertTrue("…and the session and its edits are still there", listing().any { it.id == live.id && it.pending == live.pending })
    }

    /** A row read before the agent wrote one more: the confirm names one fewer edit than is pending, and the
     *  delete purges no more than it named, so the CLI refuses rather than purge the one nobody was told about. */
    fun testEditsBeyondTheCountTheConfirmNamedAreRefusedNotPurged() {
        assertTrue("control: the demo replay seeded a session", ObservatoryCli.run(listOf("demo", "--fast"), work.absolutePath, timeoutMs = 120_000).ok)
        val live = listing().first { it.id.startsWith("demo-") }
        assertTrue("control: it has more than one edit pending review", live.pending > 1)
        val named = live.pending - 1
        val (asked, said) = deleteConfirmed(live.copy(pending = named))
        assertTrue(asked[0], asked[0].contains("${if (named == 1) "1 of those edits is" else "$named of those edits are"} still pending review"))
        assertTrue(said, said.startsWith("Could not delete ${live.displayName} — ${live.id} has ${live.pending} edits pending review, more than the $named this delete confirmed"))
        assertTrue("…and the session and its edits are still there", listing().any { it.id == live.id && it.pending == live.pending })
    }

    /** The agent rewrites a line the session's newest features.py change added, in the same ask, recorded through
     *  this tree's core the way a capture records it: the new edit JOINS that change. */
    private fun rewriteNewestChange(session: String) {
        val core = File("../core/dist").absoluteFile
        assertTrue("control: this tree's core is built at $core", File(core, "index.js").isFile)
        val script = """
            const core = require(${com.google.gson.JsonPrimitive(core.path)}), S = ${com.google.gson.JsonPrimitive(session)};
            const last = core.readLog(S).filter((r) => r.file.endsWith('features.py')).at(-1);
            const before = core.blobText(S, last.beforeBlob), after = core.blobText(S, last.afterBlob);
            const had = new Set(before.split('\n'));
            const line = after.split('\n').find((l) => l.trim() && !had.has(l));
            core.appendLog(S, { ts: Date.now(), tool: 'Edit', file: last.file, status: 'pending', beforeBlob: core.writeBlob(S, Buffer.from(after)),
              afterBlob: core.writeBlob(S, Buffer.from(after.replace(line, line + '  # tuned again'))) });
        """.trimIndent()
        val pb = ProcessBuilder("node", "-e", script).redirectErrorStream(true)
        pb.environment()["CLAUDE_CONFIG_DIR"] = cfg.absolutePath
        val proc = pb.start()
        val out = proc.inputStream.bufferedReader().readText()
        assertTrue("the edit was recorded: $out", proc.waitFor(30, TimeUnit.SECONDS) && proc.exitValue() == 0)
    }

    /** A row read before the agent rewrote the lines of a change the row had counted: that edit joins the change, so
     *  the count the confirm names still matches what is pending, and only the newest edit the row's listing saw
     *  tells them apart. The CLI refuses the edit captured after the listing rather than purge it unseen (the
     *  count alone let it through). */
    fun testAnEditThatJoinedACountedChangeAfterTheListingIsRefusedNotPurged() {
        assertTrue("control: the demo replay seeded a session", ObservatoryCli.run(listOf("demo", "--fast"), work.absolutePath, timeoutMs = 120_000).ok)
        val live = listing().first { it.id.startsWith("demo-") }
        val seen = live.lastEdit
        assertNotNull("the row names the newest edit its listing counted", seen)
        rewriteNewestChange(live.id)
        val now = listing().first { it.id == live.id }
        assertEquals("control: the new edit joined a counted change, so the count did not move", live.pending, now.pending)
        assertEquals("control: …and it is newer than the row saw", seen!! + 1, now.lastEdit)
        val (asked, said) = deleteConfirmed(live)
        assertTrue(asked[0], asked[0].contains("${live.pending} of those edits are still pending review"))
        assertEquals("Could not delete ${live.displayName} — ${live.id} captured an edit after the listing this delete was confirmed from, " +
            "still pending review; deleting the session would purge it unseen, so it was not deleted", said)
        assertTrue("…and the session and its edits are still there", listing().any { it.id == live.id && it.lastEdit == now.lastEdit })
    }

    /** 0.9.5's CLI, which the plugin still drives through its `claude-observatory` fallback, has no
     *  `sessions --delete`: it exits 0 with a listing. That is not a delete, and is not reported as one. */
    fun testACliTooOldToDeleteIsReportedAsSuch() {
        if (SystemInfo.isWindows) return // the stand-in CLI is a POSIX script
        val old = File(work, "claude-observatory-0.9.5")
        old.writeText("#!/bin/sh\nprintf '{\"active\":null,\"sessions\":[]}\\n'\n")
        old.setExecutable(true)
        val st = ObservatorySettings.instance.state
        val prevBin = st.observatoryBin
        st.observatoryBin = old.absolutePath
        try {
            val row = SessionRow(id = "fixture-session", title = "Fixture", lastActiveMs = 0, current = false, edits = 0, pending = 0, files = 0)
            val (_, said) = deleteConfirmed(row)
            assertTrue(said, said.startsWith("Could not delete Fixture — the oak CLI this plugin runs (${old.absolutePath}) is too old to delete sessions; nothing was deleted."))
        } finally {
            st.observatoryBin = prevBin
        }
    }

    /** One edit reads in the singular on a chooser row ("1 edits"). */
    fun testAChooserRowWithOneEditSaysOneEdit() {
        fun items(edits: Int): List<String> {
            val row = SessionRow(id = "fixture-session", title = "Fixture", lastActiveMs = 0, current = false, edits = edits, pending = 0, files = 0)
            val popup = ReviewOps.chooseSessionPopup(project, listOf(row))
            try {
                val list = UIUtil.findComponentOfType(popup.content, JList::class.java)!!
                return (0 until list.model.size).map { list.model.getElementAt(it).toString() }
            } finally {
                Disposer.dispose(popup)
            }
        }
        assertTrue("${items(1)}", items(1).any { it.contains(" · 1 edit · ") })
        assertTrue("${items(3)}", items(3).any { it.contains(" · 3 edits · ") })
    }

    /** The Timeline chip's chooser runs inside a popup this harness does not show, so its route is pinned
     *  by source: the row is the shared one, and it opens the shared delete picker. */
    fun testTheTimelineChooserRoutesToTheSameDelete() {
        val src = File("src/main/kotlin/com/cellobservatory/observatory/ui/TimelineSessionAction.kt")
        assertTrue("control: the plugin sources are readable from the test's working directory", src.isFile)
        val text = src.readText()
        assertTrue("the Timeline chooser lists the delete row", text.contains("labelToId[ReviewOps.DELETE_SESSION]"))
        assertTrue("…and hands it to the shared delete picker", text.contains("ReviewOps.chooseSessionToDelete("))
    }
}
