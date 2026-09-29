package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.core.StoreReader
import com.cellobservatory.observatory.model.EditRecord
import com.cellobservatory.observatory.model.ReviewParser
import com.cellobservatory.observatory.services.ObserveCache
import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffManager
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.diff.tools.fragmented.UnifiedDiffTool
import com.intellij.diff.util.DiffUserDataKeys
import com.intellij.diff.util.DiffUserDataKeysEx
import com.intellij.icons.AllIcons
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import java.io.File

/** Before ⟷ after viewer for one edit, from the store's content-addressed blobs. */
object Diffs {

    /** Default to the unified (inline) viewer — the red/green single-column look — unless the user has
     *  opted back to side-by-side. Parity with the VS Code inline-diff toggle. */
    private fun SimpleDiffRequest.preferUnified(): SimpleDiffRequest {
        if (ObservatorySettings.instance.state.unifiedDiff) {
            putUserData(DiffUserDataKeysEx.FORCE_DIFF_TOOL, UnifiedDiffTool.INSTANCE)
        }
        return this
    }

    private fun action(text: String, icon: javax.swing.Icon, run: () -> Unit): AnAction =
        object : AnAction(text, null, icon) {
            override fun actionPerformed(e: AnActionEvent) = run()
        }

    /** Step to the previous (dir=-1) / next (dir=+1) edit in the SAME file (by id, wrapping) and reopen
     *  the diff on it — the diff viewer's own edit navigation. */
    private fun stepInFile(project: Project, session: String, rec: EditRecord, dir: Int) {
        val inFile = ObservatoryService.getInstance(project).log().filter { it.file == rec.file }.sortedBy { it.id }
        if (inFile.isEmpty()) return
        val idx = inFile.indexOfFirst { it.id == rec.id }.let { if (it < 0) 0 else it }
        val target = inFile[(idx + dir + inFile.size) % inFile.size]
        show(project, session, target)
    }

    fun show(project: Project, session: String, rec: EditRecord) {
        val app = ApplicationManager.getApplication()
        // Read the (potentially large) before/after blobs OFF the EDT — this is invoked from
        // double-click / menu handlers on the UI thread. Build the diff prompt + show on the EDT.
        app.executeOnPooledThread {
            val before = StoreReader.readBlob(session, rec.beforeBlob)
            val after = StoreReader.readBlob(session, rec.afterBlob)
            // the agent's reasoning rides in the diff title; Keep/Undo/Chat sit in the diff toolbar.
            val reason = ObserveCache.getInstance(project).payload()?.edits?.find { it.id == rec.id }?.reasoning
                ?.lineSequence()?.firstOrNull { it.isNotBlank() }?.trim()
            app.invokeLater {
                if (project.isDisposed) return@invokeLater
                val name = File(rec.file).name
                val type = FileTypeManager.getInstance().getFileTypeByFileName(name) // syntax highlighting per side
                val factory = DiffContentFactory.getInstance()
                val title = if (reason != null) "#${rec.id} · ${if (reason.length > 80) reason.take(79) + "…" else reason}"
                else "$name — edit #${rec.id}"
                val prompt = SimpleDiffRequest(
                    title,
                    factory.create(project, before, type),
                    factory.create(project, after, type),
                    if (rec.beforeBlob == null) "(new file)" else "before",
                    if (rec.afterBlob == null) "(deleted)" else "after",
                )
                prompt.putUserData(
                    DiffUserDataKeys.CONTEXT_ACTIONS,
                    listOf(
                        action("Keep #${rec.id}", NavTint.KEEP) { ReviewOps.keep(project, session, rec.id, advance = false) },
                        action("Undo #${rec.id}", NavTint.UNDO) { ReviewOps.undoOrRedo(project, session, rec, redo = false, advance = false) },
                        action("Chat About #${rec.id}", AllIcons.General.Balloon) { ReviewOps.chatAbout(project, session, rec.id) },
                        // Step to the previous / next edit in THIS file and reopen the diff (parity with VS
                        // Code's diff-title Previous/Next edit); reuses the same tinted chevrons as the nav bar.
                        action("Previous edit in this file", NavTint.tint(AllIcons.Actions.PreviousOccurence, NavTint.BLUE)) { stepInFile(project, session, rec, -1) },
                        action("Next edit in this file", NavTint.tint(AllIcons.Actions.NextOccurence, NavTint.BLUE)) { stepInFile(project, session, rec, 1) },
                    ),
                )
                DiffManager.getInstance().showDiff(project, prompt.preferUnified())
            }
        }
    }

    /** The scope's changes CONCATENATED into a single editor tab — the plugin's own stacked review
     *  editor ([ReviewAllEditor]): every listed pending unit an embedded hunks-only diff with
     *  Keep/Undo/Chat on its header. The editor pages itself (ten blocks at a time, blobs read per
     *  page off the EDT — the eager build measurably froze the IDE at 2,922 units), so opening here
     *  just hands it the SPECS. Re-opening replaces the previous "Agent changes" tab: the tab is a
     *  snapshot, and stacking stale snapshots with live buttons multiplies wrong targets. */
    fun showAll(project: Project, session: String, recs: List<Triple<EditRecord, String, Int>>, title: String? = null) {
        if (recs.isEmpty()) {
            // The button only renders over a non-empty list, so an empty call means the log moved
            // between paint and click — say so rather than doing nothing.
            ReviewOps.notify(project, "Nothing to open — the session's log changed under the Review list", NotificationType.WARNING)
            return
        }
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            val fem = FileEditorManager.getInstance(project)
            fem.openFiles.filterIsInstance<ReviewAllVirtualFile>().forEach { fem.closeFile(it) }
            val specs = recs.map { (rec, rel, delta) -> ReviewAllSpec(rec, rel, delta) }
            fem.openFile(ReviewAllVirtualFile(session, specs, title ?: "Agent changes (${specs.size})"), true)
        }
    }

    /** The feed's edit-item opener: one FILE's changes as the stacked editor — every unit of that file, decided ones
     *  included, since the blocks carry verdicts and their remaining verb (a pending-only scope
     *  would open a fully decided file empty). Units and their net pairs come from the CLI's
     *  `review` — the same source the Review panel stacks from — resolved against the SUBJECT
     *  session's own log, which is not necessarily the reviewed session (a worker's feed). */
    fun showFileStacked(project: Project, session: String, file: String) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val result = ObservatoryCli.reviewJson(session, null, project.basePath)?.let { ReviewParser.parse(it) }
            val units = result?.units?.filter { it.file == file } ?: emptyList()
            val log = StoreReader.readLog(session)
            val recs = units.mapNotNull { u ->
                // Mirrors ReviewPanel.netRecord, over THIS session's log: a PENDING unit diffs as
                // the net pair (span-first before + the unit's after); a RESOLVED unit arrives raw —
                // core stops collapsing after keep/undo, and synthesizing here would double-count.
                val rep = log.find { it.id == u.id } ?: return@mapNotNull null
                val rec = if (!u.pending) rep else {
                    val first = log.find { it.id == (u.members.firstOrNull() ?: u.id) } ?: rep
                    if (first.id == rep.id) rep else rep.copy(beforeBlob = first.beforeBlob)
                }
                Triple(rec, u.rel, u.added + u.removed)
            }
            if (recs.isEmpty()) {
                ReviewOps.notify(project, "Nothing to review for ${File(file).name}", NotificationType.WARNING)
                return@executeOnPooledThread
            }
            showAll(project, session, recs, "${File(file).name} — ${recs.size} change(s) · stacked")
        }
    }

    /** Revision navigation: diff the full-file state EDIT produced (its afterBlob, left) against the live,
     *  editable current file (right). Parity with the VS Code current-vs-revision diff. */
    fun showRevision(project: Project, session: String, rec: EditRecord, currentFile: VirtualFile) {
        val app = ApplicationManager.getApplication()
        app.executeOnPooledThread {
            val revision = StoreReader.readBlob(session, rec.afterBlob) // "" if the edit deleted the file
            app.invokeLater {
                if (project.isDisposed) return@invokeLater
                val name = File(rec.file).name
                val type = FileTypeManager.getInstance().getFileTypeByFileName(name)
                val factory = DiffContentFactory.getInstance()
                val prompt = SimpleDiffRequest(
                    "edit #${rec.id} ⟶ (this file)",
                    factory.create(project, revision, type), // left: recorded revision (read-only)
                    factory.create(project, currentFile),    // right: live, editable current file
                    "edit #${rec.id}",
                    "(this file)",
                )
                DiffManager.getInstance().showDiff(project, prompt.preferUnified())
            }
        }
    }
}
