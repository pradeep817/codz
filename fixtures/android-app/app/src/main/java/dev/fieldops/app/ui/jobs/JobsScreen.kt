package dev.fieldops.app.ui.jobs

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.hilt.navigation.compose.hiltViewModel

@Composable
fun JobsScreen(viewModel: JobsViewModel = hiltViewModel()) {
    Text("Jobs")
}
