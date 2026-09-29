package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.model.NavGrouping
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.cellobservatory.observatory.ui.ColumnGroupPane
import com.cellobservatory.observatory.ui.TimelineNewSessionAction
import com.cellobservatory.observatory.ui.PromptsPanel
import com.cellobservatory.observatory.ui.ObservatoryTimelineFactory
import com.cellobservatory.observatory.ui.TimelinePanel
import com.intellij.openapi.actionSystem.ActionToolbar
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.ToggleAction
import com.intellij.openapi.actionSystem.impl.ActionToolbarImpl
import com.intellij.openapi.actionSystem.impl.SimpleDataContext
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.awt.Component
import java.awt.Container
import javax.swing.JTabbedPane

/**
 * The Timeline window's content: its session selector, its tabs and its grouping toggle.
 *
 * The selector used to be a platform title action, drawn on the tool-window header by `setTitleActions`.
 * Nothing about that is observable from a test — the header is built by the platform, the headless fixture
 * registers no tool windows at all — so "the reader cannot see the session selector" was a bug no test
 * could hold. Now the selector is a component of this panel, and these methods are what say so.
 */
class TimelineWindowTest : BasePlatformTestCase() {

    private var savedGrouped = false
    private var savedCollapsed: MutableList<String> = ArrayList()

    override fun setUp() {
        super.setUp()
        val s = ObservatorySettings.instance.state
        savedGrouped = s.timelineGroupedNav
        savedCollapsed = ArrayList(s.collapsedColumns)
        s.timelineGroupedNav = false
        s.collapsedColumns = ArrayList()
    }

    override fun tearDown() {
        try {
            val s = ObservatorySettings.instance.state
            s.timelineGroupedNav = savedGrouped
            s.collapsedColumns = savedCollapsed
        } finally {
            super.tearDown()
        }
    }

    private fun isDescendant(child: Component, root: Container): Boolean {
        var c: Component? = child
        while (c != null) {
            if (c === root) return true
            c = c.parent
        }
        return false
    }

    private fun <T> find(root: Container, type: Class<T>): List<T> {
        val out = mutableListOf<T>()
        fun walk(c: Container) {
            for (child in c.components) {
                if (type.isInstance(child)) out += type.cast(child)
                if (child is Container) walk(child)
            }
        }
        walk(root)
        return out
    }

    /**
     * The window holds ONE content, and it must not put a tab of its own on the header: the tabs a reader
     * needs are [TimelinePanel]'s, drawn inside the content. TabContentLayout.isToDrawTabs() hides a lone
     * content's tab only when Content.getToolwindowTitle() is blank — and that getter falls back to the
     * display name, so "Timeline" alone would draw one, next to the window's own "Observatory Timeline".
     */
    fun testTheLoneContentPutsNoTabOnTheHeader() {
        val tw = ToolWindowManager.getInstance(project).registerToolWindow("Observatory Timeline") {}
        ObservatoryTimelineFactory().createToolWindowContent(project, tw)
        val content = tw.contentManager.contents.single()
        assertEquals("the content is still named, for the tab-overflow chooser", "Timeline", content.displayName)
        assertTrue(
            "toolwindowTitle is \"${content.toolwindowTitle}\" — the platform draws a tab for it, and the " +
                "header reads the window name AND a redundant tab beside it",
            content.toolwindowTitle.isNullOrBlank(),
        )
    }

    fun testTheSessionSelectorIsAComponentOfTheContent() {
        val panel = TimelinePanel(project)
        val anchor = panel.sessionAnchor()
        assertTrue(
            "the selector is not inside the Timeline content — it is back on the platform header, where " +
                "nothing can ring it and a narrow header clips it away",
            isDescendant(anchor, panel),
        )
        // It is a real toolbar with the real action on it, not a placeholder.
        val toolbar = find(panel, ActionToolbarImpl::class.java)
            .firstOrNull { isDescendant(it, anchor as Container) || it === anchor }
            ?: throw AssertionError("the session anchor holds no toolbar")
        val actions = toolbar.actionGroup.getChildren(null)
        // The selector plus the "+ new session" launcher share the row.
        assertEquals("the selector and the + launcher on the row", 2, actions.size)
        assertTrue("the + launcher rides beside it", actions.any { it is TimelineNewSessionAction })
        assertTrue(
            "the row carries something other than the session selector: ${actions[0].javaClass.name}",
            actions[0] is com.cellobservatory.observatory.ui.TimelineSessionAction,
        )
    }

    /** …and the guided tour's `session-picker` anchor now resolves to it. It returned null for a release. */
    fun testTheTourCanRingTheSessionSelector() {
        val panel = TimelinePanel(project)
        // The Timeline builds its tabs only once the window is realized, which a headless fixture never
        // does — so the Prompts panel the tour asks is constructed here instead. The delegation under test
        // is the same either way: PromptsPanel resolves the anchor through whichever Timeline hosts it.
        PromptsPanel(project)
        val anchor = PromptsPanel.of(project)?.tourAnchor("session-picker")
            ?: throw AssertionError("session-picker rings nothing — the tour step points at empty space")
        assertSame("the tour must ring the selector this window is showing", panel.sessionAnchor(), anchor)
    }

    fun testTabsBecomeColumnsAndBack() {
        val panel = TimelinePanel(project)
        assertEquals(
            "ungrouped, the four surfaces are tabs",
            listOf("Feed", "Prompts", "Observations", "Actions"),
            tabTitles(panel),
        )
        assertTrue("and no column pane is mounted", find(panel, ColumnGroupPane::class.java).isEmpty())

        val toggle = groupToggle(panel) ?: throw AssertionError("the Timeline has no Group Tabs toggle")
        val e = AnActionEvent.createFromDataContext(
            ActionToolbar.ACTION_TOOLBAR_PROPERTY_KEY.toString(), null,
            SimpleDataContext.getProjectContext(project),
        )
        assertFalse("it starts off", toggle.isSelected(e))
        toggle.setSelected(e, true)
        assertTrue("grouped, the surfaces move into one column pane", find(panel, ColumnGroupPane::class.java).isNotEmpty())
        assertEquals("and the tab strip lets them go", emptyList<String>(), tabTitles(panel))
        // Every surface is still on screen — grouped means all of them at once, none folded away.
        for (name in listOf("Feed", "Prompts", "Observations", "Actions")) {
            assertTrue("$name vanished in grouped mode", panel.selectMember(name.lowercase()))
        }

        toggle.setSelected(e, false)
        assertEquals("off restores the four separate tabs", listOf("Feed", "Prompts", "Observations", "Actions"), tabTitles(panel))
        assertTrue("and the column pane gives the panes back", find(panel, ColumnGroupPane::class.java).all { it.componentCount == 0 })
    }

    /** The tour and tab strip address the same Feed member id. */
    fun testTheTourCanBringEachMemberForward() {
        val panel = TimelinePanel(project)
        for (m in listOf("feed", "prompts", "observations", "actions")) {
            assertTrue(
                "the tour cannot bring \"$m\" forward",
                panel.selectMember(m),
            )
        }
        assertFalse("an unknown member moves nothing", panel.selectMember("sessions"))
    }

    /** …including one the reader folded away. "Show me Observations" that leaves it a rail has not shown
     *  it, and the tour would go on to describe a surface that is not on screen. */
    fun testBringingAFoldedColumnForwardUnfoldsIt() {
        ObservatorySettings.instance.state.timelineGroupedNav = true
        ObservatorySettings.instance.state.collapsedColumns = mutableListOf("observations")
        val panel = TimelinePanel(project)
        assertTrue(panel.selectMember("observations"))
        assertFalse(
            "the column is still folded — the tour is pointing at a rail",
            "observations" in ObservatorySettings.instance.state.collapsedColumns,
        )
    }

    private fun tabTitles(panel: TimelinePanel): List<String> {
        val tabs = find(panel, JTabbedPane::class.java).firstOrNull { it.tabCount > 0 } ?: return emptyList()
        return (0 until tabs.tabCount).map { tabs.getTitleAt(it) }
    }

    private fun groupToggle(root: Container): ToggleAction? =
        find(root, ActionToolbarImpl::class.java)
            .flatMap { it.actionGroup.getChildren(null).toList() }
            .filterIsInstance<ToggleAction>()
            .firstOrNull { it.templatePresentation.text == "Group Tabs" }
}
