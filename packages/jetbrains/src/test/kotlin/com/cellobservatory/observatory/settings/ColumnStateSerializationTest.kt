package com.cellobservatory.observatory.settings

import com.intellij.util.xmlb.XmlSerializer
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The grouped-column state survives a round trip through `claude-observatory.xml`.
 *
 * A `PersistentStateComponent` field that the platform's serializer cannot write is not an error anywhere:
 * the IDE saves the file without it, and the reader's column widths and folds silently reset on the next
 * start. Only a real serialize/deserialize can see that, so this does one — the same [XmlSerializer] the
 * component storage uses.
 */
class ColumnStateSerializationTest {

    @Test
    fun `column widths, folds and the timeline toggle round-trip`() {
        val state = ObservatorySettings.State().apply {
            columnSplits = linkedMapOf("sessions-fleet:0" to 0.31f, "workflows-tasks-processes:1" to 0.72f)
            collapsedColumns = mutableListOf("processes", "observations")
            timelineGroupedNav = true
        }
        val xml = XmlSerializer.serialize(state)
        val back = XmlSerializer.deserialize(xml, ObservatorySettings.State::class.java)
        assertEquals("the remembered divider widths", state.columnSplits, back.columnSplits)
        assertEquals("the folded columns", state.collapsedColumns, back.collapsedColumns)
        assertEquals("the Timeline's own grouping flag", true, back.timelineGroupedNav)
        // The Overview's flag is a SEPARATE field: one window's grouping must never answer for the other's.
        assertEquals("the Overview's grouping is untouched by the Timeline's", false, back.overviewGroupedNav)
    }

    @Test
    fun `a column folded under a retired Timeline member key is dropped, its neighbours kept`() {
        // 0.10.0 renamed the Timeline's `agent` member to `conversation`, and 2026-09-23 folded
        // Conversation into the Feed. A settings file from either era can fold a column that now names
        // no member. Those keys are dropped on load — not transferred to the Feed, whose fold is its
        // own — and the neighbour proves the drop touches nothing else.
        val old = ObservatorySettings.State().apply { collapsedColumns = mutableListOf("agent", "conversation", "observations") }
        val loaded = ObservatorySettings().apply { loadState(old) }.state
        assertEquals(
            "retired keys go, the neighbour stays",
            listOf("observations"),
            loaded.collapsedColumns,
        )
    }

    @Test
    fun `a settings file written before these fields existed still loads`() {
        // What an older claude-observatory.xml looks like: no column state at all.
        val old = org.jdom.Element("State").apply {
            addContent(org.jdom.Element("option").setAttribute("name", "inlineReview").setAttribute("value", "false"))
        }
        val back = XmlSerializer.deserialize(old, ObservatorySettings.State::class.java)
        assertEquals("an absent map reads as no remembered widths", 0, back.columnSplits.size)
        assertEquals("an absent list reads as nothing folded", 0, back.collapsedColumns.size)
        assertEquals("and the value it DID carry still lands", false, back.inlineReview)
    }

    @Test
    fun `old Timeline divider indexes cannot size the new Feed column`() {
        val state = ObservatorySettings.State().apply {
            columnSplits = linkedMapOf("timeline:0" to 0.8f, "timeline:1" to 0.7f, "timeline-feed:0" to 0.3f, "sessions-fleet:0" to 0.4f)
        }
        val loaded = ObservatorySettings().apply { loadState(state) }.state
        assertEquals(mapOf("timeline-feed:0" to 0.3f, "sessions-fleet:0" to 0.4f), loaded.columnSplits)
        assertEquals("timeline-feed", com.cellobservatory.observatory.model.NavGrouping.TIMELINE)
    }

}
