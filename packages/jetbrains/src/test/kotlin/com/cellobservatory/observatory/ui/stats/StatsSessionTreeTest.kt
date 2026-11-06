package com.cellobservatory.observatory.ui.stats

import com.intellij.openapi.util.Disposer
import com.cellobservatory.observatory.platform.ObservatoryPlatformTestCase

/**
 * A session that started agents shows its own tokens and the figure with every agent it started (`usage --json`'s
 * sessionTreeTokens), each labelled, so its own never reads as the task's; one that started none shows its own alone, as
 * the VS Code panel and the status line do. Read through the panel's own parser and the rows the strip paints.
 */
class StatsSessionTreeTest : ObservatoryPlatformTestCase() {

    /** The strip's rows for [json]: each one's caption and its cells' values. */
    private fun strip(json: String): List<Pair<String?, List<String>>> {
        val panel = StatsPanel(project)
        try {
            val usage = StatsPanel::class.java.getDeclaredMethod("parseUsage", String::class.java).apply { isAccessible = true }.invoke(panel, json)
            assertNotNull("control: the usage JSON parses", usage)
            fun get(name: String) = usage.javaClass.getDeclaredMethod(name).apply { isAccessible = true }.invoke(usage)
            val tokens = Class.forName("com.cellobservatory.observatory.ui.stats.SessionTokens")
            val strip = Class.forName("com.cellobservatory.observatory.ui.stats.TokenStrip").getDeclaredConstructor().apply { isAccessible = true }.newInstance()
            strip.javaClass.getDeclaredMethod("update", tokens, tokens).apply { isAccessible = true }
                .invoke(strip, get("getSessionTokens"), get("getSessionTreeTokens"))
            val rows = strip.javaClass.getDeclaredMethod("rows").apply { isAccessible = true }.invoke(strip) as List<*>
            return rows.map { r ->
                val (caption, cells) = r as Pair<*, *>
                caption as String? to (cells as List<*>).map { (it as Triple<*, *, *>).second as String }
            }
        } finally {
            Disposer.dispose(panel)
        }
    }

    private val own = """"sessionTokens":{"available":true,"total":1284000,"input":1200000,"output":84000,"cacheRead":41000000,"cacheCreation":0,"hitPct":97}"""

    fun testASessionThatStartedAgentsShowsItsOwnAndTheFigureWithThemEachLabelled() {
        val rows = strip("""{$own,"sessionTreeTokens":{"available":true,"agents":3,"total":3910000,"input":3600000,"output":310000,"cacheRead":96000000,"cacheCreation":0,"hitPct":96}}""")
        assertEquals(listOf("OWN" to listOf("1.2M", "84k", "41M"), "WITH 3 AGENTS" to listOf("3.6M", "310k", "96M")), rows)
    }

    fun testASessionThatStartedNoAgentsShowsItsOwnAlone() {
        val rows = strip("""{$own,"sessionTreeTokens":{"available":true,"agents":0,"total":1284000,"input":1200000,"output":84000,"cacheRead":41000000,"cacheCreation":0,"hitPct":97}}""")
        assertEquals(listOf(null to listOf("1.2M", "84k", "41M")), rows)
    }
}
