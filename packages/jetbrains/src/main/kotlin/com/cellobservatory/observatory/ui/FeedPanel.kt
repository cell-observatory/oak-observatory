package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.StoreReader
import com.cellobservatory.observatory.model.Feed
import com.cellobservatory.observatory.model.FeedEntry
import com.cellobservatory.observatory.model.Md
import com.cellobservatory.observatory.services.ObservatoryService
import com.intellij.openapi.project.Project
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.ActionLink
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.JBColor
import com.intellij.ui.SimpleColoredComponent
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.BorderLayout
import java.awt.Component
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.BoxLayout
import javax.swing.DefaultListModel
import javax.swing.JList
import javax.swing.JPanel
import javax.swing.ListCellRenderer
import javax.swing.SwingUtilities

/**
 * The Timeline's FEED tab (0.10.0) — the TUI agent-feed port, and the new home of the live/audit feed
 * that used to render under the Overview's change map.
 *
 * It follows whatever the Overview selects (a worker session, a subagent, a workflow run, a task, a
 * background shell) through [ObservatoryService.selectedFeed], and shows the reviewed session's OWN
 * feed when nothing is picked — so the tab is never empty. `mode` comes from core and decides the
 * framing: 'live' is followed on the service's watcher tick and states the age of the newest evidence
 * (never a realtime claim); 'audit' is a record, labelled as one and no longer polled.
 *
 * Entries render as BLOBS, expanded by default: the head row carries the verb and its TARGET (a shell
 * call draws as a shell call — `$ cmd` — from core's category, never by matching tool names), a mark
 * by shape (✖ error · ✓ ok · ? pending permission) and the wall clock; an open blob adds the
 * reasoning (only where it CHANGED — core carries it forward per message), the tool's note, which
 * agent, and the full multi-line command. A blob attributed to a captured edit opens its diff on
 * double-click (display id = editId ?? previewId; only a real editId is ever acted on elsewhere).
 *
 * Since 2026-09-23 this is the Timeline's ONE conversation surface (the Conversation tab folded in):
 * the user's asks ride grey bands, and the agent's own words are rows of their own — a reply as prose,
 * whole; its thinking the same block folded by default.
 */
class FeedPanel(private val project: Project) : JPanel(BorderLayout()) {

    /** Live panels by project, so the tour can reach this tab — the TimelinePanel registry's shape. */
    companion object Registry {
        private val live = java.util.concurrent.ConcurrentHashMap<Project, FeedPanel>()
        fun of(project: Project): FeedPanel? = live[project]
        /** Depth growth per "load more" — the TUI's page. */
        private const val PAGE = 200

        /** One feed row, pre-joined to everything the renderer needs so painting stays allocation-free:
         *  the blob key (ts:run-within-ts — an INDEX would shift on every window slide and silently
         *  re-collapse whatever the reader opened), whether the reasoning CHANGED at this row, and the
         *  edit's bounded INLINE DIFF (prefixed +/−/~ lines, the way the agent CLI's transcript shows
         *  a change) with how many lines the bound dropped. */
        internal data class Row(
            val entry: FeedEntry,
            val key: String,
            val reasoningChanged: Boolean,
            val diff: List<String> = emptyList(),
            val diffMore: Int = 0,
        )
    }

    private val service get() = ObservatoryService.getInstance(project)

    private val headline = JBLabel().apply { font = JBUI.Fonts.smallFont() }
    private val followChip = ActionLink("✕ back to the session’s own feed") {
        service.selectedFeed = null // the setter notifies; refresh() then falls back to the session
    }.apply {
        font = JBUI.Fonts.miniFont()
        toolTipText = "Stop following the Overview’s selection and show the reviewed session’s own feed"
        isVisible = false
    }
    /** The feed's title, the session recap and core's note WRAP to the tab's width, as VS Code's header
     *  does: a label would cut them to one line. The status keeps the row with the chip and the jump. */
    private val titleLine = wrapLine(JBUI.Fonts.smallFont(), UIUtil.getLabelForeground())
    private val recapLine = wrapLine(JBUI.Fonts.miniFont(), UIUtil.getContextHelpForeground())
    private val moreLink = ActionLink("") {
        pageDepth += PAGE
        refresh(force = true)
    }.apply {
        font = JBUI.Fonts.miniFont()
        toolTipText = "Entries are chronological, oldest first — anything dropped was dropped off the top. Click to read deeper."
        isVisible = false
    }
    private val jumpLink = ActionLink("↓ newest") {
        SwingUtilities.invokeLater { if (model.size() > 0) list.ensureIndexIsVisible(model.size() - 1) }
    }.apply {
        font = JBUI.Fonts.miniFont()
        toolTipText = "Back to the newest entry"
        isVisible = false
    }
    private val noteLine = wrapLine(JBUI.Fonts.miniFont(), UIUtil.getContextHelpForeground())
    private val model = DefaultListModel<Row>()
    private val list = JBList(model).apply {
        cellRenderer = FeedBlobRenderer(::isOpen)
        fixedCellHeight = -1 // blobs are variable height — an open one carries its body rows
        emptyText.text = "Nothing recorded yet"
    }

    /** Blob keys the reader COLLAPSED — the inverse of every other list, because a feed's blobs are
     *  expanded by default (the TUI's rule: the body is why you opened the tab). Reset per subject. */
    private val closed = HashSet<String>()
    /** How deep the fetch reads for the CURRENT subject; grows by [PAGE] per load-more. */
    private var pageDepth = ObservatoryService.FEED_LIMIT
    /** The subject key the depth/closed-set belong to — a new subject resets both. */
    private var subjectKey: String? = null
    /** The feed instance on screen — an unchanged fetch must not blow away scroll or selection. */
    private var shown: Feed? = null
    private var lastCount = -1
    private var selectedPrompt: String? = null
    private var pendingPrompt: String? = null
    private var responseJump = false

    private val listener = Runnable { refresh() }

    init {
        val header = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            border = JBUI.Borders.empty(3, 6, 3, 6)
            val row = JPanel().apply {
                layout = BoxLayout(this, BoxLayout.X_AXIS)
                alignmentX = Component.LEFT_ALIGNMENT
                add(headline)
                add(javax.swing.Box.createHorizontalStrut(JBUI.scale(8)))
                add(followChip)
                add(javax.swing.Box.createHorizontalGlue())
                add(jumpLink)
            }
            moreLink.alignmentX = Component.LEFT_ALIGNMENT
            add(row)
            add(titleLine)
            add(recapLine)
            add(noteLine)
            add(moreLink)
        }
        add(header, BorderLayout.NORTH)
        val scroll = JBScrollPane(list)
        add(scroll, BorderLayout.CENTER)
        // The way back from scrollback: the ↓ newest link appears the moment the viewport leaves the
        // tail and goes when it is back — a terminal's scroll pill, in the header row.
        scroll.verticalScrollBar.addAdjustmentListener {
            val bar = scroll.verticalScrollBar
            jumpLink.isVisible = model.size() > 0 && bar.value + bar.visibleAmount < bar.maximum - JBUI.scale(24)
        }
        // Click toggles a blob (they are expanded by default; the head row is the collapse handle).
        // DOUBLE-click opens things — the JB idiom for "activate", and it never mutates: an edit item
        // opens that file's changes as the STACKED layout; any other path-like target opens the file
        // itself.
        list.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                val idx = list.locationToIndex(e.point)
                if (idx < 0) return
                val row = model.getElementAt(idx) ?: return
                if (e.clickCount == 2) {
                    val id = row.entry.editId ?: row.entry.previewId
                    if (id != null) {
                        val session = currentRef()?.session ?: return
                        // The STACKED layout for that file's changes, not the side-by-side view
                        // — scoped to the subject session's own store.
                        StoreReader.findRecord(session, id)?.let { Diffs.showFileStacked(project, session, it.file) }
                        return
                    }
                    // No edit behind it — a path-like target still opens as a file.
                    val t = row.entry.target ?: return
                    if (!pathishTarget(t)) return
                    val ws = service.workspaceRoot
                    val abs = if (java.nio.file.Paths.get(t).isAbsolute) t else (ws?.let { "$it/$t" } ?: t)
                    com.intellij.openapi.vfs.LocalFileSystem.getInstance().refreshAndFindFileByPath(abs)?.let { vf ->
                        com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project).openFile(vf, true)
                    }
                    return
                }
                if (row.entry.kind == "output") return // a raw line has no body to fold
                if (!closed.add(row.key)) closed.remove(row.key)
                // Repaint with the new fold state; the model itself is unchanged.
                list.repaint()
                // Variable-height rows: the UI caches cell heights, so a fold must invalidate them.
                list.fixedCellHeight = 1
                list.fixedCellHeight = -1
            }
        })
        remember(project, this)
        service.addListener(listener)
        refresh()
    }

    private fun isOpen(key: String): Boolean = !closed.contains(key)

    /** The ref this tab currently follows: the Overview's pick when it is still valid for the reviewed
     *  session, else the session's own feed. A pick made under ANOTHER session is dropped (and the
     *  depth with it) — the Overview publishes afresh when the reader selects again. */
    private fun currentRef(): ObservatoryService.FeedRef? {
        val sel = service.selectedFeed
        val current = service.currentSession()
        val picked = sel?.takeIf {
            // A fleet row IS a session of its own, so a session-kind pick survives a switch TO it.
            it.forSession == current || it.ref.kind == "session"
        }?.ref
        if (picked != null) return picked.copy(limit = pageDepth)
        if (sel != null) service.selectedFeed = null // stale pick from another session — drop it
        val session = current ?: return null
        return ObservatoryService.FeedRef(session, "session", "", limit = pageDepth)
    }

    fun refresh(force: Boolean = false) {
        currentRef() // discard a stale worker pick before deciding whether navigation applies
        val response = service.takeResponseJump()
        val selected = service.selectedPromptId
        if (response != null || selected != selectedPrompt) {
            selectedPrompt = selected
            pendingPrompt = if (service.selectedFeed != null) null else response ?: selected
            responseJump = response != null
            if (pendingPrompt != null) {
                pageDepth = maxOf(pageDepth, 400)
            }
        }
        if (service.selectedFeed != null) pendingPrompt = null
        val ref = currentRef()
        val key = ref?.let { "${it.session}\u0000${it.kind}\u0000${it.id}" }
        if (key != subjectKey) {
            // A new subject: its blobs open fresh, its depth starts over, the old scroll means nothing.
            subjectKey = key
            closed.clear()
            if (!force && pendingPrompt == null) pageDepth = ObservatoryService.FEED_LIMIT
            shown = null
            lastCount = -1
            model.clear()
        }
        val following = service.selectedFeed != null
        followChip.isVisible = following
        if (ref == null) {
            headline.foreground = UIUtil.getContextHelpForeground()
            headline.text = "No session is under observation yet."
            titleLine.isVisible = false
            recapLine.isVisible = false
            moreLink.isVisible = false
            noteLine.isVisible = false
            return
        }
        update(service.feed(ref, force))
    }

    private fun update(feed: Feed?) {
        if (feed == null) {
            headline.foreground = UIUtil.getContextHelpForeground()
            headline.text = "Reading the feed…"
            headline.toolTipText = null
            titleLine.isVisible = false
            return
        }
        val live = feed.live
        // Exact wall-clock (2026-08-31): the header stamps WHEN the newest evidence landed, not how
        // long ago — the stamp is a fact that never claims realtime and never ticks.
        val age = if (feed.lastTs > 0) com.cellobservatory.observatory.model.relTime(feed.lastTs) else "no activity recorded"
        headline.foreground = if (live) MT_DONE else UIUtil.getContextHelpForeground()
        headline.text = (if (live) "● live" else "▣ audit log") + (if (live) "  ·  updated $age" else "  ·  last activity $age")
        titleLine.text = feed.title
        titleLine.isVisible = feed.title.isNotBlank()
        headline.toolTipText = if (live) {
            "Still being written — this tab follows it on the service's refresh tick. The stamp is the newest entry's own time; nothing here claims realtime."
        } else {
            "Finished — this is the recorded log of what it did, not a stream, so it is no longer polled."
        }
        // The session recap rides session-kind payloads — one dim line, its source named on hover.
        val recap = feed.recap?.takeIf { it.isNotBlank() }
        recapLine.isVisible = recap != null
        if (recap != null) {
            recapLine.text = recap
            recapLine.toolTipText = recap + (feed.recapSource?.takeIf { it.isNotBlank() }?.let { "\n(recap · from the $it)" } ?: "")
        }
        // A cap that reads as completeness is a lie about what happened: the dropped count is a LINK
        // that pulls the earlier entries in, and core's note explains an empty feed.
        moreLink.isVisible = feed.truncated > 0
        if (feed.truncated > 0) moreLink.text = "… ${feed.truncated} earlier entr${if (feed.truncated == 1) "y" else "ies"} not shown — load more"
        val note = feed.note?.takeIf { it.isNotBlank() }
        noteLine.isVisible = note != null
        if (note != null) noteLine.text = note
        list.emptyText.text = note ?: "Nothing recorded yet"
        // No pinned "SAID" pane any more: the agent's replies are rows of the feed itself, so a pinned
        // copy would repeat the row above it (the TUI dropped its own for the same reason).
        if (feed === shown) { jumpToPrompt(); return } // selection can change without a new payload
        shown = feed
        // Follow the tail only when the reader WAS at the tail (or on first fill — a feed OPENS at its
        // newest entry, live or audit) — a log scrolled back through is never yanked down by a repaint;
        // the ↓ newest link is the way back.
        val atTail = lastCount < 0 || list.lastVisibleIndex >= model.size() - 1
        model.clear()
        val lastReasoning = HashMap<String?, String>()
        var lastTs = -1L
        var run = 0
        for (e in feed.entries) {
            if (e.ts == lastTs) run++ else { lastTs = e.ts; run = 0 }
            val changed = e.reasoning != null && e.reasoning != lastReasoning[e.detail]
            if (e.reasoning != null) lastReasoning[e.detail] = e.reasoning
            // Built with the payload, off the EDT (ObservatoryService.feedFetch): this runs on every
            // new payload, and reading the log and blobs here held the UI thread for every edit row.
            val (dl, more) = (e.editId ?: e.previewId)?.let { feed.previews[it] } ?: (emptyList<String>() to 0)
            model.addElement(Row(e, "${e.ts}:$run", changed, dl, more))
        }
        val jumped = jumpToPrompt()
        if (model.size() > 0 && atTail && !jumped && pendingPrompt == null) {
            // invokeLater, because on first fill the list has not been laid out yet — an immediate
            // ensureIndexIsVisible is a no-op against a zero-height viewport and the feed opens at
            // the TOP, which is exactly what this exists to prevent.
            SwingUtilities.invokeLater { if (shown === feed && pendingPrompt == null && list.selectedIndex < 0 && model.size() > 0) list.ensureIndexIsVisible(model.size() - 1) }
        }
        lastCount = model.size()
    }

    /** Consume prompt navigation even when the feed instance did not change. A response jump seats
     *  the last answer row before the next ask; a prompt pick seats the ask itself. Keep the request while fetching. */
    private fun jumpToPrompt(): Boolean {
        val id = pendingPrompt ?: return false
        val prompt = service.prompts()?.prompts?.find { it.id == id } ?: return false
        val candidates = (0 until model.size()).filter {
            val entry = model.get(it).entry
            entry.ts >= prompt.ts && (!responseJump || (entry.kind != "prompt" && (prompt.endTs == 0L || entry.ts < prompt.endTs)))
        }
        val index = (if (responseJump) candidates.lastOrNull() else candidates.firstOrNull()) ?: return false
        pendingPrompt = null
        list.selectedIndex = index
        list.ensureIndexIsVisible(index)
        val shownFeed = shown
        SwingUtilities.invokeLater {
            if (shown === shownFeed && list.selectedIndex == index) list.ensureIndexIsVisible(index)
        }
        return true
    }

    /** A target that reads as a file path — queries and prose are not doors. */
    private fun pathishTarget(t: String): Boolean =
        t.isNotBlank() && !t.contains(' ') && !t.contains('"') && (t.contains('/') || Regex("\\.[A-Za-z0-9]{1,8}$").containsMatchIn(t))

    /** The tour's anchor for the `feed` step — the whole tab body. */
    fun tourTarget(): javax.swing.JComponent = this

    private fun remember(project: Project, panel: FeedPanel) {
        live[project] = panel
        com.intellij.openapi.util.Disposer.register(project) {
            live.remove(project, panel)
            panel.service.removeListener(panel.listener)
        }
    }
}

/**
 * One BLOB. A panel-based renderer (the single-line ColoredListCellRenderer cannot draw a body), the
 * same shape the Sessions tab's wrapping renderer took: a vertical box of colored lines, measured at
 * the list's width so variable heights work.
 */
internal class FeedBlobRenderer(private val isOpen: (String) -> Boolean) : ListCellRenderer<FeedPanel.Registry.Row> {
    private val panel = JPanel().apply {
        layout = BoxLayout(this, BoxLayout.Y_AXIS)
        isOpaque = true
    }

    private data class BodyKey(val row: String, val text: String, val width: Int, val open: Boolean, val prompt: Boolean)
    // Enough for a 400-row page plus resize/streaming churn; old pages cannot grow this indefinitely.
    private val bodies = object : LinkedHashMap<BodyKey, JBLabel>(512, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<BodyKey, JBLabel>?): Boolean = size > 512
    }

    private fun body(key: String, text: String, width: Int, open: Boolean, prompt: Boolean): JBLabel =
        bodies.getOrPut(BodyKey(key, text, width, open, prompt)) {
            JBLabel("<html>${if (prompt) Md.plainHtml(text) else Md.toHtml(text)}</html>").apply {
                alignmentX = Component.LEFT_ALIGNMENT
                val html = getClientProperty(javax.swing.plaf.basic.BasicHTML.propertyKey) as javax.swing.text.View
                html.setSize(width.toFloat(), 0f)
                preferredSize = java.awt.Dimension(width, kotlin.math.ceil(html.getPreferredSpan(javax.swing.text.View.Y_AXIS)).toInt())
                maximumSize = preferredSize
            }
        }

    /** Each entry is a BORDERED block with air between blocks — the TUI's boxed blobs.
     *  Outer empty = the gap (a JBList cell has no margins of its own), then the quiet
     *  box, then a 2px status accent on the left edge, then the padding. Raw output rows stay
     *  unboxed — they are log lines, not entries. */
    /** The user-ask band — a dim grey ground, the way the agent CLI paints user turns. */
    private val USER_ASK_BG = JBColor(java.awt.Color(0xF2F2F2), java.awt.Color(0x2E3033))

    private fun blockBorder(accent: java.awt.Color?): javax.swing.border.Border = javax.swing.BorderFactory.createCompoundBorder(
        JBUI.Borders.empty(3, 4),
        javax.swing.BorderFactory.createCompoundBorder(
            JBUI.Borders.customLine(JBColor.border(), 1),
            javax.swing.BorderFactory.createCompoundBorder(
                JBUI.Borders.customLine(accent ?: JBColor.border(), 0, 2, 0, 0),
                JBUI.Borders.empty(2, 6),
            ),
        ),
    )

    private fun line(build: SimpleColoredComponent.() -> Unit): SimpleColoredComponent =
        SimpleColoredComponent().apply { isOpaque = false; alignmentX = Component.LEFT_ALIGNMENT; build() }

    override fun getListCellRendererComponent(
        list: JList<out FeedPanel.Registry.Row>, value: FeedPanel.Registry.Row?, index: Int, selected: Boolean, focus: Boolean,
    ): Component {
        panel.removeAll()
        panel.background = if (selected) list.selectionBackground else list.background
        val row = value ?: return panel
        val e = row.entry
        // A raw output line: monospace, no fabricated timestamp, no body to fold.
        if (e.kind == "output") {
            panel.border = JBUI.Borders.empty(1, 6)
            panel.add(line { font = FEED_MONO_F; append(e.label, SimpleTextAttributes.GRAYED_ATTRIBUTES) })
            panel.size = java.awt.Dimension(list.width.coerceAtLeast(JBUI.scale(48)), 1)
            return panel
        }
        if (e.kind == "reasoning") {
            // THE AGENT'S OWN WORDS (2026-09-23, the Conversation tab folded in): a reply is prose,
            // whole — wrapped to the column width with block and inline markdown; its thinking
            // is the same block folded by default. The fold set records the reader's TOGGLE, so a
            // thinking row reads it inverted. The folded head names its word count.
            val thinking = e.reasoningKind == "thinking"
            val open = if (thinking) !isOpen(row.key) else isOpen(row.key)
            val words = e.reasoning ?: ""
            panel.border = blockBorder(if (thinking) null else MT_AGENT)
            panel.add(line {
                append(if (open) "▾ " else "▸ ", SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES)
                if (e.ts > 0) append(clockOfMs(e.ts) + "  ", SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES)
                append(if (thinking) "thinking" else "said", SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, MT_AGENT))
                if (!open) append(" · ${Md.wordCount(words)} words", SimpleTextAttributes.GRAYED_ATTRIBUTES)
            })
            if (open) {
                val width = (list.width - JBUI.scale(28)).coerceAtLeast(JBUI.scale(48))
                panel.add(body(row.key, words, width, open, prompt = false).apply {
                    foreground = if (thinking) UIUtil.getContextHelpForeground() else if (selected) list.selectionForeground else list.foreground
                })
            }
            e.detail?.takeIf { it.isNotBlank() }?.let {
                panel.add(line { append("    " + it, SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES) })
            }
            panel.toolTipText = if (thinking) "What the agent thought before it acted — click to unfold" else "What the agent said"
            panel.size = java.awt.Dimension(list.width.coerceAtLeast(JBUI.scale(48)), 1)
            return panel
        }
        if (e.kind == "prompt") {
            // The user's own ask — a dim grey band, the way the agent CLI paints user turns.
            // Measure at the column width, preserving the whole ask and wrapping at word boundaries.
            panel.isOpaque = true
            panel.background = USER_ASK_BG
            panel.border = blockBorder(null)
            panel.add(line {
                append("you ", SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, MT_WORKING))
                append(e.label + "  ", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                if (e.ts > 0) append(clockOfMs(e.ts), SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES)
            })
            val width = (list.width - JBUI.scale(28)).coerceAtLeast(JBUI.scale(48))
            panel.add(body(row.key, e.promptText ?: "", width, open = true, prompt = true).apply {
                foreground = if (selected) list.selectionForeground else list.foreground
            })
            return panel
        }
        panel.border = blockBorder(
            when {
                e.ok == false -> MT_ERROR
                e.kind == "permission" -> CM_PENDING
                else -> null
            }
        )
        val open = isOpen(row.key)
        val isExec = e.category == "exec"
        panel.add(line {
            append(if (open) "▾ " else "▸ ", SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES)
            if (e.ts > 0) append(clockOfMs(e.ts) + "  ", SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES)
            when {
                e.ok == false -> append("✖ ", SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, MT_ERROR))
                e.ok == true -> append("✓ ", SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, MT_DONE))
                e.kind == "permission" -> append("? ", SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, MT_ATTENTION))
            }
            if (isExec) {
                // A shell call reads as a shell call — dollar + command, SYNTAX HIGHLIGHTED (program ·
                // flags · strings · operators, the TUI tokenizer) — never as a tool name.
                append("$ ", SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, MT_DONE))
                font = FEED_MONO_F
                shellFragments(clipStr((e.target ?: e.label).replace(Regex("\\s+"), " "), 110), this)
            } else {
                append(
                    e.label,
                    when (e.kind) {
                        "permission" -> SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, MT_ATTENTION)
                        else -> SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, MT_WORKING)
                    },
                )
                // The TARGET rides the head row, immediately after the verb — the collapsed row is
                // the one that most needs it.
                e.target?.takeIf { it.isNotBlank() }?.let {
                    append("  " + clipStr(it.replace(Regex("\\s+"), " "), 96), SimpleTextAttributes.REGULAR_ATTRIBUTES)
                }
            }
        })
        if (open) {
            // Reasoning only where it CHANGED (core carries it forward per message), labelled by kind.
            if (row.reasoningChanged) e.reasoning?.let { r ->
                panel.add(line {
                    append("    " + (if (e.reasoningKind == "thinking") "thinking — " else "said — "),
                        SimpleTextAttributes(SimpleTextAttributes.STYLE_SMALLER, MT_AGENT))
                    // Markdown, like the CLI — inline spans only: the row is a
                    // one-line clip, so block-level marks (headings, bullets) have no line to own.
                    mdFragments(clipStr(r.replace(Regex("\\s+"), " "), 240), SimpleTextAttributes(SimpleTextAttributes.STYLE_ITALIC, null), this)
                })
            }
            e.note?.takeIf { it.isNotBlank() }?.let {
                panel.add(line { append("    " + it, SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES) })
            }
            e.detail?.takeIf { it.isNotBlank() }?.let {
                panel.add(line { append("    " + it, SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES) })
            }
            // The FULL command, never clipped to the head's one-line form — each line its own row,
            // highlighted so a pipeline or a heredoc reads like it does in a terminal.
            if (isExec) e.cmd?.takeIf { it.isNotBlank() && it != e.target }?.let { cmd ->
                for (cl in cmd.lineSequence().take(12)) {
                    panel.add(line { font = FEED_MONO_F; append("    ", SimpleTextAttributes.REGULAR_ATTRIBUTES); shellFragments(cl, this) })
                }
            }
            // THE DIFF ITSELF, inline — bounded, with the overflow said out loud. Added/removed read
            // as BANDS (the editor scheme's own diff backgrounds, full row width) rather than text
            // colour — the way a diff editor paints them; context stays dim text.
            if (row.diff.isNotEmpty()) {
                for (dl in row.diff) {
                    val band = when (dl.firstOrNull()) {
                        '+' -> diffBandColor(true)
                        '-' -> diffBandColor(false)
                        else -> null
                    }
                    panel.add(line {
                        font = FEED_MONO_F
                        val attrs = if (band != null) SimpleTextAttributes.REGULAR_ATTRIBUTES else SimpleTextAttributes.GRAYED_ATTRIBUTES
                        append("      " + clipStr(dl, 160), attrs)
                        if (band != null) {
                            isOpaque = true
                            background = band
                            // Stretch to the block's full width so the band reads as a band, not a
                            // text highlight (BoxLayout honours maximumSize for the stretch).
                            maximumSize = java.awt.Dimension(Int.MAX_VALUE, preferredSize.height)
                        }
                    })
                }
                if (row.diffMore > 0) {
                    panel.add(line {
                        append("      +${row.diffMore} more line${if (row.diffMore == 1) "" else "s"} — the Review tab holds the full diff",
                            SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES)
                    })
                }
            }
            val did = e.editId ?: e.previewId
            if (did != null) {
                panel.add(line {
                    append("    ⧉ double-click opens this file’s changes, stacked — edit #$did", SimpleTextAttributes(SimpleTextAttributes.STYLE_SMALLER, MT_WORKING))
                })
            }
        }
        panel.toolTipText = buildString {
            append(e.label)
            e.target?.let { append("  $it") }
            e.note?.let { append("\n$it") }
            e.detail?.let { append("\n$it") }
            if (e.ok == false) append("\nthis call reported an error")
            if (e.kind == "permission") append("\na permission round-trip recorded by native hooks")
        }
        // Measured at the list's width so the variable-height UI asks the right preferred height.
        panel.size = java.awt.Dimension(list.width.coerceAtLeast(JBUI.scale(48)), 1)
        return panel
    }
}

/**
 * Colour one SHELL command line into [into] — the TUI tokenizer (syntax.ts highlightShell), as
 * SimpleColoredComponent fragments. Mark only what is unambiguous: the program being run (the first
 * word of the line and of every command an operator starts), its flags, its quoted strings, and the
 * operators joining the commands. Everything else is an argument and stays plain — an argument
 * mis-coloured as a flag is a lie about what the agent ran. FOO=bar assignments keep program position.
 */
internal fun shellFragments(lineText: String, into: SimpleColoredComponent) {
    val progA = SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, MT_WORKING)
    val flagA = SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, CM_PENDING)
    val strA = SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, CM_KEPT)
    val opA = SimpleTextAttributes.GRAYED_ATTRIBUTES
    var i = 0
    var program = true
    while (i < lineText.length) {
        val rest = lineText.substring(i)
        val ws = Regex("^\\s+").find(rest)
        if (ws != null) { into.append(ws.value, SimpleTextAttributes.REGULAR_ATTRIBUTES); i += ws.value.length; continue }
        val op = Regex("^(\\|\\||&&|>>|[|;&()<>])").find(rest)
        if (op != null) { into.append(op.value, opA); i += op.value.length; program = true; continue }
        if (rest[0] == '\'' || rest[0] == '"') {
            val quote = rest[0]
            var j = 1
            while (j < rest.length && rest[j] != quote) j += if (rest[j] == '\\') 2 else 1
            val tok = rest.substring(0, minOf(j + 1, rest.length))
            into.append(tok, strA); i += tok.length; program = false; continue
        }
        val word = Regex("^[^\\s|;&()<>'\"]+").find(rest)
        if (word == null) { into.append(rest[0].toString(), SimpleTextAttributes.REGULAR_ATTRIBUTES); i += 1; continue }
        val t = word.value
        val assignment = program && Regex("^[A-Za-z_][A-Za-z0-9_]*=").containsMatchIn(t)
        when {
            program && !assignment -> { into.append(t, progA); program = false }
            !program && t.startsWith("-") -> into.append(t, flagA)
            else -> into.append(t, SimpleTextAttributes.REGULAR_ATTRIBUTES)
        }
        i += t.length
    }
}

/** Inline `code` tint for markdown fragments — the TUI's cyan, readable on both themes. */
internal val MD_CODE = JBColor(java.awt.Color(0x0B7285), java.awt.Color(0x56C2D6))

/**
 * Append one line's INLINE markdown (bold/italic/`code` via [Md.inline]) as fragments of [into] —
 * the Swing face of the shared tokenizer (core format.ts, mirrored in model/Md.kt; the TUI paints
 * ANSI, the webview HTML, this paints SimpleTextAttributes). Fragments cannot switch fonts, so a
 * code span reads by TINT, not typeface. [base] carries the row's own style/colour underneath.
 */
internal fun mdFragments(lineText: String, base: SimpleTextAttributes, into: SimpleColoredComponent) {
    for (sp in Md.inline(lineText)) {
        var style = base.style
        if (sp.b) style = style or SimpleTextAttributes.STYLE_BOLD
        if (sp.i) style = style or SimpleTextAttributes.STYLE_ITALIC
        into.append(sp.t, SimpleTextAttributes(style, if (sp.c) MD_CODE else base.fgColor))
    }
}

/** The feed's monospace rows (raw output, shell commands): columns and indentation survive. */
internal val FEED_MONO_F: java.awt.Font = JBUI.Fonts.create(java.awt.Font.MONOSPACED, JBUI.Fonts.label().size)

/** Wall-clock stamp for a feed row, in the reader's own zone (the transcript's ms epoch is UTC). */
internal val FEED_CLOCK_F: java.time.format.DateTimeFormatter =
    java.time.format.DateTimeFormatter.ofPattern("HH:mm:ss").withZone(java.time.ZoneId.systemDefault())

private fun clockOfMs(ts: Long): String = FEED_CLOCK_F.format(java.time.Instant.ofEpochMilli(ts))

private fun clipStr(s: String, n: Int): String = if (s.length <= n) s else s.take(n - 1) + "…"

/** A header line that WRAPS at the panel's width instead of cutting its text — read-only, unframed,
 *  hidden until it has something to say. */
private fun wrapLine(f: java.awt.Font, fg: java.awt.Color): com.intellij.ui.components.JBTextArea = com.intellij.ui.components.JBTextArea().apply {
    isEditable = false
    isFocusable = false
    isOpaque = false
    lineWrap = true
    wrapStyleWord = true
    border = JBUI.Borders.empty()
    font = f
    foreground = fg
    alignmentX = Component.LEFT_ALIGNMENT
    isVisible = false
}

/** The feed's diff BAND colours (added/removed as background bands, not text
 *  colour) — the active editor scheme's own inserted/deleted diff backgrounds, so the bands match
 *  every real diff view in the IDE, with a quiet translucent fallback for schemes defining none. */
private fun diffBandColor(added: Boolean): java.awt.Color {
    val key = if (added) com.intellij.openapi.diff.DiffColors.DIFF_INSERTED else com.intellij.openapi.diff.DiffColors.DIFF_DELETED
    val fromScheme = com.intellij.openapi.editor.colors.EditorColorsManager.getInstance().globalScheme.getAttributes(key)?.backgroundColor
    if (fromScheme != null) return fromScheme
    return if (added) JBColor(java.awt.Color(46, 160, 67, 46), java.awt.Color(46, 160, 67, 46))
    else JBColor(java.awt.Color(248, 81, 73, 46), java.awt.Color(248, 81, 73, 46))
}
