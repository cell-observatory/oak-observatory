package com.cellobservatory.observatory.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The member ⟷ group mapping the Overview's grouped nav resolves every tab title write through.
 *
 * Two properties matter more than they look. Ungrouped, a member must map to ITSELF — otherwise the default
 * layout starts writing badges to a tab that does not exist. And the groups must partition the five members
 * exactly, in the order the panel builds them: a member in no group would lose its badge in grouped mode,
 * and one in two groups would have it written twice.
 */
class NavGroupingTest {

    private val members = ChangeMapPanelMembers

    @Test
    fun `ungrouped, every member is its own tab`() {
        for (m in members) assertEquals(m, NavGrouping.groupOf(m, grouped = false))
    }

    @Test
    fun `grouped, the two groups partition the five members in shipped order`() {
        assertEquals(
            listOf(NavGrouping.NAV_ALL),
            NavGrouping.GROUPS.keys.toList(),
        )
        assertEquals(members, NavGrouping.GROUPS.values.flatten())
        assertEquals("no member is in two groups", members.size, NavGrouping.GROUPS.values.flatten().toSet().size)
    }

    @Test
    fun `grouped, each member resolves to the group that lists it`() {
        assertEquals(NavGrouping.NAV_ALL, NavGrouping.groupOf(NavGrouping.SESSIONS, grouped = true))
        assertEquals(NavGrouping.NAV_ALL, NavGrouping.groupOf(NavGrouping.FLEET, grouped = true))
        assertEquals(NavGrouping.NAV_ALL, NavGrouping.groupOf(NavGrouping.WORKFLOWS, grouped = true))
        assertEquals(NavGrouping.NAV_ALL, NavGrouping.groupOf(NavGrouping.TASKS, grouped = true))
        assertEquals(NavGrouping.NAV_ALL, NavGrouping.groupOf(NavGrouping.PROCESSES, grouped = true))
    }

    @Test
    fun `every group has a title, and an unknown member maps to itself`() {
        for (g in NavGrouping.GROUPS.keys) {
            assertTrue("group $g has a tab title", !NavGrouping.GROUP_TITLES[g].isNullOrBlank())
        }
        assertEquals("nope", NavGrouping.groupOf("nope", grouped = true))
    }

    @Test
    fun `the members are exactly the tab names the guided tour may address`() {
        // TOUR_TABS is pinned separately by TourTabContractTest; this is the join between the two — grouped
        // mode must not change which names the tour can name.
        assertEquals(com.cellobservatory.observatory.ui.ChangeMapPanel.TOUR_TABS, members)
    }

    private companion object {
        val ChangeMapPanelMembers = listOf(
            NavGrouping.SESSIONS, NavGrouping.FLEET,
            NavGrouping.WORKFLOWS, NavGrouping.TASKS, NavGrouping.PROCESSES,
        )
    }
}
