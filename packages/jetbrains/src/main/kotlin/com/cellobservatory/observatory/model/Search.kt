package com.cellobservatory.observatory.model

import com.google.gson.JsonParser

/** One row of `oak search --json`: the session, the ask, and the excerpt that matched. */
data class SearchHit(
    val session: String,
    val title: String?,
    val agent: String,
    val ts: Long,
    val prompt: String,
    val snippet: String,
    /** `prompt` when the excerpt is from the ask itself, `response` when from the answer. */
    val where: String,
)

/** Reads `{hits:[…]}`; garbage or an empty answer reads as no hits — never a crash on a keypress. */
object SearchParser {
    fun parse(json: String?): List<SearchHit> {
        if (json.isNullOrBlank()) return emptyList()
        return try {
            val o = JsonParser.parseString(json).takeIf { it.isJsonObject }?.asJsonObject ?: return emptyList()
            val arr = o.get("hits")?.takeIf { it.isJsonArray }?.asJsonArray ?: return emptyList()
            arr.mapNotNull { el ->
                val h = el.takeIf { it.isJsonObject }?.asJsonObject ?: return@mapNotNull null
                val session = h.get("session")?.takeIf { it.isJsonPrimitive }?.asString?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
                SearchHit(
                    session = session,
                    title = h.get("title")?.takeIf { it.isJsonPrimitive }?.asString?.takeIf { it.isNotBlank() },
                    agent = h.get("agent")?.takeIf { it.isJsonPrimitive }?.asString ?: "claude",
                    ts = h.get("ts")?.takeIf { it.isJsonPrimitive }?.asLong ?: 0L,
                    prompt = h.get("prompt")?.takeIf { it.isJsonPrimitive }?.asString ?: "",
                    snippet = h.get("snippet")?.takeIf { it.isJsonPrimitive }?.asString ?: "",
                    where = h.get("where")?.takeIf { it.isJsonPrimitive }?.asString ?: "prompt",
                )
            }
        } catch (_: Exception) {
            emptyList()
        }
    }
}
