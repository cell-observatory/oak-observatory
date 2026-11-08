package com.cellobservatory.observatory.ui.inline

import com.cellobservatory.observatory.model.Deletion
import com.cellobservatory.observatory.model.Placement
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The deletion ghost's two pure rules.
 *
 * [ghostLabel] must stay byte-identical to the VS Code `ghostText`: the same removed hunk is shown in both
 * editors, and a one-character difference in the truncation boundary is the kind of drift nothing else
 * would ever report. Its rule is "truncate only when the head EXCEEDS 60 characters, then yield 60" —
 * stated as ">60" it is easy to implement as ">=60", so both sides of the boundary are pinned here rather
 * than sampled.
 *
 * [anchorLines] is the fallback that keeps a deletion-only edit reachable at the code.
 */
class GhostLabelTest {

    @Test
    fun `a single removed line is shown whole, with no tail`() {
        assertEquals("− const x = 1;", ghostLabel(listOf("const x = 1;")))
    }

    @Test
    fun `leading whitespace is trimmed away`() {
        assertEquals("− return None", ghostLabel(listOf("        return None")))
    }

    @Test
    fun `a head of exactly 60 characters is NOT truncated`() {
        val head = "a".repeat(60)
        assertEquals("− $head", ghostLabel(listOf(head)))
    }

    @Test
    fun `a head of 61 characters becomes 59 characters plus an ellipsis — 60 in total`() {
        val label = ghostLabel(listOf("b".repeat(61)))
        assertEquals("− " + "b".repeat(59) + "…", label)
        // The shown part is 60 characters: 59 + '…'. The "− " prefix is not part of the removed text.
        assertEquals(60, label.removePrefix("− ").length)
    }

    @Test
    fun `the cut ends where a character does, on the same lines VS Code's ghostText is tested on`() {
        val fam = "\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67\u200D\uD83D\uDC66"
        assertEquals("− " + "c".repeat(52) + "…", ghostLabel(listOf("c".repeat(52) + fam + "d".repeat(20))))
        assertEquals("− " + "c".repeat(48) + fam + "…", ghostLabel(listOf("c".repeat(48) + fam + "d".repeat(20))))
        assertEquals("− " + "e".repeat(58) + "… …(+1)", ghostLabel(listOf("e".repeat(58) + "\uD83C\uDDEF\uD83C\uDDF5" + "f".repeat(9), "second")))
    }

    @Test
    fun `a hidden character shows as the mark that names it, after the cut, on the lines VS Code's ghostText is tested on`() {
        assertEquals("− if (a⟨U+202E⟩) {}", ghostLabel(listOf("if (a\u202E) {}")))
        assertEquals("a mark is never cut", "− " + "a".repeat(58) + "⟨U+202E⟩…", ghostLabel(listOf("a".repeat(58) + "\u202E" + "b".repeat(10))))
        assertEquals("a joiner inside an identifier shows", "− if (is⟨U+200D⟩admin) {}", ghostLabel(listOf("if (is\u200Dadmin) {}")))
        val family = "\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67"
        assertEquals("and an emoji family keeps its joiners", "− f = \"$family\"", ghostLabel(listOf("f = \"$family\"")))
    }

    @Test
    fun `a multi-line hunk names the head and counts the rest`() {
        assertEquals("− head …(+2)", ghostLabel(listOf("head", "second", "third")))
    }

    @Test
    fun `a hunk whose first lines are blank leads with the first line that is not`() {
        // The blank lines still COUNT toward the tail — the hunk removed four lines, not two.
        assertEquals("− real content …(+3)", ghostLabel(listOf("", "   ", "real content", "trailing")))
    }

    @Test
    fun `anchorLines prefers the added lines and drops any past the end of the buffer`() {
        val p = Placement(1, listOf(2, 3, 99), listOf(Deletion(7, listOf("gone"))))
        assertEquals(listOf(2, 3), anchorLines(p, lineCount = 10))
    }

    @Test
    fun `anchorLines falls back to the deletion anchors for a pure deletion, clamped to the last line`() {
        val p = Placement(2, emptyList(), listOf(Deletion(4, listOf("gone")), Deletion(999, listOf("also gone"))))
        assertEquals(listOf(4, 9), anchorLines(p, lineCount = 10))
    }

    @Test
    fun `anchorLines is empty when an edit left nothing in the buffer at all`() {
        assertEquals(emptyList<Int>(), anchorLines(Placement(3, emptyList(), emptyList()), lineCount = 10))
    }
}
