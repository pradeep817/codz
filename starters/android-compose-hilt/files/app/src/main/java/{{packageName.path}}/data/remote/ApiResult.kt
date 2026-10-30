package {{packageName}}.data.remote

import java.io.IOException
import java.net.SocketTimeoutException
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.SerializationException
import retrofit2.HttpException

/** The outcome of an API call: the data, or a message to show the user. */
sealed interface ApiResult<out T> {
    data class Success<T>(val data: T) : ApiResult<T>
    data class Failure(val message: String, val status: Int? = null) : ApiResult<Nothing>
}

/** Runs a Retrofit call and turns every error into an [ApiResult.Failure] with a readable message. */
suspend fun <T> safeApiCall(call: suspend () -> T): ApiResult<T> =
    try {
        ApiResult.Success(call())
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        ApiResult.Failure(errorMessage(e), (e as? HttpException)?.code())
    }

/** A message for the user from any error an API call can throw. */
fun errorMessage(e: Throwable): String = when (e) {
    is SocketTimeoutException -> "The server took too long to answer. Try again."
    is IOException -> "No connection. Check your internet and try again."
    is HttpException -> when {
        e.code() == 401 -> "Please sign in again."
        e.code() == 404 -> "Not found."
        e.code() >= 500 -> "The server had a problem. Try again later."
        else -> "Request failed (${e.code()})."
    }
    is SerializationException -> "The server sent something unexpected."
    else -> "Something went wrong. Try again."
}
