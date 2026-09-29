package com.cellobservatory.observatory.model

import com.google.gson.JsonObject
import com.google.gson.JsonParser

/**
 * Kotlin mirror of core's ChangeMap view-model, parsed from `oak changemap --json`.
 * Churn rollups, the worst-unreviewed-wins status precedence, module labels, and the drill-through
 * target (`maxId`) are all computed server-side in core.buildChangeMap — this plugin only renders the
 * result (no local aggregation, so VS Code and JetBrains can never disagree about the numbers).
 */
data class ChangeMapFile(
    val rel: String,
    val module: String,
    val moduleLabel: String,
    val file: String,
    val churn: Int,
    /** Lines added and removed, kept APART. `churn` is their sum, which hides direction: +900/−4 and
     *  +4/−900 are the same churn and are not remotely the same change to review. */
    val added: Int,
    val removed: Int,
    val cnt: Int,
    val kept: Int,
    val pending: Int,
    val undone: Int,
    /** "pending" | "undone" | "kept" — worst-unreviewed-wins. */
    val status: String,
    /** Most-recent edit id — what a double-click opens. */
    val maxId: Int,
    /** Most-recent edit time (epoch ms) — the "N min ago" column + the time sort. */
    val maxTs: Long,
    /** Bare lowercased extension — the extension filter key. */
    val ext: String,
    /** One of the six type buckets — the file-type filter key. */
    val category: String,
    val classes: List<String>,
    val agent: Boolean,
    val risk: String?,
    val reason: String?,
)

data class ChangeMapModule(
    val module: String,
    val label: String,
    val churn: Int,
    val cnt: Int,
    val kept: Int,
    val pending: Int,
    val undone: Int,
    val status: String,
    val files: Int,
)

data class ChangeMapSummary(
    val session: String,
    /** Human-readable session name (a rename, else its claude.ai Remote Control title, else the agent's ai-title, else the first user prompt; blank when none) —
     *  the Overview session selector + the Stats panel show this instead of the raw id. */
    val title: String?,
    val units: Int,
    val pending: Int,
    val kept: Int,
    val undone: Int,
    /** ±lines across the slice. */
    val added: Int,
    val removed: Int,
    val errors: Int,
    val subagents: Int,
    /** Sibling sessions in this project (the 🛰 chip) — same headline the VS Code panel shows. */
    val fleet: Int,
    /** Off-machine destinations this session reached (the ⇅ chip). */
    val egress: Int,
)

/**
 * One context compaction (core.CompactionMarker), positioned by [ts]. [label] is core's one-line summary
 * ("auto · 1M→14k · 986k dropped · 2m 5s") — rendered VERBATIM, never re-derived, so both editors word a
 * compaction identically.
 */
data class CompactBoundary(
    val ts: Long,
    val trigger: String,
    val droppedTokens: Long,
    /** The harness's running session total ("dropped so far"), not this event's own drop. */
    val cumulativeDropped: Long,
    val durationMs: Long,
    val label: String,
)

/** A stable-id task (0.8.0) — content-hash identity spanning the STRICT in-progress intervals of one
 *  to-do. The Tasks tab is built from these, JOINED to [TaskRoll] by [taskId]. */
data class ChangeMapTask(
    val taskId: String,
    val content: String,
    val firstTs: Long,
    val lastTs: Long,
)

/** Per-task change rollup (0.8.0). [taskId] == null is the explicit "unassigned" bucket — edits that
 *  fell in no strict in-progress interval, never swept into a neighbouring task. */
data class TaskRoll(
    val taskId: String?,
    val edits: Int,
    val added: Int,
    val removed: Int,
    val pending: Int,
    val kept: Int,
    val undone: Int,
)

/** Per-subagent change rollup (0.8.0). [subagentId] == null = main-chain or unattributed. */
data class SubagentRoll(
    val subagentId: String?,
    val edits: Int,
    val added: Int,
    val removed: Int,
    val pending: Int,
    val kept: Int,
    val undone: Int,
)

/** Per-workflow change rollup (0.8.0 r2). [workflowId] == null = no-workflow / main-chain / ambiguous. */
data class WorkflowRoll(
    val workflowId: String?,
    val edits: Int,
    val added: Int,
    val removed: Int,
    val pending: Int,
    val kept: Int,
    val undone: Int,
)

/** One workflow's aggregate rollup (mirrors core ChangeMapWorkflow.rollup — the per-workflow Overview tab). */
data class WorkflowRollup(
    val edits: Int,
    val added: Int,
    val removed: Int,
    val pending: Int,
    val kept: Int,
    val undone: Int,
)

/** One workflow's Overview TAB (0.8.0 r2): its ts-window-attributed edits rolled up + its touched files.
 *  [taskIds] are the distinct non-null tasks this workflow contributed to (the tab's informational ribbon). */
data class ChangeMapWorkflow(
    val id: String,
    val name: String,
    val running: Boolean,
    val rollup: WorkflowRollup,
    val files: List<ChangeMapFile>,
    val taskIds: List<String>,
)

/**
 * One PROMPT as a change-map slice (0.8.7) — everything one of the user's asks produced, aggregated in
 * core exactly the way a workflow's slice is, so the same ribbon/strip/ledger renders it unchanged.
 *
 * Picking an ask in the Prompts window scopes the whole Overview to its slice: [files]/[modules]
 * drive the change map, and the id sets filter the left nav. Attribution is by START time —
 * a shell launched by one ask stays that ask's even when it exits during a later one.
 */
data class ChangeMapPrompt(
    val id: String,
    val index: Int,
    /** The ask in FULL — renderers wrap it over as many lines as it needs; nothing here is clipped. */
    val text: String,
    val title: String,
    val ts: Long,
    /** 0 while this is the ask still being answered. */
    val endTs: Long,
    val rollup: WorkflowRollup,
    val files: List<ChangeMapFile>,
    val modules: List<ChangeMapModule>,
    val editIds: List<Int>,
    val agentIds: List<String>,
    val workflowIds: List<String>,
    val processIds: List<String>,
    val actions: Int,
    val errors: Int,
    val compactions: Int,
    val durationMs: Long,
)

/** Per-agent (session) change rollup (0.8.0), worktree-aware. */
data class AgentRoll(
    val session: String,
    val edits: Int,
    val added: Int,
    val removed: Int,
    val pending: Int,
    val kept: Int,
    val undone: Int,
    val files: Int,
)

/** One agent's full change-map build (0.8.0) — the per-agent Overview TAB. Carries top-level
 *  session/worktree/gitBranch/phase for the tab label, plus its own summary/files/modules/tasks and
 *  rollups (each a per-sibling `buildChangeMap` aggregated once in core). */
data class ChangeMapAgent(
    val session: String,
    val worktree: String,
    val gitBranch: String,
    val phase: String,
    val summary: ChangeMapSummary?,
    val files: List<ChangeMapFile>,
    val modules: List<ChangeMapModule>,
    val tasks: List<ChangeMapTask>,
    val rollupByTask: List<TaskRoll>,
    val rollupBySubagent: List<SubagentRoll>,
    /** This agent's context compactions, oldest first — empty for an older CLI without the field. */
    val compactions: List<CompactBoundary>,
)

data class ChangeMap(
    val summary: ChangeMapSummary?,
    val files: List<ChangeMapFile>,
    val modules: List<ChangeMapModule>,
    // 0.8.0 additions — the three-level attribution + per-agent tabs.
    val tasks: List<ChangeMapTask>,
    val rollupByTask: List<TaskRoll>,
    val rollupBySubagent: List<SubagentRoll>,
    val rollupByAgent: List<AgentRoll>,
    val agents: List<ChangeMapAgent>,
    /** The session-wide unassigned bucket (edits outside every strict in-progress interval). */
    val unassigned: TaskRoll?,
    /** Per-workflow rollup, incl. the `workflowId: null` no-workflow/ambiguous bucket. */
    val rollupByWorkflow: List<WorkflowRoll>,
    /** One entry per workflow that produced attributed edits — the Overview's per-workflow tabs. */
    val workflows: List<ChangeMapWorkflow>,
    /** Context compactions during this session, oldest first — the Actions feed and the Stats panel
     *  render them by time. Empty for an older CLI without the field. */
    val compactions: List<CompactBoundary>,
    /** The session partitioned by what the USER asked for (0.8.7) — the scope the Prompts window sets.
     *  Empty for an older CLI, and empty on every SIBLING's map: only the active session builds them. */
    val prompts: List<ChangeMapPrompt>,
)

object ChangeMapParser {
    fun parse(json: String): ChangeMap? = try {
        val o = JsonParser.parseString(json).asJsonObject
        ChangeMap(
            o.getAsJsonObject("summary")?.let { summary(it) },
            arr(o, "files").map { file(it.asJsonObject) },
            arr(o, "modules").map { module(it.asJsonObject) },
            arr(o, "tasks").map { task(it.asJsonObject) },
            arr(o, "rollupByTask").map { taskRoll(it.asJsonObject) },
            arr(o, "rollupBySubagent").map { subagentRoll(it.asJsonObject) },
            arr(o, "rollupByAgent").map { agentRoll(it.asJsonObject) },
            arr(o, "agents").map { agent(it.asJsonObject) },
            o.getAsJsonObject("unassigned")?.let { taskRoll(it) },
            arr(o, "rollupByWorkflow").map { workflowRoll(it.asJsonObject) },
            arr(o, "workflows").map { workflow(it.asJsonObject) },
            arr(o, "compactions").map { compaction(it.asJsonObject) },
            arr(o, "prompts").map { prompt(it.asJsonObject) },
        )
    } catch (_: Exception) {
        null
    }

    /** Tolerate a missing array (an older CLI that predates a field) rather than throwing the map away. */
    private fun arr(o: JsonObject, k: String) = o.getAsJsonArray(k) ?: com.google.gson.JsonArray()

    private fun str(o: JsonObject, k: String): String? =
        o.get(k)?.takeIf { !it.isJsonNull }?.asString

    private fun int(o: JsonObject, k: String): Int =
        o.get(k)?.takeIf { !it.isJsonNull }?.asInt ?: 0

    private fun bool(o: JsonObject, k: String): Boolean =
        o.get(k)?.takeIf { !it.isJsonNull }?.asBoolean ?: false

    private fun strings(o: JsonObject, k: String): List<String> =
        (o.getAsJsonArray(k) ?: com.google.gson.JsonArray()).mapNotNull { it.takeIf { e -> !e.isJsonNull }?.asString }

    private fun summary(o: JsonObject) = ChangeMapSummary(
        str(o, "session") ?: "",
        str(o, "title"),
        int(o, "units"), int(o, "pending"), int(o, "kept"), int(o, "undone"),
        int(o, "added"), int(o, "removed"),
        int(o, "errors"), int(o, "subagents"), int(o, "fleet"), int(o, "egress"),
    )

    private fun file(o: JsonObject) = ChangeMapFile(
        str(o, "rel") ?: "", str(o, "module") ?: "", str(o, "moduleLabel") ?: "", str(o, "file") ?: "",
        int(o, "churn"), int(o, "added"), int(o, "removed"), int(o, "cnt"), int(o, "kept"), int(o, "pending"), int(o, "undone"),
        str(o, "status") ?: "kept", int(o, "maxId"),
        long(o, "maxTs"), str(o, "ext") ?: "", str(o, "category") ?: "other",
        strings(o, "classes"),
        bool(o, "agent"), str(o, "risk"), str(o, "reason"),
    )

    private fun module(o: JsonObject) = ChangeMapModule(
        str(o, "module") ?: "", str(o, "label") ?: "", int(o, "churn"), int(o, "cnt"),
        int(o, "kept"), int(o, "pending"), int(o, "undone"), str(o, "status") ?: "kept",
        int(o, "files"),
    )

    private fun long(o: JsonObject, k: String): Long =
        o.get(k)?.takeIf { !it.isJsonNull }?.asLong ?: 0L

    private fun task(o: JsonObject) = ChangeMapTask(
        str(o, "taskId") ?: "", str(o, "content") ?: "", long(o, "firstTs"), long(o, "lastTs"),
    )

    private fun compaction(o: JsonObject) = CompactBoundary(
        ts = long(o, "ts"),
        trigger = str(o, "trigger") ?: "compact",
        droppedTokens = long(o, "droppedTokens"),
        cumulativeDropped = long(o, "cumulativeDropped"),
        durationMs = long(o, "durationMs"),
        // core builds this line once (compactLabel) so both editors word a compaction identically; an
        // older CLI without it degrades to the bare trigger rather than to a blank row.
        label = str(o, "label") ?: (str(o, "trigger") ?: "compact"),
    )

    private fun taskRoll(o: JsonObject) = TaskRoll(
        str(o, "taskId"), int(o, "edits"), int(o, "added"), int(o, "removed"),
        int(o, "pending"), int(o, "kept"), int(o, "undone"),
    )

    private fun subagentRoll(o: JsonObject) = SubagentRoll(
        str(o, "subagentId"), int(o, "edits"), int(o, "added"), int(o, "removed"),
        int(o, "pending"), int(o, "kept"), int(o, "undone"),
    )

    private fun workflowRoll(o: JsonObject) = WorkflowRoll(
        str(o, "workflowId"), int(o, "edits"), int(o, "added"), int(o, "removed"),
        int(o, "pending"), int(o, "kept"), int(o, "undone"),
    )

    private fun workflow(o: JsonObject): ChangeMapWorkflow {
        val r = o.getAsJsonObject("rollup")
        return ChangeMapWorkflow(
            id = str(o, "id") ?: "",
            name = str(o, "name") ?: "workflow",
            running = bool(o, "running"),
            rollup = WorkflowRollup(
                r?.let { int(it, "edits") } ?: 0, r?.let { int(it, "added") } ?: 0, r?.let { int(it, "removed") } ?: 0,
                r?.let { int(it, "pending") } ?: 0, r?.let { int(it, "kept") } ?: 0, r?.let { int(it, "undone") } ?: 0,
            ),
            files = arr(o, "files").map { file(it.asJsonObject) },
            taskIds = strings(o, "taskIds"),
        )
    }

    private fun prompt(o: JsonObject): ChangeMapPrompt {
        val r = o.getAsJsonObject("rollup")
        return ChangeMapPrompt(
            id = str(o, "id") ?: "",
            index = int(o, "index"),
            text = str(o, "text") ?: "",
            title = str(o, "title") ?: (str(o, "text") ?: ""),
            ts = long(o, "ts"),
            endTs = long(o, "endTs"),
            rollup = WorkflowRollup(
                r?.let { int(it, "edits") } ?: 0, r?.let { int(it, "added") } ?: 0, r?.let { int(it, "removed") } ?: 0,
                r?.let { int(it, "pending") } ?: 0, r?.let { int(it, "kept") } ?: 0, r?.let { int(it, "undone") } ?: 0,
            ),
            files = arr(o, "files").map { file(it.asJsonObject) },
            modules = arr(o, "modules").map { module(it.asJsonObject) },
            editIds = o.getAsJsonArray("editIds")?.mapNotNull { it.takeIf { e -> e.isJsonPrimitive }?.asInt } ?: emptyList(),
            agentIds = strings(o, "agentIds"),
            workflowIds = strings(o, "workflowIds"),
            processIds = strings(o, "processIds"),
            actions = int(o, "actions"),
            errors = int(o, "errors"),
            compactions = int(o, "compactions"),
            durationMs = long(o, "durationMs"),
        )
    }

    private fun agentRoll(o: JsonObject) = AgentRoll(
        str(o, "session") ?: "", int(o, "edits"), int(o, "added"), int(o, "removed"),
        int(o, "pending"), int(o, "kept"), int(o, "undone"), int(o, "files"),
    )

    private fun agent(o: JsonObject) = ChangeMapAgent(
        session = str(o, "session") ?: "",
        worktree = str(o, "worktree") ?: "",
        gitBranch = str(o, "gitBranch") ?: "",
        phase = str(o, "phase") ?: "idle",
        summary = o.getAsJsonObject("summary")?.let { summary(it) },
        files = arr(o, "files").map { file(it.asJsonObject) },
        modules = arr(o, "modules").map { module(it.asJsonObject) },
        tasks = arr(o, "tasks").map { task(it.asJsonObject) },
        rollupByTask = arr(o, "rollupByTask").map { taskRoll(it.asJsonObject) },
        rollupBySubagent = arr(o, "rollupBySubagent").map { subagentRoll(it.asJsonObject) },
        compactions = arr(o, "compactions").map { compaction(it.asJsonObject) },
    )
}

/**
 * Kotlin mirror of core.moduleLabel — the change-map's module-bucket display label: '' → '(root)', an
 * out-of-workspace path → '(external)', else strip the monorepo noise (a `packages/` prefix and a trailing
 * `/src`). Kept here (not re-derived per surface) so the JetBrains Folder axis and the strip tiles agree
 * on one identity, exactly as the VS Code webview does.
 */
fun moduleLabel(module: String): String {
    if (module.isEmpty()) return "(root)"
    if (module.startsWith("..")) return "(external)"
    var s = module
    if (s.startsWith("packages/")) s = s.substring("packages/".length)
    if (s.endsWith("/src")) s = s.substring(0, s.length - "/src".length)
    return s
}

/**
 * A file's "folder" — the change-map module-bucket LABEL of its immediate parent dir (`(root)`,
 * `(external)`, or the relative dir). Mirrors the VS Code `folderLabelOf`, so a Folder-axis position and a
 * strip tile share one identity. [root] is the workspace root; [file] is an absolute path.
 */
fun folderLabelOf(file: String, root: String?): String {
    val relDir: String = if (root != null && root.isNotBlank()) {
        val rp = java.io.File(root).absoluteFile.toPath()
        val fp = java.io.File(file).absoluteFile.toPath()
        val rel = try {
            rp.relativize(fp).toString().replace(java.io.File.separatorChar, '/')
        } catch (_: Exception) {
            file.replace(java.io.File.separatorChar, '/') // cross-root (e.g. different drive) → treat as external below
        }
        val slash = rel.lastIndexOf('/')
        if (slash >= 0) rel.substring(0, slash) else "" // dirname; a bare basename → root file
    } else {
        val norm = file.replace(java.io.File.separatorChar, '/')
        val slash = norm.lastIndexOf('/')
        if (slash >= 0) norm.substring(0, slash) else ""
    }
    return moduleLabel(relDir)
}
