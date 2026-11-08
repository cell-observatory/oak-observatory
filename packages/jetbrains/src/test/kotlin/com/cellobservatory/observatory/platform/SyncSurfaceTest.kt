package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.model.SessionRow
import com.cellobservatory.observatory.model.SyncChoice
import com.cellobservatory.observatory.model.SyncConflict
import com.cellobservatory.observatory.model.SyncLine
import com.cellobservatory.observatory.model.SyncStatusParser
import com.cellobservatory.observatory.model.SyncView
import com.cellobservatory.observatory.model.relTime
import com.cellobservatory.observatory.model.syncChoices
import com.cellobservatory.observatory.settings.ObservatoryConfigurable
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.cellobservatory.observatory.ui.ChangeMapPanel
import com.cellobservatory.observatory.ui.MT_ATTENTION
import com.cellobservatory.observatory.ui.ReviewOps
import com.cellobservatory.observatory.ui.SyncOps
import com.cellobservatory.observatory.ui.SyncWidget
import com.intellij.diff.DiffDialogHints
import com.intellij.diff.DiffManager
import com.intellij.diff.DiffRequestPanel
import com.intellij.diff.chains.DiffRequestChain
import com.intellij.diff.contents.DocumentContent
import com.intellij.diff.merge.MergeRequest
import com.intellij.diff.requests.DiffRequest
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.notification.Notification
import com.intellij.notification.Notifications
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionGroup
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.TestDialog
import com.intellij.openapi.ui.TestDialogManager
import com.intellij.openapi.ui.TestInputDialog
import com.intellij.openapi.util.SystemInfo
import com.intellij.openapi.vfs.newvfs.impl.VfsRootAccess
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.replaceService
import com.intellij.util.ui.UIUtil
import java.awt.Window
import java.io.File
import java.nio.file.Files
import javax.swing.JButton
import javax.swing.JLabel
import javax.swing.JList
import javax.swing.JPanel

/**
 * oak sync on JetBrains, over the real plugin in a headless IDE and through this tree's CLI in a throwaway config.
 * herdr's list of saved machines is a stub that lists none, so no run asks any machine. Nothing shows where sync is not
 * in use; the status bar widget, the Overview's Sessions tab and the Settings page show the last run and an open
 * conflict; the conflict's two ways out (both copies in a diff, or the copy deleted through `oak sync resolve`); a run;
 * setup (nowhere else, and a folder whose key is pasted); this project excluded; the reinstall question; and a delete's
 * words with a backup folder set.
 */
class SyncSurfaceTest : ObservatoryPlatformTestCase() {

    private lateinit var cfg: File
    private lateinit var bin: File
    private var prevCfg: String? = null
    private var prevBin: String? = null
    private val seen = mutableListOf<Notification>()
    /** build.gradle.kts points this at the tree's own `oak`. */
    private val treeOak: String get() = System.getenv("CLAUDE_OBSERVATORY_BIN") ?: error("no CLAUDE_OBSERVATORY_BIN: run through gradle's test task")

    override fun setUp() {
        super.setUp()
        cfg = Files.createTempDirectory("oak-sync-cfg").toFile()
        bin = Files.createTempDirectory("oak-sync-bin").toFile()
        VfsRootAccess.allowRootAccess(testRootDisposable, cfg.path, bin.path)
        // herdr's saved machines: none, or those in machines.json. The plugin runs this tree's oak with the stubs first on
        // PATH, ssh among them: it fails as an unreachable host does, and says it ran, so no test reaches a real machine.
        File(bin, "herdr").apply {
            writeText("#!/bin/sh\nif [ \"\$1 \$2\" = \"machine list\" ]; then if [ -f '${bin.path}/machines.json' ]; then cat '${bin.path}/machines.json'; else printf '[]'; fi; fi\nexit 0\n")
            setExecutable(true)
        }
        File(bin, "ssh").apply { writeText("#!/bin/sh\necho \"\$*\" >> '${bin.path}/ssh.log'\nexit 255\n"); setExecutable(true) }
        File(bin, "oak").apply { writeText("#!/bin/sh\nPATH='${bin.path}':\"\$PATH\" exec '$treeOak' \"\$@\"\n"); setExecutable(true) }
        val st = ObservatorySettings.instance.state
        prevCfg = st.configDir
        prevBin = st.observatoryBin
        st.configDir = cfg.absolutePath
        st.observatoryBin = File(bin, "oak").path
        ClaudePaths.configDirOverride = cfg.toPath()
        SyncOps.view = null
        project.basePath?.let { File(it).mkdirs() } // the CLI runs in the project's folder, which the light test project names but never creates
        project.messageBus.connect(testRootDisposable).subscribe(Notifications.TOPIC, object : Notifications {
            override fun notify(notification: Notification) { seen += notification }
        })
    }

    override fun tearDown() {
        try {
            val st = ObservatorySettings.instance.state
            st.configDir = prevCfg
            st.observatoryBin = prevBin
            ClaudePaths.configDirOverride = null
            SyncOps.view = null // the next test class reads its own
            cfg.deleteRecursively()
            bin.deleteRecursively()
        } finally {
            super.tearDown()
        }
    }

    private fun until(what: String, cond: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 60_000
        while (!cond() && System.currentTimeMillis() < deadline) {
            PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()
            Thread.sleep(20)
        }
        assertTrue("$what (notifications: ${seen.map { it.content }})", cond())
    }

    /** `oak sync status --json` read again through SyncOps, as an action's refresh reads it: this read's own answer, not
     *  one a stamp check started before the store here was seeded. */
    private fun read(): SyncView {
        SyncOps.view = null
        SyncOps.refresh(force = true).get(60, java.util.concurrent.TimeUnit.SECONDS)
        PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue() // its listeners
        return SyncOps.view ?: error("sync's status was not read (notifications: ${seen.map { it.content }})")
    }

    private fun said(prefix: String): String? = seen.map { it.content }.lastOrNull { it.startsWith(prefix) }

    /** The set-up notification since [before] notifications. */
    private fun setUpSaid(before: Int): String = seen.drop(before).first { it.content.startsWith("OAK sync is set up") }.content

    private val store get() = File(cfg, "claude-observatory")
    private val plan get() = File(cfg, "plans/m.md")
    private val copy get() = File(store, "sync/conflicts/build-box/plans/m.md")

    /** A run 30 s ago that pulled from build-box, and one open conflict on a plan: the store as a run leaves it. */
    private fun seedConflict(): Long {
        val at = System.currentTimeMillis() - 30_000
        plan.parentFile.mkdirs(); plan.writeText("one\nleft\n")
        copy.parentFile.mkdirs(); copy.writeText("one\nright\n")
        File(store, "sync/status.json").writeText("""{"at":$at,"durationMs":800,"status":"ok","warnings":[],"machines":[{"label":"build-box","host":"h1","status":"ok",""" +
            """"pulled":{"files":2,"bytes":2048},"conflicts":1,"pending":{"files":0,"bytes":0},"errors":[],"lastOkAt":$at}]}""")
        File(store, "sync/conflicts.json").writeText("""[{"id":"c0ffee000001","family":"plans","name":"m.md","from":"build-box","host":"h1","at":$at,""" +
            """"peerSha256":null,"peerSize":11,"copy":${com.google.gson.JsonPrimitive(copy.path)},"localSha256":null,"reason":"overlap"}]""")
        return at
    }

    private fun sessionsList(panel: ChangeMapPanel): JList<*> =
        (ChangeMapPanel::class.java.getDeclaredField("sessionsList").apply { isAccessible = true }.get(panel) as JList<*>).also { it.setSize(900, 600) }

    /** The Sessions tab's sync rows, as they read. */
    private fun syncRows(list: JList<*>): List<String> = (0 until list.model.size).mapNotNull { i ->
        val v = list.model.getElementAt(i)
        when (v.javaClass.simpleName) {
            "SyncConflictsHeader", "SyncConflictRow" -> {
                val c = list.cellRenderer.let { @Suppress("UNCHECKED_CAST") (it as javax.swing.ListCellRenderer<Any>) }
                    .getListCellRendererComponent(list as JList<Any>, v, i, false, false)
                UIUtil.findComponentsOfType(c as javax.swing.JComponent, JLabel::class.java).joinToString(" ") { it.text }
            }
            else -> null
        }
    }

    private fun <T> field(o: Any, name: String): T = o.javaClass.getDeclaredField(name).apply { isAccessible = true }.get(o).let { @Suppress("UNCHECKED_CAST") (it as T) }

    /** What the Settings page's sync section says (null while it is not shown), and whether it offers the reinstall
     *  button. */
    private fun settingsSays(): Pair<String?, Boolean> {
        val page = ObservatoryConfigurable()
        try {
            // Nothing read: what the page shows is its own read's (no stamp check reads files that have not moved).
            SyncOps.view = null
            page.createComponent()
            until("the page read sync's state and herdr's machines") {
                field<JLabel>(page, "syncText").text.let { !it.contains("has not answered yet") } && field<Boolean?>(page, "syncSaved") != null
            }
            val text = field<JLabel>(page, "syncText")
            assertEquals("the heading and the buttons show with the text", text.isVisible, field<javax.swing.JComponent>(page, "syncButtons").isVisible && field<javax.swing.JComponent>(page, "syncHead").isVisible)
            return (if (text.isVisible) text.text else null) to field<JButton>(page, "syncRecord").isVisible
        } finally {
            page.disposeUIResources()
        }
    }

    private fun texts(g: ActionGroup): List<String> = g.getChildren(null).map { a: AnAction -> a.templatePresentation.text }

    fun testNothingShowsWhereSyncIsNotInUse() {
        // plugin.xml registers the widget and the three actions, which load.
        assertTrue(com.intellij.openapi.wm.StatusBarWidgetFactory.EP_NAME.extensionList.any { it is com.cellobservatory.observatory.ui.SyncStatusWidgetFactory })
        for (id in listOf("ClaudeObservatory.Sync", "ClaudeObservatory.SyncNow", "ClaudeObservatory.SyncSetup"))
            assertNotNull(id, com.intellij.openapi.actionSystem.ActionManager.getInstance().getAction(id))
        if (SystemInfo.isWindows) return // the stub herdr and oak are POSIX scripts
        val v = read()
        assertFalse("never set up, no backup, no conflict", v.inUse)
        val widget = SyncWidget(project)
        widget.show(v)
        assertFalse("the status bar shows nothing", widget.label.isVisible)
        val panel = ChangeMapPanel(project)
        read()
        assertEquals("the Sessions tab has no sync rows", emptyList<String>(), syncRows(sessionsList(panel)))
        assertEquals("no saved machine: the Settings page shows nothing new", null to false, settingsSays())
        assertEquals("the menu (OAK: Sync…) sets it up", listOf("Sync Now", "Set Up Sync…", "Machines and Projects…"), texts(SyncOps.menu(project)))
        // A machine saved here: the Settings page offers to set sync up, and nothing else changes.
        File(bin, "machines.json").writeText("""[{"id":"m1","label":"build-box","target":"builder@build-box.example","session":"default","enabled":true,"selected":false}]""")
        val (text, record) = settingsSays()
        assertTrue(text, text!!.contains("Sync is not set up here."))
        assertFalse("no record to take over", record)
        assertFalse("still not in use", read().inUse)
        assertFalse("nothing asked any machine", File(bin, "ssh.log").exists())
        // A page made again after its resources were let go (as the platform may) has its buttons once.
        val page = ObservatoryConfigurable()
        try {
            page.createComponent()
            page.disposeUIResources()
            page.createComponent()
            assertEquals(4, field<JPanel>(page, "syncButtons").componentCount)
        } finally {
            page.disposeUIResources()
        }
    }

    fun testTheLastRunAndAConflictShowAndItsTwoWaysOutGoThroughTheCli() {
        if (SystemInfo.isWindows) return
        val at = seedConflict()
        val v = read()
        assertTrue(v.inUse)
        assertEquals("the CLI's words for the machine's line", "2 files, 2KB", v.lines.single().said)
        val c = v.conflicts.single()
        assertEquals("the CLI names this machine's file beside the copy", plan.path, c.file)
        assertEquals(copy.path, c.copy)

        // The status bar: what needs the reader, every machine's line in the tooltip.
        val widget = SyncWidget(project)
        widget.show(v)
        assertTrue(widget.label.isVisible)
        assertEquals("OAK sync: 1 conflict", widget.label.text)
        assertEquals(MT_ATTENTION, widget.label.foreground)
        val tip = widget.label.toolTipText
        assertTrue(tip, tip.contains("OAK sync · last run ${relTime(at)} (ok) · background on"))
        assertTrue(tip, tip.contains("build-box: 2 files, 2KB"))
        assertTrue(tip, tip.contains("backup: none: each session stays on the machine that made it"))
        assertTrue(tip, tip.contains("1 open conflict: the Overview&#39;s Sessions tab has it") || tip.contains("1 open conflict: the Overview's Sessions tab has it"))

        // The Overview's Sessions tab: a header that is not selectable, then the conflict with its resolution, both files whole.
        val panel = ChangeMapPanel(project)
        val list = sessionsList(panel)
        read()
        until("the Sessions tab lists the conflict") { syncRows(list).size == 2 }
        assertEquals(listOf("sync conflicts · 1", "⇄ plans m.md from build-box — edit your file or delete the copy"), syncRows(list))
        val header = (0 until list.model.size).first { list.model.getElementAt(it).javaClass.simpleName == "SyncConflictsHeader" }
        list.selectionModel.setSelectionInterval(header, header)
        assertEquals("the header is skipped for the conflict under it", header + 1, list.selectedIndex)
        @Suppress("UNCHECKED_CAST")
        val cell = (list.cellRenderer as javax.swing.ListCellRenderer<Any>).getListCellRendererComponent(list as JList<Any>, list.model.getElementAt(header + 1), header + 1, false, false) as javax.swing.JComponent
        assertTrue(cell.toolTipText, cell.toolTipText.contains("yours: ${plan.path}") && cell.toolTipText.contains("build-box's copy: ${copy.path}"))

        // The Settings page and the menu.
        val (text, _) = settingsSays()
        assertTrue(text, text!!.contains("Last run: last run ${relTime(at)} (ok)") && text.contains("build-box: 2 files, 2KB") && text.contains("1 open conflict"))
        assertEquals(listOf("Sync Now", "plans m.md from build-box: edit your file or delete the copy", "Change the Backup…", "Machines and Projects…", "The Last Run"), texts(SyncOps.menu(project)))
        assertEquals(listOf("Open Both Copies", "Delete build-box's Copy (Yours Stands)"), texts(SyncOps.conflictActions(project, c)))

        // Open both copies: the other machine's on the left, this machine's on the right.
        val shown = mutableListOf<DiffRequest>()
        ApplicationManager.getApplication().replaceService(DiffManager::class.java, object : DiffManager() {
            override fun showDiff(project: Project?, request: DiffRequest) { shown += request }
            override fun showDiff(project: Project?, request: DiffRequest, hints: DiffDialogHints) { shown += request }
            override fun showDiff(project: Project?, requests: DiffRequestChain, hints: DiffDialogHints) = error("one request")
            override fun createRequestPanel(project: Project?, parent: Disposable, window: Window?): DiffRequestPanel = error("no panel")
            override fun showMerge(project: Project?, request: MergeRequest) = error("no merge")
        }, testRootDisposable)
        SyncOps.openBoth(project, c)
        val diff = shown.single() as SimpleDiffRequest
        assertEquals("m.md: build-box's copy ↔ yours", diff.title)
        assertEquals(listOf("build-box's copy", "yours"), diff.contentTitles)
        assertEquals(listOf("one\nright\n", "one\nleft\n"), diff.contents.map { (it as DocumentContent).document.text })

        // The last run whole, in the CLI's own text.
        SyncOps.showLastRun(project)
        until("the last run opens") { FileEditorManager.getInstance(project).openFiles.any { it.name == "oak sync status.txt" } }
        val doc = FileEditorManager.getInstance(project).openFiles.first { it.name == "oak sync status.txt" }
        assertTrue(String(doc.contentsToByteArray()), String(doc.contentsToByteArray()).contains("c0ffee000001  plans m.md from build-box"))

        // Delete the copy: asked first, then `oak sync resolve`, whose trash keeps it; this machine's file stands.
        val asked = mutableListOf<String>()
        val prev = TestDialogManager.setTestDialog(TestDialog { m -> asked += m; Messages.YES })
        try {
            SyncOps.deleteCopy(project, c)
            until("it says what it did") { said("OAK sync: build-box's copy of m.md") != null }
        } finally {
            TestDialogManager.setTestDialog(prev)
        }
        assertEquals("OAK sync: build-box's copy of m.md is in sync's trash, and yours stands.", said("OAK sync: build-box's copy"))
        assertTrue(asked.single(), asked.single().startsWith("It goes to sync's trash, and this machine's file stands: ${plan.path}."))
        assertFalse("the copy goes", copy.exists())
        assertEquals("closed at once", "[]", File(store, "sync/conflicts.json").readText().trim())
        assertEquals("yours stands", "one\nleft\n", plan.readText())
        until("the view follows") { SyncOps.view?.conflicts?.isEmpty() == true }
        widget.show(SyncOps.view)
        assertEquals("OAK sync ${relTime(at)}", widget.label.text)
        until("the Sessions tab follows") { syncRows(list).isEmpty() }
    }

    fun testARunSetupAndThisProjectGoThroughTheCli() {
        if (SystemInfo.isWindows) return
        // Sync now, and what it did.
        SyncOps.syncNow(project)
        until("the run says what it did") { said("OAK sync: ") != null }
        assertTrue(said("OAK sync: ")!!, said("OAK sync: ")!!.startsWith("OAK sync: nothing to pull; warning: there is no saved machine to sync with: `oak machine add <label> <ssh-target>` saves one; "))

        // Setup: nowhere else, as `oak sync setup --none` sets it.
        val asked = mutableListOf<String>()
        val prev = TestDialogManager.setTestDialog(TestDialog { m -> asked += m; 0 })
        try {
            SyncOps.setup(project)
            until("set up") { said("OAK sync is set up") != null }
        } finally {
            TestDialogManager.setTestDialog(prev)
        }
        assertTrue(asked.first(), asked.first().startsWith("Where are the agents' sessions backed up?"))
        assertTrue(asked.first(), asked.first().contains("A saved machine: it keeps every machine's sessions (none is saved here yet: oak machine add <label> <ssh-target> saves one)."))
        assertTrue(said("OAK sync is set up")!!, said("OAK sync is set up")!!.startsWith("OAK sync is set up: no backup: each session stays on the machine that made it"))

        // A folder that holds a backup made on another machine, whose key this one lacks: it asks where the key comes
        // from (no machine is saved, so pasting it), and the CLI takes it on standard input.
        val other = Files.createTempDirectory("oak-sync-other").toFile()
        try {
            val share = File(other, "share").path
            // Its standard output alone: the key's warning goes to standard error, and no key is ever put in a message.
            fun otherOak(vararg args: String): String {
                val pb = ProcessBuilder(listOf(File(bin, "oak").path) + args).redirectError(ProcessBuilder.Redirect.DISCARD)
                pb.environment().putAll(mapOf("HOME" to File(other, "h").path, "CLAUDE_CONFIG_DIR" to File(other, "h/.claude").path, "XDG_CONFIG_HOME" to File(other, "h/.config").path))
                val p = pb.start()
                val out = p.inputStream.bufferedReader().readText()
                assertEquals("another machine: oak ${args.first()} ${args[1]} exited", 0, p.waitFor())
                return out
            }
            otherOak("sync", "backup", "--folder", share)
            val key = otherOak("sync", "key", "--show").trim()
            assertTrue("control: a key made there", key.startsWith("oak-sync-1:"))
            val keyAsked = mutableListOf<String>()
            val prevD = TestDialogManager.setTestDialog(TestDialog { m -> keyAsked += m; 0 })
            val prevI = TestDialogManager.setTestInputDialog(object : TestInputDialog {
                override fun show(message: String): String = key
                override fun show(message: String, validator: com.intellij.openapi.ui.InputValidator?): String { keyAsked += message; return key }
            })
            val before = seen.size
            try {
                SyncOps.runSetup(project, listOf("--folder", share), saved = emptyList())
                until("set up with the pasted key") { seen.drop(before).any { it.content.startsWith("OAK sync is set up: the backup is the encrypted folder $share") } }
            } finally {
                TestDialogManager.setTestDialog(prevD)
                TestDialogManager.setTestInputDialog(prevI)
            }
            assertTrue(keyAsked[0], keyAsked[0].contains("holds a backup sealed under a key this machine does not have"))
            assertTrue(keyAsked[1], keyAsked[1].startsWith("The key from `oak sync key --show` on a machine that has it"))
            val prefs = com.google.gson.JsonParser.parseString(File(store, "prefs.json").readText()).asJsonObject
            assertEquals("the CLI wrote the backup to prefs.json", share, prefs.getAsJsonObject("sync").getAsJsonObject("backup").get("path").asString)
            val setUp = seen.drop(before).first { it.content.startsWith("OAK sync is set up") }.content
            assertTrue(setUp, Regex("""The backup key \S+ is kept here now\.""").containsMatchIn(setUp))

            // A folder made under yet another key: brought over the key kept here, it replaces it (`--replace`), as the
            // question says; without that the CLI refuses, and setup would end there.
            val other2 = Files.createTempDirectory("oak-sync-other").toFile()
            try {
                val share2 = File(other2, "share").path
                fun other2Oak(vararg args: String): String {
                    val pb = ProcessBuilder(listOf(File(bin, "oak").path) + args).redirectError(ProcessBuilder.Redirect.DISCARD)
                    pb.environment().putAll(mapOf("HOME" to File(other2, "h").path, "CLAUDE_CONFIG_DIR" to File(other2, "h/.claude").path, "XDG_CONFIG_HOME" to File(other2, "h/.config").path))
                    val p = pb.start()
                    val out = p.inputStream.bufferedReader().readText()
                    assertEquals("a third machine: oak ${args.first()} ${args[1]} exited", 0, p.waitFor())
                    return out
                }
                other2Oak("sync", "backup", "--folder", share2)
                val key2 = other2Oak("sync", "key", "--show").trim()
                val replaceAsked = mutableListOf<String>()
                val prevD2 = TestDialogManager.setTestDialog(TestDialog { m -> replaceAsked += m; 0 })
                val prevI2 = TestDialogManager.setTestInputDialog(object : TestInputDialog {
                    override fun show(message: String): String = key2
                    override fun show(message: String, validator: com.intellij.openapi.ui.InputValidator?): String = key2
                })
                val before2 = seen.size
                try {
                    SyncOps.runSetup(project, listOf("--folder", share2), saved = emptyList())
                    until("set up, the key here replaced") { seen.drop(before2).any { it.content.startsWith("OAK sync is set up: the backup is the encrypted folder $share2") } }
                } finally {
                    TestDialogManager.setTestDialog(prevD2)
                    TestDialogManager.setTestInputDialog(prevI2)
                }
                assertTrue(replaceAsked[0], Regex("This machine keeps another backup key \\(\\S+\\): the folder's replaces it here, and the old one is kept beside it\\.$").containsMatchIn(replaceAsked[0]))
                val keyNow = com.google.gson.JsonParser.parseString(com.cellobservatory.observatory.core.ObservatoryCli.run(listOf("sync", "key", "--json"), null).stdout).asJsonObject
                    .getAsJsonObject("syncKey").get("fingerprint").asString
                assertTrue("the folder's key is kept here now", setUpSaid(before2).contains("(key $keyNow)"))
            } finally {
                other2.deleteRecursively()
            }

            // The delete says what it does with a backup folder set: purged here, and back after an undelete and a run;
            // edits pending review are lost here, unless the folder brings them back.
            val delAsked = mutableListOf<String>()
            val prevDel = TestDialogManager.setTestDialog(TestDialog { m -> delAsked += m; Messages.NO })
            try {
                ReviewOps.confirmAndDeleteSession(project, SessionRow("fixture-del", "a session", System.currentTimeMillis(), current = false, edits = 2, pending = 0, files = 1))
                ReviewOps.confirmAndDeleteSession(project, SessionRow("fixture-pend", "a session", System.currentTimeMillis(), current = false, edits = 2, pending = 2, files = 1))
            } finally {
                TestDialogManager.setTestDialog(prevDel)
            }
            assertTrue(delAsked[0], delAsked[0].contains("its captured edits are purged here (the backup folder keeps its copy)."))
            assertTrue(delAsked[0], delAsked[0].endsWith("`oak sessions --undelete fixture-del` lists the session again, and the next oak sync now brings back what of its edits the backup folder holds."))
            assertTrue(delAsked[1], delAsked[1].contains("so OAK can no longer undo those changes here, unless the backup folder brings them back."))
        } finally {
            other.deleteRecursively()
        }

        // This project, excluded: the CLI keys the folder it is given (`--root`, wherever it runs), and its status says so
        // after.
        val base = project.basePath!!
        val status = { SyncStatusParser.parse(com.cellobservatory.observatory.core.ObservatoryCli.syncStatus(null, base).stdout)!! }
        val here = status().project!!
        assertEquals(base, here.folder)
        assertFalse(here.excluded)
        val row = syncChoices(emptyList(), status()).single()
        assertEquals(SyncChoice(base, "this project ($base)", true), row)
        SyncOps.applySynced(project, listOf(row to false))
        until("excluded") { said("OAK sync: not syncing") != null }
        assertEquals("OAK sync: not syncing this project ($base)", said("OAK sync: not syncing"))
        val after = status()
        assertEquals(listOf(here.key), after.excludeProjects)
        assertEquals(SyncChoice(base, "this project ($base)", false), syncChoices(emptyList(), after).single())
    }

    fun testTheInstalledWidgetFollowsSyncsOwnFilesThroughTheStampCheck() {
        if (SystemInfo.isWindows) return
        read()
        // Installed on a status bar, the widget hears every read; the five-second stamp check reads again once one of
        // sync's files moved, with no read forced.
        val widget = SyncWidget(project)
        com.intellij.openapi.util.Disposer.register(testRootDisposable, widget)
        widget.install(com.intellij.openapi.wm.WindowManager.getInstance().getStatusBar(project)!!)
        PlatformTestUtil.dispatchAllInvocationEventsInIdeEventQueue()
        assertFalse("not in use: hidden", widget.label.isVisible)
        seedConflict()
        until("the run and its conflict are read on the stamp check") { widget.label.isVisible && widget.label.text == "OAK sync: 1 conflict" }
        // The key too, which `oak sync key` writes alone: a file that holds no key is said as the key's state.
        File(store, "sync/key").writeText("not a key\n")
        until("the key's change is read") { SyncOps.view?.keyError != null }
    }

    fun testASavedMachineAsTheBackupIsChosenThroughTheCli() {
        if (SystemInfo.isWindows) return
        File(bin, "machines.json").writeText("""[{"id":"m1","label":"build-box","target":"builder@build-box.example","session":"default","enabled":true,"selected":false}]""")
        // "A Saved Machine…", then the machine: the CLI sets it, and its preview asks that machine over ssh (a stub that
        // fails as an unreachable host does).
        val prevD = TestDialogManager.setTestDialog(TestDialog { 1 })
        val prevI = TestDialogManager.setTestInputDialog(object : TestInputDialog {
            override fun show(message: String): String = "build-box"
            override fun show(message: String, validator: com.intellij.openapi.ui.InputValidator?): String = "build-box"
        })
        try {
            SyncOps.setup(project)
            until("set up with the saved machine") { said("OAK sync is set up") != null }
        } finally {
            TestDialogManager.setTestDialog(prevD)
            TestDialogManager.setTestInputDialog(prevI)
        }
        assertTrue(said("OAK sync is set up")!!, said("OAK sync is set up")!!.startsWith("OAK sync is set up: the backup is build-box"))
        val prefs = com.google.gson.JsonParser.parseString(File(store, "prefs.json").readText()).asJsonObject
        assertEquals("machine", prefs.getAsJsonObject("sync").getAsJsonObject("backup").get("kind").asString)
        assertEquals("build-box", prefs.getAsJsonObject("sync").getAsJsonObject("backup").get("label").asString)
        assertTrue("the preview asked the machine", File(bin, "ssh.log").readText().contains("builder@build-box.example"))
        // A folder whose key this machine lacks, the key copied from that machine: asked of it over ssh (the stub fails,
        // and the CLI's words say so).
        val other3 = Files.createTempDirectory("oak-sync-other").toFile()
        try {
            val share3 = File(other3, "share").path
            val pb = ProcessBuilder(File(bin, "oak").path, "sync", "backup", "--folder", share3).redirectErrorStream(true)
            pb.environment().putAll(mapOf("HOME" to File(other3, "h").path, "CLAUDE_CONFIG_DIR" to File(other3, "h/.claude").path, "XDG_CONFIG_HOME" to File(other3, "h/.config").path))
            val made = pb.start()
            made.inputStream.readAllBytes()
            assertEquals("control: another machine's backup", 0, made.waitFor())
            File(bin, "ssh.log").delete()
            val asked = mutableListOf<String>()
            val prevD3 = TestDialogManager.setTestDialog(TestDialog { m -> asked += m; 0 })
            val prevI3 = TestDialogManager.setTestInputDialog(object : TestInputDialog {
                override fun show(message: String): String = "build-box"
                override fun show(message: String, validator: com.intellij.openapi.ui.InputValidator?): String = "build-box"
            })
            val before3 = seen.size
            try {
                SyncOps.runSetup(project, listOf("--folder", share3), saved = listOf("build-box"))
                until("it says why the copy failed") { seen.drop(before3).any { it.content.startsWith("OAK: sync was not set up") } }
            } finally {
                TestDialogManager.setTestDialog(prevD3)
                TestDialogManager.setTestInputDialog(prevI3)
            }
            assertTrue(asked[0], asked[0].contains("holds a backup sealed under a key this machine does not have"))
            val failed = seen.drop(before3).first { it.content.startsWith("OAK: sync was not set up") }.content
            assertTrue(failed, failed.contains("build-box"))
            assertTrue("the key was asked of the saved machine", File(bin, "ssh.log").readText().contains("builder@build-box.example"))
        } finally {
            other3.deleteRecursively()
        }
    }

    fun testAFolderRecordThisMachineDidNotWriteIsAskedAboutAndTakenOver() {
        if (SystemInfo.isWindows) return
        // An oak that answers setup as the CLI does for such a folder, recording what it was asked.
        val log = File(bin, "asked.log")
        val share = File(cfg, "share").path
        val answer = { claimed: Boolean -> """{"syncSetup":1,"backup":{"kind":"folder","path":${com.google.gson.JsonPrimitive(share)}},"key":null,""" +
            """"record":{"state":"unclaimed","lastWrite":"last written by laptop"${if (claimed) ",\"claimed\":true" else ""}},"plan":null}""" }
        File(bin, "oak-record").apply {
            writeText("#!/bin/sh\necho \"\$*\" >> '${log.path}'\ncase \"\$1 \$2\" in\n  \"machine list\") printf '[]' ;;\n" +
                "  \"sync setup\") case \" \$* \" in *\" --restore \"*) printf '%s' '${answer(true)}' ;; *) printf '%s' '${answer(false)}' ;; esac ;;\nesac\nexit 0\n")
            setExecutable(true)
        }
        ObservatorySettings.instance.state.observatoryBin = File(bin, "oak-record").path
        val asked = mutableListOf<String>()
        val prev = TestDialogManager.setTestDialog(TestDialog { m -> asked += m; Messages.YES })
        try {
            SyncOps.runSetup(project, listOf("--folder", share), saved = emptyList())
            until("taken over") { said("OAK sync is set up") != null }
        } finally {
            TestDialogManager.setTestDialog(prev)
        }
        assertTrue(asked.single(), asked.single().startsWith("last written by laptop.\n\nIf this machine is a reinstall of that one, its sessions are restored here"))
        assertEquals("asked again with --restore", listOf("sync setup --folder $share --json", "sync setup --folder $share --restore --json"),
            log.readLines().filter { it.startsWith("sync setup") })
        assertTrue(said("OAK sync is set up")!!, said("OAK sync is set up")!!.contains("This machine took the folder’s record over: the next run restores its sessions from it."))

        // A run that refused the record: the Settings page and the menu offer taking it over, which asks first.
        log.delete()
        SyncOps.view = SyncView(setUp = true, auto = true, running = false, lastAt = System.currentTimeMillis(), lastStatus = "partial", lastError = null,
            lines = listOf(SyncLine("backup ($share)", "refused", "its record is another machine's", "failed: its record is another machine's", emptyList(), "unclaimed")),
            warnings = emptyList(), backupKind = "folder", backupLabel = null, backupPath = share, keyPresent = true, keyFingerprint = "ab12", keyError = null,
            conflicts = emptyList<SyncConflict>(), excludeMachines = emptyList(), excludeProjects = emptyList())
        assertTrue("the menu offers it", texts(SyncOps.menu(project)).contains("This Machine Is a Reinstall…"))
        val page = ObservatoryConfigurable()
        try {
            page.createComponent()
            assertTrue("the Settings page offers it", field<JButton>(page, "syncRecord").isVisible)
        } finally {
            page.disposeUIResources()
        }
        val take = mutableListOf<String>()
        val prev2 = TestDialogManager.setTestDialog(TestDialog { m -> take += m; Messages.YES })
        try {
            SyncOps.takeRecordOver(project)
            until("asked to take it over") { log.exists() && log.readLines().any { it.startsWith("sync setup") } }
        } finally {
            TestDialogManager.setTestDialog(prev2)
        }
        assertTrue(take.first(), take.first().startsWith("failed: its record is another machine's\n\nTaking it over says this machine is a reinstall"))
        assertEquals(listOf("sync setup --folder $share --restore --json"), log.readLines().filter { it.startsWith("sync setup") })
    }
}
