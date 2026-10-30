plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.example.notes"
    compileSdk = 35
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
}
