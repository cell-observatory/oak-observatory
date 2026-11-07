package com.cellobservatory.observatory.model

import com.cellobservatory.observatory.ui.PromptsPanel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `oak prompts --json` for a session it cannot list answers `{"transcript":null,"error":"…"}`. The panel
 * shows that reason, never "no prompts recorded yet" (an observation the CLI did not make) or a guess
 * that the CLI is too old. A session whose transcript is gone is listed from the local index, and the
 * panel says that is where the list came from.
 */
class PromptsReasonTest {

    @Test
    fun `the CLI's own reason is what the empty list says`() {
        val res = PromptsParser.parse("""{"transcript":null,"error":"no transcript found for this session under this directory"}""")!!
        assertEquals("no transcript found for this session under this directory", res.error)
        assertTrue(res.prompts.isEmpty())
        assertEquals(
            "No prompts to list — the oak CLI answered: no transcript found for this session under this directory",
            PromptsPanel.emptyText(res, attempted = true),
        )
        // Controls: a real empty session, and a CLI that answered nothing at all.
        val none = PromptsParser.parse("""{"session":"s1","summary":{"total":0,"withEdits":0,"edits":0},"prompts":[]}""")!!
        assertNull(none.error)
        assertEquals("No prompts recorded yet — this fills in with every prompt you send", PromptsPanel.emptyText(none, attempted = true))
        assertTrue(PromptsPanel.emptyText(null, attempted = true).startsWith("The oak CLI on PATH did not answer"))
    }

    @Test
    fun `a list read from the index carries the note that says so`() {
        val res = PromptsParser.parse(
            """{"session":"s1","fromIndex":true,"note":"the transcript is gone; these asks and answers are what the local database kept of it",
               "summary":{"total":1,"withEdits":0,"edits":0},"prompts":[{"id":"p1","index":1,"text":"Teach the zebracorn lexer","ts":1,"endTs":2}]}""",
        )!!
        assertEquals("the transcript is gone; these asks and answers are what the local database kept of it", res.note)
        assertEquals(listOf("Teach the zebracorn lexer"), res.prompts.map { it.text })
        val live = PromptsParser.parse("""{"session":"s1","note":"not from the database","summary":{"total":0,"withEdits":0,"edits":0},"prompts":[]}""")!!
        assertFalse("a note is the index's only when fromIndex says so", live.note != null)
    }
}
