package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.settings.ObservatorySettings
import com.cellobservatory.observatory.ui.ChangeMapPanel
import com.intellij.openapi.actionSystem.ActionToolbar
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.ToggleAction
import com.intellij.openapi.actionSystem.impl.ActionToolbarImpl
import com.intellij.openapi.actionSystem.impl.SimpleDataContext
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.awt.Container
import javax.swing.JTabbedPane

/**
 * Grouped nav, over a REAL panel in a real (headless) IDE.
 *
 * The whole hazard of this mode is index-keyed tab writes. Ungrouped there are five tabs; grouped there are
 * two, so a single surviving `setTitleAt(TASKS_TAB, "Tasks 3/5")` would relabel the group tab
 * "Workflows · Tasks · Processes" as "Tasks 3/5" — silently, on whichever repaint happened to run. Nothing
 * in a compile or a pure unit test can see that, so this builds the panel both ways and reads the titles
 * back after the badge writes have run.
 */
class GroupedNavTest : BasePlatformTestCase() {

    private var saved = false

    override fun setUp() {
        super.setUp()
        saved = ObservatorySettings.instance.state.overviewGroupedNav
    }

    override fun tearDown() {
        try {
            ObservatorySettings.instance.state.overviewGroupedNav = saved
        } finally {
            super.tearDown()
        }
    }

    private fun stripOf(panel: ChangeMapPanel): JTabbedPane =
        panel.selectNavTab("fleet") as? JTabbedPane
            ?: throw AssertionError("selectNavTab could not bring a member forward")

    private fun titles(strip: JTabbedPane) = (0 until strip.tabCount).map { strip.getTitleAt(it) }

    fun testUngroupedKeepsOneTabPerMember() {
        ObservatorySettings.instance.state.overviewGroupedNav = false
        val strip = stripOf(ChangeMapPanel(project))
        // Processes is absent until `processes --json` answers, which it cannot here.
        assertEquals(listOf("Sessions", "Workers", "Workflows", "Tasks"), titles(strip))
    }

    fun testGroupedRendersTwoGroupTabsAndNoBadgeWriteRelabelsThem() {
        ObservatorySettings.instance.state.overviewGroupedNav = true
        val panel = ChangeMapPanel(project)
        val strip = stripOf(panel)
        // Construction already ran repaintSessions / repaintTasks / repaintNavCounts, so every badge write
        // this panel makes has happened by now. The group titles must still be the group titles.
        assertEquals(listOf("Sessions · Workers · Workflows · Tasks · Processes"), titles(strip))
        // And every member the guided tour may name still resolves to one of those two tabs.
        for (m in ChangeMapPanel.TOUR_TABS.filter { it != "processes" }) {
            assertNotNull("grouped mode cannot bring \"$m\" forward", panel.selectNavTab(m))
        }
        assertEquals("the five member names are unchanged", 5, ChangeMapPanel.TOUR_TABS.size)
    }

    fun testTheToolbarToggleFlipsTheLayoutBothWays() {
        ObservatorySettings.instance.state.overviewGroupedNav = false
        val panel = ChangeMapPanel(project)
        val toggle = groupToggle(panel) ?: throw AssertionError("the Overview toolbar has no Group Tabs toggle")
        val e = AnActionEvent.createFromDataContext(
            ActionToolbar.ACTION_TOOLBAR_PROPERTY_KEY.toString(), null,
            SimpleDataContext.getProjectContext(project),
        )
        assertFalse("it starts off", toggle.isSelected(e))
        toggle.setSelected(e, true)
        assertEquals(listOf("Sessions · Workers · Workflows · Tasks · Processes"), titles(stripOf(panel)))
        assertTrue(toggle.isSelected(e))
        toggle.setSelected(e, false)
        // Back to one tab per member, WITH their badges re-written — a rebuild that forgot to re-badge would
        // leave the names bare, which is indistinguishable here from correct, so assert the count instead.
        assertEquals(listOf("Sessions", "Workers", "Workflows", "Tasks"), titles(stripOf(panel)))
        assertFalse(toggle.isSelected(e))
    }

    private fun groupToggle(root: Container): ToggleAction? {
        val out = mutableListOf<ActionToolbarImpl>()
        fun walk(c: Container) {
            for (child in c.components) {
                if (child is ActionToolbarImpl) out += child
                if (child is Container) walk(child)
            }
        }
        walk(root)
        return out.flatMap { it.actionGroup.getChildren(null).toList() }
            .filterIsInstance<ToggleAction>()
            .firstOrNull { it.templatePresentation.text == "Group Tabs" }
    }
}
