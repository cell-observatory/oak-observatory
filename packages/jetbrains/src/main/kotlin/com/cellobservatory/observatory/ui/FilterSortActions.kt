package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.services.ObservatoryService
import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.actionSystem.Presentation
import com.intellij.openapi.actionSystem.ToggleAction
import com.intellij.openapi.actionSystem.ex.CustomComponentAction
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.ui.DocumentAdapter
import com.intellij.ui.SearchTextField
import java.awt.Dimension
import javax.swing.JComponent
import javax.swing.Timer
import javax.swing.event.AncestorEvent
import javax.swing.event.AncestorListener
import javax.swing.event.DocumentEvent

/**
 * The Filter and Sort toolbar controls, shared by the Overview navbar (ChangeMapPanel) and the Review
 * navbar (EditsTreePanel) so both offer the same control. The Search field owns the query text (which
 * reads as a regex on its own the moment it carries regex syntax — there is no mode to toggle); the
 * Filter dropdown here holds the file-type and extension narrowing, and the Sort toggle orders the
 * lists. Both controls show their own state in the toolbar — the Filter button names what it is
 * narrowing by, the Sort button names the mode in force. Everything routes through ObservatoryService,
 * which re-renders every surface — the Kotlin peer of the VS Code host commands.
 */
object FilterSortActions {
    /** The six type buckets and their labels — the Kotlin peer of core's FILE_CATEGORIES. */
    private val CATEGORIES = listOf(
        "code" to "Code", "tests" to "Tests", "config" to "Config",
        "docs" to "Docs", "styles" to "Styles", "other" to "Other",
    )

    /** The inline Search FIELD — a real text box IN the toolbar (no pop-up dialog), typing straight
     *  into the shared query. The query reads as a regex the moment it carries regex syntax. Built once
     *  with the toolbar (which outlives a content refresh), so typing never loses focus; a service
     *  listener keeps it in step when the filter is cleared elsewhere (Reset scope, another surface). */
    fun searchField(project: Project): AnAction =
        object : AnAction(), CustomComponentAction, DumbAware {
            // BGT like every other toolbar action (ToolbarContractTest): this action's update() does
            // nothing, and the platform builds the custom component on the EDT itself regardless.
            override fun getActionUpdateThread() = ActionUpdateThread.BGT
            override fun actionPerformed(e: AnActionEvent) {}
            override fun createCustomComponent(presentation: Presentation, place: String): JComponent {
                val svc = ObservatoryService.getInstance(project)
                val field = SearchTextField(false) // no history dropdown
                field.textEditor.emptyText.text = "Search…"
                field.toolTipText = "Filter edits by path — a regex when it carries regex syntax, a substring otherwise"
                field.text = svc.filterQuery
                field.preferredSize = Dimension(190, field.preferredSize.height)
                field.maximumSize = field.preferredSize
                var programmatic = false
                // Debounced: a keystroke does not spawn a CLI fetch until typing settles.
                val debounce = Timer(250) { if (field.text != svc.filterQuery) svc.setFilter(field.text) }.apply { isRepeats = false }
                field.addDocumentListener(object : DocumentAdapter() {
                    override fun textChanged(e: DocumentEvent) { if (!programmatic) debounce.restart() }
                })
                val sync = Runnable {
                    // Pull an external clear into the field — but never while it is being typed in, and
                    // never in a way that re-fires the document listener into a loop.
                    if (!field.textEditor.hasFocus() && field.text != svc.filterQuery) {
                        programmatic = true; field.text = svc.filterQuery; programmatic = false
                    }
                }
                svc.addListener(sync)
                field.addAncestorListener(object : AncestorListener {
                    override fun ancestorRemoved(event: AncestorEvent) { svc.removeListener(sync) }
                    override fun ancestorAdded(event: AncestorEvent) {}
                    override fun ancestorMoved(event: AncestorEvent) {}
                })
                return field
            }
        }

    /** The "Filter edits" dropdown (anchored to its toolbar button): the file types and extensions
     *  present in this session, and a Clear. Its toolbar text names what is applied. */
    fun filterGroup(project: Project): AnAction =
        object : DefaultActionGroup("Filter", true), DumbAware {
            @Suppress("OVERRIDE_DEPRECATION") override fun displayTextInToolbar() = true
            override fun getActionUpdateThread() = ActionUpdateThread.BGT
            init {
                templatePresentation.icon = AllIcons.General.Filter
                templatePresentation.description = "Filter edits by file type and extension (the Search box sets the text; regex is automatic)"
            }
            override fun update(e: AnActionEvent) {
                // The button carries what the filter is narrowing by — the "filter shows what is
                // applied" readout, in force everywhere the button is shown.
                val summary = ObservatoryService.getInstance(project).filterSummary()
                e.presentation.text = if (summary.isNotEmpty()) summary else "Filter"
            }
            override fun getChildren(e: AnActionEvent?): Array<AnAction> {
                val svc = ObservatoryService.getInstance(project)
                val files = svc.changemap()?.files ?: emptyList()
                val catsPresent = CATEGORIES.filter { (id, _) -> files.any { it.category == id } }
                val extsPresent = files.map { it.ext }.filter { it.isNotEmpty() }.distinct().sorted()
                val out = ArrayList<AnAction>()
                if (catsPresent.isNotEmpty()) {
                    out.add(com.intellij.openapi.actionSystem.Separator.create("File type"))
                    for ((id, label) in catsPresent) out.add(object : ToggleAction(label), DumbAware {
                        override fun getActionUpdateThread() = ActionUpdateThread.BGT
                        override fun isSelected(e: AnActionEvent) = svc.filterCats.contains(id)
                        override fun setSelected(e: AnActionEvent, state: Boolean) {
                            val next = if (state) svc.filterCats + id else svc.filterCats - id
                            svc.setFilterSpec(svc.filterExts, next)
                        }
                    })
                }
                if (extsPresent.isNotEmpty()) {
                    out.add(com.intellij.openapi.actionSystem.Separator.create("Extension"))
                    for (ext in extsPresent) out.add(object : ToggleAction(".$ext"), DumbAware {
                        override fun getActionUpdateThread() = ActionUpdateThread.BGT
                        override fun isSelected(e: AnActionEvent) = svc.filterExts.contains(ext)
                        override fun setSelected(e: AnActionEvent, state: Boolean) {
                            val next = if (state) svc.filterExts + ext else svc.filterExts - ext
                            svc.setFilterSpec(next, svc.filterCats)
                        }
                    })
                }
                if (out.isNotEmpty()) {
                    out.add(com.intellij.openapi.actionSystem.Separator.create())
                    out.add(object : AnAction("Clear filter"), DumbAware {
                        override fun getActionUpdateThread() = ActionUpdateThread.BGT
                        override fun update(e: AnActionEvent) {
                            e.presentation.isEnabled = svc.filterExts.isNotEmpty() || svc.filterCats.isNotEmpty() || svc.filterQuery.isNotEmpty()
                        }
                        override fun actionPerformed(e: AnActionEvent) { svc.setFilterQuery(""); svc.setFilterSpec(emptyList(), emptyList()) }
                    })
                }
                return out.toTypedArray()
            }
        }

    private fun sortShort(key: String): String = when (key) {
        "time-asc" -> "Oldest"; "name" -> "A→Z"; "name-desc" -> "Z→A"; else -> "Newest"
    }

    /** The Sort DROPDOWN (anchored to its toolbar button): the four orders as a radio group — a
     *  direction each way on two axes. Its toolbar text names the order in force. */
    fun sortGroup(project: Project): AnAction =
        object : DefaultActionGroup("Sort", true), DumbAware {
            @Suppress("OVERRIDE_DEPRECATION") override fun displayTextInToolbar() = true
            override fun getActionUpdateThread() = ActionUpdateThread.BGT
            init {
                templatePresentation.icon = AllIcons.ObjectBrowser.Sorted
                templatePresentation.description = "Sort order — newest / oldest / name A→Z / name Z→A"
            }
            override fun update(e: AnActionEvent) {
                e.presentation.text = "Sort: " + sortShort(ObservatoryService.getInstance(project).sortKey())
            }
            override fun getChildren(e: AnActionEvent?): Array<AnAction> {
                val svc = ObservatoryService.getInstance(project)
                return com.cellobservatory.observatory.services.OAK_SORT_KEYS.map { key ->
                    object : ToggleAction(svc.sortLabel(key)), DumbAware {
                        override fun getActionUpdateThread() = ActionUpdateThread.BGT
                        override fun isSelected(e: AnActionEvent) = svc.sortKey() == key
                        override fun setSelected(e: AnActionEvent, state: Boolean) { if (state) svc.setSortKey(key) }
                    }
                }.toTypedArray()
            }
        }
}
