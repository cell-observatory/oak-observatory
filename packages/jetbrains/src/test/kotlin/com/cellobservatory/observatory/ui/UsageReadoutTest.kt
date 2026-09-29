package com.cellobservatory.observatory.ui

import com.intellij.openapi.util.Disposer
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import javax.swing.JLabel

/**
 * The status-bar readout's windows: `5h · wk · mo`, each `label: N% reset` — the shape the TUI and
 * VS Code draw.
 *
 * The account's per-model weekly cap (its "Fable" row) is detail, not a window of the bar:
 * the widget names it in its tooltip, as the Stats panel does, and gives it no chunk of
 * its own. The week keeps its own countdown whether or not the cap reports the same reset. These run
 * the real widget and read what a reader sees — the label's text and its tooltip — because the
 * tooltip is half of the rule and only the widget builds it.
 */
class UsageReadoutTest : BasePlatformTestCase() {

    private val day = 86_400_000L
    private val now = System.currentTimeMillis()
    private val weekReset = now + 3 * day

    private fun snap(fablePct: Double? = null, fableReset: Long? = null, fableLabel: String? = null) = UsageSnap(
        fivePct = 26.0, fiveReset = now + 3_600_000L, fiveTok = null, fiveTotal = null,
        weekPct = 77.0, weekReset = weekReset, weekTok = null, weekTotal = null,
        fablePct = fablePct, fableReset = fableReset, fableLabel = fableLabel,
        monthPct = 18.0, monthReset = now + 19 * day,
    )

    /** A provider's label once the widget has drawn [s]: its text and its tooltip, markup stripped. */
    private fun render(s: UsageSnap, field: String = "claudeLabel"): Pair<String, String> {
        val widget = ObservatoryUsageWidgetFactory().createWidget(project)
        try {
            widget.javaClass.getDeclaredMethod("apply", UsageSnap::class.java).apply { isAccessible = true }.invoke(widget, s)
            val label = widget.javaClass.getDeclaredField(field).apply { isAccessible = true }.get(widget) as JLabel
            fun plain(html: String?) = (html ?: "").replace("<br>", "\n").replace(Regex("<[^>]+>"), "")
            return plain(label.text) to plain(label.toolTipText)
        } finally {
            Disposer.dispose(widget)
        }
    }

    fun testTheCapIsNotAChunkAndTheWeekKeepsItsCountdown() {
        // The account can report the cap's reset as the week's own instant, a few seconds off it, or a
        // day away; none of them puts the cap on the bar or takes the week's countdown away.
        for (fableReset in listOf(weekReset, weekReset + 59_000L, weekReset + day)) {
            val (bar, tip) = render(snap(fablePct = 93.0, fableReset = fableReset, fableLabel = "Fable"))
            assertTrue("control: the widget drew its windows — $bar", bar.contains("5h: 26%") && bar.contains("mo: 18%"))
            assertFalse("the per-model cap is not a status-bar chunk — $bar", bar.contains("Fable") || bar.contains("93%"))
            assertTrue("the week keeps its own countdown — $bar", Regex("wk: 77% \\d+d \\d+h ·").containsMatchIn(bar))
            assertTrue(
                "the tooltip still names the cap and its reset, after the week — $tip",
                Regex("\nwk 77% · resets in \\d+d \\d+h\nFable 93% · resets in \\d+d \\d+h\nmo 18%").containsMatchIn(tip),
            )
        }
    }

    fun testTheTooltipWearsTheAccountsOwnModelName() {
        val (bar, tip) = render(snap(fablePct = 12.0, fableReset = weekReset, fableLabel = "Opus"))
        assertFalse("no chunk under the account's model name either — $bar", bar.contains("Opus"))
        assertTrue(tip, tip.contains("\nOpus 12% · resets in"))
        // …and never a blank label when the account names no model.
        assertTrue(render(snap(fablePct = 12.0, fableReset = weekReset)).second.contains("\nFable 12% · resets in"))
    }

    fun testAnAccountWithNoCapShowsTheThreeWindowsAndNoCapLine() {
        val (bar, tip) = render(snap())
        assertTrue(bar, Regex("5h: 26% .* · wk: 77% \\d+d \\d+h · mo: 18%").containsMatchIn(bar))
        assertTrue("control: the tooltip was built — $tip", tip.contains("\nwk 77% · resets in"))
        assertFalse(tip, tip.contains("Fable"))
    }

    fun testATokenOnlyGptMonthWearsTheSameLabel() {
        fun gpt(tok: Double?, total: Double?) = render(
            UsageSnap(
                fivePct = null, fiveReset = null, fiveTok = null, fiveTotal = null,
                weekPct = null, weekReset = null, weekTok = null, weekTotal = null,
                gptWeekPct = 40.0, gptWeekReset = weekReset, gptMonthTok = tok, gptMonthTokTotal = total,
            ),
            field = "gptLabel",
        ).first
        assertTrue("control: the week renders in the same shape — ${gpt(null, null)}", gpt(null, null).contains("wk: 40%"))
        assertTrue("a month with a budget is a share — ${gpt(900_000.0, 9_000_000.0)}", gpt(900_000.0, 9_000_000.0).contains("mo: 10%"))
        assertTrue("a token-only month wears the same label: — ${gpt(2_400_000.0, null)}", gpt(2_400_000.0, null).contains("mo: 2.4M"))
        assertFalse("no month is drawn when there is no count at all", gpt(null, null).contains("mo"))
    }

    fun testTheCapIsReadFromTheFlattenedAccountKeys() {
        // The widget reads TOP-LEVEL keys (`claudeAccount.fablePct` is the Stats panel's nested copy),
        // so the key names are a contract with `oak usage --json`: rename one and the tooltip loses the
        // cap with nothing to see in a log. The 5h key is the positive control — it proves the fixture
        // and the parser work, so a null cap below means a missing key, not a broken test.
        val snap = parseUsageSnap(
            """{"claudeFivePct":26,"claudeFiveReset":1789875001000,
                 "claudeWeekPct":77,"claudeWeekReset":1790031600000,
                 "claudeFablePct":93,"claudeFableReset":1790031600000,"claudeFableLabel":"Fable"}"""
        )
        assertNotNull(snap)
        assertEquals(26.0, snap!!.fivePct!!, 0.0)
        assertEquals(93.0, snap.fablePct!!, 0.0)
        assertEquals(1_790_031_600_000L, snap.fableReset!!)
        assertEquals("Fable", snap.fableLabel)
        // An account with no scoped cap answers those keys with null, and a blank label never wins.
        val plain = parseUsageSnap("""{"claudeFivePct":26,"claudeFablePct":null,"claudeFableLabel":""}""")
        assertNull(plain!!.fablePct)
        assertNull(plain.fableLabel)
        assertTrue("control: the rest of the payload still parsed", plain.fivePct != null)
    }

}
