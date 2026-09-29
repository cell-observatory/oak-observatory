package com.cellobservatory.observatory.core

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

/**
 * Port-fidelity tests against core's store.ts read semantics: append-only log.jsonl with
 * EditRecord lines + `{op:"status"}` folding, unparseable-line tolerance, and blob reads.
 * These formats are written by the TS side — the Kotlin reader must never drift from them.
 */
class StoreReaderTest {
    private lateinit var cfg: Path
    private val session = "test-session"

    @Before
    fun setUp() {
        cfg = Files.createTempDirectory("co-test-cfg")
        ClaudePaths.configDirOverride = cfg
        Files.createDirectories(ClaudePaths.storeDir(session).resolve("blobs"))
    }

    @After
    fun tearDown() {
        ClaudePaths.configDirOverride = null
        cfg.toFile().deleteRecursively()
    }

    private fun writeLog(vararg lines: String) {
        Files.writeString(ClaudePaths.logPath(session), lines.joinToString("\n") + "\n")
    }

    @Test
    fun `any op line is a control line — op wins over id, exactly like core`() {
        writeLog(
            """{"id":1,"ts":1,"tool":"Edit","file":"/w/a.txt","beforeBlob":"aa","afterBlob":"bb","status":"kept"}""",
            """{"op":"batch","kind":"keep","ids":[1],"prev":{"1":"pending"},"ts":2}""",
            """{"op":"scope","ids":[1],"prompt":"p1","ts":3}""",
            // The dangerous shape: a future op carrying BOTH id and file. Pre-fix, this fell through
            // to the record path and overwrote records[1] with status "pending".
            """{"op":"someFutureThing","id":1,"file":"/w/evil.txt","ts":4}""",
        )
        val log = StoreReader.readLog(session)
        assertEquals(1, log.size)
        assertEquals("/w/a.txt", log[0].file)
        assertEquals("kept", log[0].status)
    }

    @Test
    fun `status ops fold onto records in file order and the last op wins`() {
        writeLog(
            """{"id":1,"ts":1000,"tool":"Edit","file":"/w/a.txt","beforeBlob":"aa","afterBlob":"bb","status":"pending"}""",
            """{"id":2,"ts":2000,"tool":"Write","file":"/w/b.txt","beforeBlob":null,"afterBlob":"cc","status":"pending"}""",
            """{"op":"status","id":1,"status":"kept","ts":3000}""",
            """{"op":"status","id":1,"status":"undone","ts":4000}""",
        )
        val log = StoreReader.readLog(session)
        assertEquals(2, log.size)
        assertEquals("undone", log[0].status) // last op wins
        assertEquals("pending", log[1].status)
        assertEquals(null, log[1].beforeBlob) // JSON null -> Kotlin null (new-file create)
    }

    @Test
    fun `malformed and truncated lines are skipped, well-formed records survive`() {
        writeLog(
            """{"id":1,"ts":1,"tool":"Edit","file":"/w/a.txt","beforeBlob":"aa","afterBlob":"bb","status":"pending"}""",
            "not json at all",
            """{"id":2,"ts":2,"tool":"Edit","file":"/w/b.txt","before""", // truncated mid-append
            """{"op":"status","id":1,"status":"kept","ts":3}""",
        )
        val log = StoreReader.readLog(session)
        assertEquals(1, log.size)
        assertEquals(1, log[0].id)
        assertEquals("kept", log[0].status)
    }

    @Test
    fun `missing log yields an empty list and an absent freshness key`() {
        assertTrue(StoreReader.readLog("no-such-session").isEmpty())
        assertEquals("absent", StoreReader.logKey("no-such-session"))
    }

    @Test
    fun `blobs are read by content sha and missing blobs read as empty`() {
        val sha = "a".repeat(64)
        Files.writeString(ClaudePaths.blobPath(session, sha), "hello\nworld\n")
        assertEquals("hello\nworld\n", StoreReader.readBlob(session, sha))
        assertEquals("", StoreReader.readBlob(session, "f".repeat(64)))
        assertEquals("", StoreReader.readBlob(session, null))
    }

    @Test
    fun `listSessions sorts by log mtime (not max edit ts) and reports counts`() {
        writeLog(
            """{"id":1,"ts":1000,"tool":"Edit","file":"/w/a.txt","beforeBlob":"aa","afterBlob":"bb","status":"pending"}""",
            """{"op":"status","id":1,"status":"kept","ts":2000}""",
        )
        val other = "other-session"
        Files.createDirectories(ClaudePaths.storeDir(other))
        Files.writeString(
            ClaudePaths.logPath(other),
            """{"id":1,"ts":9000,"tool":"Edit","file":"/w/z.txt","beforeBlob":"aa","afterBlob":"bb","status":"pending"}""" + "\n",
        )
        // CONTRADICTING mtimes: `other` has the larger edit ts (9000) but the OLDER file mtime. A
        // max(edit.ts) sort would rank `other` first; the correct mtime sort (matching core.listSessions)
        // ranks `session` first. This is what makes the test discriminate against the old drift.
        val ft = { ms: Long -> java.nio.file.attribute.FileTime.fromMillis(ms) }
        Files.setLastModifiedTime(ClaudePaths.logPath(other), ft(1_000_000))
        Files.setLastModifiedTime(ClaudePaths.logPath(session), ft(2_000_000))
        val sessions = StoreReader.listSessions()
        assertEquals(2, sessions.size)
        assertEquals(session, sessions[0].id) // newer log mtime first, NOT the larger edit ts
        assertEquals(other, sessions[1].id)
        assertEquals(0, sessions[0].pending) // session's edit was kept
        assertEquals(1, sessions[1].pending) // other's edit is pending
    }

    @Test
    fun `sessionExists answers from the store dir, any project transcript, or a proven absence`() {
        // The store dir (created in setUp) is enough — the common pinned case.
        assertTrue(StoreReader.sessionExists(session))
        // No store dir, but a transcript in SOME project dir: the pin is application-wide, so a
        // session from a different project than the one asking still exists.
        val t = "transcript-only-session"
        val proj = ClaudePaths.configDir().resolve("projects").resolve("-w-somewhere")
        Files.createDirectories(proj)
        Files.writeString(proj.resolve("$t.jsonl"), "{}\n")
        assertTrue(StoreReader.sessionExists(t))
        // Neither, anywhere — the PROVEN absence that lets a stale pin heal instead of blanking
        // every panel (the currentSession() fallback rides exactly this answer).
        assertFalse(StoreReader.sessionExists("deleted-session"))
        assertFalse(StoreReader.sessionExists(""))
    }

    @Test
    fun `drive-letter case twins heal to one canonical path — the readLog mirror of issue 43`() {
        writeLog(
            """{"id":1,"ts":1000,"tool":"Bash","file":"C:\\repo\\ci.yml","beforeBlob":null,"afterBlob":"aa","status":"pending"}""",
            """{"id":2,"ts":2000,"tool":"Bash","file":"c:\\repo\\ci.yml","beforeBlob":"aa","afterBlob":null,"status":"pending"}""",
        )
        val log = StoreReader.readLog(session)
        assertEquals(2, log.size)
        assertEquals(setOf("C:\\repo\\ci.yml"), log.map { it.file }.toSet()) // one file, not two
    }

    @Test
    fun `canonPath and storeKey bridge editor paths to store keys`() {
        // canonPath mirrors core's paths.ts exactly — total, platform-independent.
        assertEquals("C:\\repo\\x.ts", ClaudePaths.canonPath("c:\\repo\\x.ts"))
        assertEquals("C:/repo/x.ts", ClaudePaths.canonPath("C:/repo/x.ts"))
        assertEquals("/unix/path", ClaudePaths.canonPath("/unix/path"))
        assertEquals("cargo.toml", ClaudePaths.canonPath("cargo.toml"))
        // storeKey: IntelliJ VirtualFile paths are system-independent (forward slashes, any drive
        // case) — the store holds OS-native canonical paths. Drive-shaped input flips + canonicalizes…
        assertEquals("C:\\repo\\x.ts", ClaudePaths.storeKey("c:/repo/x.ts"))
        assertEquals("C:\\repo\\x.ts", ClaudePaths.storeKey("C:/repo/x.ts"))
        assertEquals("C:\\repo\\x.ts", ClaudePaths.storeKey("C:\\repo\\x.ts")) // idempotent on store form
        // …and everything else passes through untouched (a backslash is a legal POSIX filename char).
        assertEquals("/w/a.txt", ClaudePaths.storeKey("/w/a.txt"))
        assertEquals("/w/odd\\name", ClaudePaths.storeKey("/w/odd\\name"))
    }
    @Test
    fun `duplicate legacy IDs and later capture evidence match core targeting`() {
        Files.writeString(ClaudePaths.logPath(session), """
            {"id":1,"uid":"a","file":"/tmp/one","tool":"Edit","beforeBlob":"old","afterBlob":"new"}
            {"id":1,"uid":"b","file":"/tmp/two","tool":"Edit","source":"acp","partial":true,"beforeBlob":null,"afterBlob":"two"}
            {"op":"capture-evidence","id":2,"uid":"b","beforeBlob":"before","tool":"Write","toolCallId":"native","beforeState":"present"}
            {"op":"status","id":2,"status":"undone"}
        """.trimIndent())
        val rows = StoreReader.readLog(session)
        assertEquals(listOf(1, 2), rows.map { it.id })
        assertEquals(listOf("pending", "undone"), rows.map { it.status })
        assertEquals("before", rows[1].beforeBlob)
        assertEquals("native", rows[1].toolCallId)
        assertFalse(rows[1].reviewOnly)
    }

    @Test
    fun `Codex census includes archived custom home sessions only when requested`() {
        val home = cfg.resolve("codex")
        val live = home.resolve("sessions/2026/09/09")
        val archive = home.resolve("archived_sessions")
        Files.createDirectories(live)
        Files.createDirectories(archive)
        Files.writeString(live.resolve("live.jsonl"), """{"type":"session_meta","payload":{"id":"live","cwd":"/tmp/work"}}""")
        Files.writeString(archive.resolve("archive.jsonl"), """{"type":"session_meta","payload":{"id":"archived","cwd":"/tmp/work"}}""")
        assertEquals(listOf("live"), StoreReader.codexSessions(home = home).map { it.first })
        assertEquals(setOf("live", "archived"), StoreReader.codexSessions(true, home).map { it.first }.toSet())
    }

}
