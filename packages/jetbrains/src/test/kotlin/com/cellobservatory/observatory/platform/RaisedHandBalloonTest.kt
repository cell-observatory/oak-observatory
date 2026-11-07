package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.intellij.notification.Notification
import com.intellij.notification.Notifications
import com.intellij.openapi.util.SystemInfo
import com.intellij.testFramework.LightProjectDescriptor
import com.intellij.testFramework.PlatformTestUtil
import java.io.File
import java.nio.file.Files

/**
 * A raised hand's balloon, driven through the real sessions fetch against a fake CLI. A question or an input
 * wait balloons at once. A permission prompt balloons only once `oak notify` has sat out its wait and found it
 * still up (`stillUp`), as the terminal app and VS Code pop it, so a prompt answered at the agent's terminal,
 * or by Codex's Auto-review, never pops.
 */
class RaisedHandBalloonTest : ObservatoryPlatformTestCase() {

    // A reused light project keeps its service's active session and the CLI's batched listing. A forced
    // fetch can then answer from the previous test's batch without ever calling this test's fake CLI.
    override fun getProjectDescriptor() = LightProjectDescriptor()

    private lateinit var work: File
    private var savedBin: String? = null
    private var savedPin: String? = null
    private val seen = java.util.Collections.synchronizedList(mutableListOf<Notification>())

    override fun setUp() {
        super.setUp()
        work = Files.createTempDirectory("oak-hand-balloon").toFile()
        ClaudePaths.configDirOverride = File(work, "config").toPath()
        savedBin = ObservatorySettings.instance.state.observatoryBin
        savedPin = ObservatorySettings.instance.state.session
        ObservatorySettings.instance.state.session = null
        project.basePath?.let { File(it).mkdirs() } // the CLI runs in the project's folder, which the light test project never creates
        project.messageBus.connect(testRootDisposable).subscribe(Notifications.TOPIC, object : Notifications {
            override fun notify(notification: Notification) { seen += notification }
        })
    }

    override fun tearDown() {
        try {
            File(work, "hold").delete()
            ObservatorySettings.instance.state.observatoryBin = savedBin
            ObservatorySettings.instance.state.session = savedPin
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

    fun testAPermissionPromptBalloonsOnlyWhenItsWaitEndsWithTheHandStillUp() {
        if (SystemInfo.isWindows) return // the fake CLI is a POSIX shell script
        val log = File(work, "notify.log")
        val hold = File(work, "hold").apply { writeText("") }
        val ts = System.currentTimeMillis()
        fun row(id: String, title: String, kind: String) =
            """{"id":"$id","title":"$title","lastActiveMs":$ts,"attention":{"kind":"$kind","message":"Bash","ts":$ts}}"""
        val listing = """{"active":null,"sessions":[${row("fixture-balloon-asks", "Asks", "question")},""" +
            """${row("fixture-balloon-permits", "Permits", "permission")},${row("fixture-balloon-answered", "Answered", "permission")}]}"""
        // `oak notify` sits out a permission prompt's wait: here the one still up waits on the hold file, and
        // the answered one returns at once with the hand down. Every other call fails, as a missing CLI would.
        val fake = File(work, "fake-oak")
        fake.writeText(
            "#!/bin/sh\ncase \"\$1\" in\n" +
                "  sessions) printf '%s\\n' '$listing' ;;\n" +
                "  notify) case \"\$*\" in\n" +
                "    *'--session fixture-balloon-permits '*) while [ -e '${hold.path}' ]; do sleep 0.05; done; printf '%s\\n' '{\"sent\":false,\"stillUp\":true}' ;;\n" +
                "    *'--session fixture-balloon-answered '*) printf '%s\\n' '{\"sent\":false,\"stillUp\":false}' ;;\n" +
                "    *) printf '%s\\n' '{\"sent\":true,\"stillUp\":true}' ;;\n" +
                "  esac; echo \"\$3\" >> '${log.path}' ;;\n" +
                "  *) exit 1 ;;\nesac\n",
        )
        fake.setExecutable(true)
        ObservatorySettings.instance.state.observatoryBin = fake.absolutePath
        fun notified() = if (log.isFile) log.readLines() else emptyList()

        ObservatoryService.getInstance(project).sessions(force = true)
        waitFor("a question balloons at once") { said().any { it == "“Asks” has a question for you — Bash" } }
        waitFor("the answered prompt's `oak notify` returns") { "fixture-balloon-answered" in notified() }
        Thread.sleep(300); PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()
        assertFalse("a prompt inside its wait does not balloon: ${said()}", said().any { it.contains("Permits") })
        hold.delete()
        waitFor("the prompt still up balloons once its wait ends") { said().any { it == "“Permits” needs your permission — Bash" } }
        assertFalse("a prompt answered during its wait never balloons: ${said()}", said().any { it.contains("Answered") })
        assertEquals("one balloon per hand", 1, said().count { it.contains("Permits") })
    }

    // Another machine's hand rides the listing (`syncedHands`): it balloons at once, naming its machine, once however many
    // reads, and goes to `oak notify` under that machine's id.
    fun testAnotherMachinesHandBalloonsAtOnceNamingItsMachine() {
        if (SystemInfo.isWindows) return // the fake CLI is a POSIX shell script
        val log = File(work, "notify.log")
        val ts = System.currentTimeMillis()
        val listing = """{"active":null,"sessions":[],"syncedHands":[{"id":"fixture-remote","title":"Remote","agent":"claude","workspace":"~/app",""" +
            """"machine":"build-box","host":"aaaaaaaaaaaa","kind":"permission","message":"Bash","ts":$ts,"syncedAt":$ts,"origin":"synced"}]}"""
        val fake = File(work, "fake-oak")
        fake.writeText(
            "#!/bin/sh\ncase \"\$1\" in\n" +
                "  sessions) printf '%s\\n' '$listing' ;;\n" +
                "  notify) echo \"\$*\" >> '${log.path}'; printf '%s\\n' '{\"sent\":true,\"stillUp\":true}' ;;\n" +
                "  *) exit 1 ;;\nesac\n",
        )
        fake.setExecutable(true)
        ObservatorySettings.instance.state.observatoryBin = fake.absolutePath
        val service = ObservatoryService.getInstance(project)
        service.sessions(force = true)
        waitFor("it balloons at once, naming its machine") { said().any { it == "“Remote” on build-box needs your permission — Bash" } }
        waitFor("it goes to `oak notify` under its machine") { log.isFile && log.readText().contains("--session fixture-remote ") }
        assertTrue(log.readText(), log.readText().contains("--host aaaaaaaaaaaa --machine build-box --json"))
        service.sessions(force = true)
        Thread.sleep(300); PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()
        assertEquals("once", 1, said().count { it.contains("Remote") })
        assertEquals("one desktop hand-off", 1, log.readLines().count { it.contains("fixture-remote ") })
    }

    // Another machine's finished turn, as this machine's own: no balloon, and the desktop as the reader's notification
    // options say (core decides, through `oak notify`).
    fun testAnotherMachinesFinishedTurnGoesToTheDesktopDecisionWithNoBalloon() {
        if (SystemInfo.isWindows) return // the fake CLI is a POSIX shell script
        val log = File(work, "notify.log")
        val ts = System.currentTimeMillis()
        val listing = """{"active":null,"sessions":[],"syncedHands":[{"id":"fixture-remote-done","title":"Remote done","agent":"claude","workspace":"~/app",""" +
            """"machine":"build-box","host":"aaaaaaaaaaaa","kind":"idle-done","message":"","ts":$ts,"syncedAt":$ts,"origin":"synced"}]}"""
        val fake = File(work, "fake-oak")
        fake.writeText(
            "#!/bin/sh\ncase \"\$1\" in\n" +
                "  sessions) printf '%s\\n' '$listing' ;;\n" +
                "  notify) echo \"\$*\" >> '${log.path}'; printf '%s\\n' '{\"sent\":false,\"stillUp\":true}' ;;\n" +
                "  *) exit 1 ;;\nesac\n",
        )
        fake.setExecutable(true)
        ObservatorySettings.instance.state.observatoryBin = fake.absolutePath
        ObservatoryService.getInstance(project).sessions(force = true)
        waitFor("it goes to `oak notify` under its machine") { log.isFile && log.readText().contains("--session fixture-remote-done ") }
        assertTrue(log.readText(), log.readText().contains("--kind idle-done") && log.readText().contains("--host aaaaaaaaaaaa"))
        Thread.sleep(300); PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()
        assertFalse("no balloon: ${said()}", said().any { it.contains("Remote done") })
    }
}
