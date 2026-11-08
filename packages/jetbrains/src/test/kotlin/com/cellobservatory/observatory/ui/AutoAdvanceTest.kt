package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.cellobservatory.observatory.platform.ObservatoryPlatformTestCase
import java.nio.file.Files
import java.nio.file.Path

/**
 * `revealNextOnResolve`: after ONE keep/undo the review cursor moves to the next pending edit — and after
 * a REDO it must not, because VS Code does not advance there and a silent divergence between the two
 * editors is exactly the class of defect the parity rule exists for.
 *
 * The redo assertion is the point of this file, so it comes with a positive control: the same call with
 * `redo = false` must actually move the cursor. Without that, a gate that rejected everything would look
 * like a passing redo test forever.
 */
class AutoAdvanceTest : ObservatoryPlatformTestCase() {

    private lateinit var cfg: Path
    private val session = "advance-session"
    private var savedSession: String? = null
    private var savedReveal = true

    override fun setUp() {
        super.setUp()
        cfg = Files.createTempDirectory("co-advance-cfg")
        ClaudePaths.configDirOverride = cfg
        Files.createDirectories(ClaudePaths.storeDir(session))
        val state = ObservatorySettings.instance.state
        savedSession = state.session
        savedReveal = state.revealNextOnResolve
        // Pin the session: currentSession() then answers from settings, with no transcript to resolve.
        state.session = session
        state.revealNextOnResolve = true
    }

    override fun tearDown() {
        try {
            val state = ObservatorySettings.instance.state
            state.session = savedSession
            state.revealNextOnResolve = savedReveal
            ClaudePaths.configDirOverride = null
            cfg.toFile().deleteRecursively()
        } finally {
            super.tearDown()
        }
    }

    /** Edit 1 resolved as [firstStatus]; edits 2 and 3 still pending. */
    private fun seed(firstStatus: String) {
        Files.writeString(
            ClaudePaths.logPath(session),
            listOf(
                """{"id":1,"ts":1000,"tool":"Edit","file":"/w/a.txt","beforeBlob":"aa","afterBlob":"bb","status":"$firstStatus"}""",
                """{"id":2,"ts":2000,"tool":"Edit","file":"/w/b.txt","beforeBlob":"bb","afterBlob":"cc","status":"pending"}""",
                """{"id":3,"ts":3000,"tool":"Edit","file":"/w/c.txt","beforeBlob":"cc","afterBlob":"dd","status":"pending"}""",
            ).joinToString("\n") + "\n",
        )
        ObservatoryService.getInstance(project).refresh()
    }

    fun testAnUndoAdvancesToTheNextPendingEdit() {
        seed("undone")
        val svc = ObservatoryService.getInstance(project)
        svc.parkReviewCursor(null)
        val next = ReviewOps.nextAfterResolve(project, id = 1, redo = false)
        assertNotNull("resolving #1 must hand back something still pending", next)
        assertEquals("the step resumes just past the resolved edit", 2, next!!.id)
        assertEquals("and the shared cursor moved with it", 2, svc.currentPendingEdit()?.id)
    }

    fun testARedoDoesNotMoveTheCursor() {
        // A redo re-APPLIES an edit; nothing became reviewed, so the cursor must stay where the reader
        // left it. `afterUndo` is the shared tail of both verbs, which is why this needs its own gate.
        seed("undone")
        val svc = ObservatoryService.getInstance(project)
        svc.parkReviewCursor(3)
        assertEquals("precondition: the cursor is parked on #3", 3, svc.currentPendingEdit()?.id)
        assertNull(ReviewOps.nextAfterResolve(project, id = 1, redo = true))
        assertEquals("a redo must leave the cursor alone", 3, svc.currentPendingEdit()?.id)
    }

    fun testAResolveThatDidNotHappenDoesNotMoveTheCursor() {
        // The CLI failed, a dirty buffer blocked the write, or a conflict was cancelled: #1 is STILL
        // pending, so there is no verdict to advance past.
        seed("pending")
        val svc = ObservatoryService.getInstance(project)
        svc.parkReviewCursor(3)
        assertNull(ReviewOps.nextAfterResolve(project, id = 1, redo = false))
        assertEquals(3, svc.currentPendingEdit()?.id)
    }

    fun testTheDiffViewerOptsOutWhileEverythingElseStillAdvances() {
        // The diff viewer is a window the reader opened deliberately; revealing a different file behind it
        // would throw them out of it. VS Code's diff title bar makes the same exception, so this is the
        // parity case, not a preference. The `advance = true` half is the positive control: without it this
        // test would pass against an implementation that never advances at all.
        seed("undone")
        val svc = ObservatoryService.getInstance(project)
        svc.parkReviewCursor(null)
        assertNull(
            "the diff viewer's Keep/Undo must not move the reader",
            ReviewOps.nextAfterResolve(project, id = 1, redo = false, advance = false),
        )
        assertNull("and the cursor is left where it was", svc.currentPendingEdit()?.id)
        assertEquals(
            "…while the same resolve from any other surface still advances",
            2,
            ReviewOps.nextAfterResolve(project, id = 1, redo = false, advance = true)?.id,
        )
    }

    fun testTheSettingTurnsItOff() {
        seed("undone")
        val svc = ObservatoryService.getInstance(project)
        svc.parkReviewCursor(3)
        ObservatorySettings.instance.state.revealNextOnResolve = false
        assertNull(ReviewOps.nextAfterResolve(project, id = 1, redo = false))
        assertEquals(3, svc.currentPendingEdit()?.id)
    }

    // --- ReviewSelection.currentEditIn ------------------------------------------------------------------
    // Which edit a PER-FILE surface acts on. Same fixture, because the cursor this reads is the cursor the
    // auto-advance above moves; both of its consumers — the floating bar and the editor banner — put a
    // destructive Undo on whatever it returns, and nothing else in the suite calls it.

    /** #1 resolved in a.txt; #2 and #3 both pending in b.txt; #4 pending in c.txt. Two pending edits in one
     *  file is the case the shared [seed] cannot express, and it is the case the rule is about. */
    private fun seedTwoPendingInOneFile() {
        Files.writeString(
            ClaudePaths.logPath(session),
            listOf(
                """{"id":1,"ts":1000,"tool":"Edit","file":"/w/a.txt","beforeBlob":"aa","afterBlob":"bb","status":"kept"}""",
                """{"id":2,"ts":2000,"tool":"Edit","file":"/w/b.txt","beforeBlob":"bb","afterBlob":"cc","status":"pending"}""",
                """{"id":3,"ts":3000,"tool":"Edit","file":"/w/b.txt","beforeBlob":"cc","afterBlob":"dd","status":"pending"}""",
                """{"id":4,"ts":4000,"tool":"Edit","file":"/w/c.txt","beforeBlob":"dd","afterBlob":"ee","status":"pending"}""",
            ).joinToString("\n") + "\n",
        )
        ObservatoryService.getInstance(project).refresh()
    }

    fun testAFileSurfaceIgnoresACursorParkedInAnotherFile() {
        // The cursor is shared with the tool windows, so it is routinely sitting in a file the reader is not
        // looking at. A bar over b.txt that acted on it would Undo an edit in a file that is not on screen.
        seedTwoPendingInOneFile()
        ObservatoryService.getInstance(project).parkReviewCursor(4)
        assertEquals(
            "with the cursor in c.txt, b.txt's surfaces act on b.txt's FIRST pending edit",
            2,
            ReviewSelection.currentEditIn(project, "/w/b.txt")?.id,
        )
    }

    fun testAFileSurfaceFollowsTheCursorWhenItSitsInThisFile() {
        // #3 is not the file's first pending edit, so this can only pass by reading the cursor — which is
        // what makes the bar's ‹/› and an auto-advance land the Keep/Undo on the edit they just revealed.
        seedTwoPendingInOneFile()
        ObservatoryService.getInstance(project).parkReviewCursor(3)
        assertEquals(
            "the cursor's edit wins over the file's first pending one",
            3,
            ReviewSelection.currentEditIn(project, "/w/b.txt")?.id,
        )
    }

    fun testAFileWithNothingPendingHasNoCurrentEdit() {
        // a.txt's one edit is already kept. Returning it would put a live Undo on reviewed work.
        seedTwoPendingInOneFile()
        ObservatoryService.getInstance(project).parkReviewCursor(4)
        assertNull(
            "a file whose edits are all resolved offers nothing to act on",
            ReviewSelection.currentEditIn(project, "/w/a.txt"),
        )
    }
}
