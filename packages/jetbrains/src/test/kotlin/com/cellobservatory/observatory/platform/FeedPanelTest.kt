package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.ui.FeedPanel
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.nio.file.Files

/**
 * The Feed tab's SUBJECT rules — the piece a construction test cannot see.
 *
 * The tab follows the Overview's published selection ([ObservatoryService.selectedFeed]) and falls
 * back to the reviewed session's own feed when nothing is picked. Two rules are pinned here because
 * both fail silently in the IDE (the tab just shows the wrong thing's activity):
 *   · a pick made under ANOTHER session is DROPPED on refresh — a session switch must not leave the
 *     Feed tab tailing the old session's worker;
 *   · a session-KIND pick survives, because a fleet row IS a session of its own and switching TO it
 *     is exactly what the pick asked for.
 */
class FeedPanelTest : BasePlatformTestCase() {

    private lateinit var cfg: java.nio.file.Path

    override fun setUp() {
        super.setUp()
        cfg = Files.createTempDirectory("obs-feed-cfg")
        ClaudePaths.configDirOverride = cfg
    }

    override fun tearDown() {
        try {
            ObservatoryService.getInstance(project).selectedPromptId = null
            ObservatoryService.getInstance(project).takeResponseJump()
            ClaudePaths.configDirOverride = null
            cfg.toFile().deleteRecursively()
        } finally {
            super.tearDown()
        }
    }

    fun testAStalePickFromAnotherSessionIsDropped() {
        val svc = ObservatoryService.getInstance(project)
        // POSITIVE CONTROL first: the published pick is visible before the panel looks at it — so the
        // "dropped" assertion below measures the panel's rule, not a setter that never stored anything.
        svc.selectedFeed = ObservatoryService.FeedSel(
            ObservatoryService.FeedRef("someOtherSession", "agent", "sub1"),
            forSession = "someOtherSession",
        )
        assertNotNull("control: the pick was published", svc.selectedFeed)
        // Constructing the panel runs its first refresh. This fixture has no reviewed session, so the
        // pick's forSession cannot match — the panel must drop it rather than tail the wrong session.
        FeedPanel(project)
        assertNull("a pick made under another session is dropped on refresh", svc.selectedFeed)
    }

    fun testASessionKindPickSurvivesTheSessionCheck() {
        val svc = ObservatoryService.getInstance(project)
        svc.selectedFeed = ObservatoryService.FeedSel(
            ObservatoryService.FeedRef("siblingWorktreeSession", "session", ""),
            forSession = "someOtherSession",
        )
        FeedPanel(project)
        assertNotNull("a session-kind pick survives — a fleet row IS a session of its own", svc.selectedFeed)
        svc.selectedFeed = null
    }

    /** The agent's own words as rows (2026-09-23): a reply renders whole, a thought folds by default. */
    fun testAReplyRendersWholeAndAThoughtFoldsByDefault() {
        val words = "First\u00a0line of the answer\nsecond line with **bold** words"
        fun texts(entry: com.cellobservatory.observatory.model.FeedEntry, toggled: Boolean): List<String> {
            val renderer = com.cellobservatory.observatory.ui.FeedBlobRenderer { !toggled }
            val row = FeedPanel.Registry.Row(entry, "1:0", true)
            val comp = renderer.getListCellRendererComponent(com.intellij.ui.components.JBList<FeedPanel.Registry.Row>(), row, 0, false, false) as java.awt.Container
            return comp.components.map { it.toString() }
        }
        fun entry(kind: String) = com.cellobservatory.observatory.model.FeedEntry(
            ts = 1L, kind = "reasoning", label = if (kind == "thinking") "thinking" else "said", target = null, detail = null, ok = null,
            category = null, note = null, reasoning = words, reasoningKind = kind, promptText = null, cmd = null, editId = null, previewId = null,
        )
        val said = texts(entry("text"), toggled = false)
        assertTrue("a reply opens by default: its head says so", said.first().contains("said"))
        assertTrue("and every line of the reply is a row of its own", said.any { it.contains("First\u00a0line of the answer") } && said.any { it.contains("second line with") })
        val thought = texts(entry("thinking"), toggled = false)
        assertEquals("a thought is folded by default: the head row alone", 1, thought.size)
        assertTrue("with a word count instead of clipped prose", thought.first().contains("10 words"))
        val opened = texts(entry("thinking"), toggled = true)
        assertTrue("the toggle unfolds the whole thought", opened.size > 1 && opened.any { it.contains("second line with") })
    }

    private fun feed(json: String) = com.cellobservatory.observatory.model.FeedParser.parse(json)!!
    private fun update(panel: FeedPanel, value: com.cellobservatory.observatory.model.Feed) {
        FeedPanel::class.java.getDeclaredMethod("update", com.cellobservatory.observatory.model.Feed::class.java).apply { isAccessible = true }.invoke(panel, value)
    }
    private fun rows(panel: FeedPanel): javax.swing.DefaultListModel<*> =
        FeedPanel::class.java.getDeclaredField("model").apply { isAccessible = true }.get(panel) as javax.swing.DefaultListModel<*>

    /** No diff is built on the EDT. update() runs on every refresh tick, and reading the log and two
     *  blobs per edit there cost 308 ms of EDT time for 40 edits: the fetch builds them, off the EDT. */
    fun testRowDiffsArriveWithThePayloadAndUpdateReadsNoStore() {
        val svc = ObservatoryService.getInstance(project)
        val s = "fixture-session"
        svc.demoSessionOverride = s
        try {
            val before = "a".repeat(64)
            val after = "b".repeat(64)
            Files.createDirectories(ClaudePaths.storeDir(s).resolve("blobs"))
            Files.writeString(ClaudePaths.blobPath(s, before), "old line\n")
            Files.writeString(ClaudePaths.blobPath(s, after), "new line\n")
            Files.writeString(
                ClaudePaths.storeDir(s).resolve("log.jsonl"),
                """{"id":7,"ts":1000,"tool":"Edit","file":"/w/a.txt","beforeBlob":"$before","afterBlob":"$after","status":"pending"}""" + "\n",
            )
            val payload = feed("""{"entries":[{"ts":1000,"kind":"action","label":"Edit","editId":7}]}""")
            val panel = FeedPanel(project)
            update(panel, payload)
            fun drawn() = (rows(panel).get(0) as FeedPanel.Registry.Row).diff
            assertEquals("update() reads no store: a payload that carries no diff draws none", emptyList<String>(), drawn())
            val built = com.intellij.openapi.application.ApplicationManager.getApplication()
                .executeOnPooledThread<Map<Int, Pair<List<String>, Int>>> { com.cellobservatory.observatory.ui.DiffPreviews.forFeed(s, payload.entries) }
                .get()
            assertEquals("control: the fetch side builds that edit's diff from the store", listOf("-old line", "+new line"), built[7]?.first)
            update(panel, payload.copy(previews = built))
            assertEquals("…and the row draws what the payload carried", listOf("-old line", "+new line"), drawn())
        } finally {
            svc.demoSessionOverride = null
        }
    }

    /** The header's title, recap and note are content: they WRAP, whole, as VS Code's do. They were cut
     *  to 56 and 140 characters and ended in "…". */
    fun testTheHeaderWrapsTheTitleRecapAndNoteWhole() {
        val title = "A workflow run whose description runs well past fifty-six characters, and says what it did"
        val recap = "The session refactored the parser, " + "then fixed each test the change broke along the way. ".repeat(4)
        val note = "Only part of this feed could be read: " + "the rollout was rotated while the agent was still writing it. ".repeat(2)
        val panel = FeedPanel(project)
        update(panel, feed(com.google.gson.Gson().toJson(mapOf("title" to title, "recap" to recap, "note" to note, "mode" to "live", "lastTs" to 1, "entries" to emptyList<Any>()))))
        panel.setSize(320, 600)
        repeat(2) { panel.validate(); panel.doLayout(); (panel.getComponent(0) as java.awt.Container).doLayout() }
        fun area(name: String) = FeedPanel::class.java.getDeclaredField(name).apply { isAccessible = true }.get(panel) as javax.swing.JTextArea
        for ((name, whole) in listOf("titleLine" to title, "recapLine" to recap, "noteLine" to note)) {
            val a = area(name)
            assertTrue("$name is shown", a.isVisible)
            assertEquals("$name carries the whole text, never an ellipsis", whole, a.text)
            val line = a.getFontMetrics(a.font).height
            assertTrue("$name wraps at a narrow width: height ${a.preferredSize.height} vs one line $line", a.preferredSize.height > line)
        }
        val status = (FeedPanel::class.java.getDeclaredField("headline").apply { isAccessible = true }.get(panel) as javax.swing.JLabel).text
        assertFalse("the status line no longer carries a clipped copy of the title: $status", status.contains("…"))
    }

    fun testWorkflowReasoningIsDeduplicatedPerAgent() {
        val panel = FeedPanel(project)
        update(panel, feed("""{"entries":[
          {"ts":1,"kind":"reasoning","detail":"alpha","reasoning":"Alpha words"},
          {"ts":2,"kind":"reasoning","detail":"beta","reasoning":"Beta words"},
          {"ts":3,"kind":"action","detail":"alpha","reasoning":"Alpha words"},
          {"ts":4,"kind":"action","detail":"beta","reasoning":"Beta words"}
        ]}"""))
        assertFalse((rows(panel).get(2) as FeedPanel.Registry.Row).reasoningChanged)
        assertFalse((rows(panel).get(3) as FeedPanel.Registry.Row).reasoningChanged)
    }

    fun testLongProseWrapsAtTheColumnWidthAndKeepsBlockMarkdown() {
        val words = "ordinary words ".repeat(9) + "**bold across the old chunk boundary**\n# Heading\n- Bullet item"
        val entry = feed(com.google.gson.Gson().toJson(mapOf("entries" to listOf(mapOf(
            "ts" to 1, "kind" to "reasoning", "label" to "said", "reasoningKind" to "text", "reasoning" to words,
        ))))).entries.single()
        val renderer = com.cellobservatory.observatory.ui.FeedBlobRenderer { true }
        val list = com.intellij.ui.components.JBList<FeedPanel.Registry.Row>()
        fun body(width: Int): com.intellij.ui.components.JBLabel {
            list.setSize(width, 500)
            val comp = renderer.getListCellRendererComponent(list, FeedPanel.Registry.Row(entry, "1:0", true), 0, false, false) as java.awt.Container
            return comp.components.filterIsInstance<com.intellij.ui.components.JBLabel>().single()
        }
        val wide = body(600).preferredSize.height
        val narrow = body(220)
        assertTrue(narrow.text.contains("<b>bold across the old chunk boundary</b>"))
        assertTrue(narrow.text.contains("<b>Heading</b>"))
        assertTrue(narrow.text.contains("• Bullet item"))
        assertTrue("narrow columns wrap the complete prose", narrow.preferredSize.height > wide)
        assertTrue("the label fits its column", narrow.preferredSize.width <= 220)
    }

    fun testPromptAndResponseJumpsConsumeTheSelectionEvenWithAnUnchangedFeed() {
        val svc = ObservatoryService.getInstance(project)
        svc.demoSessionOverride = "fixture-session"
        val prompts = com.cellobservatory.observatory.model.PromptsParser.parse("""{"session":"fixture-session","prompts":[{"id":"ask","index":1,"ts":20,"endTs":40,"text":"Question"},{"id":"current","index":2,"ts":40,"endTs":0,"text":"Current ask"}]}""")!!
        val fetch = svc.javaClass.getDeclaredField("promptsFetch").apply { isAccessible = true }.get(svc)
        for ((name, value) in listOf("value" to prompts, "fetchedKey" to "fixture-session", "fetchedAt" to System.currentTimeMillis(), "inFlight" to true))
            fetch.javaClass.getDeclaredField(name).apply { isAccessible = true }.set(fetch, value)
        val panel = FeedPanel(project)
        val payload = feed("""{"entries":[{"ts":10,"kind":"action"},{"ts":20,"kind":"prompt"},{"ts":30,"kind":"reasoning"},{"ts":35,"kind":"action"},{"ts":39,"kind":"reasoning"},{"ts":40,"kind":"prompt"},{"ts":45,"kind":"reasoning"}]}""")
        update(panel, payload)
        val list = FeedPanel::class.java.getDeclaredField("list").apply { isAccessible = true }.get(panel) as javax.swing.JList<*>
        svc.selectedPromptId = "ask"
        panel.refresh()
        update(panel, payload)
        assertEquals("the selected ask lands on its own row", 1, list.selectedIndex)
        svc.requestResponseJump("ask")
        panel.refresh()
        update(panel, payload)
        assertNull("the Feed consumes the one-shot response request", svc.takeResponseJump())
        assertEquals("the response seats the last row before the next ask", 4, list.selectedIndex)
        svc.requestResponseJump("current")
        panel.refresh()
        update(panel, payload)
        assertEquals("an open-ended current ask seats the newest answer", 6, list.selectedIndex)
        svc.demoSessionOverride = null
    }


    fun testOpeningTheCurrentConversationClearsThePickedWorker() {
        val svc = ObservatoryService.getInstance(project)
        svc.demoSessionOverride = "fixture-session"
        val panel = com.cellobservatory.observatory.ui.ChangeMapPanel(project)
        val row = com.cellobservatory.observatory.model.SessionRow("fixture-session", null, 0, current = true, edits = 0, pending = 0, files = 0)
        svc.selectedFeed = ObservatoryService.FeedSel(ObservatoryService.FeedRef("fixture-session", "agent", "worker"), "fixture-session")
        assertNotNull(svc.selectedFeed)
        panel.javaClass.getDeclaredMethod("openConversationRow", row.javaClass).apply { isAccessible = true }.invoke(panel, row)
        assertNull("opening an already-current session still restores its own feed", svc.selectedFeed)
        svc.demoSessionOverride = null
    }

    fun testBodiesCacheByContentAndWidthAndPromptsWrap() {
        val renderer = com.cellobservatory.observatory.ui.FeedBlobRenderer { true }
        val list = com.intellij.ui.components.JBList<FeedPanel.Registry.Row>()
        fun body(text: String, kind: String = "reasoning", width: Int = 220): com.intellij.ui.components.JBLabel {
            list.setSize(width, 500)
            val entry = feed(com.google.gson.Gson().toJson(mapOf("entries" to listOf(mapOf(
                "ts" to 1, "kind" to kind, "reasoning" to text, "promptText" to text,
            ))))).entries.single()
            val comp = renderer.getListCellRendererComponent(list, FeedPanel.Registry.Row(entry, "1:0", true), 0, false, false) as java.awt.Container
            return comp.components.filterIsInstance<com.intellij.ui.components.JBLabel>().single()
        }
        val retained = body("first cached body")
        repeat(520) { body("replacement body $it") }
        assertNotSame("the body cache evicts old entries", retained, body("first cached body"))
        val recent = body("recent body")
        assertSame("recent entries remain cached", recent, body("recent body"))
        val text = "ordinary words ".repeat(20)
        val first = body(text)
        assertSame("a paint reuses the parsed HTML and measured height", first, body(text))
        assertNotSame("streaming text invalidates the body", first, body(text + "more"))
        assertNotSame("resizing invalidates the measured width", first, body(text, width = 400))
        val prompt = body(text, "prompt")
        assertTrue(prompt.preferredSize.width <= 220)
        assertTrue(prompt.preferredSize.height > body(text, "prompt", 600).preferredSize.height)
        assertTrue(prompt.text.contains("ordinary words"))
        val path = body("path-segment/".repeat(60))
        val view = path.getClientProperty(javax.swing.plaf.basic.BasicHTML.propertyKey) as javax.swing.text.View
        assertTrue("long tokens can wrap within the column: min=" + view.getMinimumSpan(javax.swing.text.View.X_AXIS) + " html=" + path.text, view.getMinimumSpan(javax.swing.text.View.X_AXIS) < 220)
    }

    fun testPromptJumpLeavesThePickedWorkerAlone() {
        val svc = ObservatoryService.getInstance(project)
        svc.demoSessionOverride = "fixture-session"
        val panel = FeedPanel(project)
        val picked = ObservatoryService.FeedSel(ObservatoryService.FeedRef("fixture-session", "agent", "worker"), "fixture-session")
        FeedPanel::class.java.getDeclaredField("pendingPrompt").apply { isAccessible = true }.set(panel, "old-request")
        svc.selectedFeed = picked
        svc.selectedPromptId = "ask"
        svc.requestResponseJump("ask")
        panel.refresh()
        assertSame("prompt jumps do not discard a worker selection", picked, svc.selectedFeed)
        assertNull("an older queued jump cannot retarget the worker feed", FeedPanel::class.java.getDeclaredField("pendingPrompt").apply { isAccessible = true }.get(panel))
        svc.selectedFeed = null
        svc.demoSessionOverride = null
    }

    fun testFeedPaintBenchmark() {
        val renderer = com.cellobservatory.observatory.ui.FeedBlobRenderer { false }
        val list = com.intellij.ui.components.JBList<FeedPanel.Registry.Row>().apply { setSize(500, 700) }
        val entries = (0 until 400).map { i ->
            val entry = feed(com.google.gson.Gson().toJson(mapOf("entries" to listOf(mapOf(
                "ts" to i, "kind" to "reasoning", "reasoningKind" to "thinking",
                "reasoning" to ("Thought $i with **bold** and a short explanation. ".repeat(3) + "\n- another line"),
            ))))).entries.single()
            FeedPanel.Registry.Row(entry, "$i:0", true)
        }
        for (size in listOf(60, 400)) {
            fun paint(): Long {
                val start = System.nanoTime()
                entries.take(size).forEachIndexed { i, row -> renderer.getListCellRendererComponent(list, row, i, false, false) }
                return System.nanoTime() - start
            }
            repeat(3) { paint() }
            val times = List(7) { paint() }.sorted()
            println("FEED_PAINT rows=$size median_ms=" + times[3] / 1_000_000.0)
        }
    }

}
