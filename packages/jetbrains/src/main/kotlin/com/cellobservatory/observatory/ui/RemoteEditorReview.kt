package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.model.ReviewParser
import com.cellobservatory.observatory.services.ObservatoryService
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.concurrent.ConcurrentHashMap

/** The request lives on the session's host; Gateway only needs the normal SSH project link. */
object RemoteEditorReview {
    data class Mounted(val machine: String, val session: String, val remote: String)
    private val mounted = ConcurrentHashMap<String, Mounted>()
    fun mountedFile(project: Project, local: String): Mounted? {
        val svc = ObservatoryService.getInstance(project)
        return mounted[local]?.takeIf { it.machine == svc.currentMachine() && it.session == svc.currentSession() }
    }
    fun fileKey(project: Project, local: String): String? =
        if (ObservatoryService.getInstance(project).currentMachine() != null) mountedFile(project, local)?.remote
        else com.cellobservatory.observatory.core.ClaudePaths.storeKey(local)
    // https://www.jetbrains.com/help/idea/remote-development-a.html#connect_to_remote_ide
    fun gatewayLink(host: String, user: String, port: Int, idePath: String?, workspace: String): String? {
        if (host.isBlank() || user.isBlank() || port !in 1..65535 || idePath?.startsWith('/') != true || !workspace.startsWith('/')) return null
        fun enc(s: String) = URLEncoder.encode(s, StandardCharsets.UTF_8).replace("+", "%20")
        return "jetbrains-gateway://connect#idePath=${enc(idePath)}&projectPath=${enc(workspace)}&host=${enc(host)}&port=$port&user=${enc(user)}&type=ssh&deploy=false"
    }
    fun fallback(target: String, workspace: String, session: String): String =
        "Open JetBrains Gateway (install it if needed), or File → Remote Development → SSH → New Connection. " +
            "Use SSH target $target and its SSH configuration, select an IDE, and open $workspace. " +
            "Install OAK on the remote backend with oak install-extensions if needed. " +
            "The review request expires in 10 minutes; after that select session $session in OAK."

    private fun json(args: List<String>, project: Project): JsonObject {
        val r = ObservatoryCli.run(args, project.basePath)
        check(r.ok) { ObservatoryCli.failureMessage(r.stdout, r.stderr, "OAK did not answer") }
        return JsonParser.parseString(r.stdout).asJsonObject
    }
    internal fun mapPage(project: Project, machine: String, data: JsonObject): Map<String, String> = runCatching {
        val listing = ObservatoryCli.run(listOf("machine", "list", "--json"), project.basePath)
        check(listing.ok)
        val match = JsonParser.parseString(listing.stdout).asJsonArray.map { it.asJsonObject }.single {
            (it.get("label")?.asString == machine || it.get("id")?.asString == machine) && it.get("enabled")?.asBoolean != false
        }
        val files = com.google.gson.JsonArray()
        data.getAsJsonArray("records").map { it.asJsonObject.getAsJsonObject("rec").get("file").asString }.distinct().forEach { files.add(it) }
        val mapped = json(listOf("editor-review", "map", "--files", files.toString(), "--remote", data.getAsJsonObject("paths").toString(), "--target", match.get("target").asString, "--json"), project)
        mapped.getAsJsonArray("files").mapNotNull { entry ->
            val item = entry.asJsonObject
            item.get("file")?.takeUnless { it.isJsonNull }?.asString?.let { item.get("remote").asString to it }
        }.toMap()
    }.getOrDefault(emptyMap())

    fun open(project: Project, machine: String, session: String, edit: Int? = null, file: String? = null, all: Boolean = false, prompt: String? = null) {
        ApplicationManager.getApplication().executeOnPooledThread {
            var target = machine
            var workspace = "the session's workspace"
            try {
                if (all) {
                    val review = ReviewParser.parse(json(listOf("review", "--no-patch", "--json", "--session", session, "--machine", machine) + (prompt?.let { listOf("--prompt", it) } ?: emptyList()), project).toString())
                    check(review != null) { "Could not read the remote review" }
                    Diffs.showRemoteAll(project, machine, session, review)
                    return@executeOnPooledThread
                }
                val listing = ObservatoryCli.run(listOf("machine", "list", "--json"), project.basePath)
                check(listing.ok) { "Could not read saved machines" }
                val matches = JsonParser.parseString(listing.stdout).asJsonArray.map { it.asJsonObject }.filter {
                    (it.get("label")?.asString == machine || it.get("id")?.asString == machine) && it.get("enabled")?.asBoolean != false
                }
                check(matches.size == 1) { "Saved machine has no unique SSH target" }
                target = matches.single().get("target").asString
                val args = listOf("--session", session, "--editor", "jetbrains", "--action", if (all) "all" else if (file != null) "file" else "edit") +
                    (edit?.let { listOf("--edit", it.toString()) } ?: emptyList()) + (file?.let { listOf("--file", it) } ?: emptyList()) +
                    (prompt?.let { listOf("--prompt", it) } ?: emptyList()) +
                    listOf("--product", com.intellij.openapi.application.ApplicationInfo.getInstance().build.productCode, "--json", "--machine", machine)
                val info = json(listOf("editor-review", "info") + args, project)
                workspace = info.get("workspace").asString
                if (tryMounted(project, machine, session, target, info, edit, file, all, prompt)) return@executeOnPooledThread
                if (info.get("installed")?.asBoolean != true) {
                    var install = false
                    ApplicationManager.getApplication().invokeAndWait {
                        if (!project.isDisposed) install = Messages.showYesNoDialog(project,
                            "OAK is missing on the remote JetBrains backend on $machine. Install it there now?\n" + fallback(target, workspace, session),
                            "Open on $machine", "Install OAK there", "Cancel", null) == Messages.YES
                    }
                    if (!install) return@executeOnPooledThread
                    val installResult = ObservatoryCli.run(listOf("install-extensions", "--jetbrains-only", "--machine", machine), project.basePath)
                    check(installResult.ok) { ObservatoryCli.failureMessage(installResult.stdout, installResult.stderr, "Remote installation failed") }
                    check(json(listOf("editor-review", "info") + args, project).get("installed")?.asBoolean == true) { "OAK is still missing on the remote backend" }
                }
                json(listOf("editor-review", "prepare") + args, project)
                val connection = runCatching { json(listOf("editor-review", "connection", "--target", target, "--json"), project) }.getOrNull()
                val idePath = info.get("idePath")?.takeUnless { it.isJsonNull }?.asString
                val link = connection?.let { gatewayLink(it.get("host").asString, it.get("user").asString, it.get("port").asInt, idePath, workspace) }
                val instructions = fallback(target, workspace, session)
                ApplicationManager.getApplication().invokeLater {
                    if (project.isDisposed) return@invokeLater
                    if (link != null) {
                        runCatching { java.awt.Desktop.getDesktop().browse(java.net.URI(link)) }
                        // OS protocol dispatch has no connection acknowledgement, including when Gateway is absent.
                        Messages.showInfoMessage(project, "Continue in Gateway. If Gateway did not open:\n$instructions", "Open on $machine")
                    } else Messages.showInfoMessage(project, "The Gateway link could not be built (a remote IDE path and SSH settings are required).\n$instructions", "Open on $machine")
                }
            } catch (e: Exception) {
                val message = "Could not open on $machine: ${e.message}\n" + fallback(target, workspace, session)
                ApplicationManager.getApplication().invokeLater { if (!project.isDisposed) Messages.showInfoMessage(project, message, "Open on $machine") }
            }
        }
    }

    private fun tryMounted(project: Project, machine: String, session: String, target: String, info: JsonObject, edit: Int?, file: String?, all: Boolean, prompt: String?): Boolean {
        if (all) return false // Open all is handled by the paged stacked tab.
        val review = ReviewParser.parse(json(listOf("review", "--no-patch", "--json", "--session", session, "--machine", machine) + (prompt?.let { listOf("--prompt", it) } ?: emptyList()), project).toString()) ?: return false
        val files = listOfNotNull(file ?: info.get("file")?.takeUnless { it.isJsonNull }?.asString ?: review.units.find { it.id == edit }?.file)
        if (files.isEmpty()) return false
        val paths = files.map { remote ->
            val r = json(listOf("editor-review", "map", "--target", target, "--remote", info.toString(), "--file", remote, "--json"), project)
            val local = r.get("file")?.takeUnless { it.isJsonNull }?.asString ?: return false
            local to remote
        }
        paths.forEach { (local, remote) -> mounted[local] = Mounted(machine, session, remote) }
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            ReviewOps.applyRemoteSessionChoice(project, machine, session)
            paths.forEach { (local, remote) ->
                ObservatoryService.getInstance(project).selectRemoteReviewFile(remote)
                if (edit != null) Navigate.openLocalFileAtEdit(project, session, edit, remote, local, machine)
                else Navigate.openLocalFile(project, local)
            }
            edit?.let { ObservatoryService.getInstance(project).parkReviewCursor(it) }

        }
        return true
    }

    internal fun dispatch(request: JsonObject, select: (String) -> Unit, edit: (String, Int) -> Unit, file: (String, String) -> Unit, all: (String, String?) -> Unit, workspace: () -> Unit = {}) {
        val session = request.get("session").asString
        select(session)
        when (request.get("action").asString) {
            "edit" -> edit(session, request.get("edit").asInt)
            "file" -> file(session, request.get("file").asString)
            "all" -> all(session, request.get("prompt")?.asString)
            "workspace" -> { all(session, null); workspace() }
        }
    }

    fun start(project: Project): com.intellij.openapi.Disposable {
        val lifetime = com.intellij.openapi.util.Disposer.newDisposable("OAK editor requests")
        com.intellij.openapi.util.Disposer.register(project, lifetime)
        val closed = java.util.concurrent.atomic.AtomicBoolean(false)
        val busy = java.util.concurrent.atomic.AtomicBoolean(false)
        val again = java.util.concurrent.atomic.AtomicBoolean(false)
        val dir = com.cellobservatory.observatory.core.ClaudePaths.configDir().resolve("editor-review")
        fun check() {
            if (closed.get() || project.isDisposed || dir.toFile().listFiles()?.any { it.extension == "json" } != true) return
            again.set(true)
            if (!busy.compareAndSet(false, true)) return
            ApplicationManager.getApplication().executeOnPooledThread {
                try {
                    do {
                        again.set(false)
                        while (!closed.get() && !project.isDisposed && consumeNow(project)) { /* drain the mailbox */ }
                    } while (again.get() && !closed.get())
                } finally {
                    busy.set(false)
                    if (again.get()) check()
                }
            }
        }
        val watcher = runCatching {
            java.nio.file.Files.createDirectories(dir)
            val service = dir.fileSystem.newWatchService()
            try {
                dir.register(service, java.nio.file.StandardWatchEventKinds.ENTRY_CREATE, java.nio.file.StandardWatchEventKinds.ENTRY_MODIFY)
                service
            } catch (e: Exception) { service.close(); throw e }
        }.getOrNull()
        com.intellij.openapi.util.Disposer.register(lifetime) { closed.set(true); watcher?.close() }
        ApplicationManager.getApplication().messageBus.connect(lifetime).subscribe(
            com.intellij.openapi.application.ApplicationActivationListener.TOPIC,
            object : com.intellij.openapi.application.ApplicationActivationListener {
                override fun applicationActivated(ideFrame: com.intellij.openapi.wm.IdeFrame) { if (ideFrame.project == project) check() }
            })
        if (watcher != null) ApplicationManager.getApplication().executeOnPooledThread {
            try {
                while (!closed.get()) {
                    val key = watcher.take()
                    if (key.pollEvents().any { it.kind() == java.nio.file.StandardWatchEventKinds.OVERFLOW || it.context().toString().endsWith(".json") }) check()
                    if (!key.reset()) break
                }
            } catch (_: java.nio.file.ClosedWatchServiceException) { /* project closed */ }
        }
        check()
        return lifetime
    }

    fun consume(project: Project) { ApplicationManager.getApplication().executeOnPooledThread { while (!project.isDisposed && consumeNow(project)) {} } }
    private fun consumeNow(project: Project): Boolean {
        val workspace = project.basePath ?: return false
        val r = runCatching { json(listOf("editor-review", "consume", "--editor", "jetbrains", "--workspace", workspace, "--json"), project).get("request")?.takeUnless { it.isJsonNull }?.asJsonObject }.getOrNull() ?: return false
        val session = r.get("session").asString
        val action = r.get("action").asString
        val reviewResult = if (action == "all" || action == "workspace") runCatching {
            ReviewParser.parse(json(listOf("review", "--no-patch", "--json", "--session", session) +
                (if (action == "all") r.get("prompt")?.asString?.let { listOf("--prompt", it) } ?: emptyList() else emptyList()), project).toString())
        } else null
        val review = reviewResult?.getOrNull()
        ApplicationManager.getApplication().invokeAndWait {
            if (!project.isDisposed) dispatch(r,
                { ReviewOps.applySessionChoice(project, it) },
                { s, id -> ObservatoryService.getInstance(project).log().find { it.id == id }?.let { Navigate.openFileAtEdit(project, s, it) } },
                { _, file -> Navigate.openLocalFile(project, file) },
                { s, _ ->
                    if (review == null) ReviewOps.notify(project, "Could not read the requested pending changes: ${reviewResult?.exceptionOrNull()?.message ?: "invalid review response"}", com.intellij.notification.NotificationType.WARNING)
                    else if (review.units.none { it.pending }) ReviewOps.notify(project, "Nothing pending in this session")
                    else {
                        val log = ObservatoryService.getInstance(project).log()
                        Diffs.showAll(project, s, review.units.filter { it.pending }.mapNotNull { u ->
                            val rec = log.find { it.id == u.id } ?: return@mapNotNull null
                            Triple(rec.copy(beforeBlob = log.find { it.id == u.members.firstOrNull() }?.beforeBlob ?: rec.beforeBlob), u.rel, u.added + u.removed)
                        })
                    }
                },
                { ApplicationManager.getApplication().invokeLater { if (!project.isDisposed) revealWorkspace(project) } },
            )
        }
        return true
    }

    internal fun revealWorkspace(project: Project,
        activate: (String, Runnable?) -> Unit = { id, after -> com.intellij.openapi.wm.ToolWindowManager.getInstance(project).getToolWindow(id)?.activate(after) },
        terminal: () -> Unit = { project.getService(WorkspaceTerminal::class.java)?.open() }) {
        activate("Observatory Traces", Runnable {
            val window = com.intellij.openapi.wm.ToolWindowManager.getInstance(project).getToolWindow("Observatory Traces")
            window?.contentManager?.contents?.firstOrNull { it.displayName == "Review" }?.let { window.contentManager.setSelectedContent(it) }
        })
        terminal()
        activate("Observatory Timeline", null)
        activate("Observatory Dashboards", Runnable { ChangeMapPanel.of(project)?.showWorkspaceDashboards() })
    }
    fun refreshMounted(project: Project) {
        val svc = ObservatoryService.getInstance(project)
        for ((local, m) in mounted) if (m.machine == svc.currentMachine() && m.session == svc.currentSession()) {
            val vf = com.intellij.openapi.vfs.LocalFileSystem.getInstance().refreshAndFindFileByPath(local) ?: continue
            vf.refresh(true, false)
        }
    }
}
