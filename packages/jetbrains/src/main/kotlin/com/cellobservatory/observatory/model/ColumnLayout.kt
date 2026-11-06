package com.cellobservatory.observatory.model

/**
 * The rules a group of side-by-side columns follows: which of them show content, which are folded to a
 * rail, how wide each divider sits, and when the group must stack instead of shrinking.
 *
 * Pure data, away from Swing, for the same reason [NavGrouping] is: these are the decisions that go wrong
 * silently. A fold that empties a group, a divider that resets the width the reader dragged, a column
 * arriving late and taking its siblings' widths with it — none of those throw, none fail a build, and all
 * of them read to a user as "the panel moved my stuff". They are asserted in ColumnLayoutTest instead.
 *
 * Both grouped surfaces use it: the Overview's nav groups and the Timeline's Prompts · Observations ·
 * Actions. One rule set, two renderers ([com.cellobservatory.observatory.ui.ColumnGroupPane] is the only
 * one — the windows share it).
 */
object ColumnLayout {

    /** A folded column's rail: wide enough for the fold arrow and its name, and nothing else. */
    const val RAIL_PX = 26

    /** The narrowest a column showing CONTENT may become. Below it the group stacks rather than shrinks —
     *  this product never ellipsizes content text, so a column that cannot fit its rows must stop being a
     *  column. */
    const val MIN_COLUMN_PX = 200

    /** The key a divider's remembered proportion is stored under. Index counted from the LEFT, so a member
     *  appended later adds a key and renames none: the keys for
     *  [members] are always a prefix of the keys for `members + one more`. */
    fun dividerKey(group: String, index: Int): String = "$group:$index"

    /** How many dividers a group of [members] carries — one between each adjacent pair. */
    fun dividerCount(members: List<String>): Int = (members.size - 1).coerceAtLeast(0)

    /** The columns still showing content, in shipped order. */
    fun expanded(members: List<String>, collapsed: Set<String>): List<String> =
        members.filter { it !in collapsed }

    /**
     * Fold [member] away — unless it is the last column in the group still showing content.
     *
     * Returns the set UNCHANGED when the fold is refused: a group of nothing but rails is a pane with no
     * content and no explanation, and the reader's next move would be to reopen the one they just closed.
     */
    fun collapse(members: List<String>, collapsed: Set<String>, member: String): Set<String> {
        if (member !in members || member in collapsed) return collapsed
        if (expanded(members, collapsed).size <= 1) return collapsed
        return collapsed + member
    }

    fun expand(collapsed: Set<String>, member: String): Set<String> =
        if (member in collapsed) collapsed - member else collapsed

    /**
     * The proportion for the divider between [left] and [right].
     *
     * The reader's remembered value while both sides show content. When one side is nothing but rails it
     * is pinned to that side instead, so the rails keep only their own minimum width and every pixel the
     * fold released goes to the columns that are still readable — [stored] is left untouched, which is
     * what makes expanding restore the width the reader set rather than an equal share.
     */
    fun dividerProportion(stored: Float, left: List<String>, right: List<String>, collapsed: Set<String>): Float {
        val leftShows = left.any { it !in collapsed }
        val rightShows = right.any { it !in collapsed }
        if (leftShows && rightShows) return stored.coerceIn(0.05f, 0.95f)
        if (!leftShows && rightShows) return 0f
        if (leftShows) return 1f
        return stored.coerceIn(0.05f, 0.95f) // both folded: the group refuses that, but never divide by belief
    }

    /**
     * Whether the group must STACK its columns instead of laying them out side by side.
     *
     * Side by side needs [MIN_COLUMN_PX] for every column showing content, plus a rail for each folded
     * one. A width of 0 is a pane that has not been laid out yet — it is not narrow, it is unmeasured, so
     * it never triggers a stack.
     */
    fun mustStack(members: List<String>, collapsed: Set<String>, widthPx: Int): Boolean {
        if (widthPx <= 0) return false
        val shown = expanded(members, collapsed)
        if (shown.size <= 1) return false
        val rails = (members.size - shown.size) * RAIL_PX
        return widthPx - rails < shown.size * MIN_COLUMN_PX
    }
}
