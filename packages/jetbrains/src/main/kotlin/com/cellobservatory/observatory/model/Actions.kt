package com.cellobservatory.observatory.model

import com.google.gson.JsonObject
import com.google.gson.JsonParser

/** Risk score for a shell command (mirrors core's CommandRisk). */
data class CommandRisk(val level: String, val reasons: List<String>)

/** One tool call Claude made (mirrors core's ActionRecord over the CLI `actions --json` surface). */
data class ActionRecord(
    val ts: Long,
    val tool: String,
    val category: String,
    val target: String,
    val detail: String?,
    val ok: Boolean,
    val isError: Boolean,
    val reasoning: String?,
    val editId: Int?,
    val risk: CommandRisk?,
)

/** One destination this session reached (mirrors core's EgressChannel). [kind] is web | mcp | shell |
 *  file — the last being a file READ from outside the workspace, which is reach exactly like a fetch.
 *  [scope] is remote | local | unknown: 'local' means it stayed on this machine but crossed the workspace
 *  boundary (a FACT), 'unknown' that the destination could not be classified (an ADMISSION). */
data class EgressChannel(val kind: String, val target: String, val scope: String, val count: Int)

/** One file this session EDITED outside the workspace, with how many edits landed there (core's
 *  OutsideWrite, off `risk --json`). The edits ledger cannot state this — every path it shows is
 *  workspace-relative — so the risk audit is where it surfaces. */
data class OutsideWrite(val file: String, val count: Int)

/** The two audits the Actions surface folds the old footprint badges into (0.8.7): `risk --json`'s
 *  out-of-workspace writes and the FULL `egress --json` channel list. Fetched off their own verbs
 *  because the shared `multitask --json` payload's egress sub-report predates the fold and carries
 *  neither the writes nor the `file` read channels. */
data class SessionAudit(val outsideWrites: List<OutsideWrite>, val egress: List<EgressChannel>)

/** Parse the `risk --json` + `egress --json` pair into the folded audit view. Tolerant of an older CLI
 *  that emits neither key (both lists simply come back empty) and of the `{transcript:null}` payload
 *  every audit verb emits when there is no transcript to read. */
object AuditParser {
    fun parse(riskJson: String, egressJson: String): SessionAudit? = try {
        val r = JsonParser.parseString(riskJson).asJsonObject
        val e = JsonParser.parseString(egressJson).asJsonObject
        SessionAudit(
            outsideWrites = (r.getAsJsonArray("outsideWrites") ?: com.google.gson.JsonArray()).map { w ->
                val wo = w.asJsonObject
                OutsideWrite(wo.get("file").asString, wo.get("count")?.takeIf { !it.isJsonNull }?.asInt ?: 1)
            },
            egress = (e.getAsJsonArray("channels") ?: com.google.gson.JsonArray())
                .map { ActionsParser.parseEgress(it.asJsonObject) },
        )
    } catch (_: Exception) {
        null
    }
}

/** A category group in the Actions timeline (mirrors core's ActionGroup). */
data class ActionGroup(
    val category: String,
    val label: String,
    val count: Int,
    val errors: Int,
    val actions: List<ActionRecord>,
)

/** One subagent this session spawned, with its own action timeline + metrics (mirrors core's SubagentInfo). */
data class SubagentInfo(
    val agentId: String,
    val agentType: String?,
    val description: String?,
    val status: String?,
    val ts: Long,
    val durationMs: Long?,
    val tokens: Long?,
    val toolUseCount: Int?,
    val actions: List<ActionRecord>,
    val edits: Int,
    val totalActions: Int,
    val errors: Int,
)

/** Rollup across all subagents (mirrors core's SubagentsSummary). */
data class SubagentsSummary(
    val count: Int,
    val totalActions: Int,
    val totalEdits: Int,
    val totalDurationMs: Long,
    val totalTokens: Long,
    val errors: Int,
)

/** A sibling Claude Code session in the same project (mirrors core's SiblingSession). */
data class SiblingSession(
    val id: String,
    val self: Boolean,
    val active: Boolean,
    val lastMs: Long,
    val edits: Int,
    val pending: Int,
    val files: List<String>,
    val moreFiles: Int,
    val riskTotal: Int,
    val riskHigh: Int,
)

/** Rollup across the project's sessions (mirrors core's FleetSummary). */
data class FleetSummary(val total: Int, val active: Int, val siblings: Int, val pending: Int)

data class ActionsResult(
    val session: String,
    val total: Int,
    val errors: Int,
    val groups: List<ActionGroup>,
    val egress: List<EgressChannel>,
    val subagents: List<SubagentInfo>,
    val subagentsSummary: SubagentsSummary?,
    val fleet: List<SiblingSession>,
    val fleetSummary: FleetSummary?,
)

/** Parse the `oak actions --json` payload (which already carries the grouped view-model). */
object ActionsParser {
    private fun strOrNull(o: JsonObject, k: String) = o.get(k)?.takeIf { !it.isJsonNull }?.asString
    private fun longOrNull(o: JsonObject, k: String) = o.get(k)?.takeIf { !it.isJsonNull }?.asLong
    private fun intOrNull(o: JsonObject, k: String) = o.get(k)?.takeIf { !it.isJsonNull }?.asInt

    /** Parse one category group (`{category,label,count,errors,actions[]}`) — shared with MultitaskParser
     *  so the `multitask --json`.actions section reads the identical shape without duplicating the logic. */
    fun parseGroup(go: JsonObject): ActionGroup = ActionGroup(
        category = go.get("category").asString,
        label = go.get("label").asString,
        count = go.get("count").asInt,
        errors = go.get("errors").asInt,
        actions = go.getAsJsonArray("actions").map { parseAction(it.asJsonObject) },
    )

    /** Parse one egress destination (`{kind,target,scope,count}`) — shared with MultitaskParser. */
    fun parseEgress(eo: JsonObject): EgressChannel =
        EgressChannel(eo.get("kind").asString, eo.get("target").asString, eo.get("scope").asString, eo.get("count").asInt)

    fun parseAction(ao: JsonObject): ActionRecord = ActionRecord(
        ts = ao.get("ts")?.takeIf { !it.isJsonNull }?.asLong ?: 0L,
        tool = ao.get("tool")?.asString ?: "",
        category = ao.get("category")?.asString ?: "other",
        target = ao.get("target")?.asString ?: "",
        detail = strOrNull(ao, "detail"),
        ok = ao.get("ok")?.asBoolean ?: true,
        isError = ao.get("isError")?.asBoolean ?: false,
        reasoning = strOrNull(ao, "reasoning"),
        editId = ao.get("editId")?.takeIf { !it.isJsonNull }?.asInt,
        risk = ao.get("risk")?.takeIf { it.isJsonObject }?.asJsonObject?.let { r ->
            CommandRisk(r.get("level").asString, r.getAsJsonArray("reasons").map { it.asString })
        },
    )

    fun parse(json: String): ActionsResult? = try {
        val o = JsonParser.parseString(json).asJsonObject
        val summary = o.getAsJsonObject("summary")
        val groups = o.getAsJsonArray("groups").map { parseGroup(it.asJsonObject) }
        val subagents = o.get("subagents")?.takeIf { it.isJsonArray }?.asJsonArray?.map { s ->
            val so = s.asJsonObject
            val sum = so.getAsJsonObject("summary")
            SubagentInfo(
                agentId = so.get("agentId")?.asString ?: "",
                agentType = strOrNull(so, "agentType"),
                description = strOrNull(so, "description"),
                status = strOrNull(so, "status"),
                ts = so.get("ts")?.takeIf { !it.isJsonNull }?.asLong ?: 0L,
                durationMs = longOrNull(so, "durationMs"),
                tokens = longOrNull(so, "tokens"),
                toolUseCount = intOrNull(so, "toolUseCount"),
                actions = so.get("actions")?.takeIf { it.isJsonArray }?.asJsonArray?.map { parseAction(it.asJsonObject) } ?: emptyList(),
                edits = so.get("edits")?.takeIf { !it.isJsonNull }?.asInt ?: 0,
                totalActions = sum?.get("total")?.asInt ?: 0,
                errors = sum?.get("errors")?.asInt ?: 0,
            )
        } ?: emptyList()
        val subagentsSummary = o.getAsJsonObject("subagentsSummary")?.let { s ->
            SubagentsSummary(
                count = s.get("count")?.asInt ?: 0,
                totalActions = s.get("totalActions")?.asInt ?: 0,
                totalEdits = s.get("totalEdits")?.asInt ?: 0,
                totalDurationMs = s.get("totalDurationMs")?.asLong ?: 0L,
                totalTokens = s.get("totalTokens")?.asLong ?: 0L,
                errors = s.get("errors")?.asInt ?: 0,
            )
        }
        val fleet = o.get("fleet")?.takeIf { it.isJsonArray }?.asJsonArray?.map { f ->
            val fo = f.asJsonObject
            val risk = fo.getAsJsonObject("risk")
            SiblingSession(
                id = fo.get("id")?.asString ?: "",
                self = fo.get("self")?.asBoolean ?: false,
                active = fo.get("active")?.asBoolean ?: false,
                lastMs = fo.get("lastMs")?.takeIf { !it.isJsonNull }?.asLong ?: 0L,
                edits = fo.get("edits")?.asInt ?: 0,
                pending = fo.get("pending")?.asInt ?: 0,
                files = fo.get("files")?.takeIf { it.isJsonArray }?.asJsonArray?.map { it.asString } ?: emptyList(),
                moreFiles = fo.get("moreFiles")?.asInt ?: 0,
                riskTotal = risk?.get("total")?.asInt ?: 0,
                riskHigh = risk?.get("high")?.asInt ?: 0,
            )
        } ?: emptyList()
        val fleetSummary = o.getAsJsonObject("fleetSummary")?.let { s ->
            FleetSummary(
                total = s.get("total")?.asInt ?: 0,
                active = s.get("active")?.asInt ?: 0,
                siblings = s.get("siblings")?.asInt ?: 0,
                pending = s.get("pending")?.asInt ?: 0,
            )
        }
        ActionsResult(
            session = o.get("session")?.asString ?: "",
            total = summary?.get("total")?.asInt ?: 0,
            errors = summary?.get("errors")?.asInt ?: 0,
            groups = groups,
            egress = o.getAsJsonArray("egress")?.map { parseEgress(it.asJsonObject) } ?: emptyList(),
            subagents = subagents,
            subagentsSummary = subagentsSummary,
            fleet = fleet,
            fleetSummary = fleetSummary,
        )
    } catch (_: Exception) {
        null
    }
}
