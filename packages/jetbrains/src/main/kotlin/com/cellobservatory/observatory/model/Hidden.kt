package com.cellobservatory.observatory.model

/*
 * The characters a renderer draws as nothing that still act on the text around them: the bidirectional controls, which
 * reorder what comes after them (U+061C, U+200E, U+200F, U+202A-U+202E, U+2066-U+2069), the zero-width space and
 * no-break space, the word joiner, the invisible operators and the deprecated format characters (U+200B, U+FEFF,
 * U+2060-U+2064, U+206A-U+206F), the line and paragraph separators (U+2028, U+2029), which JavaScript reads as line
 * breaks, the soft hyphen and the Khmer inherent vowels (U+00AD, U+17B4, U+17B5), the Hangul fillers (U+115F, U+1160,
 * U+3164, U+FFA0), drawn as a blank, and the tag characters (U+E0001, U+E0020-U+E007F), which spell out text no one
 * sees, except in the flags they finish (England's, Scotland's and Wales's). In the
 * text of a file, where a reviewer who cannot see them reads code that runs differently from how it reads (Trojan
 * Source, CVE-2021-42574), each is shown as a mark that names it, `⟨U+202E⟩`, and so is a zero-width joiner or
 * non-joiner with only ASCII text beside it, where no emoji, Indic conjunct or Persian word puts one: it hides in an
 * identifier or a string, in the middle (`is⟨U+200D⟩admin` is not `isadmin`) or at the end (`isAdmin⟨U+200D⟩` is a
 * second name, which reads as the first). So is a combining grapheme joiner, a Mongolian vowel separator or a variation
 * selector there (`isAdmin⟨U+FE0F⟩` is a second name too), which Hebrew's points, Mongolian words and emoji keep, and a
 * variation selector after another one, which chooses nothing: a run of them spells out text, one byte each. The
 * classes, the rules and the mark are core's hidden.ts, which the CLI, VS Code and the terminal app use.
 */

/** The class of those characters, core's HIDDEN_SOURCE: a tag character is one unless it is in one of those flags (at
 *  most five tags back to the U+1F3F4 that starts one). The surrogates are Kotlin escapes, one backslash, so the pattern
 *  holds the characters themselves: only then does Java measure a look back in characters rather than UTF-16 units,
 *  and with regex escapes it fell short of a flag's third tag (Scotland's `s`, `c`, `t` showed as marks). */
val HIDDEN_IN_TEXT = Regex("(?:[\\u00ad\\u061c\\u115f\\u1160\\u17b4\\u17b5\\u200b\\u200e\\u200f\\u2028-\\u202e\\u2060-\\u2064\\u2066-\\u206f\\u3164\\ufeff\\uffa0]|\udb40\udc01|[\udb40\udc20-\udb40\udc7f](?<!(?=\ud83c\udff4\udb40\udc67\udb40\udc62(?:\udb40\udc65\udb40\udc6e\udb40\udc67|\udb40\udc73\udb40\udc63\udb40\udc74|\udb40\udc77\udb40\udc6c\udb40\udc73)\udb40\udc7f)\ud83c\udff4(?:[\udb40\udc20-\udb40\udc7e](?:[\udb40\udc20-\udb40\udc7e](?:[\udb40\udc20-\udb40\udc7e](?:[\udb40\udc20-\udb40\udc7e][\udb40\udc20-\udb40\udc7e]?)?)?)?)?[\udb40\udc20-\udb40\udc7f]))")

/** The zero-width joiner and non-joiner, the combining grapheme joiner, the Mongolian vowel separator and the variation
 *  selectors, which a file's text shows only where ASCII text alone is beside them. */
val JOINER_IN_TEXT = Regex("[\\u034f\\u180b-\\u180f\\u200c\\u200d\\ufe00-\\ufe0f\udb40\udd00-\udb40\uddef]")

/** A variation selector, which a file's text shows after another one too. */
private val SELECTOR_IN_TEXT = Regex("[\\u180b-\\u180d\\u180f\\ufe00-\\ufe0f\udb40\udd00-\udb40\uddef]")

/** An ASCII character, which no emoji, Indic letter or Persian word is written in. */
val ASCII_IN_TEXT = Regex("[\\u0000-\\u007f]")

/** One hidden character or joiner. A joiner is judged by the characters on either side of its run, so that two joiners
 *  in a row inside an identifier hide no better than one; the runs are gathered in revealedRuns, not by a repeated group
 *  (`(?:a|b)+`), for which Java recurses once a repetition: a run of a few thousand ran out of stack, and of tags, whose
 *  look back makes each repetition deeper, one of a thousand. */
private val HIDDEN_ONE = Regex("${HIDDEN_IN_TEXT.pattern}|${JOINER_IN_TEXT.pattern}")

/** How one of them, a code point, shows in a file's text: `⟨U+202E⟩`, or `⟨U+E0041⟩` for a tag character. */
fun hiddenMark(cp: Int): String = "⟨U+%04X⟩".format(cp)

/** A file's text with each of them shown as its mark. */
fun revealHidden(s: String): String = revealedRuns(s).joinToString("") { it.first }

/** [s] as runs of text and marks, each with whether it is a mark, for a renderer that dims the marks. */
fun revealedRuns(s: String): List<Pair<String, Boolean>> {
    val runs = ArrayList<Pair<String, Boolean>>()
    val text = StringBuilder()
    val bounds = ArrayList<IntArray>() // each run's start and end
    for (m in HIDDEN_ONE.findAll(s)) {
        val last = bounds.lastOrNull()
        if (last != null && last[1] == m.range.first) last[1] = m.range.last + 1 else bounds.add(intArrayOf(m.range.first, m.range.last + 1))
    }
    var from = 0
    for ((start, after) in bounds) {
        text.append(s, from, start)
        val before = start - 1
        // The start or end of the text counts as ASCII text: a joiner there joins nothing either.
        val joinsNothing = (before < 0 || ASCII_IN_TEXT.matches(s[before].toString())) &&
            (after >= s.length || ASCII_IN_TEXT.matches(s[after].toString()))
        // By code point: a tag character is two UTF-16 units, and one mark. A variation selector after another one, or
        // after a hidden character, chooses nothing.
        var i = start
        var prev = ""
        while (i < after) {
            val cp = s.codePointAt(i)
            val c = String(Character.toChars(cp))
            val choosesNothing = SELECTOR_IN_TEXT.matches(c) && (SELECTOR_IN_TEXT.matches(prev) || HIDDEN_IN_TEXT.matches(prev))
            if (HIDDEN_IN_TEXT.matches(c) || joinsNothing || choosesNothing) {
                if (text.isNotEmpty()) runs.add(text.toString() to false)
                text.setLength(0)
                runs.add(hiddenMark(cp) to true)
            } else text.append(c)
            prev = c
            i += Character.charCount(cp)
        }
        from = after
    }
    text.append(s, from, s.length)
    if (text.isNotEmpty() || runs.isEmpty()) runs.add(text.toString() to false)
    return runs
}
