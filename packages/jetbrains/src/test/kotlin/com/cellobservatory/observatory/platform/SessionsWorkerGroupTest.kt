package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.model.ActiveWorker
import com.cellobservatory.observatory.model.SessionRow
import com.cellobservatory.observatory.model.SessionsResult
import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.cellobservatory.observatory.ui.ChangeMapPanel
import java.awt.event.ActionEvent
import java.awt.event.KeyEvent
import java.awt.event.MouseEvent
import java.nio.file.Files
import java.nio.file.Path
import javax.swing.JList
import javax.swing.KeyStroke

/**
 * The Sessions tab's worker groups, driven over the REAL panel in a headless IDE: a session's workers still at it sit
 * in one group under its row, closed at first; a click or Enter opens it, those waiting on a person first, and keeps
 * the group's row selected; it stays open across the next listing; a click on a worker opens its own log; a finished
 * worker is never listed. The CLI is pointed at /bin/false, so no panel reads the real store.
 */
class SessionsWorkerGroupTest : ObservatoryPlatformTestCase() {

    private lateinit var cfg: Path
    private var savedPin: String? = null
    private var savedBin: String? = null

    override fun setUp() {
        super.setUp()
        cfg = Files.createTempDirectory("oak-worker-group-cfg")
        ClaudePaths.configDirOverride = cfg
        val st = ObservatorySettings.instance.state
        savedPin = st.session
        savedBin = st.observatoryBin
        st.session = null
        st.observatoryBin = "/bin/false"
    }

    override fun tearDown() {
        try {
            val st = ObservatorySettings.instance.state
            st.session = savedPin
            st.observatoryBin = savedBin
            ClaudePaths.configDirOverride = null
            cfg.toFile().deleteRecursively()
        } finally {
            super.tearDown()
        }
    }

    fun testASessionsWorkersOpenUnderItWaitingFirstAndAWorkerReviewsItsSession() {
        val now = System.currentTimeMillis()
        // A store on disk, so the pin a click makes is one the service keeps (it drops a pin to a session that is gone).
        Files.createDirectories(ClaudePaths.storeDir("fixture-busy"))
        fun listing() = SessionsResult(null, listOf(SessionRow(
            "fixture-busy", "Fan the review out", now - 3_600_000, current = false, edits = 0, pending = 0, files = 0, workspace = "~/fixture",
            activeWorkers = listOf(
                ActiveWorker("a1", "Review spine code", "working", "Opus 5.5", 3, 1, 120, 4, 1_200_000L, now),
                ActiveWorker("a2", "Review brain code", "awaiting-permission", phaseConfidence = "heuristic"),
                ActiveWorker("a3", "Assess rendering", "working"),
                ActiveWorker("a9", "Done already", "done"),
            ),
        )))
        val panel = ChangeMapPanel(project)
        val repaint = ChangeMapPanel::class.java.getDeclaredMethod("repaintSessions", SessionsResult::class.java).apply { isAccessible = true }
        @Suppress("UNCHECKED_CAST")
        val list = ChangeMapPanel::class.java.getDeclaredField("sessionsList").apply { isAccessible = true }.get(panel) as JList<Any>
        list.setSize(900, 600)
        fun field(v: Any, name: String): Any? = v.javaClass.getDeclaredField(name).apply { isAccessible = true }.get(v)
        fun row(i: Int): Any = list.model.getElementAt(i)
        fun shape(): List<String> = (0 until list.model.size).mapNotNull { i ->
            val v = row(i)
            when (v.javaClass.simpleName) {
                "SessionRow" -> (v as SessionRow).id
                "WorkerGroupRow" -> "group open=${field(v, "open")}"
                "WorkerStateRow" -> "${field(v, "state")} (${field(v, "count")})"
                "WorkerRow" -> "  " + (field(v, "worker") as ActiveWorker).title
                else -> null
            }
        }
        fun indexOf(kind: String, title: String? = null): Int = (0 until list.model.size).first { i ->
            val v = row(i)
            v.javaClass.simpleName == kind && (title == null || (field(v, "worker") as ActiveWorker).title == title)
        }
        fun click(i: Int) {
            val cell = list.getCellBounds(i, i)
            val e = MouseEvent(list, MouseEvent.MOUSE_CLICKED, System.currentTimeMillis(), 0, cell.x + 5, cell.y + cell.height / 2, 1, false, MouseEvent.BUTTON1)
            list.mouseListeners.forEach { it.mouseClicked(e) }
        }
        repaint.invoke(panel, listing())
        assertEquals("closed at first: the summary alone", listOf("fixture-busy", "group open=false"), shape())
        click(indexOf("WorkerGroupRow"))
        assertEquals(
            "a click opens it: those waiting on a person first, never a finished one",
            listOf("fixture-busy", "group open=true", "blocked (1)", "  Review brain code", "working (2)", "  Review spine code", "  Assess rendering"),
            shape(),
        )
        assertEquals("the group's row stays selected", indexOf("WorkerGroupRow"), list.selectedIndex)
        fun labels(i: Int): List<String> = (list.cellRenderer.getListCellRendererComponent(list, row(i), i, false, false) as java.awt.Container)
            .components.mapNotNull { (it as? javax.swing.JLabel)?.text }
        assertEquals("an inferred wait wears the Workers tree's ~", "blocked~", labels(indexOf("WorkerRow", "Review brain code")).first())
        assertEquals("control: a stated phase does not", "working", labels(indexOf("WorkerRow", "Review spine code")).first())
        repaint.invoke(panel, listing())
        assertEquals("open across the next listing", "group open=true", shape()[1])
        click(indexOf("WorkerRow", "Assess rendering"))
        assertEquals("a worker reviews its session", "fixture-busy", ObservatorySettings.instance.state.session)
        val picked = ObservatoryService.getInstance(project).selectedFeed?.ref
        assertEquals("agent", picked?.kind)
        assertEquals("a3", picked?.id)
        assertEquals("fixture-busy", picked?.session)
        list.selectedIndex = indexOf("WorkerRow", "Review spine code")
        list.getActionForKeyStroke(KeyStroke.getKeyStroke(KeyEvent.VK_ENTER, 0))!!
            .actionPerformed(ActionEvent(list, ActionEvent.ACTION_PERFORMED, "enter"))
        assertEquals("Enter opens that worker’s log too", "a1", ObservatoryService.getInstance(project).selectedFeed?.ref?.id)
        list.selectedIndex = indexOf("WorkerGroupRow")
        list.getActionForKeyStroke(KeyStroke.getKeyStroke(KeyEvent.VK_ENTER, 0))!!
            .actionPerformed(ActionEvent(list, ActionEvent.ACTION_PERFORMED, "enter"))
        assertEquals("Enter on its row closes it", listOf("fixture-busy", "group open=false"), shape())
        val remote = com.cellobservatory.observatory.model.SessionsParser.parse("""{"sessions":[],"machines":[{"host":"bbbbbbbbbbbb","label":"build-box","sessions":[{"id":"remote-parent","lastActiveMs":1,"activeWorkers":[{"agentId":"remote-worker","title":"Remote check","phase":"working"}]}]}]}""")!!
        repaint.invoke(panel, remote)
        click(indexOf("WorkerRow", "Remote check"))
        val remotePick = ObservatoryService.getInstance(project).selectedFeed?.ref
        assertEquals("build-box", remotePick?.machine)
        assertEquals("remote-parent", remotePick?.session)
        assertEquals("remote-worker", remotePick?.id)
        assertEquals("a remote worker never pins a local session", "fixture-busy", ObservatorySettings.instance.state.session)
    }
}
