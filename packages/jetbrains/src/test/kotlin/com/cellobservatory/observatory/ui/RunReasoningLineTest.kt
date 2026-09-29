package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.model.ObservationEdit
import com.cellobservatory.observatory.model.ObservationRun
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** A ×N run row names its newest edit's reasoning, as VS Code's run row does (parity, 2026-09-27). */
class RunReasoningLineTest {

    private fun edit(id: Int, reasoning: String?) = ObservationEdit(id, ts = id * 1000L, added = 1, removed = 0, status = "pending", reasoning = reasoning)
    private fun run(vararg edits: ObservationEdit) =
        ObservationRun(file = "/w/a.py", rel = "a.py", count = edits.size, added = edits.size, removed = 0, status = "pending", edits = edits.toList())

    @Test
    fun `the newest edit's reasoning names the run, not the oldest's`() {
        assertEquals("Second pass: keep the header", runReasoningLine(run(edit(1, "First pass: add the parser"), edit(2, "Second pass: keep the header\nmore"))))
    }

    @Test
    fun `a newest edit without reasoning shows none, never an older edit's`() {
        assertNull(runReasoningLine(run(edit(1, "Oldest"), edit(2, "Middle"), edit(3, null))))
        assertNull(runReasoningLine(run(edit(1, "Oldest"), edit(2, "  "))))
    }

    @Test
    fun `the newest edit's first non-blank line is the one shown, as VS Code's firstLine takes it`() {
        assertEquals("Keep the header", runReasoningLine(run(edit(1, "Older"), edit(2, "\n  \nKeep the header\nmore"))))
    }

    @Test
    fun `a run with no reasoning at all shows none`() {
        assertNull(runReasoningLine(run(edit(1, null), edit(2, ""))))
    }
}
