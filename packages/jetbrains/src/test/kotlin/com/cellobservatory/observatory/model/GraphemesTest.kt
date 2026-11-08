package com.cellobservatory.observatory.model

import org.junit.Assert.assertEquals
import org.junit.Test
import java.text.BreakIterator

/**
 * The plugin's own cuts end where a character does: a diff title, the deletion ghost, a feed row, an ask in a
 * confirmation, a Map label and the folder counter. `take` and `takeLast` count UTF-16 units, so a label cut through a
 * family emoji showed part of it, or half of a surrogate pair. These are the characters core's graphemes.ts is tested
 * on, cut at every length.
 */
class GraphemesTest {

    private val family = "👨\u200D👩\u200D👧\u200D👦"
    private val characters = listOf(
        family, // a family, joined by zero-width joiners
        "🇯🇵", // a flag, two regional indicators
        "👍🏽", // an emoji and its skin tone
        "👩🏽\u200D💻", // a skin tone inside a joined sequence
        "1\uFE0F\u20E3", // a keycap: the digit, a variation selector, the enclosing mark
        "e\u0301\u0302", // a letter and its combining marks
        "🏴\uDB40\uDC67\uDB40\uDC62\uDB40\uDC73\uDB40\uDC63\uDB40\uDC74\uDB40\uDC7F", // a subdivision flag and its tags
    )

    /** Where each character of [s] ends, as the JDK reads it: the indexes a cut may land on. */
    private fun ends(s: String): List<Int> {
        val bi = BreakIterator.getCharacterInstance().apply { setText(s) }
        return generateSequence(bi.first()) { bi.next().takeIf { b -> b != BreakIterator.DONE } }.toList()
    }

    @Test
    fun `each sample is one character, and the text around it four`() {
        for (c in characters) assertEquals("ab${c}cd", listOf(0, 1, 2, 2 + c.length, 3 + c.length, 4 + c.length), ends("ab${c}cd"))
    }

    @Test
    fun `a head ends where a character does, and a tail starts where one does, at every length`() {
        for (c in characters) {
            val s = "ab${c}cd$c"
            val ends = ends(s)
            for (max in 0..s.length + 1) {
                assertEquals("the head of $s at $max", s.substring(0, ends.filter { it <= max }.max()), graphemeHead(s, max))
                assertEquals("the tail of $s at $max", s.substring(ends.filter { it >= s.length - max }.min()), graphemeTail(s, max))
            }
        }
    }

    @Test
    fun `a family across a cut is left out whole, and the cut text keeps no half of a surrogate pair`() {
        val title = "x".repeat(55) + " " + family + " and a tail"
        assertEquals("x".repeat(55) + " ", graphemeHead(title, 63))
        assertEquals(" and a tail", graphemeTail(title, 15))
    }
}
