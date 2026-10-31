// codz's minimal Android project: what Android Studio's "Empty Activity"
// template gives you (Kotlin, Jetpack Compose, a version catalog), plus
// Navigation Compose with a Home screen so screens can be added right away.
// Android has no command-line project creator, so create always uses this.

import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTool } from '../core/proc.ts';

export const ANDROID_SKELETON_VERSIONS = {
  agp: '8.7.3',
  kotlin: '2.0.21',
  gradle: '8.11.1',
  coreKtx: '1.15.0',
  lifecycle: '2.8.7',
  activityCompose: '1.9.3',
  composeBom: '2024.10.01',
  navigationCompose: '2.8.4',
  junit: '4.13.2',
};

/** com.acme + shop-app → com.acme.shopapp */
export const androidPackage = (org: string, name: string) => `${org}.${name.replace(/[^a-z0-9]/g, '')}`;
const title = (name: string) => name.split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const pascalName = (name: string) => title(name).replace(/\s/g, '');

export function androidSkeleton(o: { name: string; org: string; primary?: string }): Map<string, string> {
  const v = ANDROID_SKELETON_VERSIONS;
  const pkg = androidPackage(o.org, o.name);
  const dir = `app/src/main/java/${pkg.replace(/\./g, '/')}`;
  const theme = `${pascalName(o.name)}Theme`;
  const primary = (o.primary ?? '#6750A4').replace(/^#/, '').toUpperCase();
  const f = new Map<string, string>();
  f.set('settings.gradle.kts', `pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\\\.android.*")
                includeGroupByRegex("com\\\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "${title(o.name)}"
include(":app")
`);
  f.set('build.gradle.kts', `// Top-level build file: plugins are declared here and applied in the modules.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
}
`);
  f.set('gradle/libs.versions.toml', `[versions]
agp = "${v.agp}"
kotlin = "${v.kotlin}"
core-ktx = "${v.coreKtx}"
lifecycle = "${v.lifecycle}"
activity-compose = "${v.activityCompose}"
compose-bom = "${v.composeBom}"
navigation-compose = "${v.navigationCompose}"
junit = "${v.junit}"

[libraries]
androidx-core-ktx = { group = "androidx.core", name = "core-ktx", version.ref = "core-ktx" }
androidx-lifecycle-runtime-ktx = { group = "androidx.lifecycle", name = "lifecycle-runtime-ktx", version.ref = "lifecycle" }
androidx-lifecycle-viewmodel-compose = { group = "androidx.lifecycle", name = "lifecycle-viewmodel-compose", version.ref = "lifecycle" }
androidx-activity-compose = { group = "androidx.activity", name = "activity-compose", version.ref = "activity-compose" }
androidx-compose-bom = { group = "androidx.compose", name = "compose-bom", version.ref = "compose-bom" }
androidx-ui = { group = "androidx.compose.ui", name = "ui" }
androidx-ui-graphics = { group = "androidx.compose.ui", name = "ui-graphics" }
androidx-ui-tooling = { group = "androidx.compose.ui", name = "ui-tooling" }
androidx-ui-tooling-preview = { group = "androidx.compose.ui", name = "ui-tooling-preview" }
androidx-material3 = { group = "androidx.compose.material3", name = "material3" }
androidx-navigation-compose = { group = "androidx.navigation", name = "navigation-compose", version.ref = "navigation-compose" }
junit = { group = "junit", name = "junit", version.ref = "junit" }

[plugins]
android-application = { id = "com.android.application", version.ref = "agp" }
kotlin-android = { id = "org.jetbrains.kotlin.android", version.ref = "kotlin" }
kotlin-compose = { id = "org.jetbrains.kotlin.plugin.compose", version.ref = "kotlin" }
`);
  f.set('gradle.properties', 'org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8\nandroid.useAndroidX=true\nkotlin.code.style=official\nandroid.nonTransitiveRClass=true\n');
  f.set('gradle/wrapper/gradle-wrapper.properties', `distributionBase=GRADLE_USER_HOME\ndistributionPath=wrapper/dists\ndistributionUrl=https\\://services.gradle.org/distributions/gradle-${v.gradle}-bin.zip\nnetworkTimeout=10000\nvalidateDistributionUrl=true\nzipStoreBase=GRADLE_USER_HOME\nzipStorePath=wrapper/dists\n`);
  f.set('.gitignore', '*.iml\n.gradle/\n/local.properties\n/.idea/\n.DS_Store\n/build/\n/app/build/\n/captures/\n.externalNativeBuild/\n.cxx/\n.kotlin/\n');
  f.set('app/.gitignore', '/build\n');
  f.set('app/proguard-rules.pro', '# Project-specific ProGuard rules go here.\n');
  f.set('app/build.gradle.kts', `plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "${pkg}"
    compileSdk = 35

    defaultConfig {
        applicationId = "${pkg}"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    kotlinOptions {
        jvmTarget = "11"
    }
    buildFeatures {
        compose = true
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material3)
    implementation(libs.androidx.navigation.compose)
    debugImplementation(libs.androidx.ui.tooling)
    testImplementation(libs.junit)
}
`);
  f.set('app/src/main/AndroidManifest.xml', `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <application
        android:allowBackup="true"
        android:label="@string/app_name"
        android:supportsRtl="true"
        android:theme="@style/Theme.${pascalName(o.name)}">
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:theme="@style/Theme.${pascalName(o.name)}">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />

                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>

</manifest>
`);
  f.set('app/src/main/res/values/strings.xml', `<resources>\n    <string name="app_name">${title(o.name)}</string>\n</resources>\n`);
  f.set('app/src/main/res/values/themes.xml', `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <style name="Theme.${pascalName(o.name)}" parent="android:Theme.Material.Light.NoActionBar" />\n</resources>\n`);
  f.set(`${dir}/MainActivity.kt`, `package ${pkg}

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import ${pkg}.ui.navigation.AppNavHost
import ${pkg}.ui.theme.${theme}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            ${theme} {
                AppNavHost()
            }
        }
    }
}
`);
  f.set(`${dir}/ui/navigation/AppNavHost.kt`, `package ${pkg}.ui.navigation

import androidx.compose.runtime.Composable
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import ${pkg}.ui.screens.HomeScreen

/** Every screen of the app. codz screen add and route add register new screens here. */
@Composable
fun AppNavHost(navController: NavHostController = rememberNavController()) {
    NavHost(navController = navController, startDestination = "home") {
        composable("home") {
            HomeScreen()
        }
    }
}
`);
  f.set(`${dir}/ui/screens/HomeScreen.kt`, `package ${pkg}.ui.screens

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier

@Composable
fun HomeScreen() {
    Scaffold { padding ->
        Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
            Text("${title(o.name)}")
        }
    }
}
`);
  f.set(`${dir}/ui/theme/Color.kt`, `package ${pkg}.ui.theme\n\nimport androidx.compose.ui.graphics.Color\n\nval Primary = Color(0xFF${primary})\n`);
  f.set(`${dir}/ui/theme/Theme.kt`, `package ${pkg}.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

@Composable
fun ${theme}(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val colors = if (darkTheme) darkColorScheme(primary = Primary) else lightColorScheme(primary = Primary)
    MaterialTheme(colorScheme = colors, content = content)
}
`);
  return f;
}

/** gradlew, gradlew.bat and gradle-wrapper.jar shipped with codz (assets/gradle-wrapper). */
const BUNDLED_WRAPPER = fileURLToPath(new URL('../../assets/gradle-wrapper/', import.meta.url));

/**
 * Adds gradlew, gradlew.bat and the wrapper jar: the copies shipped with codz,
 * so Gradle does not need to be installed (the wrapper downloads the version in
 * gradle-wrapper.properties on first run). Falls back to a local Gradle, run in
 * an empty folder so it does not try to resolve the project's plugins. Returns
 * false when neither is available.
 */
export function addGradleWrapper(dir: string): boolean {
  if (['gradlew', 'gradlew.bat', 'gradle-wrapper.jar'].every((f) => existsSync(join(BUNDLED_WRAPPER, f)))) {
    mkdirSync(join(dir, 'gradle/wrapper'), { recursive: true });
    copyFileSync(join(BUNDLED_WRAPPER, 'gradlew'), join(dir, 'gradlew'));
    copyFileSync(join(BUNDLED_WRAPPER, 'gradlew.bat'), join(dir, 'gradlew.bat'));
    copyFileSync(join(BUNDLED_WRAPPER, 'gradle-wrapper.jar'), join(dir, 'gradle/wrapper/gradle-wrapper.jar'));
    try {
      chmodSync(join(dir, 'gradlew'), 0o755);
    } catch {
      // Windows.
    }
    return true;
  }
  const tmp = mkdtempSync(join(tmpdir(), 'codz-wrapper-'));
  try {
    writeFileSync(join(tmp, 'settings.gradle.kts'), 'rootProject.name = "wrapper"\n');
    const r = runTool('gradle', ['wrapper', '--gradle-version', ANDROID_SKELETON_VERSIONS.gradle, '--distribution-type', 'bin', '-q', '--offline'], { cwd: tmp, timeout: 5 * 60_000 });
    if (r.status !== 0 || !existsSync(join(tmp, 'gradlew'))) return false;
    mkdirSync(join(dir, 'gradle/wrapper'), { recursive: true });
    for (const p of ['gradlew', 'gradlew.bat', 'gradle/wrapper/gradle-wrapper.jar']) copyFileSync(join(tmp, p), join(dir, p));
    try {
      chmodSync(join(dir, 'gradlew'), 0o755);
    } catch {
      // Windows.
    }
    return true;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
