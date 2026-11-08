package com.cellobservatory.observatory.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * `oak inbox --next --json` → the hand the action jumps to. The parser is the plugin's only contact
 * with the inbox, and every failure here is silent in the IDE: a keypress that does nothing.
 */
class InboxNextParserTest {

    @Test
    fun `a hand parses whole, with the shared label`() {
        val json = """{"next":"abc","hand":{"id":"abc","kind":"permission","message":"Bash","title":"Fix the build","ts":1700000000000,"waitingMs":4000}}"""
        val hand = InboxNextParser.parse(json)!!
        assertEquals("abc", hand.id)
        assertEquals("permission", hand.kind)
        assertEquals("Bash", hand.message)
        assertEquals("Fix the build", hand.title)
        assertEquals(1700000000000L, hand.ts)
        assertEquals("needs your permission", hand.label)
    }

    @Test
    fun `nobody waiting, garbage, and a missing id all read as null`() {
        assertNull(InboxNextParser.parse("""{"next":null,"hand":null}"""))
        assertNull(InboxNextParser.parse("not json"))
        assertNull(InboxNextParser.parse(""))
        assertNull(InboxNextParser.parse(null))
        assertNull(InboxNextParser.parse("""{"next":"x","hand":{"kind":"input"}}"""))
    }

    @Test
    fun `elsewhere counts the hands waiting on other machines, 0 when absent or unreadable`() {
        assertEquals(2, InboxNextParser.elsewhere("""{"next":null,"hand":null,"elsewhere":2}"""))
        assertEquals(0, InboxNextParser.elsewhere("""{"next":null,"hand":null}"""))
        assertEquals(0, InboxNextParser.elsewhere("""{"next":null,"hand":null,"elsewhere":"two"}"""))
        assertEquals(0, InboxNextParser.elsewhere("not json"))
        assertEquals(0, InboxNextParser.elsewhere(null))
    }

    @Test
    fun `the jump's message when nobody here waits mirrors core nobodyWaitingHere verbatim`() {
        // The same three strings core's test pins (packages/core/test/core.test.js).
        assertEquals("nobody is waiting on you", nobodyWaitingHere(0, "the Sessions tab"))
        assertEquals("nobody here is waiting on you · 1 on other machine: the Sessions tab lists it", nobodyWaitingHere(1, "the Sessions tab"))
        assertEquals("nobody here is waiting on you · 2 on other machines: the Sessions tab lists them", nobodyWaitingHere(2, "the Sessions tab"))
    }

    @Test
    fun `labels mirror core attentionLabel verbatim`() {
        assertEquals("has a question for you", attentionLabel("question"))
        assertEquals("needs your permission", attentionLabel("permission"))
        assertEquals("is waiting for your input", attentionLabel("input"))
        assertEquals("finished its turn", attentionLabel("idle-done"))
    }
}
