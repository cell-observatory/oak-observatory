package com.cellobservatory.observatory.platform

import com.intellij.openapi.actionSystem.ActionToolbar
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.impl.ActionToolbarImpl
import java.awt.Container
import javax.swing.JComponent

/**
 * Boots a REAL (headless) IntelliJ application and project, builds the plugin's panels, and asserts the
 * action-system contracts that only a live IDE otherwise reveals.
 *
 * This exists because of a defect no other test in this repo could have caught: every toolbar on the
 * Overview was bound to `targetComponent = fleetTree`, a component that lives inside ONE nav tab. The
 * platform refuses to perform an action whose toolbar target is not showing, so with any other tab
 * selected — Sessions is the default — every button on that panel silently did nothing. It compiled, the
 * unit tests passed, CI was green, and the only evidence was a line in the IDE's own log.
 */
class ToolbarContractTest : ObservatoryPlatformTestCase() {

    private fun toolbarsIn(root: Container): List<ActionToolbarImpl> {
        val out = mutableListOf<ActionToolbarImpl>()
        fun walk(c: Container) {
            for (child in c.components) {
                if (child is ActionToolbarImpl) out += child
                if (child is Container) walk(child)
            }
        }
        walk(root)
        return out
    }

    /**
     * A toolbar's target component must not be something that can stop showing while the toolbar itself
     * is still on screen — that is the exact shape of the Overview bug. Binding to the panel that OWNS
     * the toolbar is the safe form: it is showing whenever its own buttons are.
     */
    fun testOverviewToolbarsTargetAComponentThatIsShowingWheneverTheyAre() {
        val panel = com.cellobservatory.observatory.ui.ChangeMapPanel(project)
        val toolbars = toolbarsIn(panel)
        assertTrue("the Overview builds toolbars to check", toolbars.isNotEmpty())
        for (tb in toolbars) {
            val target = tb.targetComponent
            assertNotNull("a toolbar with no target component takes its context from focus, which is worse", target)
            assertTrue(
                "toolbar target must be the owning panel (or an ancestor of it), never a child of one tab: was ${target!!.javaClass.name}",
                target === panel || isAncestor(target, panel),
            )
        }
    }

    private fun isAncestor(maybeAncestor: JComponent, of: Container): Boolean {
        var c: Container? = of
        while (c != null) {
            if (c === maybeAncestor) return true
            c = c.parent
        }
        return false
    }

    /**
     * No toolbar action may declare `ActionUpdateThread.EDT`.
     *
     * The platform expands a toolbar on a background thread; an EDT-bound action makes it hop back, once
     * per action, queued behind whatever the EDT is already doing. An IDE's own log showed the result:
     * over a thousand complaints, and single toolbars taking SECONDS to expand — several of them on
     * every refresh tick. Nothing in a build or a unit test can see that; only this can.
     */
    fun testNoToolbarActionForcesAHopToTheEventDispatchThread() {
        val panels = listOf<java.awt.Container>(
            com.cellobservatory.observatory.ui.ChangeMapPanel(project),
            com.cellobservatory.observatory.ui.PromptsPanel(project),
            // The Timeline window's content, which since 0.10.0 carries two toolbars of its own — the
            // session selector and the grouping toggle. Both are re-expanded on every tick of a window
            // that is open all day, so an EDT-bound one there costs exactly what the Overview's did.
            com.cellobservatory.observatory.ui.TimelinePanel(project),
        )
        // Non-vacuity first: with no toolbars found, the loop below examines nothing and passes,
        // which is how a contract test quietly stops testing its contract.
        val found = panels.sumOf { toolbarsIn(it).size }
        assertTrue("no toolbars were built, so this asserted nothing", found > 0)
        val offenders = mutableListOf<String>()
        for (p in panels) for (tb in toolbarsIn(p)) for (a in tb.actionGroup.getChildren(null)) {
            if (a.actionUpdateThread == com.intellij.openapi.actionSystem.ActionUpdateThread.EDT) {
                offenders += a.javaClass.name
            }
        }
        assertEquals("these actions drag toolbar expansion onto the EDT: $offenders", 0, offenders.size)
    }

    /**
     * Find Action titles the session-wide verbs as the Review panel's buttons title them (and VS Code's
     * Accept All / Reject All): they had been retitled Keep All Edits and Undo All Edits, unannounced, so
     * the same action read as two. The file-level actions say Keep and Undo, as the keys do.
     */
    fun testSessionWideActionsAreTitledAsTheReviewPanelButtons() {
        val panel = com.cellobservatory.observatory.ui.EditsTreePanel(project, com.cellobservatory.observatory.ui.EditsTreePanel.Mode.DIFFS)
        fun all(g: com.intellij.openapi.actionSystem.ActionGroup): List<AnAction> =
            g.getChildren(null).flatMap { if (it is com.intellij.openapi.actionSystem.ActionGroup) listOf(it) + all(it) else listOf(it) }
        val buttons = toolbarsIn(panel).flatMap { all(it.actionGroup) }.mapNotNull { it.templatePresentation.text }
        assertTrue("control: the panel has its Accept All button: $buttons", "Accept All Edits" in buttons)
        val am = com.intellij.openapi.actionSystem.ActionManager.getInstance()
        for (id in listOf("ClaudeObservatory.AcceptAll", "ClaudeObservatory.RevertAll")) {
            val title = am.getAction(id)!!.templatePresentation.text.orEmpty()
            assertTrue("$id is titled \"$title\", which names no button of the Review panel: $buttons", title.removePrefix("OAK: ") in buttons)
        }
    }

    /**
     * The floating review bar's own contract, asserted EXPLICITLY.
     *
     * [toolbarsIn] walks ChangeMapPanel and PromptsPanel only, and the floating bar is not a descendant of
     * either — the platform builds it around an editor, from an extension point. So the two assertions
     * above cannot reach it, and adding it to that walk is not possible; without these methods a bar full
     * of EDT-bound actions would sail through a green build.
     */
    fun testFloatingReviewBarActions() {
        val group = com.cellobservatory.observatory.ui.editor.ObservatoryFloatingToolbarProvider().actionGroup
        val children = group.getChildren(null)
        assertTrue("the floating bar contributes buttons, or the EP renders an empty overlay", children.isNotEmpty())
        val offenders = children.filter {
            it.actionUpdateThread == com.intellij.openapi.actionSystem.ActionUpdateThread.EDT
        }.map { it.javaClass.name }
        assertEquals("these floating-bar actions drag toolbar expansion onto the EDT: $offenders", 0, offenders.size)
    }

    /**
     * The bar's VERBS, in scope order: the per-edit ones, then the file-wide ones, then the session-wide
     * ones. Asserted by name because the bar is the surface a reader uses without opening a tool window,
     * and a verb quietly dropped from this group is a verb that simply stops existing for them — the
     * counter and the two file buttons look no different with Chat and Spotlight missing.
     */
    fun testTheFloatingBarCarriesEveryReviewVerbInScopeOrder() {
        val group = com.cellobservatory.observatory.ui.editor.ObservatoryFloatingToolbarProvider().actionGroup
        val names = group.getChildren(null).map { it.templatePresentation.text ?: "" }
        assertEquals(
            listOf(
                "Keep", "Undo", "Chat", "View diff", // this edit
                "Previous Edit", "", "Next Edit",    // …and which edit that is (the counter has no static text)
                "Previous Changed File", "", "Next Changed File", // …and the file axis, counter between
                "Accept File", "Reject File",        // this file
                "Spotlight", "Clear Resolved",       // this session
            ),
            names,
        )
        // Spotlight is a TOGGLE — it has a state, and a plain button would make the reader click twice to
        // learn what it is.
        val spotlight = group.getChildren(null).first { it.templatePresentation.text == "Spotlight" }
        assertTrue(
            "Spotlight must show whether the dimming is on: was ${spotlight.javaClass.name}",
            spotlight is com.intellij.openapi.actionSystem.ToggleAction,
        )
    }

    /**
     * …and the provider must actually SAY YES for an ordinary editor.
     *
     * Everything else about the bar is asserted from a provider this test constructs by hand, so an
     * `isApplicable` that answers false for every editor — a narrowed kind check, an added condition, an
     * inverted return — takes the bar off the screen with the whole suite still green. The DIFF half is
     * the other side of the same rule (a review bar inside the diff OF the edit it acts on is one surface
     * too many), and it doubles as the control: without it, a provider that answers true to everything
     * would pass the first assertion.
     */
    fun testTheFloatingBarAppliesToAnOrdinaryEditorAndNotToADiff() {
        val file = myFixture.configureByText("applies.txt", "hello").virtualFile
        val doc = com.intellij.openapi.fileEditor.FileDocumentManager.getInstance().getDocument(file)!!
        val provider = com.cellobservatory.observatory.ui.editor.ObservatoryFloatingToolbarProvider()
        val factory = com.intellij.openapi.editor.EditorFactory.getInstance()
        // The fixture's own editor is EditorKind.UNTYPED, so it cannot stand in for the main editor here.
        val main = factory.createEditor(doc, project, file, false, com.intellij.openapi.editor.EditorKind.MAIN_EDITOR)
        val diff = factory.createEditor(doc, project, file, true, com.intellij.openapi.editor.EditorKind.DIFF)
        try {
            assertTrue(
                "the bar declines every main editor — it can never appear",
                provider.isApplicable(contextFor(main)),
            )
            assertFalse(
                "the bar floats inside diff panes too",
                provider.isApplicable(contextFor(diff)),
            )
        } finally {
            factory.releaseEditor(diff)
            factory.releaseEditor(main)
        }
    }

    private fun contextFor(editor: com.intellij.openapi.editor.Editor) =
        com.intellij.openapi.actionSystem.impl.SimpleDataContext.builder()
            .add(com.intellij.openapi.actionSystem.CommonDataKeys.PROJECT, project)
            .add(com.intellij.openapi.actionSystem.CommonDataKeys.EDITOR, editor)
            .build()

    /** Records what the provider asked the platform to do with the overlay. [verdict] keeps "hide it" and
     *  "never said anything" apart — a provider that stopped calling either would otherwise read as a hide. */
    private class RecordingToolbar : com.intellij.openapi.editor.toolbar.floating.FloatingToolbarComponent {
        private var shown = 0
        private var hidden = 0
        val verdict: String get() = if (shown > 0) "show" else if (hidden > 0) "hide" else "nothing at all"
        override fun scheduleShow() { shown++ }
        override fun scheduleHide() { hidden++ }
        override fun hideImmediately() { hidden++ }
        override var backgroundAlpha: Float = 0f
        override var showingTime: Int = 0
        override var hidingTime: Int = 0
        override var retentionTime: Int = 0
        override var autoHideable: Boolean = false
    }

    /**
     * The bar is shown for a file with pending edits, and hidden for everything else — the one behaviour
     * that decides whether anyone ever sees it, and the one no other test observes: `register()` is called
     * by the platform, so an inverted `floatingSurface && hasPending` (or a settings spelling that stops
     * meaning "show it") ships an editor with no review controls and no error anywhere.
     *
     * Seeds a store of its own rather than leaning on the ambient one, and puts it back afterwards, so the
     * other methods in this class keep seeing whatever they saw before.
     */
    fun testTheFloatingBarShowsItselfExactlyWhereThereIsPendingWork() {
        val session = "floating-bar-session"
        val settings = com.cellobservatory.observatory.settings.ObservatorySettings.instance.state
        val savedCfg = com.cellobservatory.observatory.core.ClaudePaths.configDirOverride
        val savedSession = settings.session
        val savedSurface = settings.editorReviewSurface
        val cfg = java.nio.file.Files.createTempDirectory("co-floating-bar")
        val factory = com.intellij.openapi.editor.EditorFactory.getInstance()
        val provider = com.cellobservatory.observatory.ui.editor.ObservatoryFloatingToolbarProvider()
        try {
            com.cellobservatory.observatory.core.ClaudePaths.configDirOverride = cfg
            settings.session = session // pinned: currentSession() then needs no transcript to resolve
            java.nio.file.Files.createDirectories(com.cellobservatory.observatory.core.ClaudePaths.storeDir(session))
            val dirty = myFixture.configureByText("has-pending.txt", "hello").virtualFile
            val clean = myFixture.configureByText("nothing-pending.txt", "hello").virtualFile
            java.nio.file.Files.writeString(
                com.cellobservatory.observatory.core.ClaudePaths.logPath(session),
                """{"id":1,"ts":1000,"tool":"Edit","file":"${dirty.path}",""" +
                    """"beforeBlob":"aa","afterBlob":"bb","status":"pending"}""" + "\n",
            )
            // No refresh() needed either way: the service's log cache is keyed on the session name, and
            // this one is used nowhere else.
            settings.editorReviewSurface = com.cellobservatory.observatory.settings.ObservatorySettings.FLOATING
            assertEquals(
                "a file with a pending edit must get the bar",
                "show",
                register(provider, factory, dirty).verdict,
            )
            assertEquals(
                "a file with nothing pending must not",
                "hide",
                register(provider, factory, clean).verdict,
            )
            settings.editorReviewSurface = com.cellobservatory.observatory.settings.ObservatorySettings.BANNER
            assertEquals(
                "`banner` means the banner INSTEAD of the bar, so the bar stays down over pending work",
                "hide",
                register(provider, factory, dirty).verdict,
            )
        } finally {
            settings.editorReviewSurface = savedSurface
            settings.session = savedSession
            com.cellobservatory.observatory.core.ClaudePaths.configDirOverride = savedCfg
            cfg.toFile().deleteRecursively()
        }
    }

    /**
     * The floating bar's "File n/m" must be the SAME number the status-bar nav bar shows.
     *
     * Both can be on screen at once, over the same session, and they resolve the file list and the index
     * independently — `FloatingFileCounter` off `pendingFiles(project)` and the event's virtual file,
     * `ReviewNavBar` off its own `pendingFiles()` and `ActiveFileTracker`. Two expressions of one rule is
     * exactly the shape that drifts silently: whichever one changed, the reader would see "File 2/7" on
     * the bar and "File 3/7" in the status bar and have no way to know which had lied. Asserted against
     * the real nav bar rather than a hard-coded string, so a change to the RULE keeps them together and a
     * change to only one of them fails here.
     */
    fun testTheFloatingFileCounterAgreesWithTheNavBar() {
        val session = "file-counter-session"
        val settings = com.cellobservatory.observatory.settings.ObservatorySettings.instance.state
        val savedCfg = com.cellobservatory.observatory.core.ClaudePaths.configDirOverride
        val savedSession = settings.session
        val cfg = java.nio.file.Files.createTempDirectory("co-file-counter")
        try {
            com.cellobservatory.observatory.core.ClaudePaths.configDirOverride = cfg
            settings.session = session
            java.nio.file.Files.createDirectories(com.cellobservatory.observatory.core.ClaudePaths.storeDir(session))
            val a = myFixture.configureByText("aaa-first.txt", "hello").virtualFile
            val b = myFixture.configureByText("zzz-second.txt", "hello").virtualFile
            // Written in the OPPOSITE order to the one they sort in — `zzz` first, `aaa` second. The axis
            // is defined as path-sorted, so a counter that indexed the store's own order would read
            // "File 1/2" here instead of 2/2. With the fixture in sorted order the two are the same list
            // and dropping the sort changes nothing, which is a test that cannot see the bug it is for.
            java.nio.file.Files.writeString(
                com.cellobservatory.observatory.core.ClaudePaths.logPath(session),
                """{"id":1,"ts":1000,"tool":"Edit","file":"${b.path}",""" +
                    """"beforeBlob":"cc","afterBlob":"dd","status":"pending"}""" + "\n" +
                    """{"id":2,"ts":2000,"tool":"Edit","file":"${a.path}",""" +
                    """"beforeBlob":"aa","afterBlob":"bb","status":"pending"}""" + "\n",
            )
            // The nav bar reads the ACTIVE file, the floating bar reads the event's — so they have to be
            // pointed at the same one for the comparison to mean anything. `b` sorts second by path.
            myFixture.openFileInEditor(b)

            val counter = com.cellobservatory.observatory.ui.editor.ObservatoryFloatingToolbarProvider()
                .actionGroup.getChildren(null)
                .first { it.javaClass.simpleName == "FloatingFileCounter" }
            val ctx = com.intellij.openapi.actionSystem.impl.SimpleDataContext.builder()
                .add(com.intellij.openapi.actionSystem.CommonDataKeys.PROJECT, project)
                .add(com.intellij.openapi.actionSystem.CommonDataKeys.VIRTUAL_FILE, b)
                .build()
            val floating = com.intellij.openapi.actionSystem.AnActionEvent.createFromDataContext(
                ActionToolbar.ACTION_TOOLBAR_PROPERTY_KEY.toString(), null, ctx
            )
            counter.update(floating)

            val navCounter = com.cellobservatory.observatory.ui.ReviewNavBar(project).fileAxis()[1]
            val nav = com.intellij.openapi.actionSystem.AnActionEvent.createFromDataContext(
                ActionToolbar.ACTION_TOOLBAR_PROPERTY_KEY.toString(), null, ctx
            )
            navCounter.update(nav)

            assertEquals("the floating counter names the second of two changed files", "File 2/2", floating.presentation.text)
            assertEquals(
                "the floating bar and the status-bar nav bar must never name different positions",
                nav.presentation.text,
                floating.presentation.text,
            )
            assertTrue("and it is visible while two files are pending", floating.presentation.isVisible)

            // …and it HIDES below two files, matching the steppers it sits between: a bar that floats over
            // code must not cover a line to say "File 1/1".
            java.nio.file.Files.writeString(
                com.cellobservatory.observatory.core.ClaudePaths.logPath(session),
                """{"id":1,"ts":1000,"tool":"Edit","file":"${b.path}",""" +
                    """"beforeBlob":"aa","afterBlob":"bb","status":"pending"}""" + "\n",
            )
            com.cellobservatory.observatory.services.ObservatoryService.getInstance(project).refresh()
            val lone = com.intellij.openapi.actionSystem.AnActionEvent.createFromDataContext(
                ActionToolbar.ACTION_TOOLBAR_PROPERTY_KEY.toString(), null, ctx
            )
            counter.update(lone)
            assertFalse("one changed file means nothing to step through, so no counter", lone.presentation.isVisible)
        } finally {
            settings.session = savedSession
            com.cellobservatory.observatory.core.ClaudePaths.configDirOverride = savedCfg
            cfg.toFile().deleteRecursively()
        }
    }

    /** Run the provider's own registration for [file] and hand back what it did with the overlay. */
    private fun register(
        provider: com.cellobservatory.observatory.ui.editor.ObservatoryFloatingToolbarProvider,
        factory: com.intellij.openapi.editor.EditorFactory,
        file: com.intellij.openapi.vfs.VirtualFile,
    ): RecordingToolbar {
        val doc = com.intellij.openapi.fileEditor.FileDocumentManager.getInstance().getDocument(file)!!
        val editor = factory.createEditor(doc, project, file, false, com.intellij.openapi.editor.EditorKind.MAIN_EDITOR)
        val component = RecordingToolbar()
        // Its own Disposable per call: the provider registers a service listener, and leaving three of them
        // hanging off the fixture's root would outlive the assertions that care about them.
        val scope = com.intellij.openapi.util.Disposer.newDisposable()
        try {
            provider.register(contextFor(editor), component, scope)
        } finally {
            com.intellij.openapi.util.Disposer.dispose(scope)
            factory.releaseEditor(editor)
        }
        return component
    }

    /** …and each of them must survive `update()` with only a project in context — which is the whole of
     *  what it gets before any editor is resolved. A throw there kills the overlay's repaint. */
    fun testFloatingReviewBarActionsSurviveUpdate() {
        val group = com.cellobservatory.observatory.ui.editor.ObservatoryFloatingToolbarProvider().actionGroup
        val children = group.getChildren(null)
        assertTrue("there are floating-bar actions to exercise", children.isNotEmpty())
        val ctx = com.intellij.openapi.actionSystem.impl.SimpleDataContext.getProjectContext(project)
        for (a in children) {
            val e = com.intellij.openapi.actionSystem.AnActionEvent.createFromDataContext(
                ActionToolbar.ACTION_TOOLBAR_PROPERTY_KEY.toString(), null, ctx
            )
            try {
                a.update(e)
            } catch (t: Throwable) {
                fail("${a.javaClass.name}.update() threw ${t.javaClass.simpleName}: ${t.message}")
            }
            assertFalse(
                "${a.javaClass.name} shows itself with no file resolved — the bar would float over clean code",
                e.presentation.isVisible,
            )
        }
    }

    /** Every action on those toolbars must survive `update()` without throwing. An exception there kills
     *  the whole toolbar's repaint, taking unrelated buttons with it. */
    fun testEveryOverviewActionSurvivesUpdate() {
        val panel = com.cellobservatory.observatory.ui.ChangeMapPanel(project)
        val actions = mutableListOf<AnAction>()
        for (tb in toolbarsIn(panel)) actions += tb.actionGroup.getChildren(null).toList()
        assertTrue("there are actions to exercise", actions.isNotEmpty())
        val ctx = com.intellij.openapi.actionSystem.impl.SimpleDataContext.getProjectContext(project)
        for (a in actions) {
            val e = com.intellij.openapi.actionSystem.AnActionEvent.createFromDataContext(
                ActionToolbar.ACTION_TOOLBAR_PROPERTY_KEY.toString(), null, ctx
            )
            try {
                a.update(e)
            } catch (t: Throwable) {
                fail("${a.javaClass.name}.update() threw ${t.javaClass.simpleName}: ${t.message}")
            }
        }
    }
}
