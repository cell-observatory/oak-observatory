package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.cellobservatory.observatory.ui.ChangeMapPanel
import com.intellij.notification.Notification
import com.intellij.notification.Notifications
import com.intellij.openapi.actionSystem.ActionGroup
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.impl.ActionToolbarImpl
import com.intellij.openapi.actionSystem.impl.SimpleDataContext
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.TestDialog
import com.intellij.openapi.ui.TestDialogManager
import com.intellij.openapi.util.SystemInfo
import com.intellij.testFramework.PlatformTestUtil
import java.awt.Container
import java.io.File
import java.nio.file.Files

/**
 * The version chip's Update Now, clicked on the real Overview against a fake CLI. An update can run for
 * minutes: a second click while one runs says so and starts no second `oak update`, and a click after it
 * ends runs one again. The message it ends with names each repair the update leaves to the user, read
 * back from `update --json --here`. The restart is offered whenever the build in this IDE's plugins
 * folder is not the one running, whoever put it there and whatever else failed.
 */
class UpdateNowTest : ObservatoryPlatformTestCase() {

    private lateinit var work: File
    private var savedBin: String? = null
    private val seen = java.util.Collections.synchronizedList(mutableListOf<Notification>())
    /** The restart dialogs shown, each answered Later. */
    private val dialogs = java.util.Collections.synchronizedList(mutableListOf<String>())
    private var prevDialog: TestDialog? = null

    override fun setUp() {
        super.setUp()
        work = Files.createTempDirectory("oak-update-now").toFile()
        ClaudePaths.configDirOverride = File(work, "config").toPath()
        savedBin = ObservatorySettings.instance.state.observatoryBin
        project.basePath?.let { File(it).mkdirs() } // the CLI runs in the project's folder, which the light test project never creates
        project.messageBus.connect(testRootDisposable).subscribe(Notifications.TOPIC, object : Notifications {
            override fun notify(notification: Notification) { seen += notification }
        })
        prevDialog = TestDialogManager.setTestDialog(TestDialog { message -> dialogs += message; Messages.NO })
        ChangeMapPanel.pendingRestartVersion = null
    }

    override fun tearDown() {
        try {
            TestDialogManager.setTestDialog(prevDialog)
            ChangeMapPanel.pendingRestartVersion = null
            ObservatorySettings.instance.state.observatoryBin = savedBin
            ClaudePaths.configDirOverride = null
            work.deleteRecursively()
        } finally {
            super.tearDown()
        }
    }

    private fun said(): List<String> = synchronized(seen) { seen.map { it.content } }

    private fun waitFor(what: String, done: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 30_000
        while (!done() && System.currentTimeMillis() < deadline) {
            PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()
            Thread.sleep(20)
        }
        assertTrue("$what (said: ${said()})", done())
    }

    /** The chip's Update Now row, found the way the toolbar shows it. */
    private fun updateNow(panel: ChangeMapPanel): AnAction {
        val groups = mutableListOf<ActionGroup>()
        fun walk(c: Container) {
            for (child in c.components) {
                if (child is ActionToolbarImpl) groups += child.actionGroup
                if (child is Container) walk(child)
            }
        }
        walk(panel)
        fun all(g: ActionGroup): List<AnAction> = g.getChildren(null).flatMap { if (it is ActionGroup) listOf(it) + all(it) else listOf(it) }
        val chip = groups.flatMap { all(it) }.filterIsInstance<ActionGroup>()
            .first { it.templatePresentation.description?.startsWith("OAK version") == true }
        return chip.getChildren(null).first { it.templatePresentation.text?.startsWith("Update Now") == true }
    }

    fun testASecondClickWhileAnUpdateRunsStartsNothingAndTheResultNamesTheRepairLeftToTheUser() {
        if (SystemInfo.isWindows) return // the fake CLI is a POSIX shell script
        val log = File(work, "argv.log")
        val hold = File(work, "hold")
        val ran = File(work, "ran")
        val repair = "/w/team/.claude/settings.json is missing Stop — run `oak init --repair` there"
        val cli = """"surfaces":[{"surface":"cli","label":"CLI","from":"9.9.9","to":"9.9.9","reason":"current"}]"""
        // Before the update a CLI out of date judges none of OAK's setup; the one it installed names the repair.
        val before = """{$cli,"components":[{"id":"hooks","label":"Claude Code capture hooks","state":"after-cli","detail":"checked by the new CLI once it is installed"}],"upToDate":false}"""
        val after = """{$cli,"components":[{"id":"project-hooks","label":"Claude Code project hooks","state":"manual","detail":"$repair"}],"upToDate":true}"""
        // `update` waits while the hold file exists; every other call fails, as a missing CLI would.
        val fake = File(work, "fake-oak")
        fake.writeText(
            "#!/bin/sh\necho \"\$*\" >> '${log.path}'\ncase \"\$*\" in\n" +
                "  \"update --json --here\") if [ -e '${ran.path}' ]; then printf '%s\\n' '$after'; else printf '%s\\n' '$before'; fi ;;\n" +
                "  update) : > '${ran.path}'; while [ -e '${hold.path}' ]; do sleep 0.05; done ;;\n" +
                "  *) exit 1 ;;\nesac\n",
        )
        fake.setExecutable(true)
        ObservatorySettings.instance.state.observatoryBin = fake.absolutePath
        fun updates() = if (log.isFile) log.readLines().count { it == "update" } else 0
        fun ended() = said().count { it.startsWith("Updating OAK done") }

        val panel = ChangeMapPanel(project)
        try {
            val click = {
                updateNow(panel).actionPerformed(AnActionEvent.createFromDataContext("UpdateNowTest", null, SimpleDataContext.getProjectContext(project)))
            }
            hold.writeText("")
            click()
            waitFor("the first click's `oak update` runs") { updates() == 1 }
            click()
            assertEquals("the second click says an update is running in this IDE", 1, said().count { it.contains("already running in this IDE") })
            hold.delete()
            waitFor("the update reports when it ends") { ended() == 1 }
            assertEquals("one `oak update`, however many clicks", 1, updates())
            val done = said().first { it.startsWith("Updating OAK done") }
            assertTrue("the message names the repair left to the user: $done", done.endsWith("Left to you: $repair"))
            // Its end frees the button: the next click runs an update again.
            click()
            waitFor("a click after the update ended runs one") { ended() == 2 }
            assertEquals(2, updates())
            assertEquals("only the click during the update was refused", 1, said().count { it.contains("already running") })
        } finally {
            hold.delete()
        }
    }

    /** The plugin build this IDE runs: what a restart moves it away from. */
    private fun running(): String = com.intellij.ide.plugins.PluginManagerCore.getPlugin(
        com.intellij.openapi.extensions.PluginId.getId("com.cell-observatory.oak-observatory"))?.version ?: ""

    /** `update --json --here` with this IDE's row: [from] is the build in its plugins folder, or no folder named
     *  at all, as a CLI older than `pluginsDir` prints it. */
    private fun plan(from: String, reason: String, folder: Boolean = true): String {
        val dir = if (folder) ""","pluginsDir":${com.google.gson.JsonPrimitive(PathManager.getPluginsPath())}""" else ""
        return """{"surfaces":[{"surface":"cli","label":"CLI","from":"9.9.9","to":"9.9.9","reason":"current"},""" +
            """{"surface":"jetbrains","label":"JetBrains (test)","from":"$from","to":"9.9.9","reason":"$reason"$dir}],"components":[],"upToDate":${reason == "current"}}"""
    }

    /** A fake CLI: `update --json --here` answers [before] until `update` has run, then [after] (null: that read
     *  fails, as it does with the release feed down); `update` exits [exit], saying [err] on stderr. Every other
     *  call fails, as a missing CLI would. */
    private fun fakeCli(before: String, after: String?, exit: Int = 0, err: String = "") {
        val ran = File(work, "ran")
        val fake = File(work, "fake-oak")
        val afterRead = if (after == null) "exit 1" else "printf '%s\\n' '$after'"
        fake.writeText(
            "#!/bin/sh\ncase \"\$*\" in\n" +
                "  \"update --json --here\") if [ -e '${ran.path}' ]; then $afterRead; else printf '%s\\n' '$before'; fi ;;\n" +
                "  update) : > '${ran.path}'; printf 'Result\\n'; printf '%s\\n' '$err' >&2; exit $exit ;;\n" +
                "  *) exit 1 ;;\nesac\n",
        )
        fake.setExecutable(true)
        ObservatorySettings.instance.state.observatoryBin = fake.absolutePath
    }

    private fun clickUpdateNow() {
        updateNow(ChangeMapPanel(project)).actionPerformed(AnActionEvent.createFromDataContext("UpdateNowTest", null, SimpleDataContext.getProjectContext(project)))
    }

    fun testAReplacedPluginOffersTheRestartAlsoWhenASavedMachineFailed() {
        if (SystemInfo.isWindows) return // the fake CLI is a POSIX shell script
        val v = running()
        assertTrue("control: the plugin under test reports its version", v.isNotEmpty())
        // `oak update` replaced this IDE's plugin, then could not update a saved machine, so it exits 1.
        fakeCli(before = plan(v, "behind"), after = plan("9.9.9", "current"), exit = 1, err = "⚠ could not update machine laptop — see the table above.")
        clickUpdateNow()
        waitFor("Later is answered") { said().any { it.startsWith("New build loads on the next IDE restart") } }
        assertEquals("one restart offer: $dialogs", 1, dialogs.size)
        assertTrue("it offers the restart: ${dialogs[0]}", dialogs[0].contains("Restart the IDE now"))
        assertEquals("the build on disk waits on the restart", "9.9.9", ChangeMapPanel.pendingRestartVersion)
        assertTrue("the failure is reported too: ${said()}", said().any { it.contains("could not update machine laptop") })
    }

    fun testAPluginAnotherRouteReplacedOffersTheRestart() {
        if (SystemInfo.isWindows) return
        assertTrue("control: the running build is not the one on disk", running().isNotEmpty() && running() != "9.9.9")
        // VS Code's Update now, a terminal's `oak update`, or an earlier Update Now answered Later already put
        // 9.9.9 in this IDE's folder: the plan reads this IDE current before the run and after it.
        fakeCli(before = plan("9.9.9", "current"), after = plan("9.9.9", "current"))
        clickUpdateNow()
        waitFor("Later is answered") { said().any { it.startsWith("New build loads on the next IDE restart") } }
        assertEquals(1, dialogs.size)
        assertEquals("9.9.9", ChangeMapPanel.pendingRestartVersion)
        assertFalse("never 'no restart needed' while the old build runs: ${said()}", said().any { it.contains("no restart needed") })
    }

    fun testNothingMovedHereNeedsNoRestart() {
        if (SystemInfo.isWindows) return
        val v = running()
        fakeCli(before = plan(v, "current"), after = plan(v, "current"))
        clickUpdateNow()
        waitFor("the update reports") { said().any { it.startsWith("Updating OAK done") } }
        assertTrue(said().any { it.startsWith("Updating OAK done — already on the newest build, no restart needed.") })
        assertTrue("no restart offered: $dialogs", dialogs.isEmpty())
        assertNull(ChangeMapPanel.pendingRestartVersion)
    }

    fun testALocalBuildIsLeftAloneAndNeedsNoRestart() {
        if (SystemInfo.isWindows) return
        val v = running()
        // This IDE's plugin is a local build (core's `local` reason), which the update leaves alone.
        fakeCli(before = plan(v, "local"), after = plan(v, "local"))
        clickUpdateNow()
        waitFor("the update reports") { said().any { it.startsWith("Updating OAK done") } }
        assertTrue(said().toString(), said().contains("Updating OAK done — this IDE's plugin is a local build (v$v), which the update leaves alone; no restart needed."))
        assertTrue("no restart offered: $dialogs", dialogs.isEmpty())
        assertNull(ChangeMapPanel.pendingRestartVersion)
    }

    fun testAPlanUnreadableAfterTheUpdateKeepsTheRowThatNeededWork() {
        if (SystemInfo.isWindows) return
        // The read after the update fails (the release feed went down): the row that needed work before it
        // moved, since the run succeeded.
        fakeCli(before = plan(running(), "behind"), after = null)
        clickUpdateNow()
        waitFor("Later is answered") { said().any { it.startsWith("New build loads on the next IDE restart") } }
        assertEquals("one restart offer: $dialogs", 1, dialogs.size)
        assertTrue(dialogs[0], dialogs[0].startsWith("Updating OAK done — the plugin on disk was replaced."))
        assertEquals("9.9.9", ChangeMapPanel.pendingRestartVersion)
    }

    fun testAPlanUnreadableAfterAFailedUpdateOffersNoRestart() {
        if (SystemInfo.isWindows) return
        // The same read fails after a run that failed: nothing says this IDE's plugin moved, so the failure is
        // reported and no restart offered.
        fakeCli(before = plan(running(), "behind"), after = null, exit = 1, err = "npm could not install the release")
        clickUpdateNow()
        waitFor("the failure is reported") { said().any { it.startsWith("Updating OAK failed") } }
        assertTrue(said().toString(), said().contains("Updating OAK failed: npm could not install the release"))
        assertTrue("no restart offered: $dialogs", dialogs.isEmpty())
        assertNull(ChangeMapPanel.pendingRestartVersion)
    }

    fun testAFailureIsShownWhole() {
        if (SystemInfo.isWindows) return
        // The update's failure line names each failure with its reason, and a notification wraps it: none is cut.
        val line = "⚠ could not update " + listOf("a", "b", "c").joinToString("; ") {
            "machine $it (not reachable over ssh (me@$it): ssh: connect to host $it port 22: No route to host)"
        } + " — see the table above."
        assertTrue("control: longer than the 300 characters it was once cut to (${line.length})", line.length > 300)
        val v = running()
        fakeCli(before = plan(v, "current"), after = plan(v, "current"), exit = 1, err = line)
        clickUpdateNow()
        waitFor("the failure is reported") { said().any { it.startsWith("Updating OAK failed") } }
        assertEquals("Updating OAK failed: $line", said().first { it.startsWith("Updating OAK failed") })
    }

    fun testACliThatNamesNoFolderKeepsTheRowThatNeededWork() {
        if (SystemInfo.isWindows) return
        // A CLI older than `pluginsDir` cannot say which row is this IDE's: the row that needed work moved
        // when the run succeeded, as before.
        fakeCli(before = plan("0.0.1", "behind", folder = false), after = plan("9.9.9", "current", folder = false))
        clickUpdateNow()
        waitFor("Later is answered") { said().any { it.startsWith("New build loads on the next IDE restart") } }
        assertEquals("9.9.9", ChangeMapPanel.pendingRestartVersion)
    }
}
