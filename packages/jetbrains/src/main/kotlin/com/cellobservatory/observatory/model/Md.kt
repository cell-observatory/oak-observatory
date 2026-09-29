package com.cellobservatory.observatory.model

/**
 * Kotlin MIRROR of core's markdown tokenizer (`mdInline`/`mdClassify`/`mdIsFence` in
 * packages/core/src/format.ts) — ONE rule, three renderers (TUI ANSI, webview HTML, these Swing
 * fragments). Keep behavior identical: the CLI's slice only — **bold**, *italic* or _italic_,
 * `code`, per-line #/## headings, dash/star/dot and "1." bullets, > quotes, ``` fences — and an
 * UNCLOSED marker stays literal (streamed chunks end mid-**bold**).
 */

data class MdSpan(val t: String, val b: Boolean = false, val i: Boolean = false, val c: Boolean = false)

sealed class MdLineKind {
    data class Heading(val depth: Int, val text: String) : MdLineKind()
    data class Bullet(val depth: Int, val text: String) : MdLineKind()
    data class Quote(val text: String) : MdLineKind()
    data class Para(val text: String) : MdLineKind()
}

object Md {
    private val H = Regex("^(#{1,6})\\s+(.*)$")
    private val B = Regex("^(\\s*)([-*•]|\\d{1,2}[.)])\\s+(.*)$")
    private val Q = Regex("^>\\s?(.*)$")
    private val FENCE = Regex("^\\s*```")

    fun isFence(line: String): Boolean = FENCE.containsMatchIn(line)

    /** A table row: starts with a pipe (after indent) and has at least one more. */
    fun isTableRow(line: String): Boolean {
        val t = line.trim()
        return t.startsWith("|") && t.indexOf('|', 1) > 0
    }

    /** The header/body divider (`|---|:--:|`): pipes, dashes, colons, spaces — nothing else. */
    fun isTableSep(line: String): Boolean {
        val t = line.trim()
        return isTableRow(line) && t.contains('-') && t.all { it == '|' || it == '-' || it == ':' || it.isWhitespace() }
    }

    /** Cell texts of one row, trimmed — for renderers building a REAL table. */
    fun tableCells(line: String): List<String> {
        var t = line.trim()
        if (t.startsWith("|")) t = t.drop(1)
        if (t.endsWith("|")) t = t.dropLast(1)
        return t.split("|").map { it.trim() }
    }

    fun classify(line: String): MdLineKind {
        H.find(line)?.let { return MdLineKind.Heading(it.groupValues[1].length, it.groupValues[2]) }
        B.find(line)?.let { return MdLineKind.Bullet(it.groupValues[1].length / 2, it.groupValues[3]) }
        Q.find(line)?.let { return MdLineKind.Quote(it.groupValues[1]) }
        return MdLineKind.Para(line)
    }

    fun inline(line: String): List<MdSpan> {
        val out = ArrayList<MdSpan>()
        var i = 0
        val plain = StringBuilder()
        fun flush() {
            if (plain.isNotEmpty()) {
                out.add(MdSpan(plain.toString()))
                plain.setLength(0)
            }
        }
        while (i < line.length) {
            val ch = line[i]
            if (ch == '`') {
                val end = line.indexOf('`', i + 1)
                if (end > i) {
                    flush()
                    out.add(MdSpan(line.substring(i + 1, end), c = true))
                    i = end + 1
                    continue
                }
            }
            if (ch == '*' && i + 1 < line.length && line[i + 1] == '*') {
                val end = line.indexOf("**", i + 2)
                if (end > i + 1) {
                    flush()
                    inline(line.substring(i + 2, end)).forEach { out.add(it.copy(b = true)) }
                    i = end + 2
                    continue
                }
            }
            if ((ch == '*' || ch == '_') && (i + 1 >= line.length || line[i + 1] != ch)) {
                val end = line.indexOf(ch, i + 1)
                if (end > i + 1 && line[i + 1] != ' ' && line[end - 1] != ' ') {
                    flush()
                    inline(line.substring(i + 1, end)).forEach { out.add(it.copy(i = true)) }
                    i = end + 1
                    continue
                }
            }
            plain.append(ch)
            i++
        }
        flush()
        return out
    }

    /** The HTML face (for the Swing `<html>` labels in the Feed): b/i/code tags, escaped;
     *  consecutive pipe rows build a real bordered table (Swing HTML renders `<table>`). */
    fun toHtml(text: String): String {
        val sb = StringBuilder()
        var fence = false
        val lines = text.split("\n")
        var li = 0
        while (li < lines.size) {
            val line = lines[li]
            if (isFence(line)) {
                fence = !fence
                sb.append("<div><small>").append(esc(line)).append("</small></div>")
                li++
                continue
            }
            if (fence) {
                sb.append("<div><code>").append(wrappable(line, true)).append("</code></div>")
                li++
                continue
            }
            if (isTableRow(line)) {
                val rows = ArrayList<String>()
                while (li < lines.size && isTableRow(lines[li])) { rows.add(lines[li]); li++ }
                val hasHead = rows.size > 1 && isTableSep(rows[1])
                sb.append("<table border=1 cellspacing=0 cellpadding=2>")
                rows.forEachIndexed { ri, row ->
                    if (isTableSep(row)) return@forEachIndexed
                    val tag = if (hasHead && ri == 0) "th" else "td"
                    sb.append("<tr>")
                    for (c in tableCells(row)) sb.append("<$tag>").append(spansHtml(c)).append("</$tag>")
                    sb.append("</tr>")
                }
                sb.append("</table>")
                continue
            }
            li++
            when (val k = classify(line)) {
                is MdLineKind.Heading -> sb.append("<div><b>").append(spansHtml(k.text)).append("</b></div>")
                is MdLineKind.Bullet -> sb.append("<div>").append("&nbsp;&nbsp;".repeat(k.depth)).append("• ").append(spansHtml(k.text)).append("</div>")
                is MdLineKind.Quote -> sb.append("<div><i>│ ").append(spansHtml(k.text)).append("</i></div>")
                is MdLineKind.Para -> sb.append(if (line.isEmpty()) "<br>" else "<div>" + spansHtml(line) + "</div>")
            }
        }
        return sb.toString()
    }

    private fun spansHtml(text: String): String {
        val sb = StringBuilder()
        for (sp in inline(text)) {
            var t = wrappable(sp.t, sp.c)
            if (sp.c) t = "<code>$t</code>"
            if (sp.b) t = "<b>$t</b>"
            if (sp.i) t = "<i>$t</i>"
            sb.append(t)
        }
        return sb.toString()
    }

    /** Swing HTML needs explicit break opportunities; a zero-width space does not lower its minimum width. */
    private fun wrappable(text: String, preserveSpaces: Boolean = false): String = buildString {
        var run = 0
        text.codePoints().forEach { cp ->
            if (Character.isWhitespace(cp) || Character.isSpaceChar(cp)) run = 0
            else if (run++ == 8) { append("<wbr>"); run = 1 }
            when {
                preserveSpaces && cp == 32 -> append("&nbsp;")
                preserveSpaces && cp == 9 -> append("&nbsp;".repeat(4))
                else -> append(esc(String(Character.toChars(cp))))
            }
        }
    }

    /** User asks are literal text, not markdown. Ordinary spaces remain word-wrap opportunities. */
    fun plainHtml(text: String): String = text.split("\n").joinToString("<br>") { wrappable(it) }

    // ECMAScript whitespace, shared with the VS Code folded-thought label (including NBSP and BOM).
    fun wordCount(text: String): Int = text.split(Regex("[\\s\\p{Z}\\uFEFF]+")).count { it.isNotEmpty() }

    private fun esc(s: String): String = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
}
