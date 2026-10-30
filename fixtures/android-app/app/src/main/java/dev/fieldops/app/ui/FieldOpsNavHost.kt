package dev.fieldops.app.ui

import androidx.compose.runtime.Composable
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import dev.fieldops.app.ui.jobs.JobsScreen

@Composable
fun FieldOpsNavHost() {
    val navController = rememberNavController()
    NavHost(navController, startDestination = "jobs") {
        composable("jobs") { JobsScreen() }
    }
}
