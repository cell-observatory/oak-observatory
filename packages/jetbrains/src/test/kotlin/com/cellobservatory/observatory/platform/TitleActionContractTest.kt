package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.ui.TimelineSessionAction
import com.intellij.openapi.actionSystem.ActionToolbar
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.impl.SimpleDataContext

/**
 * The Timeline's session selector, asserted EXPLICITLY.
 *
 * Its HOST moved in 0.10.0 — from the platform's tool-window header (`setTitleActions`) into the Timeline
 * content, where [TimelineWindowTest] can see it — but the action's own contract did not, and it is the
 * part no other test covers: this chip is re-evaluated on every toolbar tick of a window that stays open
 * all day, so an EDT-bound `update()` or one that spawns the CLI costs the same either way.
 */
class TitleActionContractTest : ObservatoryPlatformTestCase() {

    fun testTimelineSessionSelectorContract() {
        val action = TimelineSessionAction(project)
        assertEquals(
            "a title action re-evaluated on every tick must not hop to the EDT",
            ActionUpdateThread.BGT,
            action.actionUpdateThread,
        )
        val ctx = SimpleDataContext.getProjectContext(project)
        val e = AnActionEvent.createFromDataContext(
            ActionToolbar.ACTION_TOOLBAR_PROPERTY_KEY.toString(), null, ctx
        )
        try {
            action.update(e)
        } catch (t: Throwable) {
            fail("TimelineSessionAction.update() threw ${t.javaClass.simpleName}: ${t.message}")
        }
        // The chip always renders SOMETHING: an empty presentation text on a displayTextInToolbar action is
        // an invisible button, which is how a selector silently disappears.
        assertTrue("the selector always names a state", !e.presentation.text.isNullOrBlank())
        assertTrue(
            "with no session resolvable, the chip must say so rather than name one: was ${e.presentation.text}",
            e.presentation.text!!.startsWith("○") || e.presentation.text!!.startsWith("●"),
        )
    }
}
