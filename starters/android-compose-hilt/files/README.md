# {{appTitle}}

A Kotlin Android app with Jetpack Compose, Material 3, Navigation Compose, Hilt and Retrofit with kotlinx.serialization.

Open the folder in Android Studio and run the `app` configuration, or from a terminal:

```bash
./gradlew installDebug
./gradlew test
```

- The API address is in `data/remote/ApiConfig.kt`.
- `safeApiCall { api.getItems() }` returns `ApiResult.Success` or `ApiResult.Failure` with a message for the user.
- `UiState` (in `ui`) with `LoadingView` and `ErrorView` (in `ui/components`) cover the loading and error states of a screen.

Add an endpoint with `codz api add` and a screen with `codz screen add`.
