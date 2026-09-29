package com.cellobservatory.observatory.core

import org.junit.Assert.assertEquals
import org.junit.Test
import java.nio.file.Files

/**
 * Where the plugin looks for the `oak` CLI. An IDE started from a dock or launcher inherits no shell
 * PATH, so this list is how it finds the CLI at all. It lacked /usr/bin, bun, pnpm, asdf and fnm, which
 * core's `resolveBin` (analyze.ts) covers and VS Code uses, so an install there worked in one editor
 * and not the other. The expected list is core's, in core's order.
 */
class BinCandidatesTest {

    @Test
    fun `the plugin looks everywhere core does, in core's order`() {
        val home = Files.createTempDirectory("oak-bin-home").toFile()
        try {
            for (v in listOf("v20.1.0", "v22.0.0")) java.io.File(home, ".nvm/versions/node/$v/bin").mkdirs()
            java.io.File(home, ".local/share/fnm/node-versions/v24.0.0/installation/bin").mkdirs()
            val env = mapOf("PNPM_HOME" to "/pnpm-home", "APPDATA" to "C:\\AppData", "LOCALAPPDATA" to "C:\\Local")
            val h = home.path
            assertEquals(
                listOf(
                    "$h/.local/bin/oak", "/opt/homebrew/bin/oak", "/usr/local/bin/oak", "/usr/bin/oak",
                    "$h/.npm-global/bin/oak", "$h/.volta/bin/oak", "$h/.bun/bin/oak", "/pnpm-home/oak",
                    "$h/Library/pnpm/oak", "$h/.local/share/pnpm/oak", "$h/.asdf/shims/oak",
                    "$h/.nvm/versions/node/v22.0.0/bin/oak", "$h/.nvm/versions/node/v20.1.0/bin/oak",
                    "$h/.local/share/fnm/node-versions/v24.0.0/installation/bin/oak",
                    "C:\\AppData\\npm\\oak.cmd", "C:\\Local\\Volta\\bin\\oak.exe", "C:\\Local\\pnpm\\oak.cmd",
                ),
                ObservatoryCli.binCandidates("oak", h) { env[it] },
            )
        } finally {
            home.deleteRecursively()
        }
    }

    @Test
    fun `FNM_DIR wins over fnm's default roots`() {
        val home = Files.createTempDirectory("oak-bin-home").toFile()
        val fnm = Files.createTempDirectory("oak-fnm").toFile()
        try {
            java.io.File(home, ".local/share/fnm/node-versions/v20.0.0/installation/bin").mkdirs()
            java.io.File(fnm, "node-versions/v24.0.0/installation/bin").mkdirs()
            val found = ObservatoryCli.binCandidates("oak", home.path) { if (it == "FNM_DIR") fnm.path else null }
                .filter { it.contains("node-versions") }
            assertEquals(listOf("${fnm.path}/node-versions/v24.0.0/installation/bin/oak"), found)
        } finally {
            home.deleteRecursively()
            fnm.deleteRecursively()
        }
    }
}
