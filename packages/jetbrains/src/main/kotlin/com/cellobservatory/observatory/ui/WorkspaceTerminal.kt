package com.cellobservatory.observatory.ui

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindowManager
import org.jetbrains.plugins.terminal.TerminalToolWindowManager

/** Loaded only with the optional Terminal plugin. Keep its placement and reuse the window's OAK tab. */
class WorkspaceTerminal(private val project: Project) {
    fun open(create: (String, String?, String) -> Unit = { name, cwd, command ->
        TerminalToolWindowManager.getInstance(project).createShellWidget(cwd, name, false, false).sendCommandToExecute(command)
    }) {
        val window = ToolWindowManager.getInstance(project).getToolWindow("Terminal") ?: return
        val existing = window.contentManager.contents.firstOrNull { it.displayName == "OAK" }
        if (existing == null) create("OAK", project.basePath, "oak") else window.contentManager.setSelectedContent(existing)
        window.activate(null)
    }
}
