package com.cellobservatory.observatory.model

import junit.framework.TestCase

/**
 * The markdown mirror, pinned to core's contract cases (core/test/core.test.js "format: markdown
 * tokenizer …" — SAME inputs, SAME expectations). Kotlin cannot import the TS, so agreement is
 * enforced by duplicating the contract, not by sharing code: a divergence fails one side's suite.
 */
class MdTest : TestCase() {

    private fun flat(spans: List<MdSpan>): String = spans.joinToString("|") {
        (if (it.b) "b" else "") + (if (it.i) "i" else "") + (if (it.c) "c" else "") + ":" + it.t
    }

    fun testInlineContractCases() {
        assertEquals(":a |b:bold|: b", flat(Md.inline("a **bold** b")))
        assertEquals(":x |i:it|: and |i:it", flat(Md.inline("x *it* and _it_")))
        assertEquals(":run |c:oak feed|: now", flat(Md.inline("run `oak feed` now")))
        assertEquals("inline nesting recurses", "bc:code|b: bold", flat(Md.inline("**`code` bold**")))
        assertEquals("a streamed chunk mid-bold stays literal", ":**unclosed", flat(Md.inline("**unclosed")))
        assertEquals("bare asterisks in prose are not italics", ":2 * 3 * 4", flat(Md.inline("2 * 3 * 4")))
    }

    fun testClassifyContractCases() {
        assertEquals(MdLineKind.Heading(2, "Plan"), Md.classify("## Plan"))
        assertEquals(MdLineKind.Bullet(1, "item"), Md.classify("  - item"))
        assertEquals(MdLineKind.Bullet(0, "first"), Md.classify("1. first"))
        assertEquals(MdLineKind.Quote("quoted"), Md.classify("> quoted"))
        assertEquals(MdLineKind.Para("plain text"), Md.classify("plain text"))
    }

    fun testFenceContractCases() {
        assertTrue(Md.isFence("```py"))
        assertTrue(Md.isFence("  ```"))
        assertFalse(Md.isFence("a ``` b"))
    }

    fun testTableContractCases() {
        assertTrue(Md.isTableRow("| a | b |"))
        assertTrue(Md.isTableRow("  | a | b"))
        assertFalse("a mid-line pipe is a pipeline, not a table", Md.isTableRow("ls | wc -l"))
        assertTrue(Md.isTableSep("|---|:--:|"))
        assertTrue(Md.isTableSep("| --- | --- |"))
        assertFalse(Md.isTableSep("| a | b |"))
        assertEquals(listOf("a", "**b**"), Md.tableCells("| a | **b** |"))
        assertEquals(listOf("x", "y"), Md.tableCells("|x|y"))
    }

    fun testHtmlFaceBuildsRealTables() {
        val html = Md.toHtml("| h1 | h2 |\n|---|---|\n| a | `b` |")
        assertTrue(html.contains("<table"))
        assertTrue("header from the separator row", html.contains("<th>h1</th>"))
        assertTrue(html.contains("<td><code>b</code></td>"))
        assertFalse("the separator row is consumed, never rendered", html.contains("---"))
    }

    fun testHtmlFaceEscapesAndMarks() {
        // The said panes render through toHtml — markup lands as tags, content stays escaped.
        val html = Md.toHtml("**bold** & `a<b`")
        assertTrue(html.contains("<b>bold</b>"))
        assertTrue(html.contains("&amp;"))
        assertTrue(html.contains("<code>a&lt;b</code>"))
        assertFalse("raw angle brackets must never survive", html.contains("a<b"))
    }
    fun testFenceIndentationAndLongTokensSurviveHtml() {
        val token = "long-path/".repeat(40)
        val html = Md.toHtml("```\n    " + token + "\n```")
        assertTrue(html.contains("<code>&nbsp;&nbsp;&nbsp;&nbsp;"))
        assertTrue(html.contains("<wbr>"))
        assertTrue(html.replace("<wbr>", "").contains(token))
    }

    fun testWordBoundariesMatchJavaScriptIncludingNonbreakingSpaces() {
        assertEquals(4, Md.wordCount("Let\u00a0me\u202fthink\uFEFFcarefully"))
        assertEquals(0, Md.wordCount(" \t\n\u00a0"))
        assertEquals(2, Md.wordCount("字😀 café"))
    }

}
