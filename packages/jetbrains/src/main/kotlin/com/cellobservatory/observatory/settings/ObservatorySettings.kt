package com.cellobservatory.observatory.settings

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.options.Configurable
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import javax.swing.JComponent
import javax.swing.JPanel

@Service
@State(name = "ClaudeObservatorySettings", storages = [Storage("claude-observatory.xml")])
class ObservatorySettings : PersistentStateComponent<ObservatorySettings.State> {
    class State {
        var observatoryBin: String? = null // path to the oak CLI; empty = auto-detect
        var claudeBin: String? = null // path to the claude CLI (opt-in Analyze); empty = auto-detect
        var configDir: String? = null // CLAUDE_CONFIG_DIR override; empty = env var, then ~/.claude
        var inlineReview: Boolean = true // inline editor overlay (lenses + line highlights)
        var unifiedDiff: Boolean = true // open edit diffs in the unified (inline) viewer, not side-by-side
        var session: String? = null

        /**
         * After a SINGLE keep or undo, open the next edit still awaiting review — in another file when
         * that is where it is. Bulk operations, task operations and redo never move the cursor.
         *
         * On by default: the review loop is the product's main path, and stepping it by hand after every
         * verdict is the friction this removes. It is refusable because it can pull focus out of the file
         * you were reading, which is the one thing a reader might not want.
         */
        var revealNextOnResolve: Boolean = true

        /**
         * Which in-editor review chrome a file with pending edits gets: `floating` (a bar over the code,
         * bottom-right), `banner` (the editor-top notification panel), `both`, or `none`.
         *
         * Defaults to `floating` — the banner AND the bar over one file is double chrome for the same
         * verbs, and the bar sits beside the code it is about. `banner` restores the pre-0.10 behaviour.
         */
        var editorReviewSurface: String = "floating"

        /** Guided tour: docked into a tool window (the default), or floating in a dialog of its own.
         *  A person's preference about their own screen, so it is remembered rather than re-asked. */

        // --- the first-run / post-update demo offer -------------------------------------------------
        // Application-level, like everything else here: declining silences it in EVERY project, which is
        // what "never ask" has to mean for it to be worth offering.
        /** The plugin version this reader was last offered the demo for. */
        var demoOfferLastSeenVersion: String? = null
        /** Declined for good. */
        var demoOfferNever: Boolean = false
        /** Set on the first activation ever, so an empty version stamp can tell an INSTALL from an update. */
        var everRan: Boolean = false
        // The Overview's Active-only toggle. ON by default (0.8.8): the panel's job is work still awaiting
        // review, and a session's finished work otherwise buries it. Persisted so the toggle survives a
        // panel hide, a project reopen, and an IDE restart — a filter that silently resets is a filter the
        // reader has to re-check every time.
        var overviewActiveOnly: Boolean = true
        /** Which of the bottom dock's side panes are shown. The Overview is always shown — it is the
         *  reason the window exists — but Prompts and Stats are columns that squeeze it on a short dock,
         *  so each can be folded away and comes back where you left it. */
        // Unused since 0.9.0 (Prompts moved to the Observatory Timeline tool window) — kept so old
        // settings XML carrying it still round-trips; remove after a deprecation release.
        var dashShowPrompts: Boolean = true
        var dashShowStats: Boolean = true
        // Where the Overview's master/detail divider sits, as the master's share of the panel — one value
        // per layout, because a good nav WIDTH side by side is not a good nav HEIGHT stacked. Persisted for
        // the same reason the toggle above is: a divider that resets is one the reader re-drags every time.
        var overviewSplitWide: Float = 0.25f
        var overviewSplitNarrow: Float = 0.38f

        /**
         * Show the Overview's five nav members as side-by-side columns in one tab:
         * Sessions · Workers · Processes · Tasks · Workflows.
         *
         * Off by default — it trades width for seeing all five at once, and the change map on the right is
         * what most readers are here for. Persisted, like every other layout choice on that panel.
         */
        var overviewGroupedNav: Boolean = false

        /** How the change map and Review tree are ordered — one of `time` (newest first, the default),
         *  `time-asc` (oldest first), `name` (path A→Z), `name-desc` (Z→A). Persisted, like the other
         *  layout choices here; an unknown value falls back to `time` on read. */
        var overviewSort: String = "time"

        // The master/detail divider again, for GROUPED mode. Grouped columns need a wider nav than five
        // stacked tabs do, so reusing one value per orientation would leave the reader re-dragging the
        // divider on every toggle. Same two-orientation pairing as the plain fields above.
        var overviewSplitWideGrouped: Float = 0.45f
        var overviewSplitNarrowGrouped: Float = 0.55f

        /**
         * Fold the Timeline's four tabs — Feed · Prompts · Observations · Actions — into ONE view showing all
         * four as columns.
         *
         * A SEPARATE flag from [overviewGroupedNav] on purpose: they are different windows of different
         * widths, and a reader who wants the Timeline's four surfaces at once has said nothing about the
         * Overview's five nav tabs.
         */
        var timelineGroupedNav: Boolean = false

        /**
         * Grouped mode's column widths: `"<group>:<divider index>"` → that divider's proportion, counted
         * from the left. Shared by both windows' groups; see
         * [com.cellobservatory.observatory.model.ColumnLayout.dividerKey].
         *
         * A map rather than a field per divider because both windows feed it. Missing key = the shipped default, so an older settings file simply starts from it.
         */
        var columnSplits: MutableMap<String, Float> = LinkedHashMap()

        /** Grouped mode's folded columns, by member name — the reader's own choice about their screen, so
         *  it survives a restart like every other layout state here. */
        var collapsedColumns: MutableList<String> = ArrayList()

        // Read-only derivations of [editorReviewSurface], so its four spellings are interpreted in ONE
        // place. Get-only, therefore never serialized into claude-observatory.xml.
        /** True when the editor-top notification banner should be built. */
        val bannerSurface: Boolean get() = editorReviewSurface == BANNER || editorReviewSurface == BOTH

        /** True when the floating bar over the code should be shown. An UNRECOGNIZED value reads as the
         *  default rather than as "nothing": a hand-edited typo must not silently strip every review
         *  control out of the editor with no way to notice. */
        val floatingSurface: Boolean get() = editorReviewSurface != BANNER && editorReviewSurface != NONE
    }

    private var myState = State()
    override fun getState(): State = myState
    override fun loadState(state: State) {
        // The Timeline's `agent` member became `conversation` in 0.10.0, and Conversation folded into
        // the Feed (2026-09-23). A layout written before either change may still fold a column under a
        // retired key, which now matches no member. Drop those keys on the way in rather than
        // transferring the fold to the Feed — the Feed column keeps its own state. A new list, because
        // the deserializer's own is not guaranteed to be mutable.
        state.collapsedColumns = state.collapsedColumns.filterTo(ArrayList()) { it != "agent" && it != "conversation" }
        state.columnSplits = state.columnSplits.filterKeys { !it.startsWith("timeline:") }.toMutableMap()
        myState = state
    }

    companion object {
        val instance: ObservatorySettings
            get() = ApplicationManager.getApplication().getService(ObservatorySettings::class.java)

        // The four spellings [State.editorReviewSurface] admits, named once so the state, the Settings
        // combo and the two consumers cannot disagree about them.
        const val FLOATING = "floating"
        const val BANNER = "banner"
        const val BOTH = "both"
        const val NONE = "none"
    }
}

class ObservatoryConfigurable : Configurable {
    private val observatoryBin = JBTextField()
    private val claudeBin = JBTextField()
    private val configDir = JBTextField()
    private val session = JBTextField()
    private val inlineReview = JBCheckBox("Inline review overlay (lenses and line highlights in the editor)")
    private val unifiedDiff = JBCheckBox("Show edit diffs in the unified (inline) viewer instead of side-by-side")
    private val revealNextOnResolve =
        JBCheckBox("After keeping or reverting one edit, open the next edit still awaiting review")
    private val overviewGroupedNav =
        JBCheckBox("Group all tabs side by side (Sessions · Workers · Processes · Tasks · Workflows)")
    /** Label ⟷ stored value for the review-surface combo. A combo of raw values would put "floating" on
     *  screen, which says nothing about where the chrome appears. */
    private val surfaceLabels = linkedMapOf(
        ObservatorySettings.FLOATING to "Floating bar over the code",
        ObservatorySettings.BANNER to "Banner above the editor",
        ObservatorySettings.BOTH to "Both the floating bar and the banner",
        ObservatorySettings.NONE to "Neither",
    )
    private val editorReviewSurface =
        com.intellij.openapi.ui.ComboBox(surfaceLabels.values.toTypedArray())
    private var panel: JPanel? = null

    // oak sync's state and its changes, through the CLI (SyncOps). Its truth is prefs.json, which only the CLI writes for
    // sync, so this page keeps no copy of it, and Apply and Reset leave it alone.
    private val syncHead = com.intellij.ui.TitledSeparator("Sync across machines (oak sync)")
    private val syncText = com.intellij.ui.components.JBLabel().apply { setAllowAutoWrapping(true); setCopyable(true) }
    private val syncRecord = javax.swing.JButton("This Machine Is a Reinstall…")
    private val syncButtons = JPanel(java.awt.FlowLayout(java.awt.FlowLayout.LEFT, 0, 0)).apply {
        add(javax.swing.JButton("Sync Now").apply { addActionListener { com.cellobservatory.observatory.ui.SyncOps.syncNow(syncProject(it)) } })
        add(javax.swing.JButton("Set Up or Change the Backup…").apply { addActionListener { com.cellobservatory.observatory.ui.SyncOps.setup(syncProject(it)) } })
        add(javax.swing.JButton("Machines and Projects…").apply { addActionListener { com.cellobservatory.observatory.ui.SyncOps.chooseSynced(syncProject(it)) } })
        add(syncRecord.apply { addActionListener { com.cellobservatory.observatory.ui.SyncOps.takeRecordOver(syncProject(it)) } })
    }
    private var syncWatch: com.intellij.openapi.Disposable? = null
    /** Whether a machine is saved here (`oak machine list`); null until it answers. With none, and sync not in use, the
     *  section is not shown: a machine that never chose to sync is shown nothing new. */
    @Volatile private var syncSaved: Boolean? = null
    /** The project the sync actions report in: the one whose window this page was opened from (its data context), else,
     *  this page being the application's, the first one open. */
    private fun syncProject(e: java.awt.event.ActionEvent): com.intellij.openapi.project.Project? =
        (e.source as? java.awt.Component)?.let { com.intellij.openapi.actionSystem.CommonDataKeys.PROJECT.getData(com.intellij.ide.DataManager.getInstance().getDataContext(it)) }
            ?: com.intellij.openapi.project.ProjectManager.getInstance().openProjects.firstOrNull()
    private fun showSync() {
        val v = com.cellobservatory.observatory.ui.SyncOps.view
        val shown = v?.inUse == true || syncSaved == true
        listOf(syncHead, syncText, syncButtons).forEach { it.isVisible = shown }
        syncRecord.isVisible = v?.backupLine?.record != null
        syncText.text = "<html>" + when {
            v == null -> "oak sync's state comes from the oak CLI (oak sync status); it has not answered yet."
            !v.inUse -> "Sync is not set up here. Set it up to share memory, plans, skills, agents and commands with the saved machines, " +
                "and to choose where sessions are backed up."
            else -> (listOf("Backup: ${v.backupText}", "Last run: ${v.runText}") + listOfNotNull(v.lastError?.let { "the run stopped: $it" }) +
                v.lines.map { "${it.label}: ${it.said}" } +
                listOfNotNull(v.conflicts.size.takeIf { it > 0 }?.let { "$it open conflict${if (it == 1) "" else "s"}: the Overview's Sessions tab has ${if (it == 1) "it" else "them"}" }) +
                v.warnings.map { "warning: $it" }).joinToString("<br>") { com.cellobservatory.observatory.ui.escHtml(it) }
        } + "</html>"
    }

    /** The stored value the combo is showing, defaulting to `floating` — the same reading of an
     *  unrecognized value that [ObservatorySettings.State.floatingSurface] takes. */
    private fun selectedSurface(): String =
        surfaceLabels.entries.firstOrNull { it.value == editorReviewSurface.item }?.key
            ?: ObservatorySettings.FLOATING

    override fun getDisplayName() = "OAK"

    override fun createComponent(): JComponent {
        panel = FormBuilder.createFormBuilder()
            .addLabeledComponent("oak CLI path (blank = auto-detect):", observatoryBin, 1, false)
            .addLabeledComponent("claude CLI path for Analyze (blank = auto-detect):", claudeBin, 1, false)
            .addLabeledComponent("Claude config dir (blank = \$CLAUDE_CONFIG_DIR, then ~/.claude):", configDir, 1, false)
            .addLabeledComponent("Pinned session (blank = auto-resolve newest):", session, 1, false)
            .addComponent(inlineReview)
            .addComponent(unifiedDiff)
            .addLabeledComponent("Review controls in the editor:", editorReviewSurface, 1, false)
            .addComponent(revealNextOnResolve)
            .addComponent(overviewGroupedNav)
            .addComponent(syncHead)
            .addComponent(syncText)
            .addComponent(syncButtons)
            .addComponentFillVertically(JPanel(), 0)
            .panel
        reset()
        syncWatch = com.intellij.openapi.util.Disposer.newDisposable("OAK settings: sync").also { com.cellobservatory.observatory.ui.SyncOps.addListener(it) { showSync() } }
        showSync()
        com.cellobservatory.observatory.ui.SyncOps.refresh(force = true)
        // Off the EDT: herdr's list. Told in any modality, since this page is a modal dialog's.
        com.intellij.openapi.application.ApplicationManager.getApplication().executeOnPooledThread {
            val saved = com.cellobservatory.observatory.core.ObservatoryCli.machineLabels(null).isNotEmpty()
            com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater({ syncSaved = saved; showSync() }, com.intellij.openapi.application.ModalityState.any())
        }
        return panel!!
    }

    override fun disposeUIResources() {
        syncWatch?.let { com.intellij.openapi.util.Disposer.dispose(it) }
        syncWatch = null
    }

    override fun isModified(): Boolean {
        val s = ObservatorySettings.instance.state
        return observatoryBin.text != (s.observatoryBin ?: "") ||
            claudeBin.text != (s.claudeBin ?: "") ||
            configDir.text != (s.configDir ?: "") ||
            session.text != (s.session ?: "") ||
            inlineReview.isSelected != s.inlineReview ||
            unifiedDiff.isSelected != s.unifiedDiff ||
            revealNextOnResolve.isSelected != s.revealNextOnResolve ||
            overviewGroupedNav.isSelected != s.overviewGroupedNav ||
            selectedSurface() != s.editorReviewSurface
    }

    override fun apply() {
        val s = ObservatorySettings.instance.state
        s.observatoryBin = observatoryBin.text.ifBlank { null }
        s.claudeBin = claudeBin.text.ifBlank { null }
        s.configDir = configDir.text.ifBlank { null }
        s.session = session.text.ifBlank { null }
        s.inlineReview = inlineReview.isSelected
        s.unifiedDiff = unifiedDiff.isSelected
        s.revealNextOnResolve = revealNextOnResolve.isSelected
        s.overviewGroupedNav = overviewGroupedNav.isSelected
        s.editorReviewSurface = selectedSurface()
        // Re-render every open project so a config-dir change or overlay toggle applies immediately.
        for (p in com.intellij.openapi.project.ProjectManager.getInstance().openProjects) {
            com.cellobservatory.observatory.services.ObservatoryService.getInstance(p).refresh()
            // The banner is built by a notification provider, which the service refresh above only
            // reaches through the hook ObservatoryStartup installs — but the review-surface switch has to
            // take effect on THIS Apply, not on the next store write.
            com.intellij.ui.EditorNotifications.getInstance(p).updateAllNotifications()
        }
        // The nav STRUCTURE is not something a data refresh rebuilds, so the grouping toggle needs its own
        // re-apply — otherwise flipping it here would only show up on the next IDE start.
        com.cellobservatory.observatory.ui.ChangeMapPanel.applyNavGrouping()
    }

    override fun reset() {
        val s = ObservatorySettings.instance.state
        observatoryBin.text = s.observatoryBin ?: ""
        claudeBin.text = s.claudeBin ?: ""
        configDir.text = s.configDir ?: ""
        session.text = s.session ?: ""
        inlineReview.isSelected = s.inlineReview
        unifiedDiff.isSelected = s.unifiedDiff
        revealNextOnResolve.isSelected = s.revealNextOnResolve
        overviewGroupedNav.isSelected = s.overviewGroupedNav
        editorReviewSurface.item = surfaceLabels[s.editorReviewSurface] ?: surfaceLabels[ObservatorySettings.FLOATING]
    }
}
