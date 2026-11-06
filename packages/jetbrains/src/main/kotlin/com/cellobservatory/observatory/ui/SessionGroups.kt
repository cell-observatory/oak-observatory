package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.model.SessionRow
import com.cellobservatory.observatory.model.isSessionActive
import com.cellobservatory.observatory.model.workerGroups

internal data class OverviewSessionGroup(
    val workspace: String, val count: Int, val recent: List<SessionRow>, val older: List<SessionRow>, val hidden: Int,
)

/** Preserve the CLI's workspace and recency order. Filter and fold only presentation rows. */
internal fun overviewSessionGroups(rows: List<SessionRow>, pinned: String?, now: Long, activeOnly: Boolean): List<OverviewSessionGroup> =
    rows.distinctBy { it.id }.groupBy { it.workspace.ifBlank { "Unknown workspace" } }.map { (workspace, group) ->
        // A session with a worker still at it is live, however quiet its own conversation.
        fun retained(r: SessionRow) = r.id == pinned || r.current || (r.attention != null && r.attention.kind != "idle-done") || workerGroups(r).isNotEmpty()
        val visible = group.filter { !activeOnly || retained(it) || it.pending > 0 || isSessionActive(maxOf(it.liveMs, it.lastActiveMs), now) }
        val (recent, older) = visible.partition { retained(it) || now - it.lastActiveMs <= 7 * 86_400_000L }
        OverviewSessionGroup(workspace, group.size, recent, older, group.size - visible.size)
    }


internal data class ListedSession(val row: SessionRow, val machine: String? = null,
    val synced: com.cellobservatory.observatory.model.MachineListing? = null)

/** Every paint collects and filters once. Re-sort only when source rows change, never on a search keystroke. */
internal class SessionListOrder {
    private var source: List<ListedSession> = emptyList()
    private var orders: Map<String, List<ListedSession>> = emptyMap()

    fun rows(local: List<SessionRow>, saved: com.cellobservatory.observatory.core.SavedMachines.Snapshot,
        machines: List<com.cellobservatory.observatory.model.MachineListing>, sort: String = "time", query: String = "",
        activeOnly: Boolean = false, now: Long = System.currentTimeMillis(), pinned: String? = null, pinnedMachine: String? = null): List<ListedSession> {
        val listed = saved.machines.filter { it.listing != null }.mapTo(HashSet()) { it.label }
        val all = local.map { ListedSession(it) } + saved.machines.flatMap { m -> m.listing?.sessions.orEmpty().map { ListedSession(it, m.label) } } +
            machines.filter { it.label !in listed }.flatMap { m -> m.sessions.map { ListedSession(it, m.label, m) } }
        if (orders.isEmpty() || all.size != source.size || all.indices.any { i ->
                val a = all[i]; val b = source[i]; a.row !== b.row || a.machine != b.machine || a.synced !== b.synced }) {
            source = all
            val hands = compareBy<ListedSession> { if (waiting(it.row)) 0 else 1 }
                .thenBy { if (waiting(it.row)) when (it.row.attention?.kind) { "permission" -> 0; "question" -> 1; else -> 2 } else 0 }
                .thenBy { if (waiting(it.row)) it.row.attention?.ts ?: 0 else 0 }
            orders = mapOf(
                "time" to all.sortedWith(hands.thenByDescending { it.row.lastActiveMs }),
                "time-asc" to all.sortedWith(hands.thenBy { it.row.lastActiveMs }),
                "name" to all.sortedWith(hands.thenBy { (it.row.title ?: it.row.id).lowercase(java.util.Locale.ROOT) }),
                "name-desc" to all.sortedWith(hands.thenByDescending { (it.row.title ?: it.row.id).lowercase(java.util.Locale.ROOT) }),
            )
        }
        val q = query.lowercase(java.util.Locale.ROOT)
        return orders.getValue(if (sort in orders) sort else "time").filter { entry ->
            val r = entry.row
            val matches = q.isEmpty() || listOf(r.title, r.id, r.workspace, r.model, r.agent, entry.machine).joinToString(" ").lowercase(java.util.Locale.ROOT).contains(q)
            val active = (entry.synced == null && isSessionActive(maxOf(r.liveMs, r.lastActiveMs), now)) || workerGroups(r).isNotEmpty()
            matches && (!activeOnly || active || waiting(r) || r.pending > 0 || (r.id == pinned && entry.machine == pinnedMachine))
        }
    }

    companion object {
        fun waiting(r: SessionRow) = r.attention != null && r.attention.kind != "idle-done"
        fun states(saved: com.cellobservatory.observatory.core.SavedMachines.Snapshot,
            machines: List<com.cellobservatory.observatory.model.MachineListing>): List<String> {
            val labels = saved.machines.mapTo(HashSet()) { it.label }
            return listOfNotNull(saved.error?.let { "Saved machines — $it" }) + saved.machines.map { "${it.label} — ${it.status()}" } +
                machines.filter { it.label !in labels }.map { "${it.label} — synced ${it.syncedAt?.let { at -> com.cellobservatory.observatory.model.relTime(at) } ?: "at a time not recorded"}" }
        }
    }
}
