package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.model.SessionPrompt
import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.cellobservatory.observatory.ui.ReviewNavBar

/**
 * Picking a prompt on the nav bar's Prompt axis is a pick EVERYWHERE.
 *
 * The Prompts window and the Prompt axis are two views of one choice, and they used to disagree: stepping
 * or clicking the axis moved the review cursor and the Overview's scope but left the Prompts list sitting
 * on whatever row it had, so the window said one ask was picked while the counter said another. Nothing
 * fails when that happens — the reader simply gets a scope they did not choose.
 */
class PromptAxisSelectionTest : ObservatoryPlatformTestCase() {

    private fun prompt(id: String, editIds: List<Int>) = SessionPrompt(
        id = id, index = 1, ts = 1_000L, endTs = 2_000L, text = "make it faster", title = "make it faster",
        editIds = editIds, edits = editIds.size, added = 1, removed = 0, pending = editIds.size, kept = 0,
        undone = 0, files = 1, folders = 1, tokens = 0L, tasks = 0, actions = 1, errors = 0,
        agents = emptyList(), workflows = emptyList(), processes = emptyList(), compactions = 0, durationMs = 5L,
    )

    fun testRevealingAPromptMakesItThePickEveryOtherSurfaceReads() {
        val session = "prompt-axis-session"
        val settings = ObservatorySettings.instance.state
        val savedCfg = ClaudePaths.configDirOverride
        val savedSession = settings.session
        val cfg = java.nio.file.Files.createTempDirectory("co-prompt-axis")
        val service = ObservatoryService.getInstance(project)
        val savedPick = service.selectedPromptId
        try {
            ClaudePaths.configDirOverride = cfg
            settings.session = session // pinned: currentSession() then needs no transcript to resolve
            java.nio.file.Files.createDirectories(ClaudePaths.storeDir(session))
            val file = myFixture.configureByText("prompt-axis.txt", "hello").virtualFile
            java.nio.file.Files.writeString(
                ClaudePaths.logPath(session),
                """{"id":1,"ts":1000,"tool":"Edit","file":"${file.path}",""" +
                    """"beforeBlob":"aa","afterBlob":"bb","status":"pending"}""" + "\n",
            )
            service.selectedPromptId = null

            val nav = ReviewNavBar(project)
            nav.promptsProvider = { listOf(prompt("p1", listOf(1))) }
            nav.revealPrompt("p1")

            assertEquals(
                "revealing an ask must make it the pick — the Prompts window and the Overview both read this",
                "p1", service.selectedPromptId,
            )
        } finally {
            service.selectedPromptId = savedPick
            settings.session = savedSession
            ClaudePaths.configDirOverride = savedCfg
            cfg.toFile().deleteRecursively()
        }
    }

    /** An ask with nothing left to review is deliberately left alone: there is no pending edit to open, and
     *  re-scoping every surface to it would change what the reader is looking at for no reason. */
    fun testAnAskWithNothingPendingChangesNoScope() {
        val service = ObservatoryService.getInstance(project)
        val savedPick = service.selectedPromptId
        try {
            service.selectedPromptId = null
            val nav = ReviewNavBar(project)
            nav.promptsProvider = { listOf(prompt("resolved", listOf(999))) } // no such edit in the store
            nav.revealPrompt("resolved")
            assertNull("an ask with nothing pending must not re-scope the panels", service.selectedPromptId)
        } finally {
            service.selectedPromptId = savedPick
        }
    }
}
