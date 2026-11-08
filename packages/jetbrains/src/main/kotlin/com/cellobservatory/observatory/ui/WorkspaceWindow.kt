package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.model.SessionRow
import com.cellobservatory.observatory.model.SessionsParser
import com.google.gson.JsonParser
import com.intellij.ide.impl.OpenProjectTask
import com.intellij.ide.impl.ProjectUtil
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicBoolean

object WorkspaceWindow {
    private val opening = AtomicBoolean(false)
    fun open(project: Project, row: SessionRow, machine: String? = null,
        openProject: (Path, OpenProjectTask) -> Unit = { path, task -> ProjectUtil.openOrImport(path, task); Unit },
        browse: (String) -> Unit = { java.awt.Desktop.getDesktop().browse(java.net.URI(it)) }) {
        if (!opening.compareAndSet(false, true)) return
        ApplicationManager.getApplication().executeOnPooledThread {
            fun run(args: List<String>): String {
                val result = ObservatoryCli.run(args, project.basePath)
                check(result.ok) { ObservatoryCli.failureMessage(result.stdout, result.stderr, "OAK did not answer") }
                return result.stdout
            }
            try {
                val selected = if (machine == null) row else SessionsParser.parse(run(listOf("sessions", "--json", "--session", row.id, "--machine", machine)), false)
                    ?.sessions?.find { it.id == row.id } ?: error("this session has no workspace")
                val folder = selected.workspacePath
                check(folder.isNotBlank() && Path.of(folder).isAbsolute) { "this session has no workspace" }
                val exists = if (machine == null) Files.isDirectory(Path.of(folder)) else selected.workspaceExists
                check(exists != false) { "workspace folder is missing or unavailable${machine?.let { " on $it" } ?: ""}: $folder" }
                check(exists == true) { "could not verify the workspace folder on $machine; update OAK there" }
                var link: String? = null
                var target = machine.orEmpty()
                if (machine != null) {
                    val machines = JsonParser.parseString(run(listOf("machine", "list", "--json"))).asJsonArray.map { it.asJsonObject }
                        .filter { it.get("label")?.asString == machine || it.get("id")?.asString == machine }
                    check(machines.size == 1 && machines.single().get("enabled")?.asBoolean != false) { "Saved machine has no unique enabled SSH target" }
                    target = machines.single().get("target")?.asString ?: error("Saved machine has no SSH target")
                    link = runCatching {
                        val info = JsonParser.parseString(run(listOf("editor-review", "info", "--session", row.id, "--editor", "jetbrains",
                            "--product", com.intellij.openapi.application.ApplicationInfo.getInstance().build.productCode, "--json", "--machine", machine))).asJsonObject
                        val connection = JsonParser.parseString(run(listOf("editor-review", "connection", "--target", target, "--json"))).asJsonObject
                        RemoteEditorReview.gatewayLink(connection.get("host")?.asString.orEmpty(), connection.get("user")?.asString.orEmpty(),
                            connection.get("port")?.asInt ?: 0, info.get("idePath")?.takeUnless { it.isJsonNull }?.asString, folder)
                    }.getOrNull()
                }
                val prepared = JsonParser.parseString(run(listOf("editor-review", "prepare", "--session", row.id,
                    "--editor", "jetbrains", "--action", "workspace", "--json") + (machine?.let { listOf("--machine", it) } ?: emptyList()))).asJsonObject
                check(prepared.get("request")?.isJsonObject == true && prepared.get("workspace")?.asString == folder) { "The workspace handoff was not written for this folder" }
                ApplicationManager.getApplication().invokeLater {
                    try {
                        if (!project.isDisposed) {
                            if (machine == null) openProject(Path.of(folder), OpenProjectTask().withForceOpenInNewFrame(true))
                            else {
                                val instructions = "Open JetBrains Gateway (install it if needed), or File → Remote Development → SSH → New Connection. Use $target and open $folder."
                                val launched = link?.let { runCatching { browse(it) }.isSuccess } == true
                                Messages.showInfoMessage(project, if (launched) "Continue in Gateway. If it did not open: $instructions" else instructions, "Open workspace window")
                            }
                        }
                    } catch (e: Exception) {
                        Messages.showInfoMessage(project, "Could not open workspace: ${e.message}", "Open workspace window")
                    } finally { opening.set(false) }
                }
            } catch (e: Exception) {
                ApplicationManager.getApplication().invokeLater {
                    try { if (!project.isDisposed) Messages.showInfoMessage(project, e.message, "Open workspace window") }
                    finally { opening.set(false) }
                }
            }
        }
    }
}
