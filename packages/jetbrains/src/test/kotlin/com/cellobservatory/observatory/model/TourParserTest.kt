package com.cellobservatory.observatory.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Parity pin for [TourParser] — the guided tour's script is core's, delivered over
 * `demo --tour --json`, and this plugin must render exactly what it is handed.
 *
 * The cases that matter are the tolerant ones. A newer CLI will name views and anchors this plugin
 * build has never heard of, and the correct response is to carry the text through and activate nothing,
 * never to drop the step or throw: a tour that silently loses a step is worse than one that shows a step
 * it cannot highlight.
 */
class TourParserTest {

    @Test
    fun `parses the shape core emits`() {
        val json = """
            {"steps":[
              {"id":"welcome","title":"A simulated session","body":"Nothing here called a model.",
               "view":"overview","tab":"sessions","tip":"The demo session.","anchor":"session-label",
               "tryIt":"Leave with Exit Demo."},
              {"id":"prompts","title":"Prompts","body":"One row per ask.","view":"prompts"}
            ]}
        """.trimIndent()
        val steps = TourParser.parse(json)
        assertEquals(2, steps.size)
        val first = steps[0]
        assertEquals("welcome", first.id)
        assertEquals("A simulated session", first.title)
        assertEquals("overview", first.view)
        assertEquals("sessions", first.tab)
        assertEquals("session-label", first.anchor)
        assertEquals("Leave with Exit Demo.", first.tryIt)
        // The optional fields are honestly absent rather than blank — a renderer hides them on null.
        assertNull(steps[1].tab)
        assertNull(steps[1].tip)
        assertNull(steps[1].anchor)
        assertNull(steps[1].tryIt)
    }

    @Test
    fun `parses an action, and carries an unknown one through rather than dropping the step`() {
        val json = """
            {"steps":[
              {"id":"a","title":"Wait","body":"a body long enough to be real","view":"edits",
               "action":{"mode":"wait","kind":"keep-edit","hint":"Keep one edit."}},
              {"id":"b","title":"Auto","body":"a body long enough to be real","view":"edits",
               "action":{"mode":"auto","kind":"keep-task","hint":"Accepting a task.","done":"Accepted a task."}},
              {"id":"c","title":"Plain","body":"a body long enough to be real","view":"edits"},
              {"id":"d","title":"Future","body":"a body long enough to be real","view":"edits",
               "action":{"mode":"teleport","kind":"rewrite-history","hint":"Something newer."}}
            ]}
        """.trimIndent()
        val steps = TourParser.parse(json)
        assertEquals(4, steps.size)
        assertEquals("wait", steps[0].action?.mode)
        assertEquals("keep-edit", steps[0].action?.kind)
        assertNull(steps[0].action?.done)
        assertEquals("auto", steps[1].action?.mode)
        assertEquals("Accepted a task.", steps[1].action?.done)
        assertNull("a step that only reads has no action", steps[2].action)
        // A mode this build has never heard of must still READ — and the renderer treats anything that
        // is not `auto` as a wait with no watcher, so an unknown value can never make the plugin
        // execute something.
        assertEquals("teleport", steps[3].action?.mode)
        assertEquals("Something newer.", steps[3].action?.hint)
    }

    @Test
    fun `an unknown view or anchor still yields a readable step`() {
        val json = """
            {"steps":[{"id":"future","title":"A panel from a newer CLI","body":"Still worth reading.",
                       "view":"holodeck","anchor":"warp-core","tip":"Look here."}]}
        """.trimIndent()
        val steps = TourParser.parse(json)
        assertEquals(1, steps.size)
        assertEquals("holodeck", steps[0].view)
        assertEquals("warp-core", steps[0].anchor)
        assertEquals("Still worth reading.", steps[0].body)
    }

    @Test
    fun `unusable payloads yield an empty tour rather than a broken one`() {
        // An older CLI that does not know --tour, a failed spawn, and a well-formed payload with a
        // nameless step: none of them may produce a half-rendered tour.
        assertTrue(TourParser.parse("").isEmpty())
        assertTrue(TourParser.parse("not json at all").isEmpty())
        assertTrue(TourParser.parse("""{"error":"unknown flag"}""").isEmpty())
        assertTrue(TourParser.parse("""{"steps":[{"body":"no id, no title"}]}""").isEmpty())
    }
}

/**
 * The session id a streamed replay reports. The plugin takes it from the run's own narration rather
 * than picking one out of the store, so it never has to assume an ordering — and the sibling agent's
 * id is deliberately not printed, so there is exactly one candidate.
 */
class DemoSessionFromTest {
    @Test
    fun `takes the id from the run's final line`() {
        val out = """
            ▸ prompt 1 — asking Claude to extend the training pipeline
            ▸ task 1 — feature scaling (2 edits)
            ✔ demo session demo-1a2b3c4d — 9 captured edits across 21 beats (+ a sibling agent on demo/hotfix)
        """.trimIndent()
        assertEquals("demo-1a2b3c4d", com.cellobservatory.observatory.core.ObservatoryCli.demoSessionFrom(out))
    }

    @Test
    fun `reports nothing rather than guessing when the run printed no id`() {
        assertNull(com.cellobservatory.observatory.core.ObservatoryCli.demoSessionFrom(""))
        assertNull(com.cellobservatory.observatory.core.ObservatoryCli.demoSessionFrom("▸ prompt 1 — asking Claude"))
        // A real session id must never be mistaken for a demo one — that gate is what protects real work.
        assertNull(com.cellobservatory.observatory.core.ObservatoryCli.demoSessionFrom("session 11111111-2222-3333-4444-555555555555"))
    }
}

/**
 * The tab-name contract between core's tour script and this plugin's Overview.
 *
 * The activation itself is Swing and needs a platform fixture to drive, so it is not unit-tested here —
 * what IS tested is the thing that broke before: agreement on the NAMES. A tour step naming a tab this
 * panel cannot bring forward does not throw and does not fail a build; it just leaves the reader looking
 * at whatever tab was already open while the text describes another one.
 */
class TourTabContractTest {
    @Test
    fun `the panel maps exactly the five shipped Overview tabs`() {
        assertEquals(
            listOf("sessions", "fleet", "workflows", "tasks", "processes"),
            com.cellobservatory.observatory.ui.ChangeMapPanel.TOUR_TABS,
        )
    }

    @Test
    fun `every tab a tour step names is one the panel maps`() {
        // The shape core emits, with one step per tab (core's own test asserts the real script covers
        // all five; this asserts the plugin can act on each of them).
        val json = com.cellobservatory.observatory.ui.ChangeMapPanel.TOUR_TABS.joinToString(",") {
            """{"id":"$it","title":"$it","body":"a body long enough to be real","view":"overview","tab":"$it"}"""
        }
        val steps = TourParser.parse("""{"steps":[$json]}""")
        assertEquals(5, steps.size)
        for (s in steps) {
            assertTrue(
                "the tour names a tab the Overview cannot bring forward: ${s.tab}",
                s.tab in com.cellobservatory.observatory.ui.ChangeMapPanel.TOUR_TABS,
            )
        }
    }
}

/**
 * The anchor-name contract between core's tour script and this plugin's panels.
 *
 * The editors BROADCAST an anchor to every tour-aware panel and each rings it only if its own map knows
 * the name — so a name owned by two panels would ring two things, and a name owned by none rings nothing
 * while the step's text still points at it. Neither failure throws, neither fails a build, and both read
 * to a user as "the tour is broken", which is why the agreement is pinned here rather than assumed.
 */
class TourAnchorContractTest {
    /** The names each panel claims, mirroring their `tourAnchor` maps. */
    private val overview = setOf("nav-tabs", "folders-strip", "files-ledger", "summary-bar", "nav-axes", "accept-prompt", "session-label", "spotlight")
    private val stats = setOf("stats-model", "stats-compaction", "stats-tokens", "stats-cache", "stats-usage", "stats-review")
    // "session-picker" is claimed by PromptsPanel, which since 0.10.0 answers with a real component: the
    // selector moved off the platform's tool-window header into the Timeline content, and PromptsPanel
    // resolves it through its host (TimelineWindowTest asserts the two are the same component). The name
    // stays claimed by exactly one panel so no other starts answering for it.
    private val prompts = setOf("prompts-list", "session-picker")
    // The tour routes the feed view to FeedPanel; the id matches core and the tab strip.
    private val feed = setOf("feed")

    @Test
    fun `no anchor name is claimed by two panels`() {
        val all = overview.toList() + stats.toList() + prompts.toList() + feed.toList()
        assertEquals("every anchor belongs to exactly one panel", all.size, all.toSet().size)
    }

    @Test
    fun `every anchor a step names is claimed by some panel`() {
        val claimed = overview + stats + prompts + feed
        val json = claimed.joinToString(",") {
            """{"id":"$it","title":"$it","body":"a body long enough to be real","view":"stats","anchor":"$it"}"""
        }
        val steps = TourParser.parse("""{"steps":[$json]}""")
        assertEquals(claimed.size, steps.size)
        for (s in steps) {
            assertTrue("the tour names an anchor no panel can ring: ${s.anchor}", s.anchor in claimed)
        }
    }
}
