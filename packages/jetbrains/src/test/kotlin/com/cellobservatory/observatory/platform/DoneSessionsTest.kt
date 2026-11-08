package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.core.ClaudePaths
import com.cellobservatory.observatory.model.SessionRow
import com.cellobservatory.observatory.model.SessionsParser
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

class DoneSessionsTest : ObservatoryPlatformTestCase() {
    private lateinit var cfg: Path
    private var savedPin: String? = null
    private var savedBin: String? = null
    private var savedActive = true
    override fun setUp() {
        super.setUp()
        cfg = Files.createTempDirectory("oak-done-sessions")
        ClaudePaths.configDirOverride = cfg
        val st = ObservatorySettings.instance.state
        savedPin = st.session; savedBin = st.observatoryBin; savedActive = st.overviewActiveOnly
        st.session = null; st.observatoryBin = "/bin/false"; st.overviewActiveOnly = false
    }
    override fun tearDown() {
        try {
            val st = ObservatorySettings.instance.state
            st.session = savedPin; st.observatoryBin = savedBin; st.overviewActiveOnly = savedActive
            ObservatoryService.getInstance(project).setFilter("")
            ClaudePaths.configDirOverride = null
            cfg.toFile().deleteRecursively()
        } finally { super.tearDown() }
    }
    fun testDoneSessionsFoldPerMachineAndOpenByClickWhilePinPendingRevivalAndSearchStayVisible() {
        var res = SessionsParser.parse("""{"sessions":[{"id":"local-done","title":"Local finished","lastActiveMs":1,"workspace":"local-work","attention":{"kind":"idle-done","ts":1}}],
            "machines":[{"host":"bbbbbbbbbbbb","label":"saved-box","sessions":[{"id":"saved-done","title":"Saved finished","lastActiveMs":1,"workspace":"saved-work","attention":{"kind":"idle-done","ts":1}}]}]}""")!!
        val panel = ChangeMapPanel(project)
        val repaint = ChangeMapPanel::class.java.getDeclaredMethod("repaintSessions", SessionsResult::class.java).apply { isAccessible = true }
        @Suppress("UNCHECKED_CAST")
        val list = ChangeMapPanel::class.java.getDeclaredField("sessionsList").apply { isAccessible = true }.get(panel) as JList<Any>
        list.setSize(900, 600)
        fun field(v: Any, name: String): Any? = v.javaClass.getDeclaredField(name).apply { isAccessible = true }.get(v)
        fun rows() = (0 until list.model.size).map { list.model.getElementAt(it) }
        fun shown() = rows().mapNotNull { when (it.javaClass.simpleName) {
            "SessionRow" -> (it as SessionRow).id
            "IndexedSessionRow", "RemoteSessionRow" -> (field(it, "session") as SessionRow).id
            else -> null
        } }
        fun paint() { repaint.invoke(panel, res) }
        fun fold(machine: String?) = rows().indexOfFirst { it.javaClass.simpleName == "DoneSessionsToggle" && field(it, "machine") == machine }
        fun click(i: Int) {
            assertTrue("fold is visible", i >= 0)
            val cell = list.getCellBounds(i, i)
            val event = MouseEvent(list, MouseEvent.MOUSE_CLICKED, System.currentTimeMillis(), 0, cell.x + 5, cell.y + cell.height / 2, 1, false, MouseEvent.BUTTON1)
            list.mouseListeners.forEach { it.mouseClicked(event) }
        }
        paint()
        assertEquals(emptyList<String>(), shown())
        assertEquals(2, rows().count { it.javaClass.simpleName == "DoneSessionsToggle" })
        assertFalse(rows().any { it.javaClass.simpleName == "WorkspaceHeaderRow" })
        click(fold(null)); click(fold("saved-box"))
        assertEquals(listOf("local-done", "saved-done"), shown())
        assertEquals(listOf("local-work", "saved-work"), rows().filter { it.javaClass.simpleName == "WorkspaceHeaderRow" }.map { field(it, "workspace") })
        paint()
        assertEquals(2, shown().size)
        click(fold(null))
        list.selectedIndex = fold("saved-box")
        list.getActionForKeyStroke(KeyStroke.getKeyStroke(KeyEvent.VK_ENTER, 0))!!
            .actionPerformed(ActionEvent(list, ActionEvent.ACTION_PERFORMED, "enter"))
        assertEquals(emptyList<String>(), shown())
        Files.createDirectories(ClaudePaths.storeDir("local-done"))
        ObservatorySettings.instance.state.session = "local-done"
        paint()
        assertEquals(listOf("local-done"), shown())
        ObservatorySettings.instance.state.session = null
        res = res.copy(machines = res.machines.map { m -> m.copy(sessions = m.sessions.map { it.copy(pending = 1) }) })
        // A finished session with edits left to review folds too, and its fold counts them (2026-11-05, the user's request).
        // local-done stays: the store made above makes it this window's current session, which never folds.
        paint(); assertEquals("a done session with pending edits folds", listOf("local-done"), shown())
        assertEquals("the fold counts the pending edits inside it", 1, field(rows()[fold("saved-box")], "pending"))
        res = res.copy(machines = res.machines.map { m -> m.copy(sessions = m.sessions.map { it.copy(pending = 0) }) })
        // Only this machine's current session is the watched one: a saved machine's newest-in-its-folder folds (2026-11-05).
        res = res.copy(machines = res.machines.map { m -> m.copy(sessions = m.sessions.map { it.copy(current = true) }) })
        paint(); assertFalse("another machine's current session folds when done", "saved-done" in shown())
        res = res.copy(machines = res.machines.map { m -> m.copy(sessions = m.sessions.map { it.copy(current = false) }) })
        res = res.copy(sessions = res.sessions.map { it.copy(pending = 0, attention = null, liveMs = System.currentTimeMillis()) })
        paint(); assertEquals(listOf("local-done"), shown())
        ObservatoryService.getInstance(project).setFilter("saved-done")
        paint(); assertEquals(listOf("saved-done"), shown())
        ObservatoryService.getInstance(project).setFilter("")
        ObservatorySettings.instance.state.overviewActiveOnly = true
        paint(); assertEquals(listOf("local-done"), shown())
    }
}
