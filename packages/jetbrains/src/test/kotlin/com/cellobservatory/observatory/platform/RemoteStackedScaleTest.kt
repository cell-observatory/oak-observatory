package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.ui.RemoteEditorReview
import com.cellobservatory.observatory.ui.ReviewAllEditor
import com.cellobservatory.observatory.ui.ReviewAllVirtualFile
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.cellobservatory.observatory.services.ObservatoryService
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.util.ui.UIUtil
import java.awt.Container
import java.nio.file.Files
import javax.swing.JButton

class RemoteStackedScaleTest : ObservatoryPlatformTestCase() {
    private fun buttons(c: Container): List<JButton> = c.components.flatMap { (if (it is JButton) listOf(it) else emptyList()) + (if (it is Container) buttons(it) else emptyList()) }
    private fun pump(pred: () -> Boolean) {
        val end = System.currentTimeMillis() + 15000
        while (!pred() && System.currentTimeMillis() < end) { UIUtil.dispatchAllInvocationEvents(); Thread.sleep(5) }
        assertTrue("remote page/action finished", pred())
    }
    fun testOpenAllStaysHereAndLaterPageActionsKeepTheirMachine() {
        val dir = Files.createTempDirectory("oak-remote-stacked").toFile()
        val settings = ObservatorySettings.instance.state
        val oldBin = settings.observatoryBin
        val svc = ObservatoryService.getInstance(project)
        val oldPin = svc.remotePin
        val messages = mutableListOf<String>()
        val oldDialog = com.intellij.openapi.ui.TestDialogManager.setTestDialog(com.intellij.openapi.ui.TestDialog { messages.add(it); 0 })
        settings.observatoryBin = java.io.File(dir, "oak").apply {
            writeText("""#!/usr/bin/python3
import sys,json,pathlib
root=pathlib.Path(__file__).parent
args=sys.argv[1:]
with (root/'calls').open('a') as f: f.write(json.dumps(args)+'\n')
def flag(k): return args[args.index(k)+1] if k in args else None
state=json.loads((root/'state').read_text()) if (root/'state').exists() else {}
def rec(i): return dict(id=i,ts=i,tool='Edit',file='/missing/%s.ts'%(i%1293),status=state.get(str(i),'pending'),beforeBlob=None,afterBlob=None,members=[i],rel='%s.ts'%i,added=1,removed=1)
if args[0]=='review': print(json.dumps(dict(units=[rec(i) for i in range(1,2617)],ids=list(range(1,2617)),cancelledIds=[])))
elif args[0]=='diff': print(json.dumps(dict(records=[dict(rec=rec(int(i)),before='old\n',after='new\n',patch='-old\n+new\n',omittedLines=0) for i in flag('--ids').split(',')],paths=dict(home='/remote',hostname='lab-a',user='fixture',shares=[]))))
elif args[0] in ['keep','undo','redo']:
 state[args[1]]={'keep':'kept','undo':'undone','redo':'pending'}[args[0]]
 (root/'state').write_text(json.dumps(state)); print('{}')
elif args[:2]==['machine','list']: print('[{"label":"lab-a","target":"fixture@alias","enabled":true}]')
elif args[:2]==['editor-review','map']: print('{"files":[]}')
elif args[:2]==['editor-review','info']: print('{"workspace":"/missing","installed":true}')
else: print('{}')
""")
            setExecutable(true)
        }.path
        val manager = FileEditorManager.getInstance(project)
        var ownedEditor: ReviewAllEditor? = null
        try {
            project.basePath?.let { java.io.File(it).mkdirs() }
            RemoteEditorReview.open(project, "lab-a", "synthetic", all = true)
            pump { manager.openFiles.any { it is ReviewAllVirtualFile } || messages.isNotEmpty() }
            assertTrue("Open all never sends a Gateway link: $messages", messages.none { "Gateway" in it })
            val vf = manager.openFiles.filterIsInstance<ReviewAllVirtualFile>().single()
            assertTrue(vf.name, vf.name.contains("2616 change(s)"))
            val editor = ReviewAllEditor(project, vf)
            ownedEditor = editor
            fun button(text: String) = buttons(editor.component as Container).firstOrNull { it.text == text }
            pump { button("Show 10 more") != null }
            button("Show 10 more")!!.doClick()
            pump { buttons(editor.component as Container).any { it.toolTipText == "Keep #11" } }
            // Change the sidebar selection before the click: the tab must retain lab-a.
            svc.remotePin = ObservatoryService.RemotePin("other-session", "lab-b")
            buttons(editor.component as Container).first { it.toolTipText == "Keep #11" }.doClick()
            pump { buttons(editor.component as Container).any { it.toolTipText == "Revert kept #11 — its change comes off disk" } }
            buttons(editor.component as Container).first { it.toolTipText == "Revert kept #11 — its change comes off disk" }.doClick()
            pump { buttons(editor.component as Container).any { it.toolTipText == "Re-apply reverted #11" } }
            buttons(editor.component as Container).first { it.toolTipText == "Re-apply reverted #11" }.doClick()
            pump { buttons(editor.component as Container).any { it.toolTipText == "Keep #11" } }
            val calls = java.io.File(dir, "calls").readLines().map { com.google.gson.JsonParser.parseString(it).asJsonArray.map { a -> a.asString } }
            val pages = calls.filter { it.firstOrNull() == "diff" }
            assertEquals("two pages and three action refreshes", 5, pages.size)
            assertTrue(pages.toString(), pages.all { "--ids" in it && it[it.indexOf("--ids")+1].split(',').size <= 10 && it.last() == "lab-a" })
            assertTrue(calls.toString(), calls.filter { it.firstOrNull() in listOf("keep", "undo", "redo") }.all { it.last() == "lab-a" && it[1] == "11" })
            assertFalse("no handoff or per-edit snapshot", calls.any { it.firstOrNull() == "editor-review" })
        } finally {
            ownedEditor?.let { com.intellij.openapi.util.Disposer.dispose(it) }
            manager.openFiles.filterIsInstance<ReviewAllVirtualFile>().forEach { manager.closeFile(it) }
            svc.remotePin = oldPin
            settings.observatoryBin = oldBin
            com.intellij.openapi.ui.TestDialogManager.setTestDialog(oldDialog)
            dir.deleteRecursively()
        }
    }
}
