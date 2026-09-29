package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.services.ObservatoryService
import com.intellij.ide.projectView.PresentationData
import com.intellij.ide.projectView.ProjectViewNode
import com.intellij.ide.projectView.ProjectViewNodeDecorator
import com.intellij.ui.JBColor
import com.intellij.ui.SimpleTextAttributes
import java.awt.Color

/**
 * Badges files that have pending agent edits in the Project view — a small "●N" after the name in
 * the pending-amber accent (parity with the VS Code FileDecorationProvider). Count is O(1): it reads
 * ObservatoryService's log-cached pending-by-file map.
 */
class ObservatoryNodeDecorator : ProjectViewNodeDecorator {
    override fun decorate(node: ProjectViewNode<*>, data: PresentationData) {
        val project = node.project ?: return
        val vf = node.virtualFile ?: return
        if (vf.isDirectory) return
        val pending = try {
            ObservatoryService.getInstance(project).pendingCount(vf.path)
        } catch (_: Exception) {
            return
        }
        if (pending <= 0) return
        val accent = JBColor(Color(0xB8, 0x86, 0x0B), Color(0xE5, 0xC0, 0x7B)) // amber (light / dark)
        data.addText("  ●$pending", SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, accent))
        data.tooltip = (data.tooltip?.let { "$it\n" } ?: "") + "$pending pending agent edit(s)"
    }
}
