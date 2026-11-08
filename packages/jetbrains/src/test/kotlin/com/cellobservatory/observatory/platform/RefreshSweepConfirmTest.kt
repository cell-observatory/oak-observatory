package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.intellij.notification.Notification
import com.intellij.notification.NotificationType
import com.intellij.notification.Notifications
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.TestDialog
import com.intellij.openapi.ui.TestDialogManager
import com.intellij.openapi.util.SystemInfo
import com.intellij.testFramework.PlatformTestUtil
import java.io.File
import java.nio.file.Files
import java.util.concurrent.TimeUnit

/**
 * A user Refresh applies a newly-added `.observatoryignore` only after counting through the CLI
 * (`ignore --dry-run --json`) and asking in a modal, as the terminal app and VS Code do: the sweep cannot
 * be undone. No count is an error, never 0, and nothing is dropped then. A CLI below review protocol 2
 * is never asked to count, since it ignores `--dry-run` and sweeps. Drives this tree's CLI in a throwaway
 * config dir.
 */
class RefreshSweepConfirmTest : ObservatoryPlatformTestCase() {

    private lateinit var cfg: File
    private lateinit var work: File
    private var prevCfg: String? = null
    private val seen = mutableListOf<Notification>()
    private val session = "refresh-sweep-fixture"

    override fun setUp() {
        super.setUp()
        cfg = Files.createTempDirectory("oak-sweep-cfg").toFile()
        work = Files.createTempDirectory("oak-sweep-ws").toFile()
        val st = ObservatorySettings.instance.state
        prevCfg = st.configDir
        st.configDir = cfg.absolutePath
        ClaudePaths.configDirOverride = cfg.toPath()
        project.basePath?.let { File(it).mkdirs() } // the CLI runs in the project's folder, which the light test project never creates
        project.messageBus.connect(testRootDisposable).subscribe(Notifications.TOPIC, object : Notifications {
            override fun notify(notification: Notification) { seen += notification }
        })
    }

    override fun tearDown() {
        try {
            ObservatoryService.getInstance(project).demoSessionOverride = null
            ObservatorySettings.instance.state.configDir = prevCfg
            ClaudePaths.configDirOverride = null
            cfg.deleteRecursively()
            work.deleteRecursively()
        } finally {
            super.tearDown()
        }
    }

    /** One pending edit to a file the `.observatoryignore` beside it now covers, recorded through this
     *  tree's core the way a capture records it. */
    private fun seedIgnoredEdit() {
        val core = File("../core/dist").absoluteFile
        assertTrue("control: this tree's core is built at $core", File(core, "index.js").isFile)
        val file = File(work, "refresh-ignored.log")
        val script = """
            const core = require(${com.google.gson.JsonPrimitive(core.path)}), S = ${com.google.gson.JsonPrimitive(session)};
            core.ensureStore(S);
            core.appendLog(S, { ts: Date.now(), tool: 'Edit', file: ${com.google.gson.JsonPrimitive(file.path)}, status: 'pending',
              beforeBlob: core.writeBlob(S, Buffer.from('')), afterBlob: core.writeBlob(S, Buffer.from('x\n')) });
        """.trimIndent()
        val pb = ProcessBuilder("node", "-e", script).redirectErrorStream(true)
        pb.environment()["CLAUDE_CONFIG_DIR"] = cfg.absolutePath
        val proc = pb.start()
        val out = proc.inputStream.bufferedReader().readText()
        assertTrue("the edit was recorded: $out", proc.waitFor(30, TimeUnit.SECONDS) && proc.exitValue() == 0)
        File(work, ".observatoryignore").writeText("refresh-ignored.log\n")
    }

    /** Run a Refresh's sweep answering the confirm with [answer]: what the confirm said, if it was shown. */
    private fun refresh(answer: Int): List<String> {
        val asked = mutableListOf<String>()
        var ran = false
        val prev = TestDialogManager.setTestDialog(TestDialog { message -> asked += message; answer })
        try {
            ObservatoryService.getInstance(project).sweepIgnoredThen { ran = true }
            val deadline = System.currentTimeMillis() + 60_000
            while (!ran && System.currentTimeMillis() < deadline) {
                PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()
                Thread.sleep(20)
            }
        } finally {
            TestDialogManager.setTestDialog(prev)
        }
        assertTrue("the panel's own refresh runs whatever the answer", ran)
        return asked
    }

    private fun wouldDrop() = (ObservatoryCli.ignoreWouldDrop(project.basePath, session) as? ObservatoryCli.IgnoreCount.Would)?.n

    fun testTheDropQuestionDefaultsToCancel() {
        // It opens only once the count is back, so a key typed meanwhile lands on the default button, or on
        // the focused one: the real call makes both Cancel.
        seedIgnoredEdit()
        val service = ObservatoryService.getInstance(project)
        service.demoSessionOverride = session
        val calls = mutableListOf<Triple<List<String>, Int, Int>>()
        val real = service.sweepDialog
        service.sweepDialog = { _, _, _, _, options, default, focus, _ -> calls += Triple(options.toList(), default, focus); options.indexOf("Cancel") }
        try {
            assertEquals("the swapped call stands in for the platform's dialog", emptyList<String>(), refresh(Messages.YES))
        } finally {
            service.sweepDialog = real
        }
        assertEquals("asked once: $calls", 1, calls.size)
        val (options, default, focus) = calls[0]
        assertEquals("the default button", "Cancel", options[default])
        assertEquals("the focused button", "Cancel", options[focus])
        assertEquals("Cancel keeps the now-ignored edit", 1, wouldDrop())
    }

    fun testRefreshAsksBeforeDroppingAndNoCountIsAnError() {
        seedIgnoredEdit()
        ObservatoryService.getInstance(project).demoSessionOverride = session
        assertEquals("control: the CLI counts the one now-ignored edit", 1, wouldDrop())

        val cancelled = refresh(Messages.NO)
        assertEquals(1, cancelled.size)
        assertEquals(
            "Drop the 1 recorded edit in ${session.take(8)} that .observatoryignore covers?\n\nThis cannot be undone. Cancel keeps them.",
            cancelled[0],
        )
        assertEquals("Cancel keeps the now-ignored edit", 1, wouldDrop())

        // A 0.10-style CLI answers review protocol 1 and ignores --dry-run, so `ignore --dry-run` SWEEPS: it is
        // never asked to count. A CLI that answers a count as text is no count either. Both are reported,
        // never read as "nothing to drop", nothing is asked, and the edit survives.
        if (!SystemInfo.isWindows) {
            val st = ObservatorySettings.instance.state
            val prevBin = st.observatoryBin
            val tree = System.getenv("CLAUDE_OBSERVATORY_BIN")
            assertTrue("control: this tree's oak is at $tree", tree != null && File(tree).isFile)
            val older = File(work, "older-oak")
            older.writeText(
                "#!/bin/sh\n[ \"$1\" = __review-protocol ] && { echo 1; exit 0; }\n" +
                    "for a in \"$@\"; do shift; [ \"${'$'}a\" = --dry-run ] || set -- \"$@\" \"${'$'}a\"; done\nexec '$tree' \"$@\"\n",
            )
            older.setExecutable(true)
            val text = File(work, "text-count-oak")
            text.writeText("#!/bin/sh\n[ \"$1\" = __review-protocol ] && { echo 2; exit 0; }\nprintf '%s\\n' '{\"wouldDrop\":\"1\"}'\n")
            text.setExecutable(true)
            val older010 = "Could not count what .observatoryignore covers in ${session.take(8)}, so nothing was dropped: update the OAK CLI to count before dropping."
            val noCount = "Could not count what .observatoryignore covers in ${session.take(8)}, so nothing was dropped. Is the oak CLI installed and current?"
            for ((fake, expected) in listOf(older to older010, text to noCount)) {
                val name = fake.name
                st.observatoryBin = fake.absolutePath
                val before = seen.size
                val asked = try { refresh(Messages.YES) } finally { st.observatoryBin = prevBin }
                assertEquals("$name: not asked", emptyList<String>(), asked)
                val said = seen.drop(before).firstOrNull { it.type == NotificationType.ERROR }?.content
                assertEquals("$name: the missing count is reported", expected, said)
                assertEquals("$name: nothing is dropped", 1, wouldDrop())
            }
            // Control: the older fake really does sweep on `ignore --dry-run`, as 0.10 does.
            val pb = ProcessBuilder(older.absolutePath, "ignore", "--dry-run", "--session", session, "--json").redirectErrorStream(true)
            pb.environment()["CLAUDE_CONFIG_DIR"] = cfg.absolutePath
            val proc = pb.start()
            val out = proc.inputStream.bufferedReader().readText()
            assertTrue("control: the older fake ran: $out", proc.waitFor(60, TimeUnit.SECONDS) && proc.exitValue() == 0)
            assertEquals("control: the older fake swept on --dry-run: $out", 0, wouldDrop())
            seedIgnoredEdit()
            assertEquals("control: one now-ignored edit to drop again", 1, wouldDrop())
        }

        assertEquals("asked again", 1, refresh(Messages.YES).size)
        assertEquals("confirmed, the now-ignored edit is dropped", 0, wouldDrop())
        assertEquals("nothing left to drop: no confirm", emptyList<String>(), refresh(Messages.YES))
    }
}
