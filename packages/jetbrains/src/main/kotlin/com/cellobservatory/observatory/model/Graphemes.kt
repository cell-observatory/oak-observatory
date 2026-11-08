package com.cellobservatory.observatory.model

import java.text.BreakIterator

/*
 * Cuts that end where a character does: a letter with its accents, an emoji with its skin tone, a keycap, a family or
 * another sequence joined by zero-width joiners, a flag. `take` and `takeLast` count UTF-16 units, so a label cut
 * through an emoji showed part of it, or half of a surrogate pair as a replacement character. The JDK's character
 * BreakIterator follows Unicode's grapheme clusters (UAX #29) on the JDK 21 this plugin runs on, as core's
 * graphemes.ts does for the CLI, VS Code and the terminal app. The two differ where a zero-width joiner after a
 * character that is not an emoji comes before one (é, a joiner, 👩), which core keeps together, and on the Hangul jamo,
 * prepended marks and spacing marks (Thai's sara am) that the JDK joins and core does not.
 */

/** `s.take(max)` ending where a character does: the longest head of [s] at most [max] UTF-16 units long. */
fun graphemeHead(s: String, max: Int): String {
    if (s.length <= max) return s
    if (max <= 0) return ""
    val it = BreakIterator.getCharacterInstance().apply { setText(s) }
    return s.substring(0, if (it.isBoundary(max)) max else it.preceding(max))
}

/** `s.takeLast(max)` starting where a character does: the longest tail of [s] at most [max] UTF-16 units long. */
fun graphemeTail(s: String, max: Int): String {
    if (s.length <= max) return s
    if (max <= 0) return ""
    val it = BreakIterator.getCharacterInstance().apply { setText(s) }
    val from = s.length - max
    return s.substring(if (it.isBoundary(from)) from else it.following(from))
}
