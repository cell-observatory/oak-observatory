package com.cellobservatory.observatory.model

import com.google.gson.JsonParser

/**
 * The raised-hand vocabulary this plugin shares with core (2026-09-15).
 *
 * [attentionLabel] is the ONE wording every surface uses for a wait — a VERBATIM mirror of core's
 * `attentionLabel` (packages/core/src/notify.ts). The plugin cannot call core, so the mirror lives here,
 * once, and the balloon, the action and the Sessions tab all read it.
 */
fun attentionLabel(kind: String): String = when (kind) {
    "question" -> "has a question for you"
    "permission" -> "needs your permission"
    "input" -> "is waiting for your input"
    else -> "finished its turn"
}

/** One row of `oak inbox --json` — the session, what it waits on, and for how long. */
data class InboxHand(val id: String, val kind: String, val message: String, val title: String?, val ts: Long) {
    val label: String get() = attentionLabel(kind)
}

/** `oak inbox --next [--after <id>] --json` → `{next, hand}`: the session to jump to, by core's ranking
 *  (permission, then question, then input, oldest first). The rule lives in core; this only reads it. */
object InboxNextParser {
    fun parse(json: String?): InboxHand? {
        if (json.isNullOrBlank()) return null
        return try {
            val o = JsonParser.parseString(json).takeIf { it.isJsonObject }?.asJsonObject ?: return null
            val hand = o.get("hand")?.takeIf { it.isJsonObject }?.asJsonObject ?: return null
            val id = hand.get("id")?.takeIf { it.isJsonPrimitive }?.asString?.takeIf { it.isNotBlank() } ?: return null
            InboxHand(
                id = id,
                kind = hand.get("kind")?.takeIf { it.isJsonPrimitive }?.asString ?: "",
                message = hand.get("message")?.takeIf { it.isJsonPrimitive }?.asString ?: "",
                title = hand.get("title")?.takeIf { it.isJsonPrimitive }?.asString?.takeIf { it.isNotBlank() },
                ts = hand.get("ts")?.takeIf { it.isJsonPrimitive }?.asLong ?: 0L,
            )
        } catch (_: Exception) {
            null // garbage in, nobody waiting out — never a crash on a keypress
        }
    }
}
