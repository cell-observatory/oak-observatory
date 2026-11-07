package com.cellobservatory.observatory.model

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * A Trojan Source line in a file's text: a right-to-left override and isolates make a check read as part of a comment,
 * and a zero-width space hides in a name. Each shows as the mark that names it, as core's revealHidden shows it for the
 * CLI, VS Code and the terminal app.
 */
class HiddenTest {
    private val evil = "    /*\u202e } \u2066if (isAdmin)\u2069 \u2066 begin admins only */ ok\u200bname"

    companion object {
        /** U+1F3F4, [text] spelled in tag characters, and the cancel tag: Scotland's flag for `gbsct`. */
        fun tagFlag(text: String): String =
            "\uD83C\uDFF4" + text.map { String(Character.toChars(0xE0000 + it.code)) }.joinToString("") + "\uDB40\uDC7F"

        /** What looks like a hidden character and is read: England's, Scotland's and Wales's flags, emoji, Hangul
         *  syllables and jamo, and a variation selector (U+E0100, after an ideograph). */
        val KEPT = listOf(
            "go ${tagFlag("gbsct")} team", tagFlag("gbeng") + tagFlag("gbsct") + tagFlag("gbwls"),
            "\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67", "\uD83D\uDC4D\uD83C\uDFFD", "\u2764\ufe0f", "1\ufe0f\u20e3",
            "\uD83C\uDDEF\uD83C\uDDF5", "\ud55c\uad6d\uc5b4", "\u1112\u1161\u11ab\u1100\u1173\u11af", "\u3131\u314f", "\u8fba\uDB40\uDD00",
            "\uD83C\uDFF3\ufe0f\u200d\uD83C\uDF08", "\u05d9\u05b0\u05e8\u05d5\u05bc\u05e9\u05c1\u05b8\u05dc\u05b7\u034f\u05b4\u05dd",
            "\u182c\u1820\u1837\u180e\u1820", "\u182d\u180b\u1820")
    }

    @Test
    fun `each hidden character shows as the mark that names it`() {
        assertEquals("    /*⟨U+202E⟩ } ⟨U+2066⟩if (isAdmin)⟨U+2069⟩ ⟨U+2066⟩ begin admins only */ ok⟨U+200B⟩name", revealHidden(evil))
        val all = "\u061c\u200b\u200e\u200f\u2028\u2029\u202a\u202b\u202c\u202d\u202e\u2060\u2061\u2062\u2063\u2064\u2066\u2067\u2068\u2069\u206a\u206b\u206c\u206d\u206e\u206f\ufeff"
        assertEquals(all.map { "⟨U+%04X⟩".format(it.code) }.joinToString(""), revealHidden(all))
        assertEquals("control: what a reader sees stays", "é 中 ab", revealHidden("é 中 ab"))
    }

    @Test
    fun `a joiner with only ASCII text beside it shows, and one in an emoji, an Indic conjunct or a Persian word does not`() {
        assertEquals("is⟨U+200D⟩admin foo⟨U+200C⟩bar a⟨U+200D⟩1", revealHidden("is\u200Dadmin foo\u200Cbar a\u200D1"))
        assertEquals("two in a row hide no better than one", "a⟨U+200D⟩⟨U+200D⟩b", revealHidden("a\u200D\u200Db"))
        // At the end of a name too, where JavaScript reads `isAdmin` and a joiner as a second name, and at the text's edge.
        assertEquals("let isAdmin⟨U+200D⟩ = true; role == \"admin⟨U+200C⟩\"", revealHidden("let isAdmin\u200D = true; role == \"admin\u200C\""))
        assertEquals("a⟨U+200D⟩ ⟨U+200D⟩b", revealHidden("a\u200D \u200Db"))
        assertEquals("a⟨U+200D⟩", revealHidden("a\u200D"))
        assertEquals("⟨U+200C⟩b", revealHidden("\u200Cb"))
        for (built in listOf("\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67", "\u0915\u094D\u200D\u0937", "\u06A9\u062A\u0627\u0628\u200C\u0647\u0627", "PDF\u200C\u0647\u0627", "\u00E9\u200D\u00E9", "x = \"\uD83D\uDC68\u200D\""))
            assertEquals("${built.map { "%04X".format(it.code) }} keeps its joiners", built, revealHidden(built))
        assertEquals(listOf("is" to false, "⟨U+200D⟩" to true, "admin" to false), revealedRuns("is\u200Dadmin"))
    }

    @Test
    fun `the soft hyphen, the Hangul fillers and stray tag characters show, and a flag, emoji and Hangul stay`() {
        // A tag character is two UTF-16 units and one mark; the tags that finish a flag (Scotland's) are not marks.
        val more = listOf("\u00ad", "\u17b4", "\u115f", "\u1160", "\u17b5", "\u3164", "\uffa0",
            "\uDB40\uDC01", "\uDB40\uDC20", "\uDB40\uDC41", "\uDB40\uDC67", "\uDB40\uDC7E", "\uDB40\uDC7F")
        for (c in more) assertEquals("a${hiddenMark(c.codePointAt(0))}b", revealHidden("a${c}b"))
        assertEquals(more.joinToString("") { "⟨U+%04X⟩".format(it.codePointAt(0)) }, revealHidden(more.joinToString("")))
        assertEquals("⟨U+E0041⟩", hiddenMark(0xE0041))
        assertEquals(listOf("a" to false, "⟨U+E0041⟩" to true, "b" to false), revealedRuns("a\uDB40\uDC41b"))
        val scotland = "\uD83C\uDFF4\uDB40\uDC67\uDB40\uDC62\uDB40\uDC73\uDB40\uDC63\uDB40\uDC74\uDB40\uDC7F"
        assertEquals("$scotland⟨U+E0041⟩", revealHidden("$scotland\uDB40\uDC41"))
        assertEquals("a flag's tags with no end show", "\uD83C\uDFF4⟨U+E0067⟩⟨U+E0062⟩!", revealHidden("\uD83C\uDFF4\uDB40\uDC67\uDB40\uDC62!"))
        // After U+1F3F4 any other tags draw a black flag, the words they spell hidden behind it.
        for (text in listOf("ignore the user", "usca", "gbsctx")) {
            val wrapped = tagFlag(text)
            val shown = wrapped.codePoints().toArray().joinToString("") { if (it >= 0xE0000) hiddenMark(it) else String(Character.toChars(it)) }
            assertEquals(text, shown, revealHidden(wrapped))
        }
        for (kept in KEPT) assertEquals("${kept.codePoints().toArray().map { "%04X".format(it) }} stays", kept, revealHidden(kept))
    }

    @Test
    fun `a variation selector, a combining grapheme joiner or a vowel separator after a name shows, and a run of selectors from its second`() {
        // After an ASCII name each is a second name (`isAdmin` and a variation selector is not `isAdmin`); and a selector
        // after another one chooses nothing, so a run of them, which spells out text one byte each, shows from its second.
        for (c in listOf("\ufe0f", "\uDB40\uDD00", "\u180b", "\u034f", "\u180e"))
            assertEquals("if (isAdmin${hiddenMark(c.codePointAt(0))}) grant();", revealHidden("if (isAdmin$c) grant();"))
        val bytes = "hide".map { String(Character.toChars(0xE0100 + it.code - 16)) }
        assertEquals("\uD83D\uDE00" + bytes[0] + bytes.drop(1).joinToString("") { hiddenMark(it.codePointAt(0)) }, revealHidden("\uD83D\uDE00" + bytes.joinToString("")))
        assertEquals("\u2764\ufe0f⟨U+FE0F⟩", revealHidden("\u2764\ufe0f\ufe0f"))
    }

    /** Each tag looks back five tags at most for the U+1F3F4 of a flag (looking back over the whole run, Java took 2.7 s
     *  over 16,000 tags in a row), and the run is gathered without the recursion Java gives a repeated group, which ran
     *  out of stack at a thousand. Nothing is timed but the limit, which only that look back reaches. */
    @Test(timeout = 30_000)
    fun `a long run of tag characters is read in one pass`() {
        val run = "a" + "\uDB40\uDC61".repeat(200_000) + "b"
        assertEquals(2 + 200_000 * "⟨U+E0061⟩".length, revealHidden(run).length)
    }

    @Test
    fun `the runs a renderer dims are the marks`() {
        assertEquals(listOf("if (ok" to false, "⟨U+202E⟩" to true, ") {} // " to false, "⟨U+200B⟩" to true, "note" to false),
            revealedRuns("if (ok\u202e) {} // \u200bnote"))
        assertEquals(listOf("plain" to false), revealedRuns("plain"))
        assertEquals(listOf("" to false), revealedRuns(""))
    }
}
