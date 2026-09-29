package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.core.ClaudePaths
import com.intellij.openapi.Disposable
import com.intellij.openapi.util.Disposer
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.nio.file.Files

/**
 * Every tool-window panel must CONSTRUCT — that is the whole contract of createToolWindowContent,
 * and its violation is invisible to every other test (headless tool windows never build content)
 * while being TOTAL in the IDE. The 2026-08-20 field failure: an init-order NPE in EditsTreePanel
 * (properties declared BELOW the init block that used them) killed the Traces window, and — because
 * the half-built panel had already registered its refresh listener — threw on every later service
 * tick, aborting the listener fan-out and starving every later-registered panel of repaints: the
 * whole product blank, "none of the windows show any info". Logger.error also throws under the test
 * framework, so a construction-time "Cannot add null action" fails here even where the production
 * IDE would log-and-limp.
 */
class PanelConstructionTest : BasePlatformTestCase() {

    private lateinit var cfg: java.nio.file.Path

    override fun setUp() {
        super.setUp()
        cfg = Files.createTempDirectory("obs-panels-cfg")
        ClaudePaths.configDirOverride = cfg
    }

    override fun tearDown() {
        try {
            ClaudePaths.configDirOverride = null
            cfg.toFile().deleteRecursively()
        } finally {
            super.tearDown()
        }
    }

    fun testEveryToolWindowPanelConstructs() {
        val panels: List<Pair<String, () -> Any>> = listOf(
            "Review (Traces)" to { com.cellobservatory.observatory.ui.ReviewPanel(project) },
            "File History (Traces)" to { com.cellobservatory.observatory.ui.FileHistoryPanel(project) },
            "Timeline" to { com.cellobservatory.observatory.ui.TimelinePanel(project) },
            // The Feed tab is a LazyPane inside the Timeline, which a headless window never realizes —
            // so its panel is constructed directly here, or a construction-order bug ships blank.
            "Feed (Timeline)" to { com.cellobservatory.observatory.ui.FeedPanel(project) },
            "Overview (Dashboards)" to { com.cellobservatory.observatory.ui.ChangeMapPanel(project) },
            "Stats (Dashboards)" to { com.cellobservatory.observatory.ui.stats.StatsPanel(project) },
        )
        for ((name, make) in panels) {
            val p = try {
                make()
            } catch (e: Throwable) {
                throw AssertionError("$name failed to construct — its tool window is BLANK in the IDE", e)
            }
            if (p is Disposable) Disposer.dispose(p)
        }
    }
}
