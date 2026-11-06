package com.cellobservatory.observatory.model

import org.intellij.markdown.flavours.gfm.GFMFlavourDescriptor
import org.intellij.markdown.html.HtmlGenerator
import org.intellij.markdown.parser.MarkdownParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The setup check opens `oak doctor --markdown` in a tab, where the IDE's Markdown preview shows it. A check carries
 * text from outside OAK: a server's banner that ssh printed before its login, herdr's errors, a remote's message. Core
 * writes that text escaped, and doctor-hostile.md is core's report of such text (core's tests keep it current). Here it
 * goes through the IDE's own Markdown library, as the preview reads it: it must show as text, with no image or HTML
 * that loads anything, no link, no formatting and no heading but OAK's.
 */
class DoctorMarkdownTest {
    @Test
    fun `text from outside OAK in the setup check shows as text and loads nothing`() {
        val md = File("../core/test/fixtures/doctor-hostile.md").readText()
        val flavour = GFMFlavourDescriptor()
        val html = HtmlGenerator(md, MarkdownParser(flavour).buildMarkdownTreeFromString(md), flavour).generateHtml()
        for (made in listOf("<img", "<iframe", "<a ", "<em>", "user-del", "class=\"math\"", "<table", "<blockquote", "<li", "<pre", "<!--"))
            assertFalse("$made in $html", html.contains(made))
        assertEquals("one heading for each check: $html", 4, Regex("<h3>").findAll(html).count())
        assertEquals("and OAK's title the only other, a line of `=` under a check's heading included: $html", 1, Regex("<h1>").findAll(html).count())
        assertEquals("the two fixes are the only bold text: $html", 2, Regex("<strong>").findAll(html).count())
        assertTrue("the banner's image link reads as text: $html", html.contains("![](https://evil.example/banner.png)"))
        assertTrue("OAK's own code spans stay code: $html", html.contains("<code>oak doctor --fix</code>") && html.contains("<code>ssh me@box</code>"))
    }
}
