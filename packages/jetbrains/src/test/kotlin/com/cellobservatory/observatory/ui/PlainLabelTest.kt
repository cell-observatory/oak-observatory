package com.cellobservatory.observatory.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/** A saved machine's herdr label, which someone else typed, shows without the characters that drive the terminal,
 *  reorder the text around them or hide in it, as core's plainLabel shows it for the CLI, VS Code and the terminal
 *  app. The zero-width joiner (an emoji family) and non-joiner (a Persian or Indic word) stay. */
class PlainLabelTest {
    @Test
    fun `a label drops controls, bidirectional controls and zero-width characters, and keeps what a reader reads`() {
        assertEquals("build-box", plainLabel("build\u001b\u0007\t\u061c\u200b\u200e\u200f\u2028\u2029\u202a\u202b\u202c\u202d\u202e\u2060\u2061\u2062\u2063\u2064\u2066\u2067\u2068\u2069\u206a\u206b\u206c\u206d\u206e\u206f\ufeff-box"))
        val persian = "\u06a9\u062a\u0627\u0628\u200c\u0647\u0627"
        val family = "\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67"
        assertEquals("lab $persian $family é 中", plainLabel("lab $persian $family é 中"))
        // The soft hyphen, the Khmer inherent vowels, the Hangul fillers and tag characters that finish no flag go too; a
        // flag, an emoji, Hangul, a variation selector and Hebrew and Mongolian written with their joiners stay.
        assertEquals("build-box", plainLabel("build\u00ad\u17b4\u115f\u1160\u17b5\u3164\uffa0\uDB40\uDC01\uDB40\uDC20\uDB40\uDC41\uDB40\uDC7F-box"))
        for (kept in com.cellobservatory.observatory.model.HiddenTest.KEPT) assertEquals(kept, plainLabel(kept))
    }
}
