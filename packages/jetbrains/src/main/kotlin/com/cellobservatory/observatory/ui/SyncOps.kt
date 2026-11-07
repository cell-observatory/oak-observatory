package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.model.SyncChoice
import com.cellobservatory.observatory.model.SyncConflict
import com.cellobservatory.observatory.model.SyncNowParser
import com.cellobservatory.observatory.model.SyncSetupParser
import com.cellobservatory.observatory.model.SyncStatusParser
import com.cellobservatory.observatory.model.SyncView
import com.cellobservatory.observatory.model.syncChoices
import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffManager
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.ide.DataManager
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionGroup
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.testFramework.LightVirtualFile
import com.intellij.ui.CheckBoxList
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.concurrency.AppExecutorUtil
import java.awt.Component
import java.nio.file.Files
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Future
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import javax.swing.JComponent

/**
 * oak sync in this plugin: its status, read through the CLI whenever one of sync's own files moves, and its actions —
 * run now, set up or change the backup (asking what `oak sync setup` asks on a terminal), the machines and projects
 * synced, an open conflict's two ways out, and taking the backup folder's record over — each through the CLI, which
 * keeps sync's settings in prefs.json: this plugin keeps no copy. The status bar widget, the Overview's Sessions tab
 * and the Settings page render [view].
 */
object SyncOps {
    /** The last `oak sync status --json`; null until one answers. */
    @Volatile
    var view: SyncView? = null
        internal set

    private val listeners = CopyOnWriteArrayList<() -> Unit>()

    /** Told on the EDT after each read, in any modality (the Settings page is a modal dialog's, and a listener only
     *  repaints), until [parent] is disposed; the first starts the stamp check. */
    fun addListener(parent: Disposable, listener: () -> Unit) {
        listeners += listener
        Disposer.register(parent) { listeners -= listener }
        ensureWatching()
    }

    /** Reads run one at a time, in order, so a read asked for after an action is never overtaken by an older one. */
    private val reads = AppExecutorUtil.createBoundedApplicationPoolExecutor("OAK sync status", 1)
    @Volatile private var stamp = ""
    private var watch: ScheduledFuture<*>? = null

    /** sync's own files: its status, conflicts, run lock and key, and prefs.json, which holds its settings; and the day,
     *  so a new day reads again and the run's clock time then carries its date. */
    private fun stampNow(): String {
        val sync = ClaudePaths.rootDir().resolve("sync")
        return (listOf("status.json", "conflicts.json", "now.lock", "key").map { sync.resolve(it) } + ClaudePaths.configDir().resolve("claude-observatory").resolve("prefs.json"))
            .joinToString("|") { f -> runCatching { "${Files.getLastModifiedTime(f).toMillis()}:${Files.size(f)}" }.getOrDefault("-") } + "|" + java.time.LocalDate.now()
    }

    /** Read `oak sync status --json` again: when one of sync's own files moved since the last read, or always ([force],
     *  after an action). Off the EDT; done when the future is. A read that does not answer keeps what was read before. */
    fun refresh(force: Boolean = false): Future<*> = reads.submit(Runnable {
        val now = stampNow()
        if (!force && now == stamp) return@Runnable
        stamp = now
        val v = SyncStatusParser.parse(ObservatoryCli.syncStatus(null).stdout) ?: return@Runnable
        view = v
        ApplicationManager.getApplication().invokeLater({ listeners.forEach { it() } }, ModalityState.any())
    })

    /** Every five seconds, five stats; the CLI only when the stamp moved. */
    @Synchronized
    private fun ensureWatching() {
        if (watch != null) return
        watch = AppExecutorUtil.getAppScheduledExecutorService().scheduleWithFixedDelay({ if (listeners.isNotEmpty()) refresh() }, 0, 5, TimeUnit.SECONDS)
    }

    private fun notify(project: Project?, text: String, type: NotificationType = NotificationType.INFORMATION, action: Pair<String, () -> Unit>? = null) {
        val n = NotificationGroupManager.getInstance().getNotificationGroup("OAK").createNotification(text, type)
        action?.let { (label, run) -> n.addAction(NotificationAction.createSimpleExpiring(label) { run() }) }
        n.notify(project)
    }

    private fun bg(project: Project?, title: String, cancellable: Boolean = false, work: (ProgressIndicator) -> Unit) {
        ProgressManager.getInstance().run(object : Task.Backgroundable(project, title, cancellable) {
            override fun run(indicator: ProgressIndicator) = work(indicator)
        })
    }

    /** Back on the EDT for what an action says or asks next, in any modality: an action started from the Settings page,
     *  a modal dialog, asks its next question over it rather than once it closes. Dialogs and notifications only. */
    private fun edt(work: () -> Unit) = ApplicationManager.getApplication().invokeLater(work, ModalityState.any())

    /** `oak sync now`, with a cancellable progress bar, then what the run did. */
    fun syncNow(project: Project?) = bg(project, "OAK: syncing with the saved machines…", cancellable = true) { indicator ->
        indicator.isIndeterminate = true
        val r = ObservatoryCli.syncNow(project?.basePath, indicator)
        val said = SyncNowParser.parse(r.stdout)
        edt {
            if (said == null) {
                notify(project, "OAK: sync did not run — " + ObservatoryCli.failureMessage(r.stdout, r.stderr, "oak sync now did not answer").removePrefix("oak: "), NotificationType.ERROR)
            } else {
                notify(project, "OAK sync: ${said.text}", if (said.failed) NotificationType.WARNING else NotificationType.INFORMATION, "Show the Last Run" to { showLastRun(project) })
            }
        }
        refresh(force = true)
    }

    /** `oak sync status`'s own text, in a tab: every machine's line whole, the conflicts and the warnings. */
    fun showLastRun(project: Project?) = bg(project, "OAK: reading sync's status…") {
        val r = ObservatoryCli.syncStatusText(project?.basePath)
        // Not in any modality: it opens an editor tab (the menu offers it, never the Settings page).
        ApplicationManager.getApplication().invokeLater {
            if (!r.ok) return@invokeLater notify(project, "OAK: could not read sync's status — " + ObservatoryCli.failureMessage(r.stdout, r.stderr, "oak sync status did not answer").removePrefix("oak: "), NotificationType.ERROR)
            if (project != null) FileEditorManager.getInstance(project).openFile(LightVirtualFile("oak sync status.txt", r.stdout), true)
            else Messages.showInfoMessage(r.stdout, "OAK Sync")
        }
    }

    /**
     * `oak sync setup`, asking what it asks on a terminal: where sessions are backed up (nowhere else, a saved machine,
     * or a folder); for a folder that holds a backup this machine's key does not open, where the key comes from (copied
     * from a saved machine, or pasted); and for a folder whose record under this machine's name this machine has not
     * written, whether this machine is a reinstall of the one that wrote it. Also how the backup is changed later.
     */
    fun setup(project: Project?) = bg(project, "OAK: reading the saved machines…") {
        val saved = ObservatoryCli.machineLabels(project?.basePath).map { plainLabel(it) }
        edt {
            val options = arrayOf("Nowhere Else", "A Saved Machine…", "A Folder…", "Cancel")
            val where = Messages.showDialog(project,
                "Where are the agents' sessions backed up? Memory, plans, skills, agents and commands go to every saved machine either way.\n\n" +
                    "Nowhere else: each session stays on the machine that made it.\n" +
                    "A saved machine: it keeps every machine's sessions (${if (saved.isEmpty()) "none is saved here yet: oak machine add <label> <ssh-target> saves one" else saved.joinToString(", ")}).\n" +
                    "A folder: a network share, a NAS or a disk, encrypted with a key only your machines hold.",
                "OAK Sync Setup", options, 0, Messages.getQuestionIcon())
            when (where) {
                0 -> runSetup(project, listOf("--none"), saved)
                1 -> {
                    if (saved.isEmpty()) return@edt notify(project, "OAK: no machine is saved here — oak machine add <label> <ssh-target> saves one.", NotificationType.ERROR)
                    val m = Messages.showEditableChooseDialog("The machine that keeps every machine's sessions:", "OAK Sync Setup", Messages.getQuestionIcon(), saved.toTypedArray(), saved[0], null)
                    if (m != null) runSetup(project, listOf("--machine", m), saved)
                }
                2 -> FileChooser.chooseFile(FileChooserDescriptorFactory.createSingleFolderDescriptor().withTitle("The Backup Folder, as This Machine Reaches It"), project, null) { dir ->
                    runSetup(project, listOf("--folder", dir.path), saved)
                }
            }
        }
    }

    internal fun runSetup(project: Project?, args: List<String>, saved: List<String>, key: String? = null): Unit = bg(project, "OAK: setting sync up, and previewing a first run…") {
        val r = ObservatoryCli.syncSetup(args, key, project?.basePath)
        val a = SyncSetupParser.parse(r.stdout)
        val base = args.filterIndexed { i, x -> x != "--import-key" && x != "--key-from" && x != "--replace" && args.getOrNull(i - 1) != "--key-from" }
        edt {
            when {
                a?.needsKey == true -> {
                    // Where the folder's key comes from, as setup asks on a terminal; brought over this machine's own key
                    // (made for another folder), it replaces it, and the old one is kept beside it (`--replace`).
                    val over = a.keyHere?.let { "\n\nThis machine keeps another backup key ($it): the folder's replaces it here, and the old one is kept beside it." } ?: ""
                    val replace = if (a.keyHere != null) listOf("--replace") else emptyList()
                    val options = (if (saved.isNotEmpty()) arrayOf("Copy It From a Saved Machine…") else emptyArray()) + arrayOf("Paste It…", "Cancel")
                    val how = Messages.showDialog(project, (a.error ?: "") + over, "OAK: This Folder Holds a Backup Sealed With a Key This Machine Does Not Have", options, 0, Messages.getWarningIcon())
                    when (options.getOrNull(how)) {
                        "Copy It From a Saved Machine…" -> Messages.showEditableChooseDialog("Copy the backup key from:", "OAK Sync Setup", Messages.getQuestionIcon(), saved.toTypedArray(), saved[0], null)
                            ?.let { runSetup(project, base + listOf("--key-from", it) + replace, saved) }
                        "Paste It…" -> Messages.showPasswordDialog(project, "The key from `oak sync key --show` on a machine that has it (oak-sync-1:…); it is not shown as you paste it:", "OAK Sync Setup", null)
                            ?.takeIf { it.isNotBlank() }?.let { runSetup(project, base + "--import-key" + replace, saved, it) }
                    }
                }
                a == null || r.exitCode != 0 -> notify(project, "OAK: sync was not set up — " + ObservatoryCli.failureMessage(r.stdout, r.stderr, "oak sync setup did not answer").removePrefix("oak: "), NotificationType.ERROR)
                a.asksRestore && Messages.showYesNoDialog(project,
                    "${a.recordLastWrite ?: ""}.\n\nIf this machine is a reinstall of that one, its sessions are restored here, and it writes that record from now on. " +
                        "If it is another machine, give it another host name: until then nothing is restored from the folder or written to it.",
                    "OAK: The Backup Folder Holds a Record Under This Machine's Name That This Machine Has Not Written",
                    "This Machine Is a Reinstall: Restore From It", "No", Messages.getWarningIcon()) == Messages.YES -> runSetup(project, base + "--restore", saved)
                else -> {
                    val text = "OAK sync is set up: ${a.what}" + a.notes.joinToString("") { "\n\n$it" }
                    // A new key's advice is a dialog: losing the key loses the backup.
                    if (a.keyMade) Messages.showInfoMessage(project, text, "OAK Sync")
                    else notify(project, text, action = "Sync Now" to { syncNow(project) })
                }
            }
        }
        refresh(force = true)
    }

    /** Which saved machines and projects this machine syncs with: the ticked ones; one unticked is `oak sync exclude`d,
     *  one ticked again `oak sync include`d. */
    fun chooseSynced(project: Project?) = bg(project, "OAK: reading the saved machines…") {
        val saved = ObservatoryCli.machineLabels(project?.basePath).map { plainLabel(it) }
        // Read for this project's folder, so the CLI names the project and whether it is excluded here; with no project
        // open, no project row (the status read for every window names the folder the IDE runs in).
        val root = project?.basePath
        val items = syncChoices(saved, root?.let { SyncStatusParser.parse(ObservatoryCli.syncStatus(it, it).stdout) } ?: view?.copy(project = null))
        edt {
            if (items.isEmpty()) return@edt notify(project, "OAK: no saved machine or project to choose — oak machine add <label> <ssh-target> saves a machine.")
            val list = CheckBoxList<SyncChoice>()
            items.forEach { list.addItem(it, it.text, it.synced) }
            val dialog = object : DialogWrapper(project, true) {
                init {
                    title = "OAK Sync: Machines and Projects"
                    init()
                }
                override fun createCenterPanel(): JComponent = JBScrollPane(list)
            }
            if (!dialog.showAndGet()) return@edt
            applySynced(project, items.mapIndexedNotNull { i, it -> list.isItemSelected(i).takeIf { on -> on != it.synced }?.let { on -> it to on } })
        }
    }

    /** Include ([Pair.second]) or exclude each choice the reader changed, through the CLI, then say what changed. */
    internal fun applySynced(project: Project?, changes: List<Pair<SyncChoice, Boolean>>) {
        if (changes.isEmpty()) return
        bg(project, "OAK: changing which machines and projects sync…") {
            val said = changes.map { (it, on) ->
                val r = ObservatoryCli.syncSelect(on, it.arg, project?.basePath)
                if (r.ok) "${if (on) "syncing" else "not syncing"} ${it.text}"
                else "could not ${if (on) "include" else "exclude"} ${it.text}: " + ObservatoryCli.failureMessage(r.stdout, r.stderr, "no answer").removePrefix("oak: ")
            }
            edt { notify(project, "OAK sync: ${said.joinToString("; ")}") }
            refresh(force = true)
        }
    }

    /** A conflict's two ways out, as `oak inbox` names them: both copies side by side (the other machine's on the left,
     *  this machine's on the right, to edit into the merge), or the other machine's copy deleted (`oak sync resolve`). */
    fun openBoth(project: Project, c: SyncConflict) {
        val fs = LocalFileSystem.getInstance()
        val copy = fs.refreshAndFindFileByPath(c.copy) ?: return notify(project, "OAK: ${c.from}'s copy of ${c.name} is gone: the conflict is resolved.")
        val mine = c.file?.let { fs.refreshAndFindFileByPath(it) }
        if (mine == null) {
            notify(project, "OAK: this machine's ${c.family} ${c.name} is not where sync reaches it, so only ${c.from}'s copy opens.", NotificationType.WARNING)
            FileEditorManager.getInstance(project).openFile(copy, true)
            return
        }
        val f = DiffContentFactory.getInstance()
        DiffManager.getInstance().showDiff(project, SimpleDiffRequest("${c.name}: ${c.from}'s copy ↔ yours", f.create(project, copy), f.create(project, mine), "${c.from}'s copy", "yours"))
    }

    fun deleteCopy(project: Project?, c: SyncConflict) {
        val ok = Messages.showYesNoDialog(project,
            "It goes to sync's trash, and this machine's file stands: ${c.file ?: "not where sync reaches it here"}." +
                if (c.reason == "diverged") " That copy of the session is not fetched again until the other machine's copy changes." else "",
            "Delete ${c.from}'s Copy of ${c.family} ${c.name}?", "Delete ${c.from}'s Copy", "Cancel", Messages.getWarningIcon())
        if (ok != Messages.YES) return
        bg(project, "OAK: resolving the conflict…") {
            val r = ObservatoryCli.syncResolve(c.id, project?.basePath)
            val done = r.ok && runCatching { com.google.gson.JsonParser.parseString(r.stdout).asJsonObject.get("syncResolve")?.asInt == 1 }.getOrDefault(false)
            val trash = runCatching { com.google.gson.JsonParser.parseString(r.stdout).asJsonObject.get("trash")?.takeIf { !it.isJsonNull }?.asString }.getOrNull()
            edt {
                if (done) notify(project, "OAK sync: ${c.from}'s copy of ${c.name} ${if (trash != null) "is in sync's trash" else "was gone already"}, and yours stands.")
                else notify(project, "OAK: the conflict was not resolved — " + ObservatoryCli.failureMessage(r.stdout, r.stderr, "oak sync resolve did not answer").removePrefix("oak: "), NotificationType.ERROR)
            }
            refresh(force = true)
        }
    }

    /** Take the backup folder's record under this machine's name over (`oak sync setup --folder <path> --restore`), after
     *  saying why the run refused it and what taking it over does. */
    fun takeRecordOver(project: Project?) {
        val v = view ?: return
        val line = v.backupLine?.takeIf { it.record != null } ?: return
        val path = v.backupPath ?: return
        val ok = Messages.showYesNoDialog(project,
            "${line.said}\n\nTaking it over says this machine is a reinstall of the one that wrote it (or its own sync state was put back from an older copy): " +
                "the next run restores this machine's sessions from it, and this machine writes that record from now on.",
            "OAK: The Backup Folder Refused Its Record Under This Machine's Name", "Take the Record Over", "Cancel", Messages.getWarningIcon())
        if (ok == Messages.YES) bg(project, "OAK: reading the saved machines…") { runSetup(project, listOf("--folder", path, "--restore"), ObservatoryCli.machineLabels(project?.basePath)) }
    }

    private fun act(text: String, run: () -> Unit) = object : DumbAwareAction(text) {
        override fun actionPerformed(e: AnActionEvent) = run()
    }

    /** One conflict's actions: open both copies, or delete the other machine's copy. */
    fun conflictActions(project: Project, c: SyncConflict): ActionGroup = DefaultActionGroup(
        act("Open Both Copies") { openBoth(project, c) },
        act("Delete ${c.from}'s Copy (Yours Stands)") { deleteCopy(project, c) },
    ).apply { templatePresentation.text = "${c.family} ${c.name} from ${c.from}: ${c.resolution}"; isPopup = true }

    /** OAK sync's menu (the status bar widget, the OAK: Sync… action, and the Settings page): run now, each open
     *  conflict, taking the backup folder's record over when a run refused it, the backup (set up, or change it), the
     *  machines and projects synced, and the last run whole. */
    fun menu(project: Project?): DefaultActionGroup {
        val v = view
        val g = DefaultActionGroup()
        g.add(act("Sync Now") { syncNow(project) })
        if (project != null) v?.conflicts?.forEach { g.add(conflictActions(project, it)) }
        if (v?.backupLine?.record != null) g.add(act("This Machine Is a Reinstall…") { takeRecordOver(project) })
        g.add(act(if (v?.inUse == true) "Change the Backup…" else "Set Up Sync…") { setup(project) })
        g.add(act("Machines and Projects…") { chooseSynced(project) })
        if (v?.lastAt != null) g.add(act("The Last Run") { showLastRun(project) })
        return g
    }

    fun showMenu(project: Project?, anchor: Component?) {
        val popup = JBPopupFactory.getInstance().createActionGroupPopup("OAK sync — ${view?.runText ?: "not read yet"}", menu(project),
            DataManager.getInstance().getDataContext(anchor), JBPopupFactory.ActionSelectionAid.SPEEDSEARCH, true)
        if (anchor != null && anchor.isShowing) popup.showUnderneathOf(anchor)
        else if (project != null) popup.showCenteredInCurrentWindow(project)
        else popup.showInFocusCenter()
    }
}
