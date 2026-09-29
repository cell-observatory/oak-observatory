package com.cellobservatory.observatory.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Port-fidelity for `undo/redo --json` (core's UndoResult): the CLI adds fields additively and this
 * plugin deserializes by name with silent fallbacks — these fixtures pin every field the conflict
 * dialogs branch on, so a TS-side rename cannot silently drop the named-dependent offer.
 */
class ObservatoryCliParseTest {

    @Test
    fun `parseUndo reads the named-dependent conflict payload`() {
        val json = """{"ok":false,"status":"conflict","message":"edit #4 overlaps later work: unit #5 depends on it. Undo both with `oak undo --ids 5,4`, or --force to restore the whole file.","dependents":[5],"closure":[5,4]}"""
        val r = ObservatoryCli.parseUndo(ObservatoryCli.CliResult(1, json, ""))
        assertFalse(r.ok)
        assertTrue(r.conflict)
        assertEquals(listOf(5), r.dependents)
        assertEquals(listOf(5, 4), r.closure)
    }

    @Test
    fun `parseUndo without the additive fields answers empty lists, not nulls`() {
        val r = ObservatoryCli.parseUndo(
            ObservatoryCli.CliResult(0, """{"ok":true,"status":"undone","message":"undid edit #1"}""", "")
        )
        assertTrue(r.ok)
        assertEquals("undone", r.status)
        assertEquals(emptyList<Int>(), r.dependents)
        assertEquals(emptyList<Int>(), r.closure)
    }

    @Test
    fun `a scope payload's unrecorded report is read by name, and its absence is null`() {
        // Files an undo/redo rewrote whose status the store could not record: the toast must carry the
        // CLI's sentence (the ids and the command that records them), never a plain success.
        val message = "reverted 2 edits on disk, but the store stayed busy for 10 s, so edits #3, #4 are not recorded as reverted."
        val payload = """{"undone":2,"conflicts":0,"errors":0,"total":2,"ids":[3,4],"unrecorded":{"ids":[3,4],"commands":["oak undo --ids 3,4 --record-only --session s"],"message":"$message"}}"""
        val parse = { s: String -> com.google.gson.JsonParser.parseString(s).asJsonObject }
        assertEquals(message, ObservatoryCli.unrecordedOf(parse(payload)))
        assertEquals(null, ObservatoryCli.unrecordedOf(parse("""{"undone":1,"conflicts":0,"total":1}""")))
        assertEquals(null, ObservatoryCli.unrecordedOf(parse("""{"unrecorded":"not an object"}""")))
    }

    @Test
    fun `garbage stdout answers a structured error, never a throw`() {
        val r = ObservatoryCli.parseUndo(ObservatoryCli.CliResult(1, "not json", "boom"))
        assertFalse(r.ok)
        assertEquals("error", r.status)
        assertEquals("boom", r.message)
    }
}
