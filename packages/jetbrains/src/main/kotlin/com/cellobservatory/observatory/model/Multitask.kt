package com.cellobservatory.observatory.model

import com.google.gson.JsonObject
import com.google.gson.JsonParser

/**
 * Kotlin mirror of core's Multitasking view-model, parsed from `oak multitask --json`.
 * One row per running agent across every worktree-sibling, nested subagents, and the cross-agent file
 * collisions — all aggregated in core (phase, sparkline bins, ± diffs, risk, the uncapped collision
 * set). The panel only paints; VS Code and JetBrains can never disagree about the numbers.
 */
data class MtTodo(val content: String, val status: String)

/** How far an agent reached past the boundary it was given (core's `outside`): the count of distinct
 *  FILES it read / wrote outside its own workspace. The rest of the old footprint block folded into the
 *  `risk` and `egress` audits in 0.8.7; this stayed because it is the one fact worth a glance on a fleet
 *  row. Null for an older CLI without the field — an absent fact renders absent, never as a zero. */
data class OutsideTouch(val reads: Int, val writes: Int) {
    val any: Boolean get() = reads > 0 || writes > 0
}

/** A subagent spawned by a running agent, with its own live phase + current task (mirrors core). */
data class MtSubagent(
    val agentId: String,
    val agentType: String?,
    val description: String?,
    val phase: String,
    /** 'high' = structural; 'heuristic' = staleness-inferred — renderers dim/qualify those (0.8.0). */
    val phaseConfidence: String?,
    val currentTask: String?,
    val todos: List<MtTodo>,
    val edits: Int,
    val added: Int,
    val removed: Int,
    /** The spawn's OWN model + reasoning effort, its ↑input·↓output·↺cache-read token split, and its
     *  runtime — the same metrics the terminal shows next to each spawn agent. */
    val model: String? = null,
    val effort: String? = null,
    val tokensIn: Long = 0,
    val tokensOut: Long = 0,
    val tokensCacheRead: Long = 0,
    val durationMs: Long = 0,
)

/** One running agent (a session in a worktree), the top-level Multitasking row. */
data class RunningAgent(
    val session: String,
    val worktree: String,
    val gitBranch: String,
    val self: Boolean,
    /** working | awaiting-input | awaiting-permission | idle | errored | done. */
    val phase: String,
    val phaseConfidence: String?,
    /** ~20 fixed activity bins (bucketed action/edit ts) — the sparkline. */
    val sparkline: List<Int>,
    val todos: List<MtTodo>,
    val subagents: List<MtSubagent>,
    val files: List<String>,
    val added: Int,
    val removed: Int,
    /** This session's total tokens + wall-clock span — the same metric style Workflows show. */
    val tokens: Long,
    val durationMs: Long,
    val riskTotal: Int,
    val riskHigh: Int,
    /** Files this agent read / wrote outside its own worktree — the fleet row's ↗ suffix. */
    val outside: OutsideTouch?,
    /** How many times this agent's context was compacted; 0 for an older CLI without the field. */
    val compactions: Int,
    /** Conversation quiet for over a week: collapsed in the fleet, and not rebuilt on refresh (0.9.0). */
    val folded: Boolean = false,
    /**
     * False ⇒ this row's numbers are placeholders, not findings — a folded session whose change map was
     * not built. Only ever false for a folded row. Defaults TRUE so an older CLI, which emits neither
     * field, keeps reporting its rows as real instead of silently rendering every one as "not loaded".
     */
    val loaded: Boolean = true,
)

/** A file touched by 2+ agents — computed from the UNCAPPED distinct file sets, path-only (no contents
 *  cross agents). Reports the exact agent ids, never a "winner". */
/** A live cross-agent file collision. [agents] = every holder with the file pending; [activeAgents] =
 *  the subset moving right now (0.8.0: an active-vs-idle overlap flags too — renderers dim the idle). */
data class Collision(val file: String, val agents: List<String>, val activeAgents: List<String>, val anyPending: Boolean)

/** The active session's curated tool-call timeline, folded into Multitasking in 0.8.0 (the standalone
 *  Actions view is gone). `groups` are the curated ActionGroups MINUS the fleet/subagent category (those
 *  are already the fleet rows above); `egress` is the off-machine destinations sub-report. Both are
 *  computed in core — the panel only paints. */
data class MtActions(val groups: List<ActionGroup>, val egress: List<EgressChannel>)

/** One agent inside a Workflow run, with its own tokens/time/edits mined from its transcript. */
data class WorkflowAgent(
    val agentId: String,
    /** The runner's per-agent label (e.g. 'S11-vscode') from the rich state file; on a LIVE run, core
     *  derives one from the agent's prompt instead (marked by [labelDerived]); null when neither. */
    val label: String?,
    /** True when [label] is heuristic (prompt-derived) — rendered with a trailing '~', never asserted. */
    val labelDerived: Boolean,
    /** The agent's phase — a REAL phase title (e.g. 'Implement') from the state file, else the journal key; null when neither. */
    val phase: String?,
    val agentType: String?,
    val done: Boolean,
    val tokens: Long,
    val durationMs: Long,
    val edits: Int,
    val added: Int,
    val removed: Int,
    /** The agent's model as a short label (e.g. 'Opus 4.8'), '' when unknown. */
    val model: String,
    /** The agent's declared reasoning effort, "" when the transcript never said it. Shown beside the
     *  model and never guessed — the default differs by build and by model. */
    val effort: String = "",
    /** 20-bin activity histogram over the agent's own assistant turns — the same sparkline the run draws. */
    val sparkline: List<Int>,
)

/** Agents grouped by phase title, with per-phase progress ("Implement 2/2"). */
data class WorkflowPhaseGroup(val title: String, val done: Int, val total: Int)

/** A Claude Code Workflow run (a level above subagents): a scripted fan-out of agents, with per-run and
 *  per-agent tokens / wall-clock / edits. Zero-token — mined from the on-disk workflow state/journals. */
data class WorkflowRun(
    val id: String,
    val name: String,
    /** The INFORMATIVE description (state-file summary / script meta.description); null when neither. */
    val description: String?,
    val phases: List<String>,
    val agents: List<WorkflowAgent>,
    /** Agents grouped by phase, with per-phase done/total (only phases that have agents). */
    val phaseGroups: List<WorkflowPhaseGroup>,
    val running: Boolean,
    val agentCount: Int,
    val tokens: Long,
    val durationMs: Long,
    val edits: Int,
    val added: Int,
    val removed: Int,
    /** ~20 fixed activity bins (assistant turns across all the run's agents) — the same sparkline the
     *  fleet rows draw, so the Workflows list renders with the identical mini-chart. */
    val sparkline: List<Int>,
)

data class MultitaskResult(
    val agents: List<RunningAgent>,
    val collisions: List<Collision>,
    /** Distinct worktree cwds in this repo group — the bounded set the TranscriptWatcher watches. */
    val worktrees: List<String>,
    val active: Int,
    val conflicts: Int,
    /** The active session's curated action timeline (0.8.0), or null for an older CLI without it. */
    val actions: MtActions?,
    /** Claude Code Workflow runs, newest-first — empty for an older CLI without the field. */
    val workflows: List<WorkflowRun>,
    /** The ACTIVE session's task list (TaskCreate/TaskUpdate — the numbered system next to TodoWrite),
     *  for the Overview's Tasks tab. Empty for sessions that never used it, or an older CLI. */
    val tasks: List<SessionTask>,
)

/** One task from the session's task list (~/.claude/tasks/<session>/<id>.json, read by core). */
data class SessionTask(
    val id: String,
    val subject: String,
    val description: String,
    /** 'pending' | 'in_progress' | 'completed'. */
    val status: String,
    /** Present-continuous spinner label while in_progress; null when absent. */
    val activeForm: String?,
    val blocks: List<String>,
    val blockedBy: List<String>,
    /** The STRICT task id (core.taskIdForSubject) — what joins this row to the change map's per-task
     *  rollup and to `feed --kind task`. Blank for an older CLI that predates the field. */
    val taskId: String,
)

object MultitaskParser {
    fun parse(json: String): MultitaskResult? = try {
        val o = JsonParser.parseString(json).asJsonObject
        val summary = o.getAsJsonObject("summary")
        MultitaskResult(
            agents = arr(o, "agents").map { agent(it.asJsonObject) },
            collisions = arr(o, "collisions").map { collision(it.asJsonObject) },
            worktrees = arr(o, "worktrees").mapNotNull { str(it.asJsonObject, "worktree") }.distinct(),
            active = summary?.let { int(it, "active") } ?: 0,
            conflicts = summary?.let { int(it, "conflicts") } ?: 0,
            actions = o.getAsJsonObject("actions")?.let { act ->
                MtActions(
                    groups = arr(act, "groups").map { ActionsParser.parseGroup(it.asJsonObject) },
                    egress = arr(act, "egress").map { ActionsParser.parseEgress(it.asJsonObject) },
                )
            },
            workflows = arr(o, "workflows").map { workflow(it.asJsonObject) },
            tasks = arr(o, "tasks").map { t ->
                val to = t.asJsonObject
                SessionTask(
                    id = str(to, "id") ?: "",
                    subject = str(to, "subject") ?: "",
                    description = str(to, "description") ?: "",
                    status = str(to, "status") ?: "pending",
                    activeForm = str(to, "activeForm"),
                    blocks = arr(to, "blocks").mapNotNull { it.takeIf { e -> !e.isJsonNull }?.asString },
                    blockedBy = arr(to, "blockedBy").mapNotNull { it.takeIf { e -> !e.isJsonNull }?.asString },
                    taskId = str(to, "taskId") ?: "",
                )
            },
        )
    } catch (_: Exception) {
        null
    }

    private fun arr(o: JsonObject, k: String) = o.getAsJsonArray(k) ?: com.google.gson.JsonArray()
    private fun str(o: JsonObject, k: String): String? = o.get(k)?.takeIf { !it.isJsonNull }?.asString
    private fun int(o: JsonObject, k: String): Int = o.get(k)?.takeIf { !it.isJsonNull }?.asInt ?: 0
    private fun long(o: JsonObject, k: String): Long = o.get(k)?.takeIf { !it.isJsonNull }?.asLong ?: 0L

    private fun workflow(o: JsonObject) = WorkflowRun(
        id = str(o, "id") ?: "",
        name = str(o, "name") ?: "workflow",
        description = str(o, "description"),
        phases = arr(o, "phases").mapNotNull { it.takeIf { e -> !e.isJsonNull }?.asString },
        agents = arr(o, "agents").map { a ->
            val ao = a.asJsonObject
            WorkflowAgent(
                agentId = str(ao, "agentId") ?: "",
                label = str(ao, "label"),
                labelDerived = bool(ao, "labelDerived"),
                phase = str(ao, "phase"),
                agentType = str(ao, "agentType"),
                done = bool(ao, "done"),
                tokens = long(ao, "tokens"),
                durationMs = long(ao, "durationMs"),
                edits = int(ao, "edits"),
                added = int(ao, "added"),
                removed = int(ao, "removed"),
                model = str(ao, "model") ?: "",
                effort = str(ao, "effort") ?: "",
                sparkline = arr(ao, "sparkline").map { it.asInt },
            )
        },
        phaseGroups = arr(o, "phaseGroups").map { p ->
            val po = p.asJsonObject
            WorkflowPhaseGroup(title = str(po, "title") ?: "", done = int(po, "done"), total = int(po, "total"))
        },
        running = bool(o, "running"),
        agentCount = int(o, "agentCount"),
        tokens = long(o, "tokens"),
        durationMs = long(o, "durationMs"),
        edits = int(o, "edits"),
        added = int(o, "added"),
        removed = int(o, "removed"),
        sparkline = arr(o, "sparkline").map { it.asInt },
    )
    private fun bool(o: JsonObject, k: String): Boolean = o.get(k)?.takeIf { !it.isJsonNull }?.asBoolean ?: false

    private fun todos(o: JsonObject): List<MtTodo> =
        arr(o, "todos").mapNotNull { t ->
            val to = t.asJsonObject
            val content = str(to, "content") ?: return@mapNotNull null
            MtTodo(content, str(to, "status") ?: "")
        }

    private fun agent(o: JsonObject): RunningAgent {
        val diff = o.getAsJsonObject("diff")
        val risk = o.getAsJsonObject("risk")
        return RunningAgent(
            session = str(o, "session") ?: "",
            worktree = str(o, "worktree") ?: "",
            gitBranch = str(o, "gitBranch") ?: "",
            self = bool(o, "self"),
            phase = str(o, "phase") ?: "idle",
            phaseConfidence = str(o, "phaseConfidence"),
            sparkline = arr(o, "sparkline").map { it.asInt },
            todos = todos(o),
            subagents = arr(o, "subagents").map { subagent(it.asJsonObject) },
            files = arr(o, "files").mapNotNull { it.takeIf { e -> !e.isJsonNull }?.asString },
            added = diff?.let { int(it, "added") } ?: 0,
            removed = diff?.let { int(it, "removed") } ?: 0,
            tokens = long(o, "tokens"),
            durationMs = long(o, "durationMs"),
            riskTotal = risk?.let { int(it, "total") } ?: 0,
            riskHigh = risk?.let { int(it, "high") } ?: 0,
            outside = o.get("outside")?.takeIf { it.isJsonObject }?.asJsonObject
                ?.let { OutsideTouch(int(it, "reads"), int(it, "writes")) },
            compactions = int(o, "compactions"),
            folded = bool(o, "folded"),
            // NOT bool(): that yields false for an absent key, and an older CLI emits neither field —
            // which would render every row in the fleet as "not loaded". Absent must mean "real".
            loaded = o.get("loaded")?.takeIf { !it.isJsonNull }?.asBoolean ?: true,
        )
    }

    private fun subagent(o: JsonObject) = MtSubagent(
        agentId = str(o, "agentId") ?: "",
        agentType = str(o, "agentType"),
        description = str(o, "description"),
        phase = str(o, "phase") ?: "idle",
        phaseConfidence = str(o, "phaseConfidence"),
        currentTask = str(o, "currentTask"),
        todos = todos(o),
        edits = int(o, "edits"),
        added = int(o, "added"),
        removed = int(o, "removed"),
        model = str(o, "model"),
        effort = str(o, "effort"),
        tokensIn = long(o, "tokensIn"),
        tokensOut = long(o, "tokensOut"),
        tokensCacheRead = long(o, "tokensCacheRead"),
        durationMs = long(o, "durationMs"),
    )

    private fun collision(o: JsonObject) = Collision(
        file = str(o, "file") ?: "",
        agents = arr(o, "agents").mapNotNull { it.takeIf { e -> !e.isJsonNull }?.asString },
        // Tolerant default: an older CLI has no activeAgents — treat every holder as active (old rule).
        activeAgents = if (o.has("activeAgents")) arr(o, "activeAgents").mapNotNull { it.takeIf { e -> !e.isJsonNull }?.asString }
        else arr(o, "agents").mapNotNull { it.takeIf { e -> !e.isJsonNull }?.asString },
        anyPending = bool(o, "anyPending"),
    )
}
