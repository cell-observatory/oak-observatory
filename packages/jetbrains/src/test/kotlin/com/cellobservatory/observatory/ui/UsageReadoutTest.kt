package com.cellobservatory.observatory.ui

import com.intellij.openapi.util.Disposer
import com.cellobservatory.observatory.platform.ObservatoryPlatformTestCase
import javax.swing.JLabel

/**
 * The status-bar readout's windows: `wk · mo`, each `label: N% reset` — the shape the TUI and
 * VS Code draw. No bar shows the 5-hour window, in its text or its tooltip; the Stats panel does.
 *
 * The account's per-model weekly cap (its "Fable" row) is detail, not a window of the bar:
 * the widget names it in its tooltip, as the Stats panel does, and gives it no chunk of
 * its own. The week keeps its own countdown whether or not the cap reports the same reset. These run
 * the real widget and read what a reader sees — the label's text and its tooltip — because the
 * tooltip is half of the rule and only the widget builds it.
 */
class UsageReadoutTest : ObservatoryPlatformTestCase() {

    fun testAccountUsageFreshnessReachesBothTooltips() {
        val stamp = "Usage received — build-box: 2026-11-04T12:00:00.000Z (stale; unreachable)"
        val s = parseUsageSnap("""{"claudeWeekPct":20,"gptWeekPct":20,"claudeUsageFreshness":"$stamp","gptUsageFreshness":"$stamp"}""")!!
        for (field in listOf("claudeLabel", "gptLabel")) assertTrue(render(s, field).second.contains(stamp))
    }

    private val day = 86_400_000L
    private val now = System.currentTimeMillis()
    private val weekReset = now + 3 * day

    private fun snap(fablePct: Double? = null, fableReset: Long? = null, fableLabel: String? = null) = UsageSnap(
        fivePct = 26.0,
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
            assertTrue("control: the widget drew its windows — $bar", bar.contains("wk: 77%") && bar.contains("mo: 18%"))
            assertFalse("the per-model cap is not a status-bar chunk — $bar", bar.contains("Fable") || bar.contains("93%"))
            assertFalse("nor is the 5-hour window — $bar", bar.contains("5h:") || bar.contains("26%"))
            assertFalse("nor a tooltip line — $tip", tip.contains("\n5h "))
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

    fun testTheMonthsSpendSaysItIsAnEstimateAtTodaysListPrices() {
        // On a subscription OAK prices the month's tokens itself: the figure is an estimate, written as the status line
        // writes it, against its projected budget.
        val (_, tip) = render(snap().copy(monthUsd = "~\$18", monthCostTotal = 40.0))
        assertTrue(tip, tip.contains("\nmo ~\$18 spent of ~\$40 (4 weekly cycles), estimated at today’s API list prices"))
    }

    fun testTheMonthEndsWithItsDollarFigureOnEveryPlan() {
        // `oak usage --json` as the CLI writes it: a subscription's month is an estimate (~), a plan with no rolling
        // windows shows the charge Claude Code reported (no ~), and a provider with no reading shows no figure.
        val sub = parseUsageSnap(
            """{"claudeFivePct":26,"claudeWeekPct":22,"claudeWeekReset":$weekReset,"claudeMonthPct":64,"claudeMonthReset":${now + 10 * day},
                 "claudeMonthUsd":"~${'$'}10.0k","gptWeekPct":9,"gptWeekReset":$weekReset,"gptMonthTok":900000,"gptMonthTokTotal":45000000,
                 "gptMonthReset":${now + 10 * day},"gptMonthUsd":"~${'$'}13"}"""
        )!!
        val (claude, claudeTip) = render(sub)
        assertTrue("the month's estimate follows its reset — $claude", Regex("^✳ wk: 22% \\d+d \\d+h · mo: 64% \\d+d \\d+h ~\\$10\\.0k$").matches(claude))
        assertTrue(claudeTip, claudeTip.contains("\nmo ~\$10.0k spent, estimated at today’s API list prices"))
        val (gpt, gptTip) = render(sub, field = "gptLabel")
        assertTrue("GPT's too — $gpt", Regex("^⬡ wk: 9% \\d+d \\d+h · mo: 2% \\d+d \\d+h ~\\$13$").matches(gpt))
        assertTrue(gptTip, gptTip.contains("\nmo ~\$13 spent, estimated at today’s API list prices"))
        // Pay-as-you-go: no rolling windows, so no shares; the month is what Claude Code reported, without the ~.
        val (api, apiTip) = render(parseUsageSnap("""{"claudeFivePct":null,"claudeWeekPct":null,"claudeMonthUsd":"${'$'}12"}""")!!)
        assertEquals("✳ mo: \$12", api)
        assertTrue(apiTip, apiTip.contains("\nmo \$12 spent, as Claude Code reported it"))
        assertFalse(apiTip, apiTip.contains("estimated"))
        // No reading for either provider's month dollars: the shares stand alone, with no stale or zero figure.
        val none = parseUsageSnap(
            """{"claudeWeekPct":22,"claudeWeekReset":$weekReset,"claudeMonthPct":64,"claudeMonthReset":${now + 10 * day},"claudeMonthUsd":null,
                 "gptWeekPct":9,"gptWeekReset":$weekReset,"gptMonthTok":900000,"gptMonthTokTotal":45000000,"gptMonthReset":${now + 10 * day}}"""
        )!!
        val (bare, bareTip) = render(none)
        assertTrue("control: the month is drawn — $bare", Regex("^✳ wk: 22% \\d+d \\d+h · mo: 64% \\d+d \\d+h$").matches(bare))
        assertFalse(bareTip, bareTip.contains("$"))
        val (bareGpt, bareGptTip) = render(none, field = "gptLabel")
        assertTrue("control: GPT's month is drawn — $bareGpt", Regex("^⬡ wk: 9% \\d+d \\d+h · mo: 2% \\d+d \\d+h$").matches(bareGpt))
        assertFalse(bareGptTip, bareGptTip.contains("$"))
        // And a plan with no rolling windows and no reading has nothing on the bar.
        assertEquals("", render(parseUsageSnap("""{"claudeFivePct":null,"claudeWeekPct":null}""")!!).first)
    }

    /** The Stats panel's row labels for [json]: the Claude tab's, or the GPT tab's for [gpt]. */
    private fun statsLabels(json: String, gpt: Boolean): List<String> {
        val panel = com.cellobservatory.observatory.ui.stats.StatsPanel(project)
        try {
            val usage = panel.javaClass.getDeclaredMethod("parseUsage", String::class.java).apply { isAccessible = true }.invoke(panel, json)
            assertNotNull("control: the usage JSON parses", usage)
            val bars = Class.forName("com.cellobservatory.observatory.ui.stats.UsageBars").getDeclaredConstructor().apply { isAccessible = true }.newInstance()
            val usageClass = Class.forName("com.cellobservatory.observatory.ui.stats.Usage")
            val rows = bars.javaClass.getDeclaredMethod("rows", usageClass, Boolean::class.javaPrimitiveType).apply { isAccessible = true }
                .invoke(bars, usage, gpt) as List<*>
            return rows.filterNotNull().map { it.javaClass.getDeclaredMethod("getLabel").apply { isAccessible = true }.invoke(it) as String }
        } finally {
            Disposer.dispose(panel)
        }
    }

    fun testAPlanWithAFiveHourLimitShowsItInTheStatsPanelAndOnNoBar() {
        // Claude's and GPT's plans with a 5-hour limit, a running window and an ended one (a share of 0 and no reset), as
        // `oak usage --json` reports them: the Stats panel lists each one's 5h row, and neither bar nor its tooltip
        // shows a 5h window.
        for (five in listOf("26,\"claudeFiveReset\":${now + 3_600_000L},\"gptFivePct\":40,\"gptFiveReset\":${now + 3_600_000L}",
            "0,\"claudeFiveReset\":null,\"gptFivePct\":0,\"gptFiveReset\":null")) {
            val json = """{"claudeAccount":{"rollingLimits":true,"fiveHourPct":${five.substringBefore(',')},"weekPct":22},
                 "claudeFivePct":$five,"claudeWeekPct":22,"claudeWeekReset":$weekReset,"gptWeekPct":30,"gptWeekReset":$weekReset}"""
            for (gpt in listOf(false, true)) assertTrue("the Stats panel lists the 5h row", statsLabels(json, gpt).contains("5h"))
            val snap = parseUsageSnap(json)!!
            val (claude, claudeTip) = render(snap)
            assertTrue("Claude's bar is wk alone — $claude", Regex("^✳ wk: 22% \\d+d \\d+h$").matches(claude))
            val (gpt, gptTip) = render(snap, field = "gptLabel")
            assertTrue("GPT's bar is wk alone — $gpt", Regex("^⬡ wk: 30% \\d+d \\d+h$").matches(gpt))
            for (tip in listOf(claudeTip, gptTip)) {
                assertTrue("control: the tooltip gives the week — $tip", tip.contains("\nwk "))
                assertFalse("and no 5h line — $tip", tip.contains("5h"))
            }
        }
    }

    fun testAnAccountWithNoFiveHourLimitShowsWeekAndMonth() {
        // `oak usage --json` for an account with no five-hour limit (its newest usage answer carries no 5h window, as a
        // verified Ultra account's does): no 5h share under the flat keys, and when the account said so in the account
        // block. The bar shows wk and mo, as for every plan, and the tooltip has no 5h line.
        val snap = parseUsageSnap(
            """{"claudeFivePct":null,"claudeFiveReset":null,"claudeWeekPct":22,"claudeWeekReset":$weekReset,
                 "claudeMonthPct":18,"claudeMonthReset":${now + 19 * day},"claudeAccount":{"fiveHourPct":null,"fiveNoneAt":${now - 60_000}}}"""
        )!!
        val (bar, tip) = render(snap)
        assertTrue("wk and mo — $bar", Regex("^✳ wk: 22% \\d+d \\d+h · mo: 18% \\d+d \\d+h$").matches(bar))
        assertFalse(tip, tip.contains("5h"))
        assertTrue("control: the tooltip was built — $tip", tip.contains("\nwk 22% · resets in "))
    }

    fun testAGptPlanWithNoFiveHourWindowShowsTheSameBar() {
        val (none, noneTip) = render(parseUsageSnap("""{"gptWeekPct":30,"gptWeekReset":$weekReset}""")!!, field = "gptLabel")
        assertTrue("wk — $none", Regex("^⬡ wk: 30% \\d+d \\d+h$").matches(none))
        assertFalse(noneTip, noneTip.contains("5h"))
        // A GPT reading with a 5-hour window alone has nothing for the bar, so it draws no gpt group.
        assertEquals("", render(parseUsageSnap("""{"gptFivePct":4,"gptFiveReset":${now + 3_600_000L}}""")!!, field = "gptLabel").first)
    }

    fun testAnAccountWithNoCapShowsTheTwoWindowsAndNoCapLine() {
        val (bar, tip) = render(snap())
        assertTrue(bar, Regex("^✳ wk: 77% \\d+d \\d+h · mo: 18%").containsMatchIn(bar))
        assertTrue("control: the tooltip was built — $tip", tip.contains("\nwk 77% · resets in"))
        assertFalse(tip, tip.contains("Fable"))
    }

    fun testATokenOnlyGptMonthWearsTheSameLabel() {
        fun gpt(tok: Double?, total: Double?) = render(
            UsageSnap(
                fivePct = null,
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

    fun testAMonthMeasuredAtZeroReadsZeroPercentAndAMonthNeverMeasuredHides() {
        // Both bill cycles just rolled over with nothing run since: `oak usage --json` reports Claude's month as a
        // 0% share and GPT's as a measured 0 beside its allowance. Claude's wk has nothing here, so its
        // month alone keeps its group on the bar.
        val moReset = now + 17 * day
        val rolled = parseUsageSnap(
            """{"claudeMonthPct":0,"claudeMonthReset":$moReset,"gptWeekPct":30,"gptWeekReset":$weekReset,
                 "gptMonthTok":0,"gptMonthTokTotal":4428571,"gptMonthReset":$moReset}"""
        )!!
        val (claude, claudeTip) = render(rolled)
        assertTrue("the Claude tooltip names the measured 0 — $claudeTip", claudeTip.contains("\nmo 0% · resets in "))
        assertTrue("Claude's month reads 0% — $claude", Regex("✳ mo: 0% \\d+d \\d+h").matches(claude))
        val (gpt, gptTip) = render(rolled, field = "gptLabel")
        assertTrue("GPT's month reads 0% — $gpt", Regex("⬡ wk: 30% \\d+d \\d+h · mo: 0% \\d+d \\d+h").matches(gpt))
        assertTrue("the GPT tooltip names the measured 0 — $gptTip", gptTip.contains("\nmo 0 tokens · "))
        // Never measured: no Claude share and no GPT count, so neither month is drawn and Claude has no group.
        val never = parseUsageSnap("""{"claudeMonthPct":null,"gptWeekPct":30,"gptWeekReset":$weekReset,"gptMonthTok":null}""")!!
        assertEquals("", render(never).first)
        assertTrue("control: GPT still draws its week — ${render(never, field = "gptLabel").first}", render(never, field = "gptLabel").first.contains("wk: 30%"))
        assertFalse(render(never, field = "gptLabel").first.contains("mo"))
        // A GPT count of 0 with no allowance has no share to draw either.
        assertFalse(render(parseUsageSnap("""{"gptWeekPct":30,"gptMonthTok":0}""")!!, field = "gptLabel").first.contains("mo"))
    }

    fun testASavedMachinesReadingIsNamedBesideTheIconAndInTheTooltip() {
        // Where this machine has no current share, `oak usage --json` carries a saved machine's reading of the same
        // account and names that machine: in `claudeMachineTipNote`, by the windows the tooltip shows, for the tooltip,
        // and in `claudeMachineBarNote`, by the windows the bar shows, for the bar.
        val snap = parseUsageSnap(
            """{"claudeFivePct":1,"claudeFiveReset":${now + 3_600_000L},"claudeWeekPct":22,"claudeWeekReset":$weekReset,
                 "claudeMachineNote":"build-box","claudeMachineBarNote":"build-box","claudeMachineTipNote":"build-box"}"""
        )!!
        val (bar, tip) = render(snap)
        assertTrue(bar, Regex("^✳ \\(build-box\\) wk: 22% ").containsMatchIn(bar))
        assertTrue(tip, tip.contains("\nmeasured on a saved machine signed in to the same Claude account (build-box)\n"))
        // This machine's own reading names no machine, and a blank note is none.
        val (own, ownTip) = render(parseUsageSnap("""{"claudeWeekPct":22,"claudeMachineTipNote":""}""")!!)
        assertTrue(own, own.startsWith("✳ wk: 22%"))
        assertFalse(ownTip, ownTip.contains("measured on"))
        // A machine's label is text, never markup.
        assertTrue(render(snap.copy(machineBarNote = "<b>box</b>")).first.contains("(&lt;b&gt;box&lt;/b&gt;)"))
        // With no Claude Code login here there was no account to match, and the tooltip says so instead.
        val unmatched = parseUsageSnap("""{"claudeWeekPct":22,"claudeMachineBarNote":"build-box","claudeMachineTipNote":"build-box","claudeMachineUnmatched":true}""")!!
        val (uBar, uTip) = render(unmatched)
        assertTrue(uBar, uBar.startsWith("✳ (build-box) wk: 22%"))
        assertTrue(uTip, uTip.contains("\nmeasured on a saved machine (build-box); this machine has no Claude Code login to match its account with\n"))
        assertFalse(uTip, uTip.contains("same Claude account"))
    }

    fun testTheTooltipSaysWhenTheSavedMachineMeasuredTheReading() {
        // The machine measured its week two days ago and has not answered since: the tooltip gives that time, with
        // its date, so a days-old reading does not pass for a current one.
        val measured = now - 2 * day
        val at = com.cellobservatory.observatory.ui.stats.atTime(measured)
        assertFalse("control: a time on another day carries its date — $at", Regex("^\\d\\d:\\d\\d$").matches(at))
        val snap = parseUsageSnap("""{"claudeWeekPct":22,"claudeMachineTipNote":"build-box","claudeMachineTipAt":$measured}""")!!
        val (_, tip) = render(snap)
        assertTrue(tip, tip.contains("\nmeasured on a saved machine signed in to the same Claude account (build-box) at $at\n"))
        val (_, uTip) = render(snap.copy(machineUnmatched = true))
        assertTrue(uTip, uTip.contains("\nmeasured on a saved machine (build-box) at $at; this machine has no Claude Code login to match its account with\n"))
    }

    fun testAMachineLabelShowsWithoutControlCharacters() {
        // herdr's label is whatever was typed into it: ESC, BEL and TAB, bidi controls (which reorder the text around
        // them) and zero-width characters are dropped on the bar and in the tooltip, and markup stays text.
        val label = "build\\u001b[2J\\u202e\\u200bbox\\u2066\\u2069\\u200e\\u200f\\u061c\\ufeff\\u0007\\t<b>"
        val snap = parseUsageSnap("""{"claudeWeekPct":1,"claudeMachineTipNote":"$label","claudeMachineBarNote":"$label"}""")!!
        assertEquals("control: the label reached the widget whole", "build\u001b[2J\u202e\u200bbox\u2066\u2069\u200e\u200f\u061c\ufeff\u0007\t<b>", snap.machineTipNote)
        val (bar, tip) = render(snap)
        assertTrue(bar, bar.startsWith("✳ (build[2Jbox&lt;b&gt;) wk: 1%"))
        assertTrue(tip, tip.contains("account (build[2Jbox&lt;b&gt;)\n"))
        assertFalse(
            "no control, bidi or zero-width character left — ${bar + tip}",
            Regex("[\\u0000-\\u0009\\u000b-\\u001f\\u007f\\u061c\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]").containsMatchIn(bar + tip),
        )
    }

    fun testAnEmojiFamilyInALabelKeepsItsJoiners() {
        // The zero-width joiner stays where the others go: an emoji family is built with it, and it reorders nothing.
        val family = "lab \uD83E\uDDD1\u200D\uD83D\uDCBB \uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67"
        val (bar, tip) = render(parseUsageSnap("""{"claudeWeekPct":1,"claudeMachineTipNote":"$family","claudeMachineBarNote":"$family"}""")!!)
        assertTrue(bar, bar.startsWith("✳ ($family) wk: 1%"))
        assertTrue(tip, tip.contains("account ($family)\n"))
    }

    fun testTheTooltipNamesTheMachinesTheEstimatesInclude() {
        // The estimates add what the saved machines of the account measured of their own turns: the tooltip names them
        // (`claudeMeasuredMachines`), as text, while the bar, which shows this machine's own shares, names none.
        val snap = parseUsageSnap(
            """{"claudeFivePct":11,"claudeFiveReset":${now + 3_600_000L},"claudeWeekPct":9,"claudeWeekReset":$weekReset,
                 "claudeMachineTipNote":"","claudeMachineBarNote":"","claudeMeasuredMachines":"build-box, <b>lab</b>"}"""
        )!!
        val (bar, tip) = render(snap)
        assertTrue("the bar names no machine — $bar", bar.startsWith("✳ wk: 9%"))
        assertTrue(tip, tip.contains("\nestimates include usage measured on build-box, &lt;b&gt;lab&lt;/b&gt;\n"))
        assertFalse(tip, tip.contains("measured on a saved machine"))
        val (_, own) = render(parseUsageSnap("""{"claudeWeekPct":9,"claudeMeasuredMachines":""}""")!!)
        assertFalse("control: estimates of this machine alone name none — $own", own.contains("estimates include"))
    }

    fun testTheBarNamesNoMachineForTheCapAlone() {
        // The per-model cap alone came from a saved machine: the bar, which shows no cap, names no machine (its
        // `claudeMachineBarNote` is empty), and the tooltip, which shows the cap, names the machine with its window.
        val snap = parseUsageSnap(
            """{"claudeFivePct":9,"claudeFiveReset":${now + 3_600_000L},"claudeWeekPct":30,"claudeWeekReset":$weekReset,
                 "claudeFablePct":9,"claudeFableReset":$weekReset,"claudeFableLabel":"Fable",
                 "claudeMachineNote":"build-box: fable","claudeMachineBarNote":"","claudeMachineTipNote":"build-box: fable"}"""
        )!!
        val (bar, tip) = render(snap)
        assertTrue("the bar names no machine — $bar", bar.startsWith("✳ wk: 30%"))
        assertFalse(bar, bar.contains("build-box"))
        assertTrue(tip, tip.contains("\nmeasured on a saved machine signed in to the same Claude account (build-box: fable)\n"))
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

    fun testGptAccountTotalsNameBothMachinesAndTheFallback() {
        for (machines in listOf("work-box, build-box", "this machine alone")) {
            val s = parseUsageSnap("""{"gptWeekPct":20,"gptMonthTok":10000000,"gptMonthTokTotal":88571429,
                "gptMonthUsd":"~${'$'}18","gptMeasuredMachines":"$machines"}""")!!
            val (bar, tip) = render(s, "gptLabel")
            assertTrue(bar, bar.contains("wk: 20%") && bar.contains("mo: 11%") && bar.contains("~${'$'}18"))
            assertTrue(tip, tip.contains("estimates include usage measured on $machines"))
            assertFalse(tip, tip.contains("local tokens") || tip.contains("calendar month"))
        }
    }

}
