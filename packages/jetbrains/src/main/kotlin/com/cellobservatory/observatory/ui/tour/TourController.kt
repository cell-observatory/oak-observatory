package com.cellobservatory.observatory.ui.tour

import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.model.DemoStep
import com.cellobservatory.observatory.ui.ChangeMapPanel
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindowAnchor
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPanel
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.BorderLayout
import java.awt.FlowLayout
import javax.swing.JButton
import javax.swing.JComponent

/**
 * The guided tour (0.8.9), JetBrains side. Walks the same steps in the same order as the CLI and the
 * VS Code panel — the script is core's (`demo --tour --json`), never written here.
 *
 * The tour lives in a DOCKED tool window on the right, inside the IDE. It had a floating non-modal
 * dialog too; that window never appeared in PyCharm 2025.2 and was removed rather than carried as a
 * control that does nothing. VS Code keeps its own detach — it drives the platform's own
 * move-editor-to-new-window, which works — so the two editors differ here on purpose.
 *
 * It can never be a TAB of the existing OAK window: that window's panes are `Content`s
 * and only one shows at a time, so the step that says "look at the Review list" would hide the tour
 * explaining it.
 *
 * A step's TEXT lives in the tour window only. The control it names is RINGED, by a glass-pane painter —
 * Swing's equivalent of a CSS outline: it paints above the component and costs no layout, where a border
 * would add insets and reflow the very panel the reader is being pointed at.
 */
@Service(Service.Level.PROJECT)
class TourController(private val project: Project) : com.intellij.openapi.Disposable {

    /** Closing the project with the tour open reaches no other teardown. Without this the 1 Hz countdown
     *  task reschedules itself forever, because its body returns on `project.isDisposed` without
     *  cancelling. */
    override fun dispose() {
        stopAutoplay()
        if (watch != null) service().removeListener(watchListener)
        watch = null
        ring(null)
    }

    companion object {
        const val TOOL_WINDOW_ID = "OAK Tour"
        fun getInstance(project: Project): TourController = project.service()
    }

    private var steps: List<DemoStep> = emptyList()
    /** Set while the SHORT track is being walked, with its exact complement parked for the offer at the end.
     *  Core owns the split (`demo --tour --essentials` is the marked subset); this is just the other half. */
    private var essentialsTrack = false
    private var remainder: List<DemoStep> = emptyList()
    private var index = -1
    private var ringDisposable: com.intellij.openapi.Disposable? = null
    /** The wait step currently armed. No timer and no new watcher — the service already fires on every
     *  store change, and the verdict itself is core's, so both editors reach the same one. */
    private var watch: Watch? = null
    private var litSpotlight = false
    private val watchListener = Runnable { checkWatch() }

    /**
     * Autoplay. ONE timer per step, which is also a wait step's countdown — that single timer is what
     * makes pausing actually pause. (The site's browser demo keeps them separate, so pausing there stops
     * the step timer but not the gate countdown, and a paused demo still drifts forward.)
     *
     * The platform exposes no reduced-motion signal, so unlike the VS Code build this always starts
     * playing; the transport button is the control.
     */
    private var playing = true
    private var stepFuture: java.util.concurrent.ScheduledFuture<*>? = null
    private var tickFuture: java.util.concurrent.ScheduledFuture<*>? = null
    private var deadlineMs = 0L
    private val playBtn by lazy { JButton("❚❚") }

    private fun stopAutoplay() {
        stepFuture?.cancel(false); stepFuture = null
        tickFuture?.cancel(false); tickFuture = null
    }

    /** Pause. Every manual control routes through here — taking the wheel is explicit. */
    private fun pauseAutoplay() {
        playing = false
        stopAutoplay()
        playBtn.text = "▸"
        renderAction(steps.getOrNull(index)?.action, watch?.state)
    }

    private fun armAutoplay() {
        stopAutoplay()
        if (!playing || !running) return
        val step = steps.getOrNull(index) ?: return
        if (index + 1 >= steps.size) { pauseAutoplay(); return } // the last step is an offer, not a frame
        val waiting = step.action?.mode == "wait"
        val ms = if (waiting) 9_000L else dwellMs(step)
        deadlineMs = System.currentTimeMillis() + ms
        playBtn.text = "❚❚"
        val sched = com.intellij.util.concurrency.EdtScheduledExecutorService.getInstance()
        tickFuture = sched.scheduleWithFixedDelay(
            { if (!project.isDisposed) renderAction(step.action, watch?.state) }, 1, 1, java.util.concurrent.TimeUnit.SECONDS
        )
        stepFuture = sched.schedule({ if (!project.isDisposed) expire(step) }, ms, java.util.concurrent.TimeUnit.MILLISECONDS)
    }

    /** The timer ran out. A reading step moves on; an unanswered ask is performed, then moves on. */
    private fun expire(step: DemoStep) {
        stopAutoplay()
        if (!playing || !running) return
        if (step.action?.mode == "wait" && watch?.state == "waiting") {
            performWaitAction(step.action.kind)
            com.cellobservatory.observatory.services.ObservatoryService.getInstance(project).refresh(force = true)
            watch?.state = "satisfied"
            renderAction(step.action, "satisfied")
            // Show the result before moving — the point of doing it was that the reader sees it happen.
            stepFuture = com.intellij.util.concurrency.EdtScheduledExecutorService.getInstance()
                .schedule({ if (playing && running) applyStep(index + 1) }, 1400, java.util.concurrent.TimeUnit.MILLISECONDS)
            return
        }
        applyStep(index + 1)
    }

    /** Seconds left on this step, for the countdown line. Zero when paused or not timing. */
    private fun secsLeft(): Int =
        if (!playing || stepFuture == null) 0
        else Math.max(0, Math.ceil((deadlineMs - System.currentTimeMillis()) / 1000.0).toInt())

    /** Core's reading-derived dwell, mirrored: the CLI is not spawned once per step just to ask. */
    private fun dwellMs(step: DemoStep): Long {
        val chars = step.body.length + (step.tip?.length ?: 0) + (step.tryIt?.length ?: 0)
        return Math.min(9_000L, Math.max(3_500L, Math.round(chars / 46.0 * 1000)))
    }

    /** Perform an unanswered ask, through the handlers the product already ships. */
    private fun performWaitAction(kind: String) {
        val session = service().currentSession() ?: return
        // Belt and braces: this ACCEPTS AND REVERTS EDITS, on a timer, with nobody watching. It must
        // never touch a session the reader actually cares about, whatever route got us here.
        if (!ObservatoryCli.isDemoSession(session)) return
        val log = service().log()
        when (kind) {
            "keep-edit" -> log.firstOrNull { it.pending }?.let { com.cellobservatory.observatory.ui.ReviewOps.keep(project, session, it.id) }
            "undo-edit" -> log.firstOrNull { it.pending }?.let { com.cellobservatory.observatory.ui.ReviewOps.undoOrRedo(project, session, it, false) }
            "keep-prompt" -> keepFirstPendingPrompt()
            else -> {}
        }
    }

    private data class Watch(val kind: String, val beforeKept: Int, val beforeUndone: Int, var state: String)

    /** Mirrors core's `demoActionState`. The rule itself lives in [com.cellobservatory.observatory.model.TourVerdict]
     *  so a test can pin it without a Project — it is a second implementation of core's rule, and the
     *  only thing keeping the editors in agreement is that it says the same thing. */
    private fun verdict(w: Watch, log: List<com.cellobservatory.observatory.model.EditRecord>): String =
        com.cellobservatory.observatory.model.TourVerdict.of(
            kind = w.kind,
            beforeKept = w.beforeKept,
            beforeUndone = w.beforeUndone,
            kept = log.count { it.status == "kept" },
            undone = log.count { it.status == "undone" },
            pending = log.count { it.pending },
            total = log.size,
        )

    // Built LAZILY, on the EDT, when the tour window is first opened. This is a project service, and
    // `TourNextAction.update()` runs on a background thread (SessionAction declares ActionUpdateThread.BGT)
    // — typing "guided tour" into Find Action instantiates the service, so constructing Swing components
    // in its constructor would build them off the EDT before any tour had run.
    private val counter by lazy { JBLabel() }
    private val title by lazy { JBLabel() }
    private val body by lazy { JBLabel() }
    private val tip by lazy { JBLabel() }
    private val tryIt by lazy { JBLabel() }
    private val actionLabel by lazy { JBLabel() }
    private val actionHint by lazy { JBLabel() }
    private val actionState by lazy { JBLabel() }
    private val backBtn by lazy { JButton("◂ Back") }
    private val nextBtn by lazy { JButton("Next ▸") }

    val running: Boolean get() = index >= 0

    /** Fetch the script (off the EDT — it spawns the CLI), ask how much of it to walk, then open. */
    fun start(onFailure: (String) -> Unit = {}) {
        // The tour ACTS on the session under review — it accepts and reverts edits, some on a timer — so
        // it may only run against the demo. `demoPresent` is true whenever a demo exists on disk, which
        // is deliberately weaker: one real Claude turn after a demo makes that the newest session.
        val service = service()
        if (!ObservatoryCli.isDemoSession(service.currentSession())) {
            val found = ObservatoryCli.demoSession(project.basePath)
            if (found == null) {
                onFailure("The guided tour runs against the demo session, and there is no demo recorded for this project. Start Demo Mode first.")
                return
            }
            service.demoSessionOverride = found
        }
        com.intellij.util.concurrency.AppExecutorUtil.getAppExecutorService().submit {
            val full = ObservatoryCli.demoTour(project.basePath, essentials = false)
            val short = ObservatoryCli.demoTour(project.basePath, essentials = true)
            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) return@invokeLater
                if (full.isEmpty()) {
                    // Never open an empty tour: say why instead (an older CLI on PATH is the usual cause).
                    onFailure("Could not read the guided tour — is the oak CLI installed and up to date?")
                    return@invokeLater
                }
                val essentialsLabel = "Essentials — ${short.size} steps"
                val everythingLabel = "Everything — ${full.size} steps"
                com.intellij.openapi.ui.popup.JBPopupFactory.getInstance()
                    .createPopupChooserBuilder(listOfNotNull(essentialsLabel.takeIf { short.isNotEmpty() }, everythingLabel))
                    .setTitle("Guided tour — how much would you like to see?")
                    .setItemChosenCallback { chosen ->
                        val isShort = chosen == essentialsLabel
                        begin(
                            script = if (isShort) short else full,
                            rest = if (isShort) full.filterNot { f -> short.any { it.id == f.id } } else emptyList(),
                            isEssentials = isShort,
                        )
                    }
                    .createPopup()
                    .showCenteredInCurrentWindow(project)
            }
        }
    }

    /**
     * Open a track and show its first step. The ONLY path into a running tour — the chooser callback and
     * the test seam both come through here, so a test cannot accidentally skip setup the real path does.
     * (It did: an earlier seam duplicated three of these lines and silently missed the fourth.)
     */
    private fun begin(script: List<DemoStep>, rest: List<DemoStep>, isEssentials: Boolean, play: Boolean = true) {
        essentialsTrack = isEssentials
        remainder = rest
        steps = script
        playing = play
        // The tour narrates rows Active only hides; hand the reader's own filter back in stop().
        ChangeMapPanel.of(project)?.setShowAll(true)
        // Unfold the dock's side panes for the duration. Seven of the forty-one steps ring a control
        // inside Prompts or Stats — `prompts` and `finish` are on the Essentials track — and a folded
        // pane is not showing, so `ring()` bails and the step narrates a panel the reader cannot see.
        // Restored in stop(), exactly like the Active-only filter above.
        foldedStats = !settings().dashShowStats
        if (foldedStats) setDockPanes(stats = true)
        openWindow()
        applyStep(0)
    }

    /**
     * Test seam: walk a script without the track chooser, which is a popup and cannot open headlessly.
     * Autoplay is left OFF so a test steps deterministically instead of racing timers. Everything else
     * goes through [begin], the same function the chooser uses — this is the only feature here that no
     * other kind of test can reach, so the seam has to be faithful or it is worse than nothing.
     */
    @org.jetbrains.annotations.TestOnly
    internal fun driveForTest(script: List<DemoStep>) =
        begin(script, rest = emptyList(), isEssentials = false, play = false)

    // Every manual control hands over the wheel: autoplay stops and only the transport restarts it.
    fun next() {
        if (!running) return
        pauseAutoplay()
        if (index + 1 >= steps.size) finish() else applyStep(index + 1)
    }

    fun back() {
        if (!running || index <= 0) return
        pauseAutoplay()
        applyStep(index - 1)
    }

    fun playPause() {
        if (playing) { pauseAutoplay(); return }
        playing = true
        armAutoplay()
    }

    /** Jump straight to a step — the counterpart of the VS Code panel's dot row, so neither editor can
     *  only be walked forwards. Offered as a chooser rather than dots because forty-one dots in a Swing
     *  strip say less than forty-one titles. */
    private fun chooseStep(anchor: JComponent) {
        if (!running) return
        val labels = steps.mapIndexed { i, s -> "${i + 1}. ${s.title}" }
        com.intellij.openapi.ui.popup.JBPopupFactory.getInstance()
            .createPopupChooserBuilder(labels)
            .setTitle("Go to step")
            .setSelectedValue(labels.getOrNull(index), true)
            .setItemChosenCallback { chosen -> pauseAutoplay(); applyStep(labels.indexOf(chosen)) }
            .createPopup()
            .showUnderneathOf(anchor)
    }

    // --- action steps ---------------------------------------------------------------------------

    private fun service() = com.cellobservatory.observatory.services.ObservatoryService.getInstance(project)

    private fun settings() = com.cellobservatory.observatory.settings.ObservatorySettings.instance.state

    /** Whether the tour unfolded the dock's Stats pane, so stop() can put it back. (Prompts is its own
     *  tool window since 0.9.0 — showing it needs no fold bookkeeping.) */
    private var foldedStats = false

    /** Show or hide the Dashboards Stats pane, through the same path the title-bar toggle uses. */
    private fun setDockPanes(stats: Boolean) {
        settings().dashShowStats = stats
        com.cellobservatory.observatory.ui.ObservatoryDashboardsFactory.applyPanes(project)
    }

    /** Disarm, and put back anything an `auto` step changed about the reader's editor. */
    private fun disarm() {
        if (watch != null) {
            service().removeListener(watchListener)
            watch = null
        }
        if (litSpotlight) {
            litSpotlight = false
            com.cellobservatory.observatory.ui.inline.InlineOverlay.getInstance(project).toggleHeatmap()
        }
    }

    /**
     * Arm a `wait` step, or run an `auto` one. The verdict for a wait step is core's
     * (`demoActionState`), mirrored here so the two editors cannot disagree about what "done" means —
     * including the case that matters, where a fully reviewed demo drops its own records and the log
     * going EMPTY is itself the answer rather than a reason to keep waiting.
     */
    private fun armOrRun(step: DemoStep) {
        val a = step.action ?: return
        if (a.mode == "auto") {
            // Did it actually run? An auto step that no-ops (nothing pending, no demo pinned, the panel
            // not built yet) must not print its past-tense line — the reader can see nothing happened.
            var ran = false
            when (a.kind) {
                "toggle-spotlight" -> {
                    // Turn it ON, never merely flip it: a reader who already had Spotlight lit would
                    // otherwise watch it go OUT under a panel announcing that it came on.
                    val overlay = com.cellobservatory.observatory.ui.inline.InlineOverlay.getInstance(project)
                    if (!overlay.heatmapOn) {
                        overlay.toggleHeatmap()
                        litSpotlight = true // only ours to put back if we were the one who lit it
                    }
                    ran = true
                }
                "keep-task" -> ran = keepFirstPendingTask()
                // activate()'s editor branch already ran this one — but only if it found a file it could
                // open, which is exactly the case this flag exists to report.
                "open-demo-file" -> ran = openedDemoFile
                else -> {}
            }
            renderAction(a, if (ran) "satisfied" else "vacated")
            return
        }
        val log = service().log()
        watch = Watch(a.kind, log.count { it.status == "kept" }, log.count { it.status == "undone" }, "waiting")
        service().addListener(watchListener)
        checkWatch()
    }

    private fun checkWatch() {
        val w = watch ?: return
        val log = service().log()
        val state = verdict(w, log)
        if (state == w.state) return
        w.state = state
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            renderAction(steps.getOrNull(index)?.action, state)
            // The reader did it — cancel the countdown and move on after the same beat the timer would
            // have used, so doing it yourself and letting it happen feel like the same tour (VS Code parity).
            if (state != "waiting" && playing) {
                stopAutoplay()
                val at = index
                stepFuture = com.intellij.util.concurrency.EdtScheduledExecutorService.getInstance()
                    .schedule({ if (playing && index == at) applyStep(at + 1) }, 1400, java.util.concurrent.TimeUnit.MILLISECONDS)
            }
        }
    }

    /** Accept the first task that still has pending edits, resolved from the DATA — not from the rendered
     *  rows, which Active only (on by default) strips of every completed task, and five of the demo's six
     *  are completed. Returns whether it actually accepted anything. */
    private fun keepFirstPendingTask(): Boolean {
        val session = service().currentSession() ?: return false
        if (!ObservatoryCli.isDemoSession(session)) return false // never accept a real session's work
        val (taskId, label) = ChangeMapPanel.of(project)?.firstPendingTaskInData() ?: return false
        com.cellobservatory.observatory.ui.ReviewOps.keepTask(project, session, taskId, label)
        return true
    }

    /** Accept every pending edit of the first ask that still has some — the prompt-scoped accept the step
     *  actually names. VS Code runs `promptKeep`; this is the same set of edits, through the same store. */
    private fun keepFirstPendingPrompt(): Boolean {
        val session = service().currentSession() ?: return false
        if (!ObservatoryCli.isDemoSession(session)) return false
        val prompt = service().prompts()?.prompts?.firstOrNull { it.pending > 0 } ?: return false
        val ids = prompt.editIds.toHashSet()
        val targets = service().log().filter { it.id in ids && it.pending }
        if (targets.isEmpty()) return false
        com.cellobservatory.observatory.ui.ReviewOps.keepAll(project, session, targets, "prompt #${prompt.index}")
        return true
    }

    /** Paint the action block. Exactly two labels, one geometry — a mixed script reads as inconsistent
     *  unless the reader can tell at a glance which kind of step they are on. */
    private fun renderAction(a: com.cellobservatory.observatory.model.DemoAction?, state: String?) {
        if (a == null) {
            actionLabel.isVisible = false; actionHint.isVisible = false; actionState.isVisible = false
            nextBtn.text = if (index + 1 >= steps.size) "Finish" else "Next ▸"
            return
        }
        val auto = a.mode == "auto"
        // An auto step that did NOT run says so, and drops the past-tense line with it: claiming
        // "accepted a task — its files went green" over a screen where nothing moved is worse than silence.
        val ranNothing = auto && state == "vacated"
        actionLabel.isVisible = true; actionHint.isVisible = true; actionState.isVisible = true
        actionLabel.text = if (auto) "THE TOUR DID THIS" else "YOUR TURN"
        actionHint.text = wrapHtml(if (!auto) a.hint else if (ranNothing) a.hint else (a.done ?: a.hint))
        val waiting = !auto && state != "satisfied" && state != "vacated"
        val secs = secsLeft()
        actionState.text = when {
            ranNothing -> "— nothing left here to do it to"
            auto || state == "satisfied" -> "✓ done"
            state == "vacated" -> "✓ nothing left to review here"
            // Under autoplay, say plainly that it will apply itself: a reader who does nothing is not
            // being ignored, and one who wants to act can see exactly how long they have.
            secs > 0 -> "◌ applies automatically in ${secs}s…"
            else -> "◌ waiting…"
        }
        // Next is RELABELLED, never disabled: nothing about an action may trap the reader.
        nextBtn.text = if (waiting) "Skip ▸" else if (index + 1 >= steps.size) "Finish" else "Next ▸"
    }

    /** End the tour and take its window away. Safe to call when no tour is running. */
    fun stop() {
        index = -1
        stopAutoplay()
        lastRing = null
        windowShown = false
        disarm()
        ChangeMapPanel.of(project)?.setShowAll(false)
        // Give back exactly what the reader had before the tour opened them.
        if (foldedStats) {
            setDockPanes(stats = false)
            foldedStats = false
        }
        ring(null)
        closeWindow()
    }

    /**
     * The end of a track. After the short one, offer its exact complement rather than just closing: the
     * reader chose Essentials without knowing what was in the other half, and this is the only place they
     * are told. Dismissing the offer ends the tour — an unanswered question is not consent to keep going.
     */
    private fun finish() {
        if (!essentialsTrack || remainder.isEmpty()) { stop(); return }
        pauseAutoplay()
        val go = "See the other ${remainder.size}"
        val blurb = "That is the short track. ${remainder.size} more steps cover the rest of the panels " +
            "and the features this one skipped."
        com.intellij.openapi.ui.popup.JBPopupFactory.getInstance()
            .createPopupChooserBuilder(listOf(go, "Done"))
            .setTitle(blurb)
            .setItemChosenCallback { chosen ->
                if (chosen != go) { stop(); return@setItemChosenCallback }
                begin(remainder, rest = emptyList(), isEssentials = false)
            }
            .setCancelCallback { stop(); true }
            .createPopup()
            .showCenteredInCurrentWindow(project)
    }

    // --- the window -----------------------------------------------------------------------------

    private fun openWindow() = ensureToolWindow()

    private fun closeWindow() {
        // Hide, never remove: the window is declared, so removing it takes the platform's own
        // registration with it and it cannot be brought back without an IDE restart.
        ToolWindowManager.getInstance(project).getToolWindow(TOOL_WINDOW_ID)?.let {
            it.isAvailable = false
        }
    }

    /** Subscribed once, for the project's lifetime. A tour whose window is not on screen must not keep
     *  ACTING — its wait steps accept and revert edits on a nine-second timer, and doing that behind a
     *  window the reader cannot see is the worst thing this feature could do.
     *
     *  It PAUSES rather than ends: the window also hides when the reader activates any other tool window
     *  on the same anchor, and losing the whole tour to a misclick on a stripe button would be its own
     *  defect. Bringing it back re-draws the ring; resuming stays the reader's to ask for, like every
     *  other manual control. */
    private var hideWatch: com.intellij.openapi.Disposable? = null
    /** Last known visibility of the tour's tool window, so the listener acts on TRANSITIONS only —
     *  stateChanged fires for every tool window in the project, many times per step. */
    private var windowShown = false
    /** The control the current step rings, kept so hiding and re-showing the window restores it. */
    private var lastRing: JComponent? = null

    private fun watchForHide() {
        if (hideWatch != null) return
        val d = com.intellij.openapi.util.Disposer.newDisposable("observatory-tour-hide")
        com.intellij.openapi.util.Disposer.register(this, d)
        hideWatch = d
        project.messageBus.connect(d).subscribe(
            com.intellij.openapi.wm.ex.ToolWindowManagerListener.TOPIC,
            object : com.intellij.openapi.wm.ex.ToolWindowManagerListener {
                override fun stateChanged(mgr: ToolWindowManager) {
                    if (!running) return
                    val tw = mgr.getToolWindow(TOOL_WINDOW_ID) ?: return
                    val visible = tw.isVisible
                    if (visible == windowShown) return // only the transitions matter
                    windowShown = visible
                    if (!visible) {
                        pauseAutoplay()
                        ring(null) // no outline pointing at a control the tour can no longer explain
                    } else {
                        ring(lastRing) // back on screen: point at the step's control again
                    }
                }
            },
        )
    }

    /** Called by [TourToolWindowFactory] when the platform builds the declared window's content. */
    internal fun fillToolWindow(tw: com.intellij.openapi.wm.ToolWindow) {
        val cm = tw.contentManager
        cm.removeAllContents(true)
        val content = cm.factory.createContent(buildPanel(), "", false)
        content.isCloseable = false
        cm.addContent(content)
    }

    private fun ensureToolWindow() {
        watchForHide()
        // The window is DECLARED in plugin.xml; making it available and activating it is the supported
        // way to bring one up on demand. Registering it here instead invoked an override-only platform
        // API — unsupported, and the kind of thing that breaks silently on an IDE update.
        val tw = ToolWindowManager.getInstance(project).getToolWindow(TOOL_WINDOW_ID)
        if (tw == null) {
            // The window is declared in plugin.xml, so this should not happen — but if it ever does, a
            // tour that runs with nothing on screen is the worst possible outcome: it keeps advancing and
            // keeps ACTING, on a timer, with no text explaining any of it. Stop and say so.
            stop()
            com.cellobservatory.observatory.ui.ReviewOps.notify(
                project,
                "OAK: could not open the guided tour window, so the tour was not started.",
                com.intellij.notification.NotificationType.WARNING,
            )
            return
        }
        tw.isAvailable = true
        tw.activate(null)
        windowShown = true // the listener acts on transitions, so seed it with the truth
    }

    private fun buildPanel(): JComponent {
        counter.foreground = UIUtil.getContextHelpForeground()
        title.font = title.font.deriveFont(java.awt.Font.BOLD, title.font.size + 1f)
        for (l in listOf(body, tip, tryIt)) l.verticalAlignment = JBLabel.TOP
        tip.foreground = UIUtil.getContextHelpForeground()
        tryIt.foreground = UIUtil.getContextHelpForeground()
        actionLabel.foreground = UIUtil.getContextHelpForeground()
        actionLabel.font = JBUI.Fonts.smallFont()
        actionState.foreground = UIUtil.getContextHelpForeground()

        val north = JBPanel<JBPanel<*>>(BorderLayout()).apply {
            isOpaque = false
            add(counter, BorderLayout.NORTH)
            add(title, BorderLayout.CENTER)
            border = JBUI.Borders.emptyBottom(6)
        }
        val center = JBPanel<JBPanel<*>>().apply {
            isOpaque = false
            layout = javax.swing.BoxLayout(this, javax.swing.BoxLayout.Y_AXIS)
            add(body); add(javax.swing.Box.createVerticalStrut(8)); add(tip)
            add(javax.swing.Box.createVerticalStrut(6)); add(tryIt)
            add(javax.swing.Box.createVerticalStrut(8)); add(actionLabel); add(actionHint); add(actionState)
        }
        val south = JBPanel<JBPanel<*>>(FlowLayout(FlowLayout.LEFT, 6, 0)).apply {
            isOpaque = false
            // Wired ONCE. These three are `by lazy` singletons and buildPanel() runs again on every
            // dock/float, so re-adding would leave Next advancing two steps and the transport toggling
            // twice — pausing and resuming in the same click, which reads as a dead button.
            if (backBtn.actionListeners.isEmpty()) backBtn.addActionListener { back() }
            if (nextBtn.actionListeners.isEmpty()) nextBtn.addActionListener { next() }
            val steps = JButton("Steps…")
            steps.addActionListener { chooseStep(steps) }
            playBtn.toolTipText = "Pause or resume the tour. Any other control pauses it too."
            if (playBtn.actionListeners.isEmpty()) playBtn.addActionListener { playPause() }
            val exit = JButton("Exit demo")
            // Exit goes through the shared handler, so leaving from here removes exactly what leaving
            // from the palette or the panel toolbar removes.
            exit.addActionListener { com.cellobservatory.observatory.ui.ReviewOps.exitDemo(project) }
            add(playBtn); add(backBtn); add(nextBtn); add(steps); add(exit)
        }
        return JBPanel<JBPanel<*>>(BorderLayout()).apply {
            border = JBUI.Borders.empty(10, 12)
            add(north, BorderLayout.NORTH)
            add(center, BorderLayout.CENTER)
            add(south, BorderLayout.SOUTH)
        }
    }

    // --- one step -------------------------------------------------------------------------------

    private fun applyStep(i: Int) {
        if (i < 0 || i >= steps.size) return
        disarm()
        index = i
        val step = steps[i]
        // Keep the fleet inside its 60s active window while the tour explains it. On STEP ADVANCE only:
        // this touches watched files, and a heartbeat driven by a refresh would wake itself forever.
        com.intellij.util.concurrency.AppExecutorUtil.getAppExecutorService().submit {
            ObservatoryCli.demoTouch(project.basePath)
        }
        counter.text = "${i + 1} / ${steps.size}"
        title.text = step.title
        body.text = wrapHtml(step.body)
        tip.text = step.tip?.let { wrapHtml(it) } ?: ""
        tip.isVisible = !step.tip.isNullOrBlank()
        tryIt.text = step.tryIt?.let { wrapHtml("Try: $it") } ?: ""
        tryIt.isVisible = !step.tryIt.isNullOrBlank()
        backBtn.isEnabled = i > 0
        nextBtn.text = if (i + 1 >= steps.size) "Finish" else "Next ▸"

        ring(null) // clear the previous step's ring before anything moves
        lastRing = null
        val anchor = activate(step)
        // Re-raise the tour LAST so the reader ends up looking at the text, not at what it just moved.
        ToolWindowManager.getInstance(project).getToolWindow(TOOL_WINDOW_ID)?.show(null)
        lastRing = anchor
        ring(anchor)
        // After the surface is forward, so the reader can see the thing before being asked to act on it.
        renderAction(step.action, null)
        armOrRun(step)
        armAutoplay()
    }

    /** Bring the surface this step is about forward, and return the component to point the tip at.
     *  An unrecognized view activates nothing and returns null — the step still reads. */
    private fun activate(step: DemoStep): JComponent? {
        val mgr = ToolWindowManager.getInstance(project)
        return when (step.view) {
            "overview", "stats" -> {
                mgr.getToolWindow("Observatory Dashboards")?.show(null)
                val panel = ChangeMapPanel.of(project)
                if (step.view == "overview") step.tab?.let { panel?.selectNavTab(it) }
                // The Overview and Stats are always-visible columns of the same bottom split, so raising
                // the window IS the activation. The anchor then decides WHICH control is ringed, by
                // asking every panel: names are globally unique, so exactly one answers.
                com.cellobservatory.observatory.ui.stats.StatsPanel.of(project)?.tourAnchor(step.anchor)
                    ?: panel?.tourAnchor(step.anchor)
                    // No fallback to the whole panel. An outline around EVERYTHING points at nothing, and
                    // most steps carry no anchor at all — so the old fallback ringed the entire Overview
                    // for the majority of the tour. VS Code rings nothing in that case; so does this.
            }
            "prompts" -> {
                // Prompts lives in the Observatory Timeline window (0.9.0) — raise IT and bring the tab
                // forward. Since 0.10.0 that tab is a component of TimelinePanel rather than a tool-window
                // content, so the selection goes through the panel. The anchor chain keeps the
                // ChangeMapPanel because a Prompts step can ring Accept Prompt, which lives in the Overview.
                mgr.getToolWindow("Observatory Timeline")?.show(null)
                com.cellobservatory.observatory.ui.TimelinePanel.of(project)?.selectMember("prompts")
                com.cellobservatory.observatory.ui.PromptsPanel.of(project)?.tourAnchor(step.anchor)
                    ?: ChangeMapPanel.of(project)?.tourAnchor(step.anchor)
            }
            "review", "fileHistory", "actions", "observations", "feed" -> {
                // Feed, Actions and Observations belong to Timeline; Review stays in Traces.
                val inTimeline = step.view == "actions" || step.view == "observations" || step.view == "feed"
                val tw = mgr.getToolWindow(if (inTimeline) "Observatory Timeline" else "Observatory Traces") ?: return null
                tw.show(null)
                if (inTimeline) {
                    val panel = com.cellobservatory.observatory.ui.TimelinePanel.of(project)
                    panel?.selectMember(step.view)
                    // Only when the step actually names a control: an anchorless step brings the tab
                    // forward and rings nothing, rather than outlining the whole pane. The feed step's
                    // anchor is the tab body itself.
                    if (step.view == "feed") {
                        return if (step.anchor != null) {
                            com.cellobservatory.observatory.ui.FeedPanel.of(project)?.tourTarget() ?: panel
                        } else null
                    }
                    return if (step.anchor != null) panel else null
                }
                if (step.view == "review") {
                    // The Review tab narrates the PICKED ask. A reader who skipped the prompt-scope
                    // step (or autoplay) must not face the empty state mid-tour: pick the demo's
                    // second ask — the one that step talks about — exactly as its Review button would.
                    val svc = com.cellobservatory.observatory.services.ObservatoryService.getInstance(project)
                    if (svc.selectedPromptId == null) {
                        svc.prompts()?.prompts?.getOrNull(1)?.let { svc.selectedPromptId = it.id }
                    }
                }
                val name = when (step.view) {
                    "review" -> "Review"; else -> "File History"
                }
                val cm = tw.contentManager
                cm.contents.firstOrNull { it.displayName == name }?.let { cm.setSelectedContent(it) }
                if (step.anchor != null) cm.selectedContent?.component else null
            }
            // The editor: open the newest pending edit so the inline overlay has something to show. The
            // step describes reviewing in the file itself, so leaving the editor on whatever happened to
            // be open would point at nothing.
            "editor" -> {
                openedDemoFile = openNewestPendingEdit()
                null // the balloon has no stable component here; the tour panel carries the text
            }
            else -> null
        }
    }

    /** Open the file of the newest pending edit in the session under review, at that edit. */
    /** Whether the last `editor` step actually got a file open — what makes its auto action honest. */
    private var openedDemoFile = false

    private fun openNewestPendingEdit(): Boolean {
        val service = com.cellobservatory.observatory.services.ObservatoryService.getInstance(project)
        // storeKey (#43): basePath is system-independent (`C:/repo`) while record paths are OS-native
        // (`C:\repo\…`) — a raw prefix of basePath + '\' can never match on Windows.
        val base = project.basePath?.let { com.cellobservatory.observatory.core.ClaudePaths.storeKey(it) + java.io.File.separator }
        // Openable means INSIDE the workspace — the scenario's last edit is the report written outside it,
        // and the step is about the inline margins of a project file — and still ON DISK, because one edit
        // is a deletion and it becomes the newest pending the moment the reader accepts anything.
        val rec = service.log().lastOrNull {
            it.pending && (base == null || it.file.startsWith(base)) && java.io.File(it.file).isFile
        } ?: return false
        val vf = com.intellij.openapi.vfs.LocalFileSystem.getInstance().refreshAndFindFileByPath(rec.file)
            ?: return false
        com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project).openFile(vf, true)
        return true
    }

    /**
     * Ring the component a step names, on the IDE's glass pane. A painter rather than a border: a border
     * adds insets and reflows the panel being pointed at, which moves the very thing the reader is
     * looking for. Passing null clears the ring.
     */
    private fun ring(on: JComponent?) {
        ringDisposable?.let { com.intellij.openapi.util.Disposer.dispose(it) }
        ringDisposable = null
        if (on == null || !on.isShowing) return
        val d = com.intellij.openapi.util.Disposer.newDisposable("claude-observatory-tour-ring")
        try {
            com.intellij.openapi.wm.IdeGlassPaneUtil.find(on).addPainter(on, RingPainter(on), d)
            com.intellij.openapi.util.Disposer.register(project, d)
            ringDisposable = d
        } catch (_: Exception) {
            // A ring is a nicety; a step must never fail to show because it could not be painted.
            com.intellij.openapi.util.Disposer.dispose(d)
        }
    }

    /** Swing labels do not wrap; the HTML flavour does. Escaped, because the text is data. */
    private fun wrapHtml(s: String): String =
        "<html><body style='width:220px'>" +
            s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;") +
            "</body></html>"
}

/**
 * Paints the guided tour's highlight around one component, on the IDE's glass pane — above everything,
 * and outside the component's own layout, so ringing a panel never moves what is inside it.
 *
 * The colour is the accent both editors' tours already use for this (`.ov-ring` in the VS Code webview),
 * so the same step looks like the same step in either IDE.
 */
private class RingPainter(private val target: JComponent) : com.intellij.openapi.ui.AbstractPainter() {
    override fun needsRepaint(): Boolean = true // follow the component through scrolls and resizes

    override fun executePaint(component: java.awt.Component, g: java.awt.Graphics2D) {
        if (!target.isShowing) return
        var r = javax.swing.SwingUtilities.convertRectangle(target.parent ?: return, target.bounds, component)
        // The glass pane sets NO clip, and a JList inside a JBScrollPane reports its FULL bounds — so an
        // unclipped ring is drawn around the whole list, straight over the panes above and below the
        // viewport. Clip to what is actually visible; ring nothing when none of it is.
        val vis = javax.swing.SwingUtilities.convertRectangle(target, target.visibleRect, component)
        r = r.intersection(vis)
        if (r.isEmpty) return
        g.color = com.intellij.ui.JBColor(0x4C8BF5, 0x4C8BF5)
        g.stroke = java.awt.BasicStroke(JBUI.scale(2).toFloat())
        g.drawRoundRect(r.x - 1, r.y - 1, r.width + 2, r.height + 2, JBUI.scale(4), JBUI.scale(4))
    }
}
