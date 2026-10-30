package {{packageName}}.data.remote

import java.io.IOException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

class ApiResultTest {
    @Test
    fun `success keeps the data`() = runTest {
        assertEquals(ApiResult.Success(42), safeApiCall { 42 })
    }

    @Test
    fun `no connection becomes a readable message`() = runTest {
        val result = safeApiCall<Int> { throw IOException("offline") }
        assertEquals(ApiResult.Failure("No connection. Check your internet and try again."), result)
    }
}
