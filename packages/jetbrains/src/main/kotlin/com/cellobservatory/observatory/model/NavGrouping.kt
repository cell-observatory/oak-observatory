package com.cellobservatory.observatory.model

/**
 * How the Overview's left-nav members fold into side-by-side groups.
 *
 * Grouped mode renders all five nav members as columns of ONE tab, so which conversation (Sessions,
 * Workers) and what it is doing (Workflows, Tasks, Processes) are on screen together, at the cost of width —
 * which is why it is a toggle and not the default.
 *
 * Kept as pure data here, away from the panel, for one reason: the member names are also the names core's
 * guided tour uses, and every tab title write in the panel resolves through them. A wrong answer from this
 * function relabels the wrong column, silently, on whichever repaint runs next.
 */
object NavGrouping {

    const val SESSIONS = "sessions"
    const val FLEET = "fleet"
    const val WORKFLOWS = "workflows"
    const val TASKS = "tasks"
    const val PROCESSES = "processes"

    /** ONE group (group ALL the tabs together, never two) — every member
     *  side by side; folding columns is how a reader narrows it. */
    const val NAV_ALL = "nav-all"

    /** Group key → its members, in shipped order. Sessions leads its group for the same reason it leads
     *  the plain tab strip: which session you are reviewing precedes every other question. */
    val GROUPS: Map<String, List<String>> = linkedMapOf(
        NAV_ALL to listOf(SESSIONS, FLEET, WORKFLOWS, TASKS, PROCESSES),
    )

    /** The tab title each group carries. Members are separated by the same middle dot the product uses
     *  everywhere else for "and also". */
    val GROUP_TITLES: Map<String, String> = mapOf(
        NAV_ALL to "Sessions · Workers · Workflows · Tasks · Processes",
    )

    /**
     * Which TAB hosts [member]: itself when the nav is ungrouped, its group when it is grouped.
     *
     * An unknown member maps to itself in both modes — the caller then finds no such tab and does nothing,
     * which is the same "unknown name rings nothing" contract the tour anchors use.
     */
    fun groupOf(member: String, grouped: Boolean): String {
        if (!grouped) return member
        return GROUPS.entries.firstOrNull { member in it.value }?.key ?: member
    }

    // --- The Timeline window's own grouping (0.10.0) -----------------------------------------------
    // Its four surfaces answer ONE question between them — what is happening, in order — so grouped mode
    // puts all four on screen at once rather than pairing two of them: the conversation on the left, and
    // the asks, observations and tool calls to its right. The Overview's grouping is a separate toggle
    // for a separate window; nothing here reads its setting.

    const val PROMPTS = "prompts"
    const val OBSERVATIONS = "observations"
    const val ACTIONS = "actions"

    /** The Feed tab (0.10.0) — the conversation as it happened (prompts, replies, thinking, tool
     *  calls, permissions, captured edits), or the live/audit feed of whatever the Overview selects.
     *  It absorbed the Conversation tab (2026-09-23): one Timeline surface carries all the info. Its
     *  KEY is its title lowercased, like every other member here: the tab strip, the column pane and
     *  the tour all address a member by name, so a key spelling something the reader cannot see
     *  strands whoever asks for the surface — silently, at the map lookup. */
    const val FEED = "feed"

    /** The group key the Timeline's remembered column widths are stored under. */
    const val TIMELINE = "timeline-feed"

    /** The members, in the same order as their solo tabs: the Feed leads. */
    val TIMELINE_MEMBERS: List<String> = listOf(FEED, PROMPTS, OBSERVATIONS, ACTIONS)

    val TIMELINE_TITLES: Map<String, String> = mapOf(
        PROMPTS to "Prompts",
        OBSERVATIONS to "Observations",
        ACTIONS to "Actions",
        FEED to "Feed",
    )

}
