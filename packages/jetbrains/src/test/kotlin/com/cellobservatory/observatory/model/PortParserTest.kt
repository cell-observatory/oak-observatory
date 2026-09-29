package com.cellobservatory.observatory.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Port-fidelity tests for the JSON parsers that consume the CLI's stable-by-name `--json` surface
 * (`tree --json`, `observe`). They deserialize by field name with silent catch/null fallbacks, so a
 * TS-side rename would silently null/drop data — these fixtures pin every field the plugin reads.
 */
class PortParserTest {

    @Test
    fun `TreeParser extracts folders, files, classes, loose edits and exact deltas`() {
        val json = """
            {"folders":[{"label":"src","path":"/w/src","folders":[],"files":[
              {"rel":"src/a.ts","file":"/w/src/a.ts","classes":[
                {"name":"Foo","edits":[{"id":1,"ts":1000,"tool":"Edit","file":"/w/src/a.ts","beforeBlob":"aa","afterBlob":"bb","status":"pending","added":3,"removed":1}]}
              ],"loose":[{"id":2,"ts":2000,"tool":"Write","file":"/w/src/a.ts","beforeBlob":null,"afterBlob":"cc","status":"kept","added":5,"removed":0}]}
            ]}],"files":[]}
        """.trimIndent()
        val tree = TreeParser.parse(json)!!
        assertEquals(1, tree.folders.size)
        val folder = tree.folders[0]
        assertEquals("src", folder.label)
        assertEquals("/w/src", folder.path) // drives the folder-scoped Accept/Revert/Clear actions
        assertEquals(listOf(1, 2), folder.allEdits.map { it.id }) // every descendant edit, for folder ops
        val file = folder.files[0]
        assertEquals("src/a.ts", file.rel)
        assertEquals("/w/src/a.ts", file.file)
        val classEdit = file.classes[0].edits[0]
        assertEquals("Foo", file.classes[0].name)
        assertEquals(1, classEdit.rec.id)
        assertEquals("Edit", classEdit.rec.tool)
        assertEquals(3, classEdit.added)
        assertEquals(1, classEdit.removed)
        val loose = file.loose[0]
        assertEquals(2, loose.rec.id)
        assertNull(loose.rec.beforeBlob) // JSON null -> null (new-file create)
        assertEquals("kept", loose.rec.status)
        assertEquals(5, loose.added)
        assertEquals(listOf(1, 2), file.allEdits.map { it.id }) // class-grouped + loose, for Undo-All
    }

    @Test
    fun `ObserveParser extracts session, recap, suggestions, and per-edit fields incl memory + flags`() {
        val json = """
            {"session":"s1","recap":"did stuff","insights":{"todos":[],"lastSummary":"ls","title":"t"},
             "suggestions":["do X","do Y"],
             "edits":[{"id":1,"ts":1000,"tool":"Edit","file":"/w/a.ts","status":"pending",
                       "summary":"edited a.ts (+3 -1)","reasoning":"because","flags":[{"level":"warn","message":"adds a debug statement"}],
                       "memory":{"summary":"2 kept","risky":true},"analysis":null}]}
        """.trimIndent()
        val p = ObserveParser.parse(json)!!
        assertEquals("s1", p.session)
        assertEquals("did stuff", p.recap)
        assertEquals("ls", p.insights?.lastSummary)
        assertEquals("t", p.insights?.title)
        assertEquals(listOf("do X", "do Y"), p.suggestions)
        val e = p.edits[0]
        assertEquals(1, e.id)
        assertEquals("edited a.ts (+3 -1)", e.summary)
        assertEquals("because", e.reasoning)
        assertEquals("warn", e.flags[0].level)
        assertEquals("adds a debug statement", e.flags[0].message)
        assertEquals("2 kept", e.memorySummary)
        assertTrue(e.risky)
        assertNull(e.analysis)
    }

    @Test
    fun `ObserveParser tolerates a null recap and empty edits`() {
        val p = ObserveParser.parse("""{"session":"s2","recap":null,"suggestions":[],"edits":[]}""")!!
        assertEquals("s2", p.session)
        assertNull(p.recap)
        assertNull(p.insights) // absent insights object -> null, not a crash
        assertTrue(p.suggestions.isEmpty())
        assertTrue(p.edits.isEmpty())
    }

    @Test
    fun `ActionsParser extracts category groups + action fields incl editId link and error`() {
        val json = """
            {"session":"s1","summary":{"total":3,"errors":1,"byCategory":{"edit":2,"read":1}},
             "groups":[
               {"category":"edit","label":"Edits","count":2,"errors":0,"actions":[
                  {"ts":1000,"tool":"Edit","category":"edit","target":"/w/a.ts","detail":null,"ok":true,"isError":false,"reasoning":"because","editId":7,"risk":{"level":"high","reasons":["recursive delete"]}}
               ]},
               {"category":"read","label":"Reads","count":5,"errors":1,"actions":[
                  {"ts":2000,"tool":"Read","category":"read","target":"/w/b.ts","ok":false,"isError":true,"editId":null}
               ]}
             ],
             "egress":[{"kind":"web","target":"api.example.com","scope":"remote","count":2}]}
        """.trimIndent()
        val res = ActionsParser.parse(json)!!
        assertEquals("s1", res.session)
        assertEquals(3, res.total)
        assertEquals(1, res.errors)
        assertEquals(2, res.groups.size)
        val edits = res.groups[0]
        assertEquals("edit", edits.category)
        assertEquals("Edits", edits.label)
        assertEquals(2, edits.count)
        val a = edits.actions[0]
        assertEquals("Edit", a.tool)
        assertEquals("/w/a.ts", a.target)
        assertEquals("because", a.reasoning)
        assertTrue(a.editId == 7) // links to a store record → double-click reviews it in the panel
        assertTrue(a.ok)
        // The "Reads" group leaked into curated output because it has an error; the errored row is flagged.
        val reads = res.groups[1]
        assertEquals(1, reads.errors)
        val err = reads.actions[0]
        assertTrue(err.isError)
        assertNull(err.editId) // non-edit action carries no store link
        // risk + egress (0.7.0) are parsed off the same --json surface
        assertEquals("high", a.risk?.level)
        assertEquals("recursive delete", a.risk?.reasons?.get(0))
        assertNull(err.risk) // absent risk -> null
        assertEquals(1, res.egress.size)
        assertEquals("api.example.com", res.egress[0].target)
        assertEquals("remote", res.egress[0].scope)
        assertEquals(2, res.egress[0].count)
    }

    @Test
    fun `ActionsParser extracts subagents (with metrics) and fleet siblings, defaulting empty when absent`() {
        val json = """
            {"session":"s1","summary":{"total":0,"errors":0,"byCategory":{}},"groups":[],"egress":[],
             "subagents":[
               {"agentId":"a1","agentType":"code-reviewer","description":"review diff","status":"completed",
                "ts":1000,"durationMs":300000,"tokens":45000,"toolUseCount":12,
                "actions":[{"ts":1100,"tool":"Read","category":"read","target":"/x.ts","ok":true,"isError":false,"editId":null},
                           {"ts":1200,"tool":"Grep","category":"search","target":"foo","ok":false,"isError":true,"editId":null}],
                "edits":0,"summary":{"total":2,"errors":1,"byCategory":{"read":1,"search":1},"firstTs":1100,"lastTs":1200}}],
             "subagentsSummary":{"count":1,"totalActions":2,"totalEdits":0,"totalDurationMs":300000,"totalTokens":45000,"errors":1},
             "fleet":[
               {"id":"self1","self":true,"active":true,"lastMs":2000,"edits":3,"pending":1,"files":["/a.ts"],"moreFiles":0,"risk":{"total":0,"high":0}},
               {"id":"sib1","self":false,"active":false,"lastMs":1500,"edits":2,"pending":2,"files":["/b.ts","/c.ts"],"moreFiles":1,"risk":{"total":2,"high":1}}],
             "fleetSummary":{"total":2,"active":1,"siblings":1,"pending":2}}
        """.trimIndent()
        val res = ActionsParser.parse(json)!!
        // subagents: metadata + metrics + nested action timeline
        assertEquals(1, res.subagents.size)
        val sa = res.subagents[0]
        assertEquals("a1", sa.agentId)
        assertEquals("code-reviewer", sa.agentType)
        assertEquals("review diff", sa.description)
        assertEquals(300000L, sa.durationMs) // per-subagent metrics from toolUseResult
        assertEquals(45000L, sa.tokens)
        assertEquals(12, sa.toolUseCount)
        assertEquals(2, sa.actions.size)
        assertEquals("Read", sa.actions[0].tool) // the subagent's own tool calls, nested
        assertTrue(sa.actions[1].isError)
        assertEquals(2, sa.totalActions)
        assertEquals(1, sa.errors)
        assertEquals(1, res.subagentsSummary?.count)
        assertEquals(300000L, res.subagentsSummary?.totalDurationMs)
        // fleet: sibling sessions with status / pending / files / risk
        assertEquals(2, res.fleet.size)
        val self = res.fleet.first { it.self }
        val sib = res.fleet.first { !it.self }
        assertTrue(self.active)
        assertEquals(2, sib.pending)
        assertEquals(listOf("/b.ts", "/c.ts"), sib.files)
        assertEquals(1, sib.moreFiles)
        assertEquals(2, sib.riskTotal)
        assertEquals(1, sib.riskHigh)
        assertEquals(1, res.fleetSummary?.siblings)
        // back-compat: a 0.6.x payload with no subagents/fleet keys still parses (empty, not a crash)
        val legacy = ActionsParser.parse("""{"session":"s","summary":{"total":0,"errors":0,"byCategory":{}},"groups":[],"egress":[]}""")!!
        assertTrue(legacy.subagents.isEmpty() && legacy.fleet.isEmpty())
        assertNull(legacy.subagentsSummary)
    }

    @Test
    fun `ChangeMapParser extracts the core-computed file and module rollups (0_7_5)`() {
        // Mirrors `changemap --json`. The rollups (churn, worst-unreviewed-wins status, moduleLabel,
        // maxId) are computed in core — the plugin must read them, never recompute them.
        val json = """
            {"summary":{"session":"s1","title":"Wire the change map","units":3,"rawEdits":4,"pending":2,"kept":1,"undone":0,
                        "added":40,"removed":5,"actions":9,"errors":1,"subagents":2,"fleet":3,"egress":1,"spanMs":1000},
             "edits":[],
             "files":[{"rel":"packages/core/src/a.ts","module":"packages/core/src","moduleLabel":"core","file":"a.ts",
                       "churn":35,"cnt":2,"added":30,"removed":5,"kept":1,"pending":1,"undone":0,
                       "status":"pending","maxId":7,"classes":["Foo","bar()"],
                       "agent":true,"risk":"adds a debug statement","reason":"because"},
                      {"rel":"docs/x.md","module":"docs","moduleLabel":"docs","file":"x.md",
                       "churn":10,"cnt":1,"added":10,"removed":0,"kept":0,"pending":1,"undone":0,
                       "status":"pending","maxId":9,"classes":[],
                       "agent":false,"risk":null,"reason":null}],
             "modules":[{"module":"packages/core/src","label":"core","churn":35,"cnt":2,"added":30,"removed":5,
                         "kept":1,"pending":1,"undone":0,"status":"pending","files":1}]}
        """.trimIndent()
        val m = ChangeMapParser.parse(json)!!
        assertEquals("s1", m.summary?.session)
        assertEquals("Wire the change map", m.summary?.title) // the Overview selector + Stats show this, not the id
        assertEquals(3, m.summary?.units)
        assertEquals(1, m.summary?.errors)
        assertEquals(3, m.summary?.fleet)   // the 🛰 chip — parity with the VS Code panel
        assertEquals(1, m.summary?.egress)  // the ⇅ chip

        val f = m.files[0]
        assertEquals("packages/core/src/a.ts", f.rel)
        assertEquals("core", f.moduleLabel) // pre-rendered by core — the plugin must not re-derive it
        assertEquals(35, f.churn)
        assertEquals("pending", f.status) // worst-unreviewed-wins, computed in core
        assertEquals(7, f.maxId) // the drill-through target for a double-click
        assertEquals(listOf("Foo", "bar()"), f.classes)
        assertTrue(f.agent)
        assertEquals("adds a debug statement", f.risk)
        assertNull(m.files[1].risk) // JSON null -> null, not the string "null"
        assertNull(m.files[1].reason)

        val mod = m.modules[0]
        assertEquals("core", mod.label)
        assertEquals(35, mod.churn)
        assertEquals("pending", mod.status)
        assertEquals(1, mod.files)

        // back-compat: an older CLI without files/modules parses to empty lists, not a crash
        val legacy = ChangeMapParser.parse("""{"summary":{"session":"s"},"edits":[]}""")!!
        assertTrue(legacy.files.isEmpty() && legacy.modules.isEmpty())
        // a 0.7.x payload predates the 0.8.0 attribution keys — they default empty, not a crash
        assertTrue(legacy.tasks.isEmpty() && legacy.agents.isEmpty() && legacy.rollupByTask.isEmpty())
        assertTrue(legacy.workflows.isEmpty() && legacy.rollupByWorkflow.isEmpty()) // 0.8.0 r2 keys default empty
        assertNull(legacy.unassigned)
        // garbage in -> null out (the panel then just renders empty)
        assertNull(ChangeMapParser.parse("not json"))
    }

    @Test
    fun `ChangeMapParser extracts the 0_8_0 attribution keys tasks rollups agents and unassigned`() {
        // Mirrors the 0.8.0 `changemap --json`: stable-id tasks, three-level rollups (incl. the null-id
        // unassigned bucket), and per-agent tab builds (each with its own tasks + rollupByTask). The
        // Tasks tab JOINS tasks to rollupByTask by taskId — pin every field.
        val json = """
            {"summary":{"session":"s1","units":5,"pending":3,"kept":2,"undone":0,"added":50,"removed":4,
                        "errors":0,"subagents":1,"fleet":2,"egress":0},
             "edits":[],
             "files":[],"modules":[],
             "tasks":[{"taskId":"7aabc656686a","content":"Wire the CLI","firstTs":1000,"lastTs":2000},
                      {"taskId":"92b86356a7a3","content":"Ship it","firstTs":2000,"lastTs":3000}],
             "rollupByTask":[{"taskId":"7aabc656686a","edits":3,"added":30,"removed":2,"pending":1,"kept":2,"undone":0},
                             {"taskId":null,"edits":2,"added":20,"removed":2,"pending":2,"kept":0,"undone":0}],
             "rollupBySubagent":[{"subagentId":"a1","edits":1,"added":10,"removed":0,"pending":1,"kept":0,"undone":0},
                                 {"subagentId":null,"edits":4,"added":40,"removed":4,"pending":2,"kept":2,"undone":0}],
             "rollupByAgent":[{"session":"s1","edits":5,"added":50,"removed":4,"pending":3,"kept":2,"undone":0,"files":3}],
             "rollupByWorkflow":[{"workflowId":"wf_1","edits":3,"added":30,"removed":2,"pending":1,"kept":2,"undone":0},
                                 {"workflowId":null,"edits":2,"added":20,"removed":2,"pending":2,"kept":0,"undone":0}],
             "workflows":[{"id":"wf_1","name":"obs-round2","running":true,
                "rollup":{"edits":3,"added":30,"removed":2,"pending":1,"kept":2,"undone":0},
                "files":[{"rel":"pkg/cli/a.ts","module":"pkg/cli","moduleLabel":"cli","file":"a.ts","churn":30,"cnt":3,
                          "added":30,"removed":2,"kept":2,"pending":1,"undone":0,"status":"pending","maxId":9,
                          "classes":[],"agent":false,"risk":null,"reason":null}],
                "taskIds":["7aabc656686a"]}],
             "unassigned":{"taskId":null,"edits":2,"added":20,"removed":2,"pending":2,"kept":0,"undone":0},
             "agents":[
               {"session":"s1","worktree":"/w/main","gitBranch":"main","phase":"working",
                "summary":{"session":"s1","units":5,"pending":3,"kept":2,"undone":0,"added":50,"removed":4,
                           "errors":0,"subagents":1,"fleet":2,"egress":0},
                "modules":[{"module":"pkg/cli","label":"cli","churn":30,"cnt":3,"added":30,"removed":2,
                            "kept":2,"pending":1,"undone":0,"status":"pending","files":1}],
                "files":[{"rel":"pkg/cli/a.ts","module":"pkg/cli","moduleLabel":"cli","file":"a.ts","churn":30,"cnt":3,
                          "added":30,"removed":2,"kept":2,"pending":1,"undone":0,"status":"pending","maxId":9,
                          "classes":[],"agent":false,"risk":null,"reason":null}],
                "tasks":[{"taskId":"7aabc656686a","content":"Wire the CLI","firstTs":1000,"lastTs":2000}],
                "rollupByTask":[{"taskId":"7aabc656686a","edits":3,"added":30,"removed":2,"pending":1,"kept":2,"undone":0},
                                {"taskId":null,"edits":2,"added":20,"removed":2,"pending":2,"kept":0,"undone":0}],
                "rollupBySubagent":[{"subagentId":null,"edits":5,"added":50,"removed":4,"pending":3,"kept":2,"undone":0}]},
               {"session":"s2","worktree":"/w/feat","gitBranch":"feat/x","phase":"idle",
                "summary":{"session":"s2","units":0},"modules":[],"files":[],"tasks":[],
                "rollupByTask":[],"rollupBySubagent":[]}
             ]}
        """.trimIndent()
        val m = ChangeMapParser.parse(json)!!

        // Top-level stable-id tasks + the three parallel rollups.
        assertEquals(2, m.tasks.size)
        assertEquals("7aabc656686a", m.tasks[0].taskId)
        assertEquals("Wire the CLI", m.tasks[0].content)
        assertEquals(1000L, m.tasks[0].firstTs)
        // rollupByTask carries the null-id (unassigned) bucket alongside real tasks.
        assertEquals(30, m.rollupByTask.first { it.taskId == "7aabc656686a" }.added)
        assertNull(m.rollupByTask.first { it.taskId == null }.taskId)
        assertEquals(2, m.rollupByTask.first { it.taskId == null }.edits)
        assertEquals(1, m.rollupBySubagent.first { it.subagentId == "a1" }.edits)
        assertNull(m.rollupBySubagent.first { it.subagentId == null }.subagentId)
        assertEquals("s1", m.rollupByAgent[0].session)
        assertEquals(3, m.rollupByAgent[0].files)
        // The explicit session-wide unassigned bucket.
        assertEquals(2, m.unassigned?.edits)
        assertEquals(20, m.unassigned?.added)

        // 0.8.0 r2: per-workflow rollup (incl. the null-id no-workflow bucket) + the per-workflow Overview
        // tab (id/name/running + its rollup, touched files, and contributed taskIds).
        assertEquals(3, m.rollupByWorkflow.first { it.workflowId == "wf_1" }.edits)
        assertNull(m.rollupByWorkflow.first { it.workflowId == null }.workflowId)
        assertEquals(2, m.rollupByWorkflow.first { it.workflowId == null }.edits)
        assertEquals(1, m.workflows.size)
        val wf = m.workflows[0]
        assertEquals("wf_1", wf.id)
        assertEquals("obs-round2", wf.name)
        assertTrue(wf.running)
        assertEquals(3, wf.rollup.edits)
        assertEquals(30, wf.rollup.added)
        assertEquals("pkg/cli/a.ts", wf.files[0].rel) // its churn-ranked touched files (a per-workflow rollupFiles)
        assertEquals(listOf("7aabc656686a"), wf.taskIds) // the tasks this workflow contributed to

        // Per-agent tabs: each is a full build with top-level session/worktree/gitBranch/phase.
        assertEquals(2, m.agents.size)
        val a0 = m.agents[0]
        assertEquals("s1", a0.session)
        assertEquals("/w/main", a0.worktree)
        assertEquals("main", a0.gitBranch)
        assertEquals("working", a0.phase)
        assertEquals(5, a0.summary?.units)
        assertEquals("cli", a0.modules[0].label)
        assertEquals("pkg/cli/a.ts", a0.files[0].rel)
        // The ribbon JOIN: agents[0].tasks JOINED to agents[0].rollupByTask by taskId.
        assertEquals(1, a0.tasks.size)
        val roll = a0.rollupByTask.first { it.taskId == a0.tasks[0].taskId }
        assertEquals(3, roll.edits)
        assertEquals(1, roll.pending)
        // ...and the agent's own unassigned bucket (null taskId) is present.
        assertEquals(2, a0.rollupByTask.first { it.taskId == null }.edits)
        // A second, idle agent with an empty build parses to a valid one-task-free tab.
        val a1 = m.agents[1]
        assertEquals("feat/x", a1.gitBranch)
        assertTrue(a1.tasks.isEmpty() && a1.files.isEmpty())
    }

    @Test
    fun `ChangeMapParser reads the change-map's per-prompt slices (0_8_8)`() {
        // `changemap --json` renamed `requests[]` to `prompts[]` in 0.8.8 with NO alias, and this parser
        // is what the Prompt axis and the prompt-scoped bulk actions read. Nothing exercised it: the
        // other ChangeMapParser fixtures carry no prompts key at all, so the rename could have been
        // half-applied here and every test would still pass.
        val json = """
            {"summary":{"session":"s1"},"edits":[],"files":[],"modules":[],
             "prompts":[{"id":"p1","index":1,"text":"Add retry logic to the uploader","title":"Add retry logic",
                         "ts":1700,"endTs":1900,
                         "rollup":{"edits":3,"added":9,"removed":2,"pending":2,"kept":1,"undone":0},
                         "files":[{"rel":"up.ts","module":"src","moduleLabel":"src","file":"up.ts","churn":9,
                                   "cnt":3,"kept":1,"pending":2,"undone":0,"status":"pending","maxId":3,"classes":[]}],
                         "modules":[],"editIds":[1,2,3],"agentIds":["a1"],"workflowIds":[],"processIds":["sh1"],
                         "actions":7,"errors":1,"compactions":0,"durationMs":200}]}
        """.trimIndent()
        val m = ChangeMapParser.parse(json)!!
        assertEquals(1, m.prompts.size)
        val p = m.prompts[0]
        assertEquals("p1", p.id)
        assertEquals(1, p.index)
        assertEquals("Add retry logic to the uploader", p.text)
        assertEquals(listOf(1, 2, 3), p.editIds)      // what Accept Prompt acts on
        assertEquals(listOf("a1"), p.agentIds)        // what scopes the Fleet pane to this ask
        assertEquals(3, p.rollup.edits)
        assertEquals(2, p.rollup.pending)
        assertEquals(1, p.files.size)
        assertEquals("up.ts", p.files[0].rel)
        // The pre-0.8.8 name must NOT be read: a payload carrying only `requests[]` comes from a CLI too
        // old for this plugin, and pretending it parsed would show an empty ask list as if it were true.
        val old = ChangeMapParser.parse("""{"summary":{"session":"s1"},"edits":[],"files":[],"modules":[],
             "requests":[{"id":"r1","index":1,"text":"old shape","ts":1,"endTs":2}]}""".trimIndent())!!
        assertEquals(0, old.prompts.size)
    }

    @Test
    fun `ChangeMapParser ignores keys an older CLI still emits`() {
        // An older CLI on PATH keeps emitting keys this plugin no longer reads: `subtasks` (the display
        // layer removed in 0.8.8) and `footprint` (folded into risk/egress in 0.8.7). Neither may disturb
        // the rest of the map — a stale key is data to ignore, never a reason to drop a payload.
        val json = """
            {"summary":{"session":"s1"},"edits":[],
             "subtasks":[{"id":"c0","taskId":"c0","index":0,"title":"Wire it","status":"wip",
                          "startTs":1700,"endTs":1900,"edits":1,"added":1,"removed":0,
                          "pending":1,"kept":0,"undone":0,"agent":false,"editIds":[1]}],
             "files":[{"rel":"a.ts","module":"","moduleLabel":"(root)","file":"a.ts","churn":1,"cnt":1,
                       "kept":0,"pending":1,"undone":0,"status":"pending","maxId":1,"classes":[]}],
             "modules":[],
             "footprint":{"reads":{"count":29,"outOfRoot":25,"samples":["~/.claude/CLAUDE.md"]},
                          "exec":{"count":384,"risky":8,"high":8},"outsideWrites":3}}
        """.trimIndent()
        val m = ChangeMapParser.parse(json)!!
        assertEquals("s1", m.summary?.session)
        assertEquals(1, m.files.size)
        assertEquals("a.ts", m.files[0].rel)
    }

    @Test
    fun `SessionsParser reads the workspace session listing`() {
        // `sessions --json` (0.8.8): the stat-only listing behind the Sessions tab and the Switch Session
        // popup. No row carries a pending count BY DESIGN — counting would mean parsing every session's
        // edit log, which is exactly the cost this listing exists to avoid.
        val json = """
            {"active":"s1",
             "sessions":[{"id":"s1","title":"Wire the change map","lastActiveMs":1700,"current":true},
                         {"id":"s2","title":"","lastActiveMs":900,"current":false}]}
        """.trimIndent()
        val r = SessionsParser.parse(json)!!
        assertEquals("s1", r.active)
        assertEquals(2, r.sessions.size)
        assertEquals("Wire the change map", r.sessions[0].title)
        assertEquals("Wire the change map", r.sessions[0].displayName)
        assertTrue(r.sessions[0].current)
        assertEquals(1700L, r.sessions[0].lastActiveMs)
        // A session Claude never titled falls back to a short id — a row must never render nameless.
        assertNull(r.sessions[1].title)
        assertEquals("session s2", r.sessions[1].displayName)
        // An empty listing is a valid answer (a workspace with no sessions yet).
        assertEquals(0, SessionsParser.parse("""{"sessions":[]}""")!!.sessions.size)
        // A pre-0.8.8 CLI answers the OLD row shape (edits/pending/lastMs, no lastActiveMs). Parsing it
        // would fabricate "last active at the epoch" for every row and mark none of them live, so the
        // parser refuses it and the panel falls back to saying the CLI could not answer.
        assertNull(
            SessionsParser.parse(
                """{"active":"s1","sessions":[{"id":"s1","title":"Old","edits":3,"pending":1,"lastMs":1700}]}"""
            )
        )
        assertNull(SessionsParser.parse("not json"))
    }

    @Test
    fun `AuditParser reads the folded footprint facts off risk + egress`() {
        // The two facts the badge row alone used to report, now each in the audit it belongs to: writes
        // that left the workspace (risk — they changed files nobody pointed the agent at) and reads that
        // left it (egress — reach, exactly like a fetch). Both are rendered in the Actions surface.
        val risk = """
            {"session":"s1","count":1,"high":1,
             "risky":[{"ts":1,"tool":"Bash","target":"rm -rf /tmp/x","level":"high","reasons":["recursive delete"]}],
             "outsideWrites":[{"file":"~/.zshrc","count":3},{"file":"~/notes.md","count":1}]}
        """.trimIndent()
        val egress = """
            {"session":"s1","remote":1,"byKind":{"web":1,"file":1},
             "channels":[{"kind":"web","target":"docs.anthropic.com","scope":"remote","count":2},
                         {"kind":"mcp","target":"chrome","scope":"unknown","count":1},
                         {"kind":"file","target":"~/.claude/CLAUDE.md","scope":"local","count":4}]}
        """.trimIndent()
        val a = AuditParser.parse(risk, egress)!!
        assertEquals(2, a.outsideWrites.size)
        assertEquals("~/.zshrc", a.outsideWrites[0].file)
        assertEquals(3, a.outsideWrites[0].count)
        // The `file` channel is a first-class destination, and its scope is 'local' — a FACT that the read
        // left the workspace. It must never arrive as 'unknown', which is an admission, not a finding.
        val file = a.egress.first { it.kind == "file" }
        assertEquals("local", file.scope)
        assertEquals("~/.claude/CLAUDE.md", file.target)
        assertEquals("unknown", a.egress.first { it.kind == "mcp" }.scope)
        // An older CLI emits neither key (and every audit verb emits {transcript:null} with no transcript
        // at all) — both degrade to empty lists, never to a crash or an invented default.
        val legacy = AuditParser.parse("""{"session":"s","count":0,"high":0,"risky":[]}""", """{"session":"s","transcript":null}""")!!
        assertTrue(legacy.outsideWrites.isEmpty() && legacy.egress.isEmpty())
    }

    @Test
    fun `MultitaskParser extracts running agents, sparkline, subagents, and cross-agent collisions`() {
        val json = """
            {"agents":[
               {"session":"s1","worktree":"/w/main","gitBranch":"main","self":true,"phase":"awaiting-permission",
                "phaseConfidence":"heuristic","sparkline":[0,3,7,0,2],"todos":[{"content":"do X","status":"in_progress"}],
                "subagents":[{"agentId":"a1","agentType":"Explore","description":"scan tests","phase":"working",
                              "currentTask":"reading","todos":[{"content":"read","status":"in_progress"}],
                              "edits":2,"added":12,"removed":1}],
                "files":["/w/main/a.ts","/w/main/b.ts"],"diff":{"added":40,"removed":3},
                "tokens":8000,"durationMs":120000,"risk":{"total":2,"high":1},
                "outside":{"reads":3,"writes":20}},
               {"session":"s2","worktree":"/w/feat","gitBranch":"feat/x","self":false,"phase":"idle",
                "phaseConfidence":"heuristic","sparkline":[0,0,0,0,0],"todos":[],"subagents":[],
                "files":["/w/feat/a.ts"],"diff":{"added":0,"removed":0},"risk":{"total":0,"high":0}}],
             "collisions":[{"file":"/w/main/a.ts","agents":["s1","s2"],"anyPending":true}],
             "worktrees":[{"worktree":"/w/main","gitBranch":"main","sessions":["s1"]},
                          {"worktree":"/w/feat","gitBranch":"feat/x","sessions":["s2"]}],
             "actions":{"groups":[
                 {"category":"edit","label":"Edits","count":2,"errors":0,"actions":[
                   {"ts":1500,"tool":"Edit","category":"edit","target":"/w/main/a.ts","ok":true,"isError":false,"editId":5,"reasoning":"tighten"}]},
                 {"category":"exec","label":"Commands","count":1,"errors":0,"actions":[
                   {"ts":1600,"tool":"Bash","category":"exec","target":"npm test","ok":true,"isError":false,"editId":null}]}],
               "egress":[{"kind":"web","target":"api.example.com","scope":"remote","count":1}]},
             "workflows":[{"id":"wf_1","name":"Editors R2","description":"ship the round-2 upgrade",
                 "phases":["Implement","Verify"],
                 "phaseGroups":[{"title":"Implement","done":2,"total":2},{"title":"Verify","done":1,"total":2}],
                 "agents":[{"agentId":"imp1","label":"S11-vscode","phase":"Implement","agentType":"workflow-subagent","done":true,"tokens":500,"durationMs":30000,"edits":1,"added":3,"removed":0,"model":"Opus 4.8","sparkline":[1,0,2]},
                           {"agentId":"ver2","label":"S22-jetbrains","phase":"Verify","agentType":null,"done":false,"tokens":100,"durationMs":5000,"edits":1}],
                 "running":true,"agentCount":2,"tokens":1100,"durationMs":45000,"edits":3,"added":3,"removed":1,"sparkline":[5,0,2,4,1]}],
             "summary":{"active":1,"conflicts":1}}
        """.trimIndent()
        val r = MultitaskParser.parse(json)!!
        assertEquals(2, r.agents.size)
        val a = r.agents[0]
        assertEquals("s1", a.session)
        assertTrue(a.self)
        assertEquals("awaiting-permission", a.phase) // the needs-attention state must survive the port
        assertEquals("heuristic", a.phaseConfidence)
        assertEquals(listOf(0, 3, 7, 0, 2), a.sparkline)
        assertEquals(40, a.added)
        assertEquals(3, a.removed)
        assertEquals(8000L, a.tokens) // 0.8.0 r3: the tokens/time metric the Fleet nav shows, like Workflows
        assertEquals(120000L, a.durationMs)
        assertEquals(2, a.riskTotal)
        assertEquals(1, a.riskHigh)
        // 0.8.7: the fleet row's "↗ 3 read · 20 written outside" suffix — the one footprint fact kept when
        // the badge row folded into risk/egress. An agent without the key renders the suffix absent, not 0.
        assertEquals(3, a.outside?.reads)
        assertEquals(20, a.outside?.writes)
        assertEquals(null, r.agents[1].outside)
        assertEquals(1, a.todos.size)
        // nested subagent with its own live phase + current task + ±
        assertEquals(1, a.subagents.size)
        val sub = a.subagents[0]
        assertEquals("Explore", sub.agentType)
        assertEquals("working", sub.phase)
        assertEquals("reading", sub.currentTask)
        assertEquals(12, sub.added)
        assertEquals(1, sub.todos.size)
        // collisions (uncapped) + worktrees (drives the TranscriptWatcher's bounded dir set) + summary
        assertEquals(1, r.collisions.size)
        assertEquals(listOf("s1", "s2"), r.collisions[0].agents)
        assertTrue(r.collisions[0].anyPending)
        assertEquals(listOf("/w/main", "/w/feat"), r.worktrees)
        assertEquals(1, r.active)
        assertEquals(1, r.conflicts)

        // 0.8.0: the folded-in Actions section — the active session's curated groups + egress, rendered
        // below the fleet (the fleet/subagent categories are dropped in core; not re-aggregated here).
        assertEquals(2, r.actions?.groups?.size)
        assertEquals("Edits", r.actions?.groups?.get(0)?.label)
        assertEquals(5, r.actions?.groups?.get(0)?.actions?.get(0)?.editId) // links to a reviewable store record
        assertEquals("Commands", r.actions?.groups?.get(1)?.label)
        assertEquals("npm test", r.actions?.groups?.get(1)?.actions?.get(0)?.target)
        assertEquals(1, r.actions?.egress?.size)
        assertEquals("api.example.com", r.actions?.egress?.get(0)?.target)
        assertEquals("remote", r.actions?.egress?.get(0)?.scope)

        // 0.8.0 r2: workflow runs from the rich state file — informative description, per-phase progress
        // (phaseGroups), and labeled agents carrying a REAL phase title. All aggregated in core.
        assertEquals(1, r.workflows.size)
        val wf = r.workflows[0]
        assertEquals("Editors R2", wf.name)
        assertEquals("ship the round-2 upgrade", wf.description)
        assertEquals(listOf("Implement", "Verify"), wf.phases)
        assertTrue(wf.running)
        assertEquals(1100L, wf.tokens)
        assertEquals(45000L, wf.durationMs)
        assertEquals(listOf(5, 0, 2, 4, 1), wf.sparkline) // the fleet-style activity sparkline survives the port
        assertEquals(2, wf.phaseGroups.size)
        assertEquals("Implement", wf.phaseGroups[0].title)
        assertEquals(2, wf.phaseGroups[0].done)
        assertEquals(2, wf.phaseGroups[0].total)
        assertEquals(1, wf.phaseGroups[1].done) // Verify: one agent still running
        assertEquals(2, wf.phaseGroups[1].total)
        val wa = wf.agents[0]
        assertEquals("S11-vscode", wa.label)
        assertEquals("Implement", wa.phase) // a REAL phase title, not the journal hash
        assertEquals("workflow-subagent", wa.agentType)
        assertEquals(500L, wa.tokens)
        assertEquals(1, wa.edits)
        assertTrue(wa.done)
        // per-agent "extras" (0.8.0): ±diff, model, and the per-agent activity sparkline survive the port
        assertEquals(3, wa.added)
        assertEquals(0, wa.removed)
        assertEquals("Opus 4.8", wa.model)
        assertEquals(listOf(1, 0, 2), wa.sparkline)

        // back-compat / empty: a payload with no agents parses to empty, not a crash
        val empty = MultitaskParser.parse("""{"agents":[],"collisions":[],"worktrees":[],"summary":{"active":0,"conflicts":0}}""")!!
        assertTrue(empty.agents.isEmpty() && empty.collisions.isEmpty())
        assertNull(empty.actions) // an older CLI without the actions section -> null, not a crash
        assertNull(MultitaskParser.parse("not json"))
    }

    @Test
    fun `ObservationsParser extracts recap, coalesced runs with per-edit reasoning, and next steps`() {
        // Mirrors `observations --json` (0.8.0, Timeline folded into Observations): a recap, the edit
        // timeline as coalesced same-file ×N runs (most-recent first) each edit carrying its reasoning,
        // and the still-open next steps. The panel renders this payload thin — pin every field.
        val json = """
            {"recap":"Wire the CLI + ship",
             "runs":[
               {"file":"/w/src/a.ts","rel":"src/a.ts","count":2,"added":30,"removed":4,"status":"pending","edits":[
                  {"id":3,"ts":3000,"added":20,"removed":3,"status":"pending","reasoning":"tighten the loop"},
                  {"id":5,"ts":3200,"added":10,"removed":1,"status":"kept","reasoning":null}]},
               {"file":"/w/docs/x.md","rel":"docs/x.md","count":1,"added":8,"removed":0,"status":"kept","edits":[
                  {"id":1,"ts":1000,"added":8,"removed":0,"status":"kept","reasoning":"document it"}]}],
             "nextSteps":["run the tests","update the changelog"]}
        """.trimIndent()
        val o = ObservationsParser.parse(json)!!
        assertEquals("Wire the CLI + ship", o.recap)
        assertEquals(2, o.runs.size)
        val run = o.runs[0]
        assertEquals("/w/src/a.ts", run.file)
        assertEquals("src/a.ts", run.rel)
        assertEquals(2, run.count) // adjacent same-file edits coalesced into a ×N run
        assertEquals(30, run.added)
        assertEquals(4, run.removed)
        assertEquals("pending", run.status) // worst-unreviewed-wins rollup, computed in core
        assertEquals(2, run.edits.size)
        assertEquals(3, run.edits[0].id)
        assertEquals("tighten the loop", run.edits[0].reasoning) // Claude's own words, inline per edit
        assertEquals("kept", run.edits[1].status)
        assertNull(run.edits[1].reasoning) // JSON null -> null (uncorrelated edit)
        // A lone edit is still its own run (count 1) — the panel renders it as a leaf.
        assertEquals(1, o.runs[1].count)
        assertEquals("kept", o.runs[1].status)
        assertEquals(listOf("run the tests", "update the changelog"), o.nextSteps)

        // back-compat / empty: a payload with no runs/nextSteps parses to empty, not a crash
        val bare = ObservationsParser.parse("""{"recap":"","runs":[],"nextSteps":[]}""")!!
        assertEquals("", bare.recap)
        assertTrue(bare.runs.isEmpty() && bare.nextSteps.isEmpty())
        // absent recap -> "" (not a crash); garbage -> null (the panel then renders empty)
        assertEquals("", ObservationsParser.parse("""{"runs":[]}""")!!.recap)
        assertNull(ObservationsParser.parse("not json"))
    }

    @Test
    fun `ProcessesParser reads shells, summary and a fractional last-output stamp`() {
        val json = """
            {"session":"s1","summary":{"total":2,"running":1,"failed":0},"processes":[
              {"id":"bpk1","toolUseId":"toolu_1","command":"npm test 2>&1 | tail -30","description":"Run the suite",
               "startedTs":1000,"endedTs":9000,"running":false,"status":"completed","exitCode":0,"runtimeMs":8000,
               "outputPath":"/tmp/bpk1.output","outputBytes":2352,"lastOutputTs":1784742469423.7883},
              {"id":"bpk2","toolUseId":null,"command":"sleep 90","description":null,
               "startedTs":2000,"endedTs":0,"running":true,"status":"running","exitCode":null,"runtimeMs":4000,
               "outputPath":null,"outputBytes":0,"lastOutputTs":0}
            ]}
        """.trimIndent()
        val res = ProcessesParser.parse(json)!!
        assertEquals("s1", res.session)
        assertEquals(2, res.summary.total)
        assertEquals(1, res.summary.running)
        val done = res.processes[0]
        assertEquals("bpk1", done.id) // the harness's shell id IS the identity — no OS pid exists to read
        assertEquals("Run the suite", done.description)
        assertEquals(0, done.exitCode)
        assertEquals(8000L, done.runtimeMs)
        assertEquals(2352L, done.outputBytes)
        // core stats the output file, so this stamp arrives fractional — it must not throw or land as 0
        assertEquals(1784742469423L, done.lastOutputTs)
        val live = res.processes[1]
        assertTrue(live.running)
        assertNull(live.exitCode) // never reported one — NOT the same as exit 0, so the row can't say so
        assertNull(live.description)
        assertNull(live.outputPath)
        // older CLI / bare payload: no crash, no rows
        val bare = ProcessesParser.parse("""{"session":"s1"}""")!!
        assertEquals(0, bare.summary.total)
        assertTrue(bare.processes.isEmpty())
        assertNull(ProcessesParser.parse("not json"))
    }

    @Test
    fun `PromptsParser reads the asks, their edit scope, and the one still being answered`() {
        // Mirrors `prompts --json`. editIds is the load-bearing field: the Prompt review axis accepts and
        // reverts exactly that set, so a rename would silently scope "accept everything from this ask" to
        // nothing. endTs 0 marks the CURRENT prompt — the row says "answering…" instead of a duration
        // that would otherwise keep growing unexplained.
        val json = """
            {"session":"s1","summary":{"total":2,"withEdits":1,"edits":3},
             "prompts":[
               {"id":"0381d2f21f10","index":1,"ts":1000,"endTs":5000,
                "text":"fold all of that into 0.8.6 and ship it","title":"fold all of that into 0.8.6 and ship it",
                "editIds":[4,5,9],"edits":3,"added":0,"removed":0,"pending":2,"kept":1,"undone":0,
                "files":2,"folders":1,"tokens":135000,"tasks":4,
                "actions":14,"errors":1,"agents":["toolu_a1"],"workflows":["wf_1"],"processes":["toolu_b1","toolu_b2"],
                "compactions":1,"durationMs":4000},
               {"id":"b66dc615f487","index":2,"ts":5000,"endTs":0,
                "text":"is everything installed locally?","title":"is everything installed locally?",
                "editIds":[],"edits":0,"added":0,"removed":0,"pending":0,"kept":0,"undone":0,
                "actions":3,"errors":0,"agents":[],"workflows":[],"processes":[],"compactions":0,"durationMs":57000}
             ]}
        """.trimIndent()
        val res = PromptsParser.parse(json)!!
        assertEquals("s1", res.session)
        assertEquals(2, res.summary.total)
        assertEquals(1, res.summary.withEdits)
        assertEquals(3, res.summary.edits)
        val first = res.prompts[0]
        assertEquals("0381d2f21f10", first.id)
        assertEquals(1, first.index) // 1-based, the way a person counts their own turns
        assertEquals(listOf(4, 5, 9), first.editIds) // the review scope the Prompt axis acts on
        assertEquals(2, first.pending)
        assertEquals(1, first.kept)
        assertEquals(14, first.actions)
        assertEquals(1, first.errors)
        assertEquals(listOf("toolu_a1"), first.agents)
        assertEquals(listOf("wf_1"), first.workflows)
        assertEquals(2, first.processes.size) // shells it STARTED — they may well outlive it
        assertEquals(1, first.compactions)
        assertEquals(4000L, first.durationMs)
        assertFalse(first.current) // it has an endTs, so it is finished
        // 0.8.7 per-prompt headline stats.
        assertEquals(2, first.files)
        assertEquals(1, first.folders)
        assertEquals(135000L, first.tokens)
        assertEquals(4, first.tasks)
        // An ask with no edits is normal (a question) — it parses as itself, never as missing data.
        val second = res.prompts[1]
        assertEquals(0, second.edits)
        assertTrue(second.editIds.isEmpty())
        assertTrue(second.current) // endTs 0 = still being answered
        // An older CLI without a pre-trimmed title falls back to the text — never a blank, nameless row.
        val untitled = PromptsParser.parse(
            """{"session":"s","summary":{"total":1,"withEdits":0,"edits":0},"prompts":[{"id":"x","index":1,"ts":1,"endTs":2,"text":"do the thing"}]}""",
        )!!
        assertEquals("do the thing", untitled.prompts[0].title)
        assertTrue(untitled.prompts[0].editIds.isEmpty())
        // bare / older payload: no crash, no rows; garbage -> null (the tab then renders its empty state)
        val bare = PromptsParser.parse("""{"session":"s1"}""")!!
        assertEquals(0, bare.summary.total)
        assertTrue(bare.prompts.isEmpty())
        assertNull(PromptsParser.parse("not json"))
    }

    @Test
    fun `PromptsParser reads Claude's response to one ask`() {
        // Mirrors `prompts --id N --response --json` — the prose a reviewer expands to read.
        val resp = PromptsParser.parseResponse(
            """{"session":"s1","response":{"promptId":"0381d2f21f10","index":1,"text":"Here is what I did…","turns":3,"bytes":18,"truncated":0}}""",
        )!!
        assertEquals("0381d2f21f10", resp.promptId)
        assertEquals(1, resp.index)
        assertEquals("Here is what I did…", resp.text)
        assertEquals(3, resp.turns)
        assertEquals(0L, resp.truncated)
        // A capped response reports how much it dropped; an ask with no recorded reply parses as null.
        assertEquals(4096L, PromptsParser.parseResponse("""{"response":{"promptId":"x","index":2,"text":"…","turns":1,"truncated":4096}}""")!!.truncated)
        assertNull(PromptsParser.parseResponse("""{"session":"s1","response":null}"""))
        assertNull(PromptsParser.parseResponse("not json"))
    }

    @Test
    fun `FeedParser keeps core's mode, order, truncation and failure marks`() {
        val json = """
            {"ref":{"kind":"process","id":"bpk1"},"title":"Run the suite","running":true,"mode":"live",
             "entries":[
               {"ts":1000,"kind":"action","label":"Bash","target":"npm test","detail":"main agent","ok":false,
                "category":"exec","note":"run the unit suite","cmd":"npm test 2>&1 |\ntail -5",
                "reasoning":"the suite should pass now","reasoningKind":"thinking","editId":7,"previewId":9},
               {"ts":0,"kind":"output","label":"  ok 12 passed"},
               {"ts":2000,"kind":"reasoning","label":"checking the failure"},
               {"ts":3000,"kind":"permission","label":"Write outside the workspace?"}
             ],"truncated":26,"lastTs":3000,"note":null,
             "recap":"Fixed the flaky suite","recapSource":"analysis"}
        """.trimIndent()
        val feed = FeedParser.parse(json)!!
        assertEquals("process", feed.kind)
        assertEquals("bpk1", feed.id) // the pane checks this before painting, so a stale tail can't show
        assertTrue(feed.live)
        assertEquals(26, feed.truncated) // said out loud — a cap must never read as completeness
        assertEquals(3000L, feed.lastTs)
        assertNull(feed.note)
        assertEquals(4, feed.entries.size)
        assertEquals(false, feed.entries[0].ok) // an explicit false is a failure to mark
        assertEquals(0L, feed.entries[1].ts) // raw output has no timestamp — rendered without a fake one
        assertNull(feed.entries[1].ok) // absent -> not applicable, never "failed"
        assertEquals("reasoning", feed.entries[2].kind)
        assertEquals("permission", feed.entries[3].kind) // the row a hook-observed session can't have
        // The 0.10.0 blob fields round-trip — and their ABSENCE stays null (entries[1] carries none).
        val rich = feed.entries[0]
        assertEquals("exec", rich.category)
        assertEquals("run the unit suite", rich.note)
        assertEquals("the suite should pass now", rich.reasoning)
        assertEquals("thinking", rich.reasoningKind)
        assertEquals("npm test 2>&1 |\ntail -5", rich.cmd) // the FULL command, newline intact
        assertEquals(7, rich.editId)
        assertEquals(9, rich.previewId)
        val bare = feed.entries[1]
        assertNull(bare.category); assertNull(bare.note); assertNull(bare.reasoning)
        assertNull(bare.reasoningKind); assertNull(bare.cmd); assertNull(bare.editId); assertNull(bare.previewId)
        // The session recap rides the payload (session-kind feeds), with its source labelled.
        assertEquals("Fixed the flaky suite", feed.recap)
        assertEquals("analysis", feed.recapSource)

        // finished source: audit, plus core's explanation of an empty feed
        val audit = FeedParser.parse(
            """{"ref":{"kind":"agent","id":"a1"},"title":"a1","running":false,"mode":"audit","entries":[],"truncated":0,"lastTs":0,"note":"no transcript for this agent yet"}""",
        )!!
        assertFalse(audit.live)
        assertEquals("no transcript for this agent yet", audit.note)
        // an unknown/absent mode must not be labelled live (and must not be polled forever)
        assertFalse(FeedParser.parse("""{"title":"x","entries":[]}""")!!.live)
        assertNull(FeedParser.parse("not json"))
    }
}
