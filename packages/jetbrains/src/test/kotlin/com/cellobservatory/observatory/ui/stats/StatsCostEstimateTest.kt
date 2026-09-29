package com.cellobservatory.observatory.ui.stats

import com.intellij.openapi.util.Disposer
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/**
 * The Stats `$` row prices the month's tokens at list prices, and its total projects that price over the
 * whole month: both figures are estimates, so each carries `~`, as the docs say every such figure does
 * (the projected total had none). Read through the panel's own parser and the rows the
 * section paints.
 */
class StatsCostEstimateTest : BasePlatformTestCase() {

    /** The `$` row's (spent, total) for [json] on the [gpt] or Claude tab. */
    private fun dollarRow(json: String, gpt: Boolean): Pair<String, String> {
        val panel = StatsPanel(project)
        try {
            val usage = StatsPanel::class.java.getDeclaredMethod("parseUsage", String::class.java).apply { isAccessible = true }.invoke(panel, json)
            assertNotNull("control: the usage JSON parses", usage)
            val bars = Class.forName("com.cellobservatory.observatory.ui.stats.UsageBars").getDeclaredConstructor().apply { isAccessible = true }.newInstance()
            val usageClass = Class.forName("com.cellobservatory.observatory.ui.stats.Usage")
            val rows = bars.javaClass.getDeclaredMethod("rows", usageClass, Boolean::class.javaPrimitiveType).apply { isAccessible = true }
                .invoke(bars, usage, gpt) as List<*>
            fun field(row: Any, name: String) = row.javaClass.getDeclaredMethod(name).apply { isAccessible = true }.invoke(row) as String
            val row = rows.filterNotNull().first { field(it, "getLabel") == "$" }
            return field(row, "getSpent") to field(row, "getTotal")
        } finally {
            Disposer.dispose(panel)
        }
    }

    fun testTheClaudeMonthsProjectedCostIsMarkedAsAnEstimate() {
        val (spent, total) = dollarRow(
            """{"claudeAccount":{"monthTokens":1200000,"monthTokensTotal":4000000,"monthCost":18.0,"monthCostTotal":40.0}}""", gpt = false)
        assertEquals("~$18.00", spent)
        assertEquals("~$40.00", total)
    }

    fun testTheGptMonthsProjectedCostIsMarkedAsAnEstimate() {
        val (spent, total) = dollarRow(
            """{"gptWeekPct":30,"gptMonthTok":900000,"gptMonthTokTotal":3000000,"gptMonthCost":12.5,"gptMonthCostTotal":41.0}""", gpt = true)
        assertEquals("~$12.50", spent)
        assertEquals("~$41.00", total)
    }
}
