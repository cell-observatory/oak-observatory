package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.actions.NextAttentionAction
import com.cellobservatory.observatory.actions.SearchConversationsAction
import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.cellobservatory.observatory.ui.ReviewOps
import com.intellij.notification.Notification
import com.intellij.notification.Notifications
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.impl.SimpleDataContext
import com.intellij.openapi.ui.TestDialogManager
import com.intellij.openapi.ui.TestInputDialog
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.io.File

/**
 * A read that FAILED is said as a failure. "Nothing matches “q” in any conversation" and "Nobody is
 * waiting on you" are claims about every session, and they used to be what a failed or timed-out CLI
 * run produced. The actions run for real, with the CLI pinned to /bin/false.
 */
class FailedReadsTest : BasePlatformTestCase() {

    private var savedBin: String? = null
    private val seen = mutableListOf<Notification>()

    override fun setUp() {
        super.setUp()
        savedBin = ObservatorySettings.instance.state.observatoryBin
        ObservatorySettings.instance.state.observatoryBin = "/bin/false"
        project.messageBus.connect(testRootDisposable).subscribe(Notifications.TOPIC, object : Notifications {
            override fun notify(notification: Notification) { seen += notification }
        })
    }

    override fun tearDown() {
        try {
            ObservatorySettings.instance.state.observatoryBin = savedBin
        } finally {
            super.tearDown()
        }
    }

    private fun perform(action: AnAction): String {
        action.actionPerformed(AnActionEvent.createFromDataContext("FailedReadsTest", null, SimpleDataContext.getProjectContext(project)))
        val deadline = System.currentTimeMillis() + 15_000
        while (seen.isEmpty() && System.currentTimeMillis() < deadline) {
            PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()
            Thread.sleep(20)
        }
        assertEquals("the action said exactly one thing", 1, seen.size)
        return seen.single().content
    }

    fun testAFailedInboxReadIsNotNobodyWaiting() {
        val said = perform(NextAttentionAction())
        assertFalse("a failed read is not reported as nobody waiting: $said", said.contains("Nobody is waiting"))
        assertTrue("…it says it could not read them: $said", said.contains("Could not read which sessions are waiting"))
    }

    fun testAFailedSearchIsNotNothingMatches() {
        val prev = TestDialogManager.setTestInputDialog(TestInputDialog { "needle" })
        try {
            val said = perform(SearchConversationsAction())
            assertFalse("a failed search is not reported as an empty result: $said", said.contains("Nothing matches"))
            assertTrue("…it says it could not search: $said", said.contains("Could not search the conversations"))
        } finally {
            TestDialogManager.setTestInputDialog(prev)
        }
    }

    fun testATimedOutSetupCheckIsSlowNotMissing() {
        val slow = ReviewOps.doctorFailure(ObservatoryCli.CliResult(-1, "", "oak timed out after ${ObservatoryCli.HEAVY_TIMEOUT_MS}ms"))
        assertTrue(slow, slow.contains("did not finish within 3 minutes") && slow.contains("saved herdr machine"))
        assertFalse("a slow run is not blamed on a missing CLI: $slow", slow.contains("installed"))
        assertTrue(ReviewOps.doctorFailure(ObservatoryCli.CliResult(-1, "", "Cannot run program \"oak\"")).contains("is the oak CLI installed?"))
        // Both editors give doctor the same deadline: VS Code's constant, read from its source.
        val vs = File("../vscode/src/extension.ts")
        assertTrue("control: the VS Code source is readable from the test's working directory", vs.isFile)
        val deadline = Regex("""const DOCTOR_TIMEOUT_MS = ([\d_]+);""").find(vs.readText())?.groupValues?.get(1)?.replace("_", "")?.toInt()
        assertEquals("VS Code's setup-check deadline matches this plugin's", ObservatoryCli.HEAVY_TIMEOUT_MS, deadline)
    }
}
