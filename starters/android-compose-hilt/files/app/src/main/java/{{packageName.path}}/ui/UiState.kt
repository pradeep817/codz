package {{packageName}}.ui

/** What a screen shows while it loads data, when it has it, and when loading failed. */
sealed interface UiState<out T> {
    data object Loading : UiState<Nothing>

    data class Success<T>(val data: T) : UiState<T>

    data class Error(val message: String) : UiState<Nothing>
}
