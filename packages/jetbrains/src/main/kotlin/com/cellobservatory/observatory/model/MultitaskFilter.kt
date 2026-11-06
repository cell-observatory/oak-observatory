package com.cellobservatory.observatory.model

/**
 * The Overview nav's Active-only / Clear-completed DISPLAY classification — the Kotlin port of the ONE
 * pure `multitaskFilter` the VS Code webview embeds verbatim (extension.ts). Extracted to `model/` so
 * the panel can't drift from the canonical rule, and pinned by MultitaskFilterTest against the SAME
 * fixture payload the VS Code smoke test drives:
 *   · an agent is ACTIVE when its own phase is working/awaiting-input/awaiting-permission, OR any of
 *     its subagents is (a live subagent promotes an idle parent);
 *   · a workflow is active while `running`;
 *   · a dismissed (Clear-completed) item hides ONLY while inactive — it reappears the moment it goes
 *     active again.
 */
object MultitaskFilter {
    fun isActivePhase(phase: String?): Boolean =
        phase == "working" || phase == "awaiting-input" || phase == "awaiting-permission"

    fun agentActive(a: RunningAgent): Boolean =
        if (a.state != null) a.state in setOf("queued", "working", "waiting", "blocked")
        else isActivePhase(a.phase) || a.subagents.any { isActivePhase(it.phase) }

    fun workflowActive(w: WorkflowRun): Boolean = w.running

    /** True when the item should be shown under the given display state (see class doc). */
    fun showAgent(a: RunningAgent, activeOnly: Boolean, dismissed: Set<String>): Boolean {
        val active = agentActive(a)
        if (activeOnly && !active) return false
        return active || a.key !in dismissed
    }

    fun showWorkflow(w: WorkflowRun, activeOnly: Boolean, dismissed: Set<String>): Boolean {
        if (activeOnly && !w.running) return false
        return w.running || w.id !in dismissed
    }

    /** Dismissed-and-still-inactive items — feeds the "N hidden · show all" affordance. */
    fun hiddenCount(res: MultitaskResult?, dismissedAgents: Set<String>, dismissedWorkflows: Set<String>): Int {
        res ?: return 0
        return res.agents.count { it.key in dismissedAgents && !agentActive(it) } +
            res.workflows.count { it.id in dismissedWorkflows && !it.running }
    }
}
