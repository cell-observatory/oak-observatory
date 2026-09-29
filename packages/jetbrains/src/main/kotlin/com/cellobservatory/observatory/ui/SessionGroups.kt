package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.model.SessionRow
import com.cellobservatory.observatory.model.isSessionActive

internal data class OverviewSessionGroup(
    val workspace: String, val count: Int, val recent: List<SessionRow>, val older: List<SessionRow>, val hidden: Int,
)

/** Preserve the CLI's workspace and recency order. Filter and fold only presentation rows. */
internal fun overviewSessionGroups(rows: List<SessionRow>, pinned: String?, now: Long, activeOnly: Boolean): List<OverviewSessionGroup> =
    rows.distinctBy { it.id }.groupBy { it.workspace.ifBlank { "Unknown workspace" } }.map { (workspace, group) ->
        fun retained(r: SessionRow) = r.id == pinned || r.current || (r.attention != null && r.attention.kind != "idle-done")
        val visible = group.filter { !activeOnly || retained(it) || it.pending > 0 || isSessionActive(maxOf(it.liveMs, it.lastActiveMs), now) }
        val (recent, older) = visible.partition { retained(it) || now - it.lastActiveMs <= 7 * 86_400_000L }
        OverviewSessionGroup(workspace, group.size, recent, older, group.size - visible.size)
    }
