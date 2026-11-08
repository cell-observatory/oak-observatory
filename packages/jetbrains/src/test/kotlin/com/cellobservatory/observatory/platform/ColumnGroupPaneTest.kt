package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.model.ColumnLayout
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.cellobservatory.observatory.ui.ColumnGroupPane
import com.intellij.openapi.ui.Splitter
import java.awt.Container
import javax.swing.JLabel
import javax.swing.JPanel

/**
 * The grouped columns, over a REAL pane.
 *
 * [com.cellobservatory.observatory.model.ColumnLayoutTest] pins the rules; this pins that the pane obeys
 * them — which is where they actually go wrong. A splitter rebuilt from a constant instead of the stored
 * proportion, a fold that writes the pinned value back over the reader's width, a late column that takes
 * the whole group with it: all three compile, and all three are invisible until someone drags a divider
 * and comes back the next day.
 */
class ColumnGroupPaneTest : ObservatoryPlatformTestCase() {

    private val group = "runs"
    private val members = listOf("workflows", "tasks", "processes")

    private var savedSplits: MutableMap<String, Float> = LinkedHashMap()
    private var savedCollapsed: MutableList<String> = ArrayList()

    override fun setUp() {
        super.setUp()
        val s = ObservatorySettings.instance.state
        savedSplits = LinkedHashMap(s.columnSplits)
        savedCollapsed = ArrayList(s.collapsedColumns)
        s.columnSplits = LinkedHashMap()
        s.collapsedColumns = ArrayList()
    }

    override fun tearDown() {
        try {
            val s = ObservatorySettings.instance.state
            s.columnSplits = savedSplits
            s.collapsedColumns = savedCollapsed
        } finally {
            super.tearDown()
        }
    }

    private fun pane(): ColumnGroupPane = ColumnGroupPane(
        group = group,
        members = members,
        title = { it.replaceFirstChar { c -> c.uppercase() } },
        tip = { "the $it column" },
        defaultProportion = { i -> if (i == 0) 0.34f else 0.5f },
    )

    /** The outermost splitter of the pane — the one whose proportion is divider 0. */
    private fun outerSplitter(pane: ColumnGroupPane): Splitter =
        pane.components.filterIsInstance<Splitter>().firstOrNull()
            ?: throw AssertionError("the group pane built no splitter, so there is no divider to assert about")

    private fun labels(root: Container): List<String> {
        val out = mutableListOf<String>()
        fun walk(c: Container) {
            for (child in c.components) {
                if (child is JLabel && !child.text.isNullOrBlank()) out += child.text
                if (child is Container) walk(child)
            }
        }
        walk(root)
        return out
    }

    fun testAColumnArrivingLateKeepsTheWidthTheReaderAlreadySet() {
        val pane = pane()
        pane.mount("workflows", JPanel())
        pane.mount("tasks", JPanel())
        // The reader drags divider 0 wide. (The drag itself is the platform's; what it leaves behind is
        // this, and it is what the next rebuild has to honour.)
        ObservatorySettings.instance.state.columnSplits[ColumnLayout.dividerKey(group, 0)] = 0.7f
        pane.rebuild()
        assertEquals("the stored width is what the pane lays out", 0.7f, outerSplitter(pane).proportion, 0.0001f)
        // …and now Processes answers for the first time, exactly as repaintProcesses mounts it.
        pane.mount("processes", JPanel())
        assertEquals(
            "mounting a third column reset the first divider — the reader's width is gone",
            0.7f, outerSplitter(pane).proportion, 0.0001f,
        )
        val inner = outerSplitter(pane).secondComponent as? Splitter
            ?: throw AssertionError("the third column did not get a divider of its own")
        assertEquals(
            "the new divider must take the shipped default, not the value the reader set for another one",
            0.5f, inner.proportion, 0.0001f,
        )
    }

    fun testFoldingKeepsTheStoredWidthSoReopeningRestoresIt() {
        val pane = pane()
        pane.mount("workflows", JPanel())
        pane.mount("tasks", JPanel())
        ObservatorySettings.instance.state.columnSplits[ColumnLayout.dividerKey(group, 0)] = 0.7f
        pane.rebuild()

        pane.foldColumn("tasks")
        assertEquals("a folded right half gives every pixel to the left", 1f, outerSplitter(pane).proportion, 0.0001f)
        // The divider is still there beside the rail, and still draggable — a drag on it is the one thing
        // that can overwrite the reader's remembered width with a value that means nothing, since one side
        // is showing no content at all. This is that drag.
        outerSplitter(pane).proportion = 0.93f
        assertEquals(
            "a drag against a folded column overwrote the width the reader set",
            0.7f,
            ObservatorySettings.instance.state.columnSplits[ColumnLayout.dividerKey(group, 0)],
        )
        assertTrue("the fold is remembered", "tasks" in ObservatorySettings.instance.state.collapsedColumns)

        pane.unfoldColumn("tasks")
        assertEquals("reopening restores the reader's width, not an even split", 0.7f, outerSplitter(pane).proportion, 0.0001f)
        assertFalse("and the fold is forgotten", "tasks" in ObservatorySettings.instance.state.collapsedColumns)
    }

    fun testTheLastColumnShowingContentRefusesToFold() {
        val pane = pane()
        pane.mount("workflows", JPanel())
        pane.mount("tasks", JPanel())
        pane.foldColumn("workflows")
        pane.foldColumn("tasks")
        assertEquals(
            "both columns folded — the group is an empty pane with no way back",
            listOf("workflows"), ObservatorySettings.instance.state.collapsedColumns,
        )
    }

    /** A folded column keeps its NAME on screen: a rail nobody can identify is one nobody reopens. */
    fun testAFoldedColumnStaysNamedAndReachable() {
        val pane = pane()
        pane.mount("workflows", JPanel())
        pane.mount("tasks", JPanel())
        pane.header("workflows").text = "Workflows 2/3" // the badge a payload writes
        pane.foldColumn("workflows")
        assertTrue(
            "the rail must carry the member's name and badge: saw ${railTexts(pane)}",
            railTexts(pane).any { it.contains("Workflows 2/3") },
        )
        // …and a badge written while it is folded reaches the rail too, or the rail shows a stale count
        // for as long as the reader leaves it closed.
        pane.header("workflows").text = "Workflows 3/3"
        pane.syncRailText("workflows")
        assertTrue(
            "a badge written to a folded column never reached its rail: saw ${railTexts(pane)}",
            railTexts(pane).any { it.contains("Workflows 3/3") },
        )
        pane.unfoldColumn("workflows")
        assertTrue(
            "reopening must put the column header back: saw ${labels(pane)}",
            labels(pane).any { it.contains("Workflows") },
        )
    }

    /** The rail draws its name itself (rotated), so it is not a JLabel — read it off the component. */
    private fun railTexts(pane: ColumnGroupPane): List<String> {
        val out = mutableListOf<String>()
        fun walk(c: Container) {
            for (child in c.components) {
                if (child is com.cellobservatory.observatory.ui.VerticalLabel) out += child.text
                if (child is Container) walk(child)
            }
        }
        walk(pane)
        return out
    }

    /** Only THIS group's members may be rewritten in the shared collapsed list — both windows use it. */
    fun testFoldingOneGroupLeavesAnotherGroupsFoldsAlone() {
        ObservatorySettings.instance.state.collapsedColumns = mutableListOf("observations")
        val pane = pane()
        pane.mount("workflows", JPanel())
        pane.mount("tasks", JPanel())
        pane.foldColumn("tasks")
        assertTrue(
            "the Timeline's folded column was dropped by an Overview fold",
            "observations" in ObservatorySettings.instance.state.collapsedColumns,
        )
        assertTrue("tasks" in ObservatorySettings.instance.state.collapsedColumns)
    }
}
