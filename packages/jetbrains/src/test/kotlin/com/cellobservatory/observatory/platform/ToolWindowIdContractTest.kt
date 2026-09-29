package com.cellobservatory.observatory.platform

import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Agreement on the tool-window IDS the code raises: `getToolWindow("…")` returns null for an id
 * plugin.xml doesn't declare, and every raise-site null-safes that away — so a rename that misses
 * one side ships a button that silently does nothing (the platform fixture registers no tool
 * windows, which is why DemoTourDriveTest cannot catch it either). The mirror set below must list
 * every id a `getToolWindow` literal or TOOL_WINDOW_ID constant names; 0.9.0's container renames
 * (Traces / Dashboards / Timeline) are exactly the drift this pins.
 */
class ToolWindowIdContractTest {
    @Test
    fun `plugin xml declares every tool-window id the code raises`() {
        val xml = javaClass.getResourceAsStream("/META-INF/plugin.xml")!!.readBytes().decodeToString()
        val declared = Regex("""<toolWindow[^>]*\bid="([^"]+)"""").findAll(xml).map { it.groupValues[1] }.toSet()
        val raised = setOf(
            "Observatory Traces", // ReviewNavBar, EditsTreePanel, TourController
            "Observatory Dashboards", // ObservatoryService, TourController
            "Observatory Timeline", // TourController, ObservatoryService
            "OAK Tour", // TourController.TOOL_WINDOW_ID
        )
        raised.forEach { id -> assertTrue("plugin.xml is missing toolWindow id \"$id\"", id in declared) }
    }
}
