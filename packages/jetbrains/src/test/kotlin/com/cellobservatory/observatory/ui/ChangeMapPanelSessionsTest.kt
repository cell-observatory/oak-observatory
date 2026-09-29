package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.model.SessionRow
import org.junit.Assert.*
import org.junit.Test

class ChangeMapPanelSessionsTest {
    private val now = 20 * 86_400_000L
    private fun row(id: String, workspace: String, days: Long = 0, pending: Int = 0) =
        SessionRow(id, id, now - days * 86_400_000L, current = false, edits = pending, pending = pending, files = 0, workspace = workspace)

    @Test fun `workspace headers retain CLI order and counts with week folds`() {
        val rows = listOf(row("here", "~/app", 2), row("old", "~/app", 8, 1), row("other", "~/other"))
        val groups = overviewSessionGroups(rows, "here", now, false)
        assertEquals(listOf("~/app", "~/other"), groups.map { it.workspace })
        assertEquals(listOf(2, 1), groups.map { it.count })
        assertEquals(listOf("here"), groups.first().recent.map { it.id })
        assertEquals(listOf("old"), groups.first().older.map { it.id })
        assertEquals(rows.map { it.id }, groups.flatMap { it.recent + it.older }.map { it.id })
    }

    @Test fun `active filter preserves pin and pending edits and reports hidden rows`() {
        val rows = listOf(row("pin", "~/app", 10), row("pending", "~/app", 9, 1), row("finished", "~/app", 2), row("live", "~/other"))
        val groups = overviewSessionGroups(rows, "pin", now, true)
        assertEquals(listOf("pin"), groups.first().recent.map { it.id })
        assertEquals(listOf("pending"), groups.first().older.map { it.id })
        assertEquals(1, groups.first().hidden)
        assertEquals(3, groups.first().count)
        assertEquals("live", groups.last().recent.single().id)
    }
}
