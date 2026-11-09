package com.dtinth.vxbeamer.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PairingTest {
    @Test
    fun `a pairing link names the backend and the code`() {
        val link = Pairing.parseLink("https://vx.example.com/pair#5FSW5KA3MS7B")

        assertEquals(Pairing.Link("https://vx.example.com", "5FSW5KA3MS7B"), link)
    }

    @Test
    fun `a pasted link is tolerated - spaces, a trailing slash, lowercase, dashes`() {
        val link = Pairing.parseLink("  https://vx.example.com/pair/#5fsw-5ka3-ms7b \n")

        assertEquals(Pairing.Link("https://vx.example.com", "5FSW5KA3MS7B"), link)
    }

    @Test
    fun `a non-default port stays in the backend url`() {
        val link = Pairing.parseLink("http://localhost:8787/pair#5FSW5KA3MS7B")

        assertEquals("http://localhost:8787", link?.backendUrl)
    }

    @Test
    fun `plain http is only accepted for localhost`() {
        assertNull(Pairing.parseLink("http://vx.example.com/pair#5FSW5KA3MS7B"))
    }

    @Test
    fun `anything else is not a pairing link`() {
        assertNull(Pairing.parseLink(""))
        assertNull(Pairing.parseLink("5FSW5KA3MS7B"))
        assertNull(Pairing.parseLink("https://vx.example.com/#5FSW5KA3MS7B"))
        assertNull(Pairing.parseLink("https://vx.example.com/pair"))
        assertNull(Pairing.parseLink("https://vx.example.com/pair#TOO-SHORT"))
        // I, L, O and U are not in the alphabet.
        assertNull(Pairing.parseLink("https://vx.example.com/pair#ILOUILOUILOU"))
    }
}
